import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { config } from '../../../packages/server-infra/src/config.js';
import { putObject,openObject,legacyReadBucket } from '../../../packages/server-infra/src/storage.js';
import { assetDto,HttpError,notFound,emit,jobDto } from '../../../packages/server-domain/src/common.js';
import { createUpload,completeUpload,getUpload,assetVersionDto,linkProjectAsset,activeProject,supportedImageTypes } from '../../../packages/server-domain/src/assets.js';

export async function mediaRoutes(app:FastifyInstance) {
 app.get('/api/assets',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>(await tx.query('SELECT * FROM assets WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1000')).rows.map(assetDto)));
 app.post('/api/uploads',async(req:any,reply)=>{
  if(!config.storageDirectUploadsEnabled)throw new HttpError(503,'DIRECT_UPLOAD_DISABLED','直传暂未启用');
  reply.code(201);return createUpload(req.identity.workspace.id,req.body);
 });
 app.get('/api/uploads/:id',async(req:any)=>getUpload(req.identity.workspace.id,req.params.id));
 app.post('/api/uploads/:id/complete',async(req:any,reply)=>{reply.code(202);return completeUpload(req.identity.workspace.id,req.params.id);});
 // Compatibility path for existing clients. New clients use signed staging PUT.
 app.post('/api/assets',async(req:any,reply)=>{
  const file=await req.file();if(!file)throw new HttpError(400,'FILE_REQUIRED','请选择图片');
  if(!(supportedImageTypes as readonly string[]).includes(file.mimetype))throw new HttpError(400,'UNSUPPORTED_TYPE','支持 PNG、JPG、WebP、GIF');
  const bytes=await file.toBuffer();if(bytes.length>config.maxUploadBytes)throw new HttpError(413,'PAYLOAD_TOO_LARGE','文件不能超过 10 MB');
  const workspaceId=req.identity.workspace.id,upload=await createUpload(workspaceId,{filename:file.filename,mime:file.mimetype,bytes:bytes.length});
  const session=await tenantTransaction(workspaceId,async tx=>(await tx.query('SELECT staging_bucket,staging_key FROM upload_sessions WHERE id=$1',[upload.id])).rows[0]);
  await putObject(session.staging_key,bytes,file.mimetype,{bucket:session.staging_bucket});
  const result=await completeUpload(workspaceId,upload.id);reply.code(202);return result.asset;
 });
 app.get('/api/assets/:id/versions',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  if(!(await tx.query('SELECT 1 FROM assets WHERE id=$1 AND deleted_at IS NULL',[req.params.id])).rowCount)notFound();
  return (await tx.query('SELECT * FROM asset_versions WHERE asset_id=$1 ORDER BY created_at DESC',[req.params.id])).rows.map(assetVersionDto);
 }));
 for(const immutable of [false,true])for(const variant of ['file','thumbnail'])app.get(immutable?`/api/assets/:id/versions/:versionId/${variant}`:`/api/assets/:id/${variant}`,async(req:any,reply)=>{
  const asset=await tenantTransaction(req.identity.workspace.id,async tx=>{
   const row=(await tx.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL',[req.params.id])).rows[0];if(!row)notFound();
   if(immutable){const version=(await tx.query('SELECT * FROM asset_versions WHERE id=$1 AND asset_id=$2',[req.params.versionId,row.id])).rows[0];if(!version)notFound();return {...row,...version,status:'ready'};}
   const baseline=row.current_version_id?(await tx.query('SELECT * FROM asset_versions WHERE asset_id=$1 ORDER BY created_at,id LIMIT 1',[row.id])).rows[0]:null;
   return baseline?{...row,...baseline,status:'ready'}:{...row,bucket:row.storage_bucket||legacyReadBucket()};
  });
  if(asset.status!=='ready')throw new HttpError(409,'ASSET_NOT_READY',asset.error||'素材仍在处理');
  const object=await openObject(variant==='thumbnail'?asset.thumbnail_key||asset.object_key:asset.object_key,{bucket:asset.bucket});
  // Permission is evaluated for every GET; never expose private material via a public CDN URL.
  reply.header('Cache-Control','private,max-age=60');reply.type(object.contentType);return object.stream;
 });
 app.get('/api/projects/:id/assets',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  await activeProject(tx,req.params.id);
  return (await tx.query('SELECT a.*,COALESCE(pa.version_id,a.current_version_id) AS current_version_id,COALESCE(v.bytes,a.bytes) AS bytes,COALESCE(v.width,a.width) AS width,COALESCE(v.height,a.height) AS height FROM project_assets pa JOIN assets a ON a.id=pa.asset_id LEFT JOIN asset_versions v ON v.id=COALESCE(pa.version_id,a.current_version_id) WHERE pa.project_id=$1 AND pa.revoked_at IS NULL AND a.deleted_at IS NULL ORDER BY pa.created_at DESC',[req.params.id])).rows.map(assetDto);
 }));
 app.post('/api/projects/:id/assets',async(req:any)=>{
  const data=z.object({assetId:z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),versionId:z.string().uuid().optional()}).parse(req.body);
  return tenantTransaction(req.identity.workspace.id,tx=>linkProjectAsset(tx,req.identity.workspace.id,req.params.id,data.assetId,data.versionId));
 });
 app.delete('/api/projects/:id/assets/:assetId',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  await activeProject(tx,req.params.id);
  await tx.query('UPDATE project_assets SET revoked_at=now() WHERE project_id=$1 AND asset_id=$2',[req.params.id,req.params.assetId]);
  await emit(tx,req.identity.workspace.id,'asset.revoked',{projectId:req.params.id,assetId:req.params.assetId});return {ok:true};
 }));
 app.delete('/api/assets/:id',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const row=(await tx.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[req.params.id])).rows[0];if(!row)notFound();
  if((await tx.query('SELECT 1 FROM asset_refs WHERE asset_id=$1 LIMIT 1',[row.id])).rowCount)throw new HttpError(409,'ASSET_IN_USE','素材仍被设计引用，请先在设计中移除');
  if((await tx.query('SELECT 1 FROM generation_inputs WHERE asset_id=$1 UNION ALL SELECT 1 FROM generation_outputs WHERE asset_id=$1 LIMIT 1',[row.id])).rowCount)throw new HttpError(409,'ASSET_IN_USE','素材仍被创作历史引用；可以单独撤销项目关联');
  const needle=`%/api/assets/${row.id}/%`;
  if((await tx.query('SELECT 1 FROM document_versions WHERE content::text LIKE $1 LIMIT 1',[needle])).rowCount)throw new HttpError(409,'ASSET_IN_USE','素材仍被历史版本引用，请保留以便恢复');
  if((await tx.query('SELECT 1 FROM preferences WHERE value::text LIKE $1 LIMIT 1',[needle])).rowCount)throw new HttpError(409,'ASSET_IN_USE','素材仍用于品牌套件或创作参考');
  if((await tx.query("SELECT 1 FROM documents WHERE kind='board' AND content::text LIKE $1 LIMIT 1",[needle])).rowCount)throw new HttpError(409,'ASSET_IN_USE','素材仍被工作区引用');
  const cancelled=(await tx.query("UPDATE jobs SET status='cancelled',updated_at=now() WHERE kind='media.ingest' AND payload->>'assetId'=$1 AND status IN ('queued','running') RETURNING *",[row.id])).rows;
  for(const job of cancelled)await emit(tx,req.identity.workspace.id,'job.updated',jobDto(job));
  await tx.query("UPDATE upload_sessions SET status='failed',error='素材已删除' WHERE asset_id=$1 AND status IN ('uploading','processing')",[row.id]);
  await tx.query('UPDATE project_assets SET revoked_at=now() WHERE asset_id=$1',[row.id]);
  await tx.query('UPDATE assets SET deleted_at=now() WHERE id=$1',[row.id]);
  await emit(tx,req.identity.workspace.id,'asset.deleted',{assetId:row.id});return {ok:true};
 }));
}
