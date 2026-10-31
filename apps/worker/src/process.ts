import sharp from 'sharp';
import { tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { getObject,putObject } from '../../../packages/server-infra/src/storage.js';
import { emit,assetDto,jobDto,id } from '../../../packages/server-domain/src/common.js';
import { updateJob } from '../../../packages/server-domain/src/jobs.js';
export async function runBusinessJob(queueJob:any,handler:(job:any)=>Promise<any>){
 const {jobId,workspaceId}=queueJob.data;
 const job=await tenantTransaction(workspaceId,async tx=>{
  const row=(await tx.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];
  if(!row||row.queue_id!==queueJob.id||['cancelled','succeeded'].includes(row.status))return null;
  const updated=(await tx.query("UPDATE jobs SET status='running',progress=5,error=NULL,attempts=attempts+1,execution_token=$2,updated_at=now() WHERE id=$1 RETURNING *",[jobId,id()])).rows[0];
  await emit(tx,workspaceId,'job.updated',jobDto(updated));return updated;
 });
 if(!job)return;
 try{
  const result=await handler(job);
  await updateJob(workspaceId,jobId,{status:'succeeded',progress:100,error:null,result},job.execution_token);
  return result;
 }catch(error:any){
  await updateJob(workspaceId,jobId,{status:'failed',error:String(error.message||'任务处理失败').slice(0,500)},job.execution_token);
  if(job.kind==='media.ingest')await tenantTransaction(workspaceId,async tx=>{const active=(await tx.query('SELECT execution_token,status FROM jobs WHERE id=$1',[jobId])).rows[0];if(active?.execution_token!==job.execution_token||active?.status==='cancelled')return;await tx.query("UPDATE assets SET status='failed',error=$1 WHERE id=$2 AND status<>'ready'",[String(error.message).slice(0,500),job.payload.assetId]);});
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
 const raw=await getObject(asset.object_key);
 const pipeline=sharp(raw.bytes,{limitInputPixels:40000000,animated:false}).rotate();
 const metadata=await pipeline.metadata();
 if(!metadata.width||!metadata.height)throw new Error('无法解码此图片');
 if(!['jpeg','png','webp','gif'].includes(metadata.format||''))throw new Error('图片内容与支持格式不匹配');
 await updateJob(job.workspace_id,job.id,{progress:35},job.execution_token);
 const normal=await pipeline.clone().png().toBuffer({resolveWithObject:true});
 const thumbnail=await pipeline.clone().resize({width:256,height:256,fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer();
 const key=`${job.workspace_id}/assets/${asset.id}/original.png`,thumbKey=`${job.workspace_id}/assets/${asset.id}/thumb.webp`;
 await assertActive(job);await putObject(key,normal.data,'image/png');await putObject(thumbKey,thumbnail,'image/webp');
 await updateJob(job.workspace_id,job.id,{progress:85},job.execution_token);
 await tenantTransaction(job.workspace_id,async tx=>{
  const current=(await tx.query('SELECT status,queue_id,execution_token FROM jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
  if(current.status==='cancelled'||current.queue_id!==job.queue_id||current.execution_token!==job.execution_token)throw new Error('任务已取消');
  const row=(await tx.query("UPDATE assets SET status='ready',object_key=$1,thumbnail_key=$2,mime='image/png',width=$3,height=$4,error=NULL WHERE id=$5 RETURNING *",[key,thumbKey,normal.info.width,normal.info.height,asset.id])).rows[0];
  await emit(tx,job.workspace_id,'asset.ready',assetDto(row));
 });
 return {assetId:asset.id,width:normal.info.width,height:normal.info.height};
}
