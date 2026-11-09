import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {parseBucketAliases,resolveObjectLocation} from '../../packages/server-infra/src/storage-locations.js';
import {mirrorStores,type MirrorStore} from '../../scripts/mirror-storage.js';

test('historical bucket aliases isolate equal keys without changing immutable logical references',()=>{
 const aliases=parseBucketAliases('{"old-stage":{"bucket":"target-bucket","prefix":"_legacy/old-stage/"}}');
 assert.deepEqual(resolveObjectLocation('old-stage','tenant/asset',aliases),{bucket:'target-bucket',key:'_legacy/old-stage/tenant/asset'});
 assert.deepEqual(resolveObjectLocation('target-bucket','tenant/asset',aliases),{bucket:'target-bucket',key:'tenant/asset'});
 for(const raw of ['[]','{"old-stage":{"bucket":"target-bucket","prefix":"../"}}','{"old-stage":{"bucket":"target-bucket","prefix":"a//"}}','{"old-stage":{"bucket":"target-bucket"},"target-bucket":{"bucket":"other"}}'])assert.throws(()=>parseBucketAliases(raw));
 for(const key of ['../asset','x/../asset','/asset','x\\asset'])assert.throws(()=>resolveObjectLocation('old-stage',key,aliases));
});

type Stored={bytes:Buffer;mime:string;metadata?:Record<string,string>};
function memoryStore(initial:Record<string,Record<string,string>>){
 const buckets=new Map(Object.entries(initial).map(([name,objects])=>[name,new Map(Object.entries(objects).map(([key,value])=>[key,{bytes:Buffer.from(value),mime:'image/png'} as Stored]))]));
 const commands:string[]=[];const etag=(value:Stored)=>'"'+createHash('md5').update(value.bytes).digest('hex')+'"';
 const error=(name:string,status:number)=>Object.assign(new Error(name),{name,$metadata:{httpStatusCode:status}});
 return {buckets,commands,send:async(command:any)=>{
  const name=command.constructor.name,args=command.input;commands.push(name);
  const bucket=buckets.get(args.Bucket);if(!bucket)throw error('NotFound',404);
  if(name==='HeadBucketCommand')return {};
  if(name==='ListObjectsV2Command'){
   const values=[...bucket].sort(([a],[b])=>a.localeCompare(b)),offset=Number(args.ContinuationToken||0),page=values.slice(offset,offset+1);
   return {Contents:page.map(([Key,value])=>({Key,Size:value.bytes.length,ETag:etag(value),LastModified:new Date(0)})),IsTruncated:offset+1<values.length,NextContinuationToken:offset+1<values.length?String(offset+1):undefined};
  }
  if(name==='GetObjectCommand'){
   const value=bucket.get(args.Key);if(!value)throw error('NoSuchKey',404);
   if(args.IfMatch&&args.IfMatch!==etag(value))throw error('PreconditionFailed',412);
   return {Body:Readable.from([value.bytes]),ContentLength:value.bytes.length,ContentType:value.mime,Metadata:value.metadata};
  }
  if(name==='PutObjectCommand'){
   assert.equal(args.IfNoneMatch,'*','copy must never overwrite an existing target');
   if(bucket.has(args.Key))throw error('PreconditionFailed',412);
   bucket.set(args.Key,{bytes:Buffer.from(args.Body),mime:args.ContentType,metadata:args.Metadata});return {};
  }
  throw new Error('Unexpected command '+name);
 }};
}
const source:MirrorStore={endpoint:'http://source',region:'auto',bucket:'assets',stagingBucket:'stage',accessKeyId:'synthetic',secretAccessKey:'synthetic'};
const target:MirrorStore={...source,endpoint:'https://target',bucket:'assets',stagingBucket:'assets',aliases:'{"stage":{"bucket":"assets","prefix":"_legacy/stage/"}}'};

test('full mirror preserves both buckets, checks every target, resumes safely and rejects conflicting bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'designx-mirror-test-'));
 const sourceClient=memoryStore({assets:{'same-key':'asset-version','old-export':'export-file'},stage:{'same-key':'frozen-upload'}}),targetClient=memoryStore({assets:{unrelated:'preserve-me'}});
 const manifestPath=join(dir,'manifest.json'),base={source,target,sourceClient,targetClient,manifestPath,concurrency:2};
 try{
  const plan=await mirrorStores({...base,mode:'plan'});assert.equal(plan.status,'planned');assert.equal(plan.entries.length,3);assert.equal(targetClient.commands.filter(c=>c==='PutObjectCommand').length,0);
  const copied=await mirrorStores({...base,mode:'copy'});assert.equal(copied.status,'verified');assert.equal(copied.entries.every(e=>e.status==='copied'&&e.sha256?.length===64),true);
  assert.equal(targetClient.buckets.get('assets')!.get('same-key')!.bytes.toString(),'asset-version');
  assert.equal(targetClient.buckets.get('assets')!.get('_legacy/stage/same-key')!.bytes.toString(),'frozen-upload');
  assert.equal(targetClient.buckets.get('assets')!.get('unrelated')!.bytes.toString(),'preserve-me');
  const writes=targetClient.commands.filter(c=>c==='PutObjectCommand').length;
  await mirrorStores({...base,mode:'copy'});assert.equal(targetClient.commands.filter(c=>c==='PutObjectCommand').length,writes);
  await mirrorStores({...base,mode:'verify'});
  targetClient.buckets.get('assets')!.get('same-key')!.bytes=Buffer.from('corrupted');
  await assert.rejects(mirrorStores({...base,mode:'copy'}),/Target differs from source/);
  assert.equal(targetClient.buckets.get('assets')!.get('same-key')!.bytes.toString(),'corrupted');
  assert.equal(sourceClient.buckets.get('assets')!.get('same-key')!.bytes.toString(),'asset-version');
  assert.equal(JSON.parse(await readFile(manifestPath,'utf8')).status,'failed');
  assert.ok(![...sourceClient.commands,...targetClient.commands].some(c=>c.includes('Delete')));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('mirror refuses missing source bytes and changed source snapshots instead of reporting a complete copy',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'designx-mirror-missing-'));
 const sourceClient=memoryStore({assets:{old:'data'},stage:{}}),targetClient=memoryStore({assets:{}});
 const manifestPath=join(dir,'manifest.json'),base={source,target,sourceClient,targetClient,manifestPath};
 try{
  await mirrorStores({...base,mode:'plan'});
  sourceClient.buckets.get('assets')!.set('new',{bytes:Buffer.from('changed'),mime:'image/png'});
  await assert.rejects(mirrorStores({...base,mode:'copy'}),/source inventory changed/);
  sourceClient.buckets.get('assets')!.delete('new');
  const send=sourceClient.send;sourceClient.send=async command=>{if(command.constructor.name==='GetObjectCommand')sourceClient.buckets.get('assets')!.delete('old');return send(command);};
  await assert.rejects(mirrorStores({...base,mode:'copy'}),/NoSuchKey/);
  assert.equal(targetClient.commands.filter(c=>c==='PutObjectCommand').length,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('invalid worker counts and unavailable target buckets cannot produce a verified manifest',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'designx-mirror-failure-'));
 const sourceClient=memoryStore({assets:{old:'data'},stage:{}}),targetClient=memoryStore({});
 const manifestPath=join(dir,'manifest.json'),base={source,target,sourceClient,targetClient,manifestPath,mode:'copy' as const};
 try{
  for(const concurrency of [NaN,0,9,1.5])await assert.rejects(mirrorStores({...base,concurrency}),/Concurrency must be an integer/);
  await assert.rejects(mirrorStores(base),/NotFound/);
  assert.equal(JSON.parse(await readFile(manifestPath,'utf8')).status,'failed');
  assert.equal(targetClient.commands.filter(c=>c==='PutObjectCommand').length,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('all object operations and signed uploads resolve the same historical bucket prefix',async()=>{
 const {createServer}=await import('node:http'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const requests:Array<{method?:string,url?:string,copySource?:string|string[]}>=[];
 const server=createServer((req,res)=>{requests.push({method:req.method,url:req.url,copySource:req.headers['x-amz-copy-source']});req.resume();if(req.headers['x-amz-copy-source']){res.setHeader('Content-Type','application/xml');res.end('<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>');}else if(req.method==='GET'){res.setHeader('Content-Type','image/png');res.end('bytes');}else if(req.method==='HEAD'){res.setHeader('Content-Length','5');res.end();}else{res.statusCode=req.method==='DELETE'?204:200;res.end();}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const code="const s=await import('./packages/server-infra/src/storage.ts'); await s.getObject('a',{bucket:'old-stage'});await s.headObject('a',{bucket:'old-stage'});await s.putObject('b',Buffer.from('bytes'),'image/png',{bucket:'old-stage'});await s.copyObject('a','c',{sourceBucket:'old-stage',bucket:'old-stage'});await s.deleteObject('c',{bucket:'old-stage'});console.log(new URL(await s.signedUpload('new','image/png',5)).pathname);";
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',code],{env:{...process.env,S3_ENDPOINT:endpoint,S3_REGION:'auto',S3_BUCKET:'target-bucket',S3_STAGING_BUCKET:'old-stage',S3_ACCESS_KEY_ID:'synthetic',S3_SECRET_ACCESS_KEY:'synthetic',S3_BUCKET_ALIASES_JSON:'{"old-stage":{"bucket":"target-bucket","prefix":"_legacy/old-stage/"}}'},timeout:10000});
  assert.equal(stdout.trim(),'/target-bucket/_legacy/old-stage/new');
  assert.ok(requests.every(r=>r.url?.startsWith('/target-bucket/_legacy/old-stage/')));
  assert.deepEqual(requests.map(r=>r.method),['GET','HEAD','PUT','PUT','DELETE']);
  assert.equal(requests[3].copySource,'target-bucket/_legacy/old-stage/a');
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
