import { createHash, createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Tx } from '../../server-infra/src/db.js';
import { tenantTransaction } from '../../server-infra/src/db.js';
import { config } from '../../server-infra/src/config.js';
import { getObject,putObject,headObject } from '../../server-infra/src/storage.js';
import { HttpError } from './common.js';
import { activeProject } from './assets.js';

// Protocol port from WorkX f81c31a3b09d13d8955248ec7bdefbdfc1f08a6e.
// Exact file visibility belongs to root-owned matfs, not the pool-prefix credential.
export type ProjectMaterial={assetId:string,assetVersionId:string,path:string,size:number,sha256:string,objectKey:string,bucket:string};
export type ProjectMaterialManifest={version:1,projectId:string,entries:ProjectMaterial[]};
export function validateMaterialEntries(entries:Array<{path:string,size:number,sha256:string}>) {
 if(entries.length>200000)throw new Error('Material entry budget exceeded');
 const paths=new Set<string>();
 for(const entry of entries){
  const parts=entry.path.split('/');
  if(!entry.path||Buffer.byteLength(entry.path)>1024||/[\\\p{Cc}]/u.test(entry.path)||parts.some(p=>!p||p==='.'||p==='..')||paths.has(entry.path))throw new Error('Invalid or duplicate material path');
  if(!Number.isSafeInteger(entry.size)||entry.size<0||entry.size>100*1024*1024||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('Invalid material content identity');
  paths.add(entry.path);
 }
 for(const name of paths){const parts=name.split('/');for(let i=1;i<parts.length;i++)if(paths.has(parts.slice(0,i).join('/')))throw new Error('Material file/directory collision');}
}
export async function freezeProjectMaterials(tx:Tx,projectId:string):Promise<ProjectMaterialManifest> {
 await activeProject(tx,projectId);
 const rows=(await tx.query("SELECT a.id,a.title,COALESCE(pa.version_id,a.current_version_id) AS version_id,v.object_key,v.bucket,v.bytes,v.sha256,v.mime FROM project_assets pa JOIN assets a ON a.id=pa.asset_id LEFT JOIN asset_versions v ON v.id=COALESCE(pa.version_id,a.current_version_id) AND v.asset_id=a.id WHERE pa.project_id=$1 AND pa.revoked_at IS NULL AND a.deleted_at IS NULL AND a.status='ready' ORDER BY a.id",[projectId])).rows;
 if(rows.some(row=>!row.version_id||!row.sha256))throw new HttpError(409,'MATERIAL_MIGRATION_REQUIRED','项目素材需完成版本迁移后才能交给 Agent');
 const entries=rows.map(row=>({assetId:row.id,assetVersionId:row.version_id,path:`${row.id}/${row.title.replace(/[\\/\p{Cc}]/gu,'_').slice(0,120)||'image'}.${row.mime==='image/jpeg'?'jpg':row.mime==='image/webp'?'webp':'png'}`,size:Number(row.bytes),sha256:row.sha256,objectKey:row.object_key,bucket:row.bucket}));
 validateMaterialEntries(entries);return {version:1,projectId,entries};
}
export async function authorizeFrozenMaterials(tx:Tx,manifest:ProjectMaterialManifest) {
 await activeProject(tx,manifest.projectId);validateMaterialEntries(manifest.entries);
 for(const item of manifest.entries){
  // A newer asset version or rename does not invalidate an already submitted run.
  const row=(await tx.query('SELECT v.* FROM project_assets pa JOIN assets a ON a.id=pa.asset_id JOIN asset_versions v ON v.asset_id=a.id WHERE pa.project_id=$1 AND a.id=$2 AND v.id=$3 AND pa.revoked_at IS NULL AND a.deleted_at IS NULL FOR SHARE OF pa,a,v',[manifest.projectId,item.assetId,item.assetVersionId])).rows[0];
  if(!row||row.sha256!==item.sha256||Number(row.bytes)!==item.size||row.object_key!==item.objectKey||row.bucket!==item.bucket)throw new HttpError(403,'MATERIAL_REVOKED','项目素材授权已撤销或内容身份不匹配');
 }
}
export type R2SigningInput={accountId:string,endpoint:string,parentAccessKeyId:string,parentSecretAccessKey:string,bucket:string,prefixes:string[],ttlSeconds?:number,now?:number};
export function signR2ReadOnly(input:R2SigningInput) {
 const endpoint=new URL(input.endpoint),ttl=input.ttlSeconds??900,now=input.now??Math.floor(Date.now()/1000);
 const host=`${input.accountId}.r2.cloudflarestorage.com`;
 if(endpoint.protocol!=='https:'||endpoint.host!==host||!['','/'].includes(endpoint.pathname)||endpoint.search||endpoint.hash||endpoint.username||endpoint.password)throw new Error('Invalid R2 account endpoint');
 if(!input.accountId||!input.parentAccessKeyId||!input.parentSecretAccessKey||!input.bucket||!Number.isInteger(ttl)||ttl<=0||ttl>604800||!input.prefixes.length||input.prefixes.some(p=>!p||p.startsWith('/')||p.split('/').includes('..')))throw new Error('Invalid scoped R2 credential configuration');
 const claims={sub:input.accountId,iss:input.parentAccessKeyId,aud:host,iat:now,exp:now+ttl,bucket:input.bucket,scope:'object-read-only',paths:{prefixPaths:input.prefixes,objectPaths:[]}};
 const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
 const message=`${encode({alg:'HS256',typ:'JWT'})}.${encode(claims)}`;
 const jwt=`${message}.${createHmac('sha256',input.parentSecretAccessKey).update(message).digest('base64url')}`;
 return {accessKeyId:input.parentAccessKeyId,secretAccessKey:createHash('sha256').update(jwt).digest('hex'),sessionToken:Buffer.from(`jwt/${jwt}`).toString('base64'),ttlSeconds:ttl,expiresAt:new Date((now+ttl)*1000).toISOString()};
}
export type MaterialPreparationOptions={signal?:AbortSignal,deadlineAt?:number,maxPublishBytes?:number};
export function materialPreparationBudget(options:MaterialPreparationOptions={}){
 const deadline=Math.min(options.deadlineAt??Infinity,Date.now()+120000),limit=options.maxPublishBytes??2*1024*1024*1024;
 if(!Number.isSafeInteger(limit)||limit<0||!Number.isFinite(deadline))throw new Error('Invalid material preparation budget');
 options.signal?.throwIfAborted();
 if(deadline<=Date.now())throw new Error('Material preparation deadline expired');
 const timeout=AbortSignal.timeout(Math.max(1,Math.floor(deadline-Date.now()))),signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
 let published=0;
 return {signal,check:()=>signal.throwIfAborted(),charge:(bytes:number)=>{signal.throwIfAborted();if(!Number.isSafeInteger(bytes)||bytes<0||published+bytes>limit)throw new HttpError(413,'MATERIAL_PREPARATION_BUDGET','本轮素材准备超过发布字节预算');published+=bytes;},get publishedBytes(){return published;}};
}
export async function prepareProjectMaterialMount(workspaceId:string,projectId:string,attemptId:string,frozenManifest?:ProjectMaterialManifest,options:MaterialPreparationOptions={}) {
 const budget=materialPreparationBudget(options);
 if(!/^[a-zA-Z0-9-]+$/.test(attemptId)||!/^[a-zA-Z0-9-]+$/.test(projectId))throw new Error('Invalid material run identity');
 const manifest=await tenantTransaction(workspaceId,async tx=>{const value=frozenManifest||await freezeProjectMaterials(tx,projectId);if(value.projectId!==projectId)throw new Error('Material project mismatch');await authorizeFrozenMaterials(tx,value);return value;});
 budget.check();
 const prefix=`${workspaceId}/projects/${projectId}/content-pool/`;
 const accountId=new URL(config.s3Endpoint).hostname.match(/^([a-zA-Z0-9]+)\.r2\.cloudflarestorage\.com$/)?.[1];
 if(!accountId)throw new Error('Project material mount requires the configured private R2 account endpoint');
 for(const item of manifest.entries){
  budget.check();
  await tenantTransaction(workspaceId,tx=>authorizeFrozenMaterials(tx,{...manifest,entries:[item]}));
  let exists=false;
  try {const meta=await headObject(prefix+item.sha256,{signal:budget.signal});exists=meta.bytes===item.size&&meta.metadata?.sha256===item.sha256;}
  catch(error:any){if(error.$metadata?.httpStatusCode!==404&&error.name!=='NotFound'&&error.name!=='NoSuchKey')throw error;}
  if(!exists){
   budget.charge(item.size);
   const data=await getObject(item.objectKey,{bucket:item.bucket,maxBytes:100*1024*1024,signal:budget.signal});
   if(data.bytes.length!==item.size||createHash('sha256').update(data.bytes).digest('hex')!==item.sha256)throw new Error('Material source integrity check failed');
   budget.check();await tenantTransaction(workspaceId,tx=>authorizeFrozenMaterials(tx,{...manifest,entries:[item]}));budget.check();
   try{await putObject(prefix+item.sha256,data.bytes,'application/octet-stream',{ifAbsent:true,sha256:item.sha256,signal:budget.signal});}
   catch(error:any){if(error.$metadata?.httpStatusCode!==412)throw error;}
  }
 }
 budget.check();await tenantTransaction(workspaceId,tx=>authorizeFrozenMaterials(tx,manifest));budget.check();
 const matfsManifest={version:1,entries:manifest.entries.map(({path,size,sha256})=>({path,size,sha256}))};
 const manifestBytes=gzipSync(Buffer.from(JSON.stringify(matfsManifest)));budget.check();
 const credentials=signR2ReadOnly({accountId,endpoint:config.s3Endpoint,parentAccessKeyId:config.s3AccessKey,parentSecretAccessKey:config.s3SecretKey,bucket:config.s3Bucket,prefixes:[prefix],ttlSeconds:900});
 return {manifest,manifestBytes,prefix,bucket:config.s3Bucket,endpoint:config.s3Endpoint,region:'auto',credentials,readBudgetBytes:2*1024*1024*1024};
}
