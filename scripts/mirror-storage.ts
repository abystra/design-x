/** Offline full-store copy/verify. No database references or source objects change.
 * --source-env PATH --target-env PATH --manifest PATH [--copy|--verify] [--concurrency 4]
 * Source S3_BUCKET + S3_STAGING_BUCKET and MIRROR_SOURCE_BUCKETS_JSON are inventoried.
 * Target S3_BUCKET_ALIASES_JSON maps historical buckets into isolated prefixes.
 */
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'dotenv';
import {S3Client,ListObjectsV2Command,GetObjectCommand,PutObjectCommand,HeadBucketCommand} from '@aws-sdk/client-s3';
import {parseBucketAliases,resolveObjectLocation} from '../packages/server-infra/src/storage-locations.js';

export type MirrorStore={endpoint:string;region:string;bucket:string;stagingBucket:string;accessKeyId:string;secretAccessKey:string;aliases?:string;sourceBuckets?:string[]};
type ListedObject={bucket:string;key:string;bytes:number;etag:string;lastModified:string};
type MirrorEntry=ListedObject&{targetBucket:string;targetKey:string;sha256?:string;contentType?:string;status:'pending'|'missing'|'copied'|'verified'|'failed';error?:string};
type S3Like={send:(command:any)=>Promise<any>};
export function mirrorConfig(env:Record<string,string>):MirrorStore {
 const endpoint=env.S3_ENDPOINT,accessKeyId=env.S3_ACCESS_KEY_ID,secretAccessKey=env.S3_SECRET_ACCESS_KEY,bucket=env.S3_BUCKET;
 if(!endpoint||!accessKeyId||!secretAccessKey||!bucket)throw new Error('Explicit store env file is incomplete');
 const url=new URL(endpoint);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid store endpoint');
 const sourceBuckets:unknown=env.MIRROR_SOURCE_BUCKETS_JSON?JSON.parse(env.MIRROR_SOURCE_BUCKETS_JSON):[];
 if(!Array.isArray(sourceBuckets)||sourceBuckets.some(b=>typeof b!=='string'||!b))throw new Error('MIRROR_SOURCE_BUCKETS_JSON must contain bucket names');
 return {endpoint:url.href.replace(/\/$/,''),region:env.S3_REGION||'auto',bucket,stagingBucket:env.S3_STAGING_BUCKET||`${bucket}-staging`,accessKeyId,secretAccessKey,aliases:env.S3_BUCKET_ALIASES_JSON,sourceBuckets};
}
const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const missing=(error:any)=>error?.$metadata?.httpStatusCode===404||['NoSuchKey','NotFound'].includes(error?.name);
const metadataIdentity=(items:ListedObject[])=>sha(JSON.stringify(items));
export async function inventoryStore(client:S3Like,buckets:string[]):Promise<ListedObject[]> {
 const result:ListedObject[]=[];
 for(const bucket of [...new Set(buckets)].sort()){
  let cursor:string|undefined;
  do{
   const page=await client.send(new ListObjectsV2Command({Bucket:bucket,ContinuationToken:cursor}));
   for(const row of page.Contents||[]){if(typeof row.Key!=='string'||!Number.isSafeInteger(row.Size)||row.Size<0||!row.ETag)throw new Error('Invalid source inventory entry');result.push({bucket,key:row.Key,bytes:row.Size,etag:row.ETag,lastModified:row.LastModified?.toISOString()||''});}
   if(page.IsTruncated&&!page.NextContinuationToken)throw new Error('Incomplete source listing');cursor=page.NextContinuationToken;
  }while(cursor);
 }
 return result.sort((a,b)=>a.bucket.localeCompare(b.bucket)||a.key.localeCompare(b.key));
}
async function objectBytes(client:S3Like,bucket:string,key:string,etag?:string){
 const response=await client.send(new GetObjectCommand({Bucket:bucket,Key:key,...(etag?{IfMatch:etag}:{})}));
 const limit=256*1024*1024;if(!response.Body||Number(response.ContentLength)>limit)throw new Error('Object missing a body or exceeding the 256 MiB copy budget');
 let length=0;const chunks:Buffer[]=[];
 try{for await(const chunk of response.Body){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>limit)throw new Error('Object exceeds the 256 MiB copy budget');chunks.push(bytes);}}
 finally{response.Body.destroy?.();}
 const bytes=Buffer.concat(chunks,length);
 if(Number(response.ContentLength)!==bytes.length)throw new Error('Object content length mismatch');
 return {response,bytes,sha256:sha(bytes)};
}
export async function mirrorStores(options:{source:MirrorStore;target:MirrorStore;sourceClient:S3Like;targetClient:S3Like;manifestPath:string;mode:'plan'|'copy'|'verify';concurrency?:number}) {
 const {source,target,sourceClient,targetClient,manifestPath,mode}=options;
 const concurrency=options.concurrency??4;
 if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('Concurrency must be an integer between 1 and 8');
 const buckets=[...new Set([source.bucket,source.stagingBucket,...(source.sourceBuckets||[])])];
 const aliases=parseBucketAliases(target.aliases),inventory=await inventoryStore(sourceClient,buckets);
 const fingerprint=sha(JSON.stringify({sourceEndpoint:source.endpoint,targetEndpoint:target.endpoint,buckets:buckets.sort(),aliases:[...aliases],targetBucket:target.bucket}));
 const sourceInventorySha256=metadataIdentity(inventory);
 const entries:MirrorEntry[]=inventory.map(item=>{const destination=resolveObjectLocation(item.bucket,item.key,aliases);return {...item,targetBucket:destination.bucket,targetKey:destination.key,status:'pending'};});
 const addresses=new Set<string>();
 for(const item of entries){
  if(item.targetBucket!==target.bucket&&item.targetBucket!==target.stagingBucket)throw new Error('Every source bucket must map into the explicitly configured target buckets');
  const address=JSON.stringify([item.targetBucket,item.targetKey]);if(addresses.has(address))throw new Error('Two source objects map to the same target; use isolated bucket prefixes');addresses.add(address);
  if(source.endpoint===target.endpoint&&item.bucket===item.targetBucket&&item.key===item.targetKey)throw new Error('Refusing to mirror an object onto itself');
 }
 let prior:any;try{prior=JSON.parse(await readFile(manifestPath,'utf8'));}catch(error:any){if(error.code!=='ENOENT')throw error;}
 if(prior&&(prior.fingerprint!==fingerprint||prior.sourceInventorySha256!==sourceInventorySha256))throw new Error('Store configuration or source inventory changed; preserve the existing manifest and create a new one');
 const report={version:1,startedAt:prior?.startedAt||new Date().toISOString(),updatedAt:new Date().toISOString(),status:'running',mode,fingerprint,sourceInventorySha256,sourceObjectCount:entries.length,sourceBytes:entries.reduce((sum,e)=>sum+e.bytes,0),sourcePreserved:true,entries};
 await mkdir(dirname(resolve(manifestPath)),{recursive:true});
 let saveChain=Promise.resolve();
 const save=()=>{saveChain=saveChain.then(async()=>{report.updatedAt=new Date().toISOString();const tmp=manifestPath+'.tmp';await writeFile(tmp,JSON.stringify(report,null,2),{mode:0o600});await rename(tmp,manifestPath);});return saveChain;};
 await save();
 let index=0,failure:Error|undefined;
 try{for(const bucket of new Set(entries.map(e=>e.targetBucket)))await targetClient.send(new HeadBucketCommand({Bucket:bucket}));}
 catch(error){report.status='failed';await save();throw error;}
 async function run(){while(!failure&&index<entries.length){const entry=entries[index++];try{
  const original=await objectBytes(sourceClient,entry.bucket,entry.key,entry.etag);
  if(original.bytes.length!==entry.bytes)throw new Error('Source size changed after inventory');
  if(original.response.Metadata?.sha256&&original.response.Metadata.sha256!==original.sha256)throw new Error('Source declared digest does not match its bytes');
  entry.sha256=original.sha256;entry.contentType=original.response.ContentType||'application/octet-stream';
  let destination:Awaited<ReturnType<typeof objectBytes>>|undefined;
  try{destination=await objectBytes(targetClient,entry.targetBucket,entry.targetKey);}catch(error){if(!missing(error))throw error;}
  if(!destination){
   if(mode==='verify')throw new Error('Target object is missing');
   if(mode==='plan'){entry.status='missing';await save();continue;}
   try{await targetClient.send(new PutObjectCommand({Bucket:entry.targetBucket,Key:entry.targetKey,Body:original.bytes,ContentType:entry.contentType,ContentLength:original.bytes.length,IfNoneMatch:'*',Metadata:{...original.response.Metadata,sha256:original.sha256},...(original.response.ContentEncoding?{ContentEncoding:original.response.ContentEncoding}:{}),...(original.response.CacheControl?{CacheControl:original.response.CacheControl}:{}),...(original.response.ContentDisposition?{ContentDisposition:original.response.ContentDisposition}:{})}));}
   catch(error:any){if(error.$metadata?.httpStatusCode!==412)throw error;}
   destination=await objectBytes(targetClient,entry.targetBucket,entry.targetKey);entry.status='copied';
  }else entry.status='verified';
  if(destination.bytes.length!==original.bytes.length||destination.sha256!==original.sha256||destination.response.ContentType!==entry.contentType)throw new Error('Target differs from source; existing target was not overwritten');
  await save();
 }catch(error:any){entry.status='failed';entry.error=error.$metadata?.httpStatusCode?`${error.name||'StorageError'} HTTP ${error.$metadata.httpStatusCode}`:String(error.message||'Object verification failed').replace(/https?:\/\/\S+/g,'[endpoint]');failure=new Error(`Mirror stopped at ${entry.bucket}/${entry.key}: ${entry.error}`);await save();}}}
 await Promise.all(Array.from({length:concurrency},run));
 if(!failure){try{if(metadataIdentity(await inventoryStore(sourceClient,buckets))!==sourceInventorySha256)failure=new Error('Source objects changed during mirroring; keep writers paused and create a new inventory');}catch(error:any){failure=new Error(`Unable to recheck the source inventory: ${error.name||'StorageError'}`);}}
 report.status=failure?'failed':mode==='plan'?'planned':'verified';await save();
 if(failure)throw failure;
 return report;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const value=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
 const sourceFile=value('--source-env'),targetFile=value('--target-env'),manifestPath=value('--manifest');
 if(!sourceFile||!targetFile||!manifestPath)throw new Error('Required: --source-env PATH --target-env PATH --manifest PATH [--copy|--verify]');
 if(process.argv.includes('--copy')&&process.argv.includes('--verify'))throw new Error('Choose copy or verify');
 const source=mirrorConfig(parse(await readFile(sourceFile))),target=mirrorConfig(parse(await readFile(targetFile)));
 const client=(store:MirrorStore)=>new S3Client({endpoint:store.endpoint,region:store.region,forcePathStyle:true,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',credentials:{accessKeyId:store.accessKeyId,secretAccessKey:store.secretAccessKey}});
 const sourceClient=client(source),targetClient=client(target);
 try{const report=await mirrorStores({source,target,sourceClient,targetClient,manifestPath,mode:process.argv.includes('--copy')?'copy':process.argv.includes('--verify')?'verify':'plan',concurrency:Number(value('--concurrency')||4)});console.log(JSON.stringify({status:report.status,objects:report.sourceObjectCount,bytes:report.sourceBytes,manifest:resolve(manifestPath),sourcePreserved:true}));}
 finally{sourceClient.destroy();targetClient.destroy();}
}
