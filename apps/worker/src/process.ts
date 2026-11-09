import { tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { getObject,legacyReadBucket } from '../../../packages/server-infra/src/storage.js';
import { emit,assetDto,jobDto,id } from '../../../packages/server-domain/src/common.js';
import { ingestBufferAsset } from '../../../packages/server-domain/src/assets.js';
import { updateJob } from '../../../packages/server-domain/src/jobs.js';
export async function runBusinessJob(queueJob:any,handler:(job:any)=>Promise<any>){
 const {jobId,workspaceId}=queueJob.data;
 const job=await tenantTransaction(workspaceId,async tx=>{
  const row=(await tx.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];
  if(!row||row.queue_id!==queueJob.id||['cancelled','succeeded'].includes(row.status)||(row.kind==='ai.turn'&&row.status==='failed'))return null;
  const updated=(await tx.query("UPDATE jobs SET status='running',progress=5,error=NULL,attempts=attempts+1,execution_token=$2,updated_at=now() WHERE id=$1 RETURNING *",[jobId,id()])).rows[0];
  await emit(tx,workspaceId,'job.updated',jobDto(updated));return updated;
 });
 if(!job)return;
 try{
  const result=await handler(job);
  await updateJob(workspaceId,jobId,{status:'succeeded',progress:100,error:null,result},job.execution_token);
  return result;
 }catch(error:any){
  if(job.kind==='ai.turn'&&error.code==='EXECUTION_LEASE_LOST')throw error;
  await updateJob(workspaceId,jobId,{status:'failed',error:String(error.message||'任务处理失败').slice(0,500)},job.execution_token);
  if(job.kind==='media.ingest')await tenantTransaction(workspaceId,async tx=>{const active=(await tx.query('SELECT execution_token,status FROM jobs WHERE id=$1',[jobId])).rows[0];if(active?.execution_token!==job.execution_token||active?.status==='cancelled')return;await tx.query("UPDATE assets SET status='failed',error=$1 WHERE id=$2 AND status<>'ready'",[String(error.message).slice(0,500),job.payload.assetId]);if(job.payload.uploadId)await tx.query("UPDATE upload_sessions SET status='failed',error=$1 WHERE id=$2 AND status<>'ready'",[String(error.message).slice(0,500),job.payload.uploadId]);});
  throw error;
 }
}
export async function assertActive(job:any){
 const current=await tenantTransaction(job.workspace_id,async tx=>(await tx.query('SELECT status,queue_id,execution_token FROM jobs WHERE id=$1',[job.id])).rows[0]);
 if(!current||current.status==='cancelled'||current.queue_id!==job.queue_id||current.execution_token!==job.execution_token)throw new Error('任务已取消或已被新的执行替代');
}
export async function ingestAsset(job:any){
 const asset=await tenantTransaction(job.workspace_id,async tx=>(await tx.query('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL',[job.payload.assetId])).rows[0]);
 if(!asset)throw new Error('素材不存在');
 const raw=await getObject(job.payload.sourceKey||asset.object_key,{bucket:job.payload.sourceBucket||asset.storage_bucket||legacyReadBucket(),maxBytes:64*1024*1024});
 const authorize=async(tx:any)=>{
  const current=(await tx.query('SELECT status,queue_id,execution_token FROM jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
  if(current?.status!=='running'||current.queue_id!==job.queue_id||current.execution_token!==job.execution_token)throw new Error('任务已取消或已被新的执行替代');
  if(!(await tx.query('SELECT id FROM assets WHERE id=$1 AND deleted_at IS NULL',[asset.id])).rowCount)throw new Error('素材已删除');
 };
 const result=await ingestBufferAsset(job.workspace_id,{assetId:asset.id,bytes:raw.bytes,mime:job.payload.mime||asset.mime,title:asset.title,source:{kind:'upload',uploadId:job.payload.uploadId},projectId:job.project_id||undefined,attemptId:job.id,expectedSha256:job.payload.expectedSha256},authorize,async(tx)=>{
  if(job.payload.uploadId)await tx.query("UPDATE upload_sessions SET status='ready',error=NULL WHERE id=$1",[job.payload.uploadId]);
 });
 return result;
}
