import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../../server-infra/src/config.js';
import { tenantTransaction, type Tx } from '../../server-infra/src/db.js';
import { getObject, putObject, headObject, copyObject, signedUpload, ensureUploadStorage, stagingBucket } from '../../server-infra/src/storage.js';
import { id, HttpError, notFound, emit, assetDto } from './common.js';
import { createJob } from './jobs.js';

export const supportedImageTypes = ['image/png','image/jpeg','image/webp','image/gif'] as const;
export const uploadSchema = z.object({ filename:z.string().min(1).max(240), mime:z.enum(supportedImageTypes), bytes:z.number().int().positive().max(config.maxUploadBytes), sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(), projectId:z.string().uuid().optional() });
const digest = (bytes:Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function activeProject(tx:Tx, projectId:string) {
  const project=(await tx.query('SELECT id FROM projects WHERE id=$1 AND deleted_at IS NULL FOR SHARE',[projectId])).rows[0];
  if(!project)notFound(); return project;
}
export function versionUrl(assetId:string,versionId:string,variant='file') { return `/api/assets/${assetId}/versions/${versionId}/${variant}`; }
export function assetVersionDto(row:any) {
  return { id:row.id,assetId:row.asset_id,versionId:row.id,bytes:Number(row.bytes),sha256:row.sha256,mime:row.mime,width:row.width,height:row.height,source:row.source,createdAt:row.created_at,image:versionUrl(row.asset_id,row.id),thumbnail:versionUrl(row.asset_id,row.id,'thumbnail') };
}
export async function registerCandidate(tx:Tx,workspaceId:string,bucket:string,key:string,purpose:string) {
  await tx.query('INSERT INTO storage_candidates(workspace_id,bucket,object_key,purpose) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[workspaceId,bucket,key,purpose]);
}
export async function assertCandidateAvailable(tx:Tx,bucket:string,key:string) {
  if(!(await tx.query('SELECT 1 FROM storage_candidates WHERE bucket=$1 AND object_key=$2 FOR SHARE',[bucket,key])).rowCount)throw new Error('Stored output expired before publication');
}
export async function linkProjectAsset(tx:Tx,workspaceId:string,projectId:string,assetId:string,versionId?:string) {
  await activeProject(tx,projectId);
  const asset=(await tx.query("SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL AND status='ready' FOR SHARE",[assetId])).rows[0];
  if(!asset)throw new HttpError(400,'INVALID_ASSET','素材不存在、无权访问或尚未就绪');
  const version=versionId?(await tx.query('SELECT * FROM asset_versions WHERE id=$1 AND asset_id=$2',[versionId,assetId])).rows[0]:null;
  if(versionId&&!version)notFound();
  await tx.query('INSERT INTO project_assets(workspace_id,project_id,asset_id,version_id) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,asset_id) DO UPDATE SET version_id=EXCLUDED.version_id,revoked_at=NULL',[workspaceId,projectId,assetId,versionId||null]);
  await emit(tx,workspaceId,'asset.linked',{projectId,assetId,assetVersionId:versionId||asset.current_version_id});
  return assetDto({...asset,...(version?{bytes:version.bytes,mime:version.mime,width:version.width,height:version.height}:{}),current_version_id:versionId||asset.current_version_id});
}
function uploadDto(row:any,asset?:any) { return {id:row.id,assetId:row.asset_id,projectId:row.project_id,status:row.status,expiresAt:row.expires_at,error:row.error,jobId:row.job_id,asset:asset?assetDto(asset):undefined}; }
export async function getUpload(workspaceId:string,uploadId:string) {
  return tenantTransaction(workspaceId,async tx=>{
    let row=(await tx.query('SELECT * FROM upload_sessions WHERE id=$1',[uploadId])).rows[0];if(!row)notFound();
    if(row.status==='uploading'&&new Date(row.expires_at).getTime()<Date.now()){
      row=(await tx.query("UPDATE upload_sessions SET status='expired',error='上传会话已过期' WHERE id=$1 AND status='uploading' RETURNING *",[uploadId])).rows[0]||row;
      if(row.status==='expired')await tx.query("UPDATE assets SET status='failed',error='上传会话已过期' WHERE id=$1 AND status='pending'",[row.asset_id]);
    }
    const asset=(await tx.query('SELECT * FROM assets WHERE id=$1',[row.asset_id])).rows[0];
    return uploadDto(row,asset);
  });
}
export async function createUpload(workspaceId:string,input:unknown) {
  const data=uploadSchema.parse(input),uploadId=id(),assetId=id(),key=`${workspaceId}/uploads/${uploadId}/incoming`,expiresAt=new Date(Date.now()+600000);
  await ensureUploadStorage();
  const result=await tenantTransaction(workspaceId,async tx=>{
    if(data.projectId)await activeProject(tx,data.projectId);
    await tx.query('INSERT INTO assets(id,workspace_id,title,mime,bytes,object_key) VALUES($1,$2,$3,$4,$5,$6)',[assetId,workspaceId,data.filename.replace(/\.[^.]+$/,'').slice(0,200)||'上传素材',data.mime,data.bytes,key]);
    const row=(await tx.query('INSERT INTO upload_sessions(id,workspace_id,asset_id,project_id,staging_bucket,staging_key,filename,mime,expected_bytes,expected_sha256,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',[uploadId,workspaceId,assetId,data.projectId||null,stagingBucket(),key,data.filename,data.mime,data.bytes,data.sha256||null,expiresAt])).rows[0];
    await registerCandidate(tx,workspaceId,stagingBucket(),key,'upload'); return uploadDto(row);
  });
  const url=await signedUpload(key,data.mime,data.bytes);
  return {...result,upload:{url,method:'PUT',headers:{'Content-Type':data.mime}}};
}
export async function completeUpload(workspaceId:string,uploadId:string) {
  const session=await tenantTransaction(workspaceId,async tx=>{
    const row=(await tx.query('SELECT * FROM upload_sessions WHERE id=$1',[uploadId])).rows[0];if(!row)notFound();return row;
  });
  if(session.status!=='uploading')return getUpload(workspaceId,uploadId);
  if(new Date(session.expires_at).getTime()<Date.now()) {
    await tenantTransaction(workspaceId,tx=>tx.query("UPDATE upload_sessions SET status='expired',error='上传会话已过期' WHERE id=$1 AND status='uploading'",[uploadId]));
    throw new HttpError(410,'UPLOAD_EXPIRED','上传会话已过期，请重新上传');
  }
  let meta:{bytes:number,contentType:string,etag?:string};
  try {
    meta=await headObject(session.staging_key,{bucket:session.staging_bucket});
    if(meta.bytes!==Number(session.expected_bytes))throw new HttpError(400,'UPLOAD_SIZE_MISMATCH','上传大小与声明不一致');
  }catch(error:any){ if(error.name==='NoSuchKey'||error.name==='NotFound'||error.$metadata?.httpStatusCode===404)throw new HttpError(409,'UPLOAD_MISSING','文件尚未上传完成');throw error; }
  // Storage-side conditional copy freezes the uploaded object without routing media
  // bytes through the API. The media worker verifies SHA-256 and actual format.
  const frozenKey=`${workspaceId}/uploads/${uploadId}/frozen/${id()}`;
  await tenantTransaction(workspaceId,tx=>registerCandidate(tx,workspaceId,session.staging_bucket,frozenKey,'upload-snapshot'));
  try{await copyObject(session.staging_key,frozenKey,{sourceBucket:session.staging_bucket,bucket:session.staging_bucket,sourceEtag:meta.etag});}
  catch(error:any){if(error.$metadata?.httpStatusCode===412)throw new HttpError(409,'UPLOAD_CHANGED','上传内容已变化，请重新确认完成');throw error;}
  await tenantTransaction(workspaceId,async tx=>{
    const current=(await tx.query('SELECT * FROM upload_sessions WHERE id=$1 FOR UPDATE',[uploadId])).rows[0];
    if(current.status!=='uploading')return;
    await assertCandidateAvailable(tx,current.staging_bucket,frozenKey);
    if(current.project_id)await activeProject(tx,current.project_id);
    const asset=(await tx.query('SELECT id FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[current.asset_id])).rows[0];if(!asset)notFound();
    const job=await createJob(tx,workspaceId,'media.ingest',{assetId:current.asset_id,uploadId,sourceKey:frozenKey,sourceBucket:current.staging_bucket,expectedSha256:current.expected_sha256||undefined,mime:current.mime},current.project_id);
    await tx.query("UPDATE upload_sessions SET status='processing',job_id=$2,completed_at=now() WHERE id=$1",[uploadId,job.id]);
    await emit(tx,workspaceId,'asset.processing',{assetId:current.asset_id,projectId:current.project_id,uploadId});
  });
  return getUpload(workspaceId,uploadId);
}
export type IngestedAsset={assetId:string,assetVersionId:string,image:string,thumbnail:string,width:number,height:number,bytes:number,sha256:string};
export type IngestInput={assetId?:string,bytes:Buffer,mime:string,title:string,source:Record<string,unknown>,projectId?:string,attemptId:string,expectedSha256?:string};
function ingested(row:any):IngestedAsset { return {assetId:row.asset_id,assetVersionId:row.id,image:versionUrl(row.asset_id,row.id),thumbnail:versionUrl(row.asset_id,row.id,'thumbnail'),width:row.width,height:row.height,bytes:Number(row.bytes),sha256:row.sha256}; }
export async function ingestBufferAsset(workspaceId:string,input:IngestInput,authorize?:(tx:Tx)=>Promise<void>,onCommitted?:(tx:Tx,result:IngestedAsset)=>Promise<void>):Promise<IngestedAsset> {
  const assetId=input.assetId||id();
  const previous=await tenantTransaction(workspaceId,async tx=>{if(authorize)await authorize(tx);const existing=(await tx.query('SELECT status,current_version_id FROM assets WHERE id=$1',[assetId])).rows[0];if(existing?.status==='ready'&&!existing.current_version_id)throw new HttpError(409,'MATERIAL_MIGRATION_REQUIRED','请先完成已有素材版本迁移');return (await tx.query("SELECT * FROM asset_versions WHERE asset_id=$1 AND source->>'attemptId'=$2",[assetId,input.attemptId])).rows[0];});
  if(previous)return tenantTransaction(workspaceId,async tx=>{if(authorize)await authorize(tx);const result=ingested(previous);if(onCommitted)await onCommitted(tx,result);return result;});
  if(input.bytes.length>64*1024*1024)throw new HttpError(413,'MEDIA_TOO_LARGE','图片超过媒体处理预算');
  if(input.expectedSha256&&digest(input.bytes)!==input.expectedSha256)throw new HttpError(400,'MEDIA_INTEGRITY','图片内容校验失败');
  const pipeline=sharp(input.bytes,{limitInputPixels:40000000,animated:false}).rotate();
  const metadata=await pipeline.metadata();
  const formatMime:Record<string,string>={jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif'};
  if(!metadata.width||!metadata.height||!metadata.format||!formatMime[metadata.format])throw new HttpError(400,'UNSUPPORTED_MEDIA','无法解码支持的图片格式');
  if(formatMime[metadata.format]!==input.mime)throw new HttpError(400,'MEDIA_TYPE_MISMATCH','图片内容与声明格式不一致');
  const normal=await pipeline.clone().png().toBuffer({resolveWithObject:true});
  if(normal.data.length>100*1024*1024)throw new HttpError(413,'MEDIA_TOO_LARGE','标准化图片超过存储预算');
  const thumbnail=await pipeline.clone().resize({width:256,height:256,fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer();
  const versionId=id(),prefix=`${workspaceId}/assets/${assetId}/versions/${versionId}`,key=`${prefix}/original.png`,thumbKey=`${prefix}/thumbnail.webp`,sha256=digest(normal.data);
  await tenantTransaction(workspaceId,async tx=>{if(authorize)await authorize(tx);await registerCandidate(tx,workspaceId,config.s3Bucket,key,'media');await registerCandidate(tx,workspaceId,config.s3Bucket,thumbKey,'media');});
  await putObject(key,normal.data,'image/png',{ifAbsent:true,sha256});
  await putObject(thumbKey,thumbnail,'image/webp',{ifAbsent:true});
  return tenantTransaction(workspaceId,async tx=>{
    if(authorize)await authorize(tx);
    if(input.projectId)await activeProject(tx,input.projectId);
    // Serializes concurrent redelivery for the same asset, including initial insert.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`asset:${workspaceId}:${assetId}`]);
    const duplicate=(await tx.query("SELECT * FROM asset_versions WHERE asset_id=$1 AND source->>'attemptId'=$2",[assetId,input.attemptId])).rows[0];
    if(duplicate){const result=ingested(duplicate);if(onCommitted)await onCommitted(tx,result);return result;}
    const existing=(await tx.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE',[assetId])).rows[0];
    if(existing?.deleted_at)throw new HttpError(409,'ASSET_DELETED','素材已删除');
    if(!existing)await tx.query("INSERT INTO assets(id,workspace_id,title,mime,bytes,object_key) VALUES($1,$2,$3,'image/png',$4,$5)",[assetId,workspaceId,input.title.slice(0,200)||'创作素材',normal.data.length,key]);
    await assertCandidateAvailable(tx,config.s3Bucket,key);await assertCandidateAvailable(tx,config.s3Bucket,thumbKey);
    const version=(await tx.query('INSERT INTO asset_versions(id,workspace_id,asset_id,object_key,thumbnail_key,bucket,bytes,sha256,mime,width,height,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[versionId,workspaceId,assetId,key,thumbKey,config.s3Bucket,normal.data.length,sha256,'image/png',normal.info.width,normal.info.height,JSON.stringify({...input.source,attemptId:input.attemptId})])).rows[0];
    const row=(await tx.query("UPDATE assets SET status='ready',current_version_id=$2,object_key=$3,thumbnail_key=$4,mime='image/png',bytes=$5,width=$6,height=$7,error=NULL,storage_bucket=$8 WHERE id=$1 RETURNING *",[assetId,versionId,key,thumbKey,normal.data.length,normal.info.width,normal.info.height,config.s3Bucket])).rows[0];
    if(input.projectId)await linkProjectAsset(tx,workspaceId,input.projectId,assetId);
    const result=ingested(version);if(onCommitted)await onCommitted(tx,result);
    await emit(tx,workspaceId,'asset.ready',{...assetDto(row),projectId:input.projectId});return result;
  });
}
