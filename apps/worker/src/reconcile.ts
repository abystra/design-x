import { pool,tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { startQueue } from '../../../packages/server-infra/src/queue.js';
import { updateJob } from '../../../packages/server-domain/src/jobs.js';
import { cleanupImportStaging } from './import-project.js';
// Lease expiry is managed by pg-boss. Reconcile business status after the final expired/failed delivery.
export async function reconcileJobs(){
 const boss=await startQueue();
 const workspaces=(await pool.query('SELECT id FROM workspaces')).rows;
 for(const workspace of workspaces){
  const jobs=await tenantTransaction(workspace.id,async tx=>(await tx.query("SELECT * FROM jobs WHERE status IN ('queued','running') AND updated_at<now()-interval '30 seconds' ORDER BY updated_at LIMIT 100")).rows);
  for(const job of jobs){
   const queueJob=await boss.getJobById(job.kind,job.queue_id);
   if(queueJob?.state==='failed'||queueJob?.state==='cancelled')await updateJob(workspace.id,job.id,{status:'failed',error:'后台执行已中断，可重新尝试'},job.execution_token);
   else if(!queueJob&&Date.now()-new Date(job.updated_at).getTime()>5*60000)await updateJob(workspace.id,job.id,{status:'failed',error:'任务投递记录已失效，请重新尝试'},job.execution_token);
  }
  // A killed process cannot execute its catch/finally cleanup. The durable manifest
  // lets a later worker reclaim only abandoned attempt objects after queue settlement.
  const imports=await tenantTransaction(workspace.id,async tx=>(await tx.query("SELECT * FROM jobs WHERE kind='project.import' AND status IN ('failed','cancelled') AND updated_at<now()-interval '30 seconds' AND jsonb_array_length(COALESCE(payload->'importStaging','[]'::jsonb))>0 LIMIT 100")).rows);
  for(const job of imports){
   const queueJob=await boss.getJobById(job.kind,job.queue_id);
   if(queueJob&&!['failed','cancelled','completed'].includes(queueJob.state))continue;
   await cleanupImportStaging(workspace.id,job.id,job.payload.importStaging);
   await tenantTransaction(workspace.id,async tx=>{
    await tx.query("UPDATE jobs SET payload=jsonb_set(payload,'{importStaging}','[]'::jsonb) WHERE id=$1 AND status IN ('failed','cancelled') AND execution_token IS NOT DISTINCT FROM $2",[job.id,job.execution_token]);
   });
  }
 }
}
