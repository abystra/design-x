import type { FastifyInstance } from 'fastify';
import { tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { config } from '../../../packages/server-infra/src/config.js';
import { putObject,getObject,deleteObject,ensureBucket } from '../../../packages/server-infra/src/storage.js';
import { createJob } from '../../../packages/server-domain/src/jobs.js';
import { id,assetDto,HttpError,notFound,emit,jobDto } from '../../../packages/server-domain/src/common.js';
export async function mediaRoutes(app:FastifyInstance) {
 app.get('/api/assets',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>(await tx.query('SELECT * FROM assets WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1000')).rows.map(assetDto)));
 app.post('/api/assets',async(req:any,reply)=>{
  const file=await req.file();if(!file)throw new HttpError(400,'FILE_REQUIRED','请选择图片');
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.mimetype))throw new HttpError(400,'UNSUPPORTED_TYPE','支持 PNG、JPG、WebP、GIF');
  const bytes=await file.toBuffer();if(bytes.length>config.maxUploadBytes)throw new HttpError(413,'PAYLOAD_TOO_LARGE','文件不能超过 10 MB');
  const assetId=id(),workspaceId=req.identity.workspace.id,objectKey=`${workspaceId}/uploads/${assetId}`;
  await ensureBucket();await putObject(objectKey,bytes,file.mimetype);
  try{
   const asset=await tenantTransaction(workspaceId,async tx=>{
    const row=(await tx.query('INSERT INTO assets(id,workspace_id,title,mime,bytes,object_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[assetId,workspaceId,file.filename.replace(/\.[^.]+$/,'').slice(0,200)||'上传素材',file.mimetype,bytes.length,objectKey])).rows[0];
    await createJob(tx,workspaceId,'media.ingest',{assetId});return assetDto(row);
   });
   reply.code(202);return asset;
  }catch(error){await deleteObject(objectKey).catch(()=>{});throw error;}
 });
 for(const variant of ['file','thumbnail'])app.get(`/api/assets/:id/${variant}`,async(req:any,reply)=>{
  const asset=await tenantTransaction(req.identity.workspace.id,async tx=>(await tx.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL',[req.params.id])).rows[0]);
  if(!asset)notFound();if(asset.status!=='ready')throw new HttpError(409,'ASSET_NOT_READY',asset.error||'素材仍在处理');
  const object=await getObject(variant==='thumbnail'?asset.thumbnail_key||asset.object_key:asset.object_key);
  reply.header('Cache-Control','private,max-age=60');reply.type(object.contentType);return object.bytes;
 });
 app.delete('/api/assets/:id',async(req:any)=>tenantTransaction(req.identity.workspace.id,async tx=>{
  const row=(await tx.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[req.params.id])).rows[0];if(!row)notFound();
  if((await tx.query('SELECT 1 FROM asset_refs WHERE asset_id=$1 LIMIT 1',[row.id])).rowCount)throw new HttpError(409,'ASSET_IN_USE','素材仍被设计引用，请先在设计中移除');
  if((await tx.query("SELECT 1 FROM document_versions v, jsonb_array_elements(v.content->'nodes') node WHERE node->>'src' IN ($1,$2) LIMIT 1",[`/api/assets/${row.id}/file`,`/api/assets/${row.id}/thumbnail`])).rowCount)throw new HttpError(409,'ASSET_IN_USE','素材仍被历史版本引用，请保留以便恢复');
  if((await tx.query("SELECT 1 FROM preferences WHERE value::text LIKE $1 LIMIT 1",[`%/api/assets/${row.id}/%`])).rowCount)throw new HttpError(409,'ASSET_IN_USE','素材仍用于品牌套件或创作参考');
  if((await tx.query("SELECT 1 FROM documents WHERE kind='board' AND content::text LIKE $1 LIMIT 1",[`%/api/assets/${row.id}/%`])).rowCount)throw new HttpError(409,'ASSET_IN_USE','素材仍被工作区引用');
  // Keep bytes available for historical versions; retention/GC can reclaim unreferenced deleted objects later.
  const cancelled=(await tx.query("UPDATE jobs SET status='cancelled',updated_at=now() WHERE kind='media.ingest' AND payload->>'assetId'=$1 AND status IN ('queued','running') RETURNING *",[row.id])).rows;
  for(const job of cancelled)await emit(tx,req.identity.workspace.id,'job.updated',jobDto(job));
  await tx.query('UPDATE assets SET deleted_at=now() WHERE id=$1',[row.id]);await emit(tx,req.identity.workspace.id,'asset.deleted',{assetId:row.id});return {ok:true};
 }));
}
