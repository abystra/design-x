import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {signR2ReadOnly,validateMaterialEntries} from '../../packages/server-domain/src/project-materials.js';
const vector=JSON.parse(readFileSync(new URL('../fixtures/workx-r2-credential-vector.json',import.meta.url),'utf8'));
test('TypeScript R2 signer matches pinned WorkX Python byte-for-byte fixture',()=>{
 const i=vector.input;
 const {expiresAt,...actual}=signR2ReadOnly({accountId:i.account_id,endpoint:i.endpoint,parentAccessKeyId:i.parent_access_key_id,parentSecretAccessKey:i.parent_secret_access_key,bucket:i.bucket,prefixes:i.prefixes,ttlSeconds:i.ttl_seconds,now:i.now});
 assert.deepEqual(actual,vector.expected);assert.equal(expiresAt,'1970-01-01T00:31:40.000Z');
 const jwt=Buffer.from(actual.sessionToken,'base64').toString().slice(4),claims=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url').toString());
 assert.deepEqual(claims.paths,{prefixPaths:['safe/'],objectPaths:[]});assert.equal(claims.scope,'object-read-only');
});
test('R2 signer rejects other accounts, missing prefixes and invalid TTL',()=>{
 const base={accountId:'account',endpoint:'https://account.r2.cloudflarestorage.com',parentAccessKeyId:'parent',parentSecretAccessKey:'synthetic-secret',bucket:'bucket',prefixes:['safe/']};
 for(const patch of [{endpoint:'https://another.r2.cloudflarestorage.com'},{endpoint:'https://account.r2.cloudflarestorage.com/other'},{prefixes:[]},{prefixes:['../other/']},{ttlSeconds:0},{ttlSeconds:604801}])assert.throws(()=>signR2ReadOnly({...base,...patch}));
});
test('manifest matches matfs boundaries and rejects escapes and ambiguous namespaces',()=>{
 const entry={path:'素材/产品.png',size:25,sha256:'a'.repeat(64)};
 assert.doesNotThrow(()=>validateMaterialEntries([entry]));
 for(const path of ['/x','../x','a/../b','a//b','a\\b','a\u0000b','a\u0085b','a/./b','a/'])assert.throws(()=>validateMaterialEntries([{...entry,path}]));
 assert.throws(()=>validateMaterialEntries([entry,entry]));
 assert.throws(()=>validateMaterialEntries([{...entry,path:'a'},{...entry,path:'a/b'}]));
 assert.throws(()=>validateMaterialEntries([{...entry,size:100*1024*1024+1}]));
 assert.throws(()=>validateMaterialEntries([{...entry,sha256:'z'.repeat(64)}]));
});

test('material preparation enforces cumulative uncached byte budget and caller cancellation',async()=>{
 const {materialPreparationBudget}=await import('../../packages/server-domain/src/project-materials.js');
 const budget=materialPreparationBudget({maxPublishBytes:100,deadlineAt:Date.now()+5000});budget.charge(60);budget.charge(40);assert.equal(budget.publishedBytes,100);assert.throws(()=>budget.charge(1),(error:any)=>error.code==='MATERIAL_PREPARATION_BUDGET');
 assert.throws(()=>materialPreparationBudget({deadlineAt:Date.now()-1}),/deadline expired/);
 const controller=new AbortController(),cancelled=materialPreparationBudget({signal:controller.signal});controller.abort(new Error('attempt revoked'));
 assert.throws(()=>cancelled.check(),/attempt revoked/);assert.throws(()=>cancelled.charge(1),/attempt revoked/);
 const {getObject,putObject,headObject}=await import('../../packages/server-infra/src/storage.js');
 await assert.rejects(getObject('never-read',{signal:controller.signal}),/attempt revoked/);
 await assert.rejects(headObject('never-read',{signal:controller.signal}),/attempt revoked/);
 await assert.rejects(putObject('never-written',Buffer.from('x'),'image/png',{signal:controller.signal}),/attempt revoked/);
});

test('storage byte reads abort an in-flight stream when execution is revoked',async()=>{
 const {Readable}=await import('node:stream');
 const {storage,getObject}=await import('../../packages/server-infra/src/storage.js');
 const original=storage.send,controller=new AbortController();
 let started!:()=>void;const reading=new Promise<void>(resolve=>{started=resolve;});
 const stream=new Readable({read(){this.push(Buffer.from('first chunk'));started();this._read=()=>{};}});
 (storage as any).send=async()=>({Body:stream,ContentType:'image/png'});
 try{const pending=getObject('fixture',{signal:controller.signal});await reading;controller.abort(new Error('attempt revoked mid-read'));await assert.rejects(pending,/attempt revoked mid-read/);assert.equal(stream.destroyed,true);}
 finally{storage.send=original;stream.destroy();}
});

test('cloud upload preparation never creates buckets or changes shared bucket CORS',async()=>{
 const {storage,ensureBucket,ensureUploadStorage}=await import('../../packages/server-infra/src/storage.js');
 const {config}=await import('../../packages/server-infra/src/config.js');
 const originalSend=storage.send,originalEndpoint=config.s3Endpoint,originalProduction=config.production;
 const commands:string[]=[];
 try{
  config.s3Endpoint='https://synthetic.r2.cloudflarestorage.com';config.production=false;
  (storage as any).send=async(command:any)=>{commands.push(command.constructor.name);return {};};
  await ensureUploadStorage();assert.deepEqual(commands,['HeadBucketCommand']);
  commands.length=0;
  (storage as any).send=async(command:any)=>{commands.push(command.constructor.name);throw Object.assign(new Error('missing'),{name:'NotFound',$metadata:{httpStatusCode:404}});};
  await assert.rejects(ensureBucket(),/Required private storage bucket is missing/);assert.deepEqual(commands,['HeadBucketCommand']);
  commands.length=0;
  (storage as any).send=async(command:any)=>{commands.push(command.constructor.name);throw Object.assign(new Error('denied'),{name:'AccessDenied',$metadata:{httpStatusCode:403}});};
  await assert.rejects(ensureUploadStorage(),/denied/);assert.deepEqual(commands,['HeadBucketCommand']);
 }finally{storage.send=originalSend;config.s3Endpoint=originalEndpoint;config.production=originalProduction;}
});

test('only local development storage receives automatic upload CORS configuration',async()=>{
 const {storage,ensureUploadStorage}=await import('../../packages/server-infra/src/storage.js');
 const {config}=await import('../../packages/server-infra/src/config.js');
 const originalSend=storage.send,originalEndpoint=config.s3Endpoint,originalProduction=config.production;
 const commands:string[]=[];
 try{
  (storage as any).send=async(command:any)=>{commands.push(command.constructor.name);return {};};
  config.s3Endpoint='http://127.0.0.1:58333';config.production=false;
  await ensureUploadStorage();assert.deepEqual(commands,['HeadBucketCommand','PutBucketCorsCommand']);
  for(const endpoint of ['http://127.0.0.1.cloud.example:58333','https://127.0.0.1:58333','https://storage.example']){
   commands.length=0;config.s3Endpoint=endpoint;await ensureUploadStorage();assert.deepEqual(commands,['HeadBucketCommand']);
  }
  commands.length=0;config.s3Endpoint='http://127.0.0.1:58333';config.production=true;
  await ensureUploadStorage();assert.deepEqual(commands,['HeadBucketCommand']);
 }finally{storage.send=originalSend;config.s3Endpoint=originalEndpoint;config.production=originalProduction;}
});

test('single-bucket R2 acceptance requires an explicit non-production opt-in',async()=>{
 const {validateR2VerificationMode}=await import('../../scripts/verify-r2-runtime.js');
 assert.doesNotThrow(()=>validateR2VerificationMode('assets','staging',true,false));
 assert.throws(()=>validateR2VerificationMode('shared','shared',false,false),/--single-bucket-test/);
 assert.doesNotThrow(()=>validateR2VerificationMode('shared','shared',false,true));
 assert.throws(()=>validateR2VerificationMode('shared','shared',true,true),/prohibited in production/);
 assert.throws(()=>validateR2VerificationMode('assets','staging',true,true),/prohibited in production/);
});

test('migration rejects ambiguous equal bucket names across endpoints before touching storage or the database',async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx','scripts/migrate-storage.ts','--workspace','synthetic-fixture'],{
  env:{...process.env,DATABASE_URL:'postgres://synthetic:synthetic@127.0.0.1:1/no-database',S3_ENDPOINT:'https://synthetic.r2.cloudflarestorage.com',S3_BUCKET:'same-bucket',S3_STAGING_BUCKET:'staging',S3_ACCESS_KEY_ID:'synthetic',S3_SECRET_ACCESS_KEY:'synthetic',LEGACY_S3_ENDPOINT:'http://127.0.0.1:1',LEGACY_S3_BUCKET:'same-bucket',LEGACY_S3_ACCESS_KEY_ID:'synthetic',LEGACY_S3_SECRET_ACCESS_KEY:'synthetic'},timeout:5000,
 }),(error:any)=>{assert.equal(error.code,1);assert.match(error.stderr,/same bucket name on different endpoints/);assert.doesNotMatch(error.stderr,/ECONNREFUSED|timed out/);return true;});
});

test('legacy bucket reads use a separate endpoint while writes stay on the primary client',async()=>{
 const {createServer}=await import('node:http');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const requests:Array<{store:string,method:string|undefined}>=[];
 async function endpoint(store:string){const server=createServer((req,res)=>{requests.push({store,method:req.method});const bytes=Buffer.from(`${store}-bytes`);res.setHeader('Content-Type','image/png');if(req.method==='PUT'){req.resume();res.setHeader('ETag','"fixture"');res.end();}else{res.setHeader('Content-Length',bytes.length);res.end(req.method==='HEAD'?undefined:bytes);}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,url:`http://127.0.0.1:${(server.address() as any).port}`};}
 const primary=await endpoint('primary'),legacy=await endpoint('legacy');
 try{
  const code="const s=await import('./packages/server-infra/src/storage.ts'); const a=await s.getObject('key');const b=await s.getObject('key',{bucket:'legacy-fixture'});await s.headObject('key',{bucket:'legacy-fixture'});await s.putObject('key',Buffer.from('new'),'image/png',{bucket:'legacy-fixture'});console.log(JSON.stringify({primary:a.bytes.toString(),legacy:b.bytes.toString()}));";
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',code],{env:{...process.env,S3_ENDPOINT:primary.url,S3_BUCKET:'primary-fixture',S3_STAGING_BUCKET:'staging-fixture',S3_ACCESS_KEY_ID:'synthetic',S3_SECRET_ACCESS_KEY:'synthetic',LEGACY_S3_ENDPOINT:legacy.url,LEGACY_S3_BUCKET:'legacy-fixture',LEGACY_S3_ACCESS_KEY_ID:'synthetic-legacy',LEGACY_S3_SECRET_ACCESS_KEY:'synthetic-legacy'},timeout:10000});
  assert.deepEqual(JSON.parse(stdout.trim()),{primary:'primary-bytes',legacy:'legacy-bytes'});
  assert.deepEqual(requests.filter(r=>r.store==='legacy').map(r=>r.method),['GET','HEAD']);assert.ok(requests.some(r=>r.store==='primary'&&r.method==='PUT'));
 }finally{await Promise.all([primary.server,legacy.server].map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));}
});
