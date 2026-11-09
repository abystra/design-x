import { config } from '../../server-infra/src/config.js';
import { tenantTransaction, type Tx } from '../../server-infra/src/db.js';
import { sendInTransaction } from '../../server-infra/src/queue.js';
import { id,emit,jobDto } from './common.js';
export async function createJob(tx:Tx,workspaceId:string,kind:string,payload:unknown,projectId?:string) {
 const jobId=id(),queueId=id();
 const row=(await tx.query('INSERT INTO jobs(id,workspace_id,project_id,kind,payload,queue_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[jobId,workspaceId,projectId||null,kind,JSON.stringify(payload),queueId])).rows[0];
 await sendInTransaction(tx,kind,{jobId,workspaceId},queueId);
 await emit(tx,workspaceId,'job.updated',jobDto(row));return jobDto(row);
}
export async function updateJob(workspaceId:string,jobId:string,patch:{status?:string,progress?:number,error?:string|null,result?:any},executionToken?:string) {
 return tenantTransaction(workspaceId,async tx=>{
  const current=(await tx.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];
  if(!current||current.status==='cancelled'||current.status==='succeeded'||(executionToken&&current.execution_token!==executionToken))return current;
  if(patch.status==='succeeded'&&patch.result?.objectKey){
   const candidate=await tx.query('SELECT 1 FROM storage_candidates WHERE bucket=$1 AND object_key=$2 FOR SHARE',[patch.result.storageBucket||config.s3Bucket,patch.result.objectKey]);
   if(!candidate.rowCount)throw new Error('成果对象已过期，请重新执行导出');
  }
  const row=(await tx.query('UPDATE jobs SET status=$1,progress=$2,error=$3,result=$4,updated_at=now() WHERE id=$5 RETURNING *',[patch.status||current.status,patch.progress??current.progress,patch.error===undefined?current.error:patch.error,JSON.stringify(patch.result??current.result),jobId])).rows[0];
  await emit(tx,workspaceId,'job.updated',jobDto(row));return row;
 });
}
