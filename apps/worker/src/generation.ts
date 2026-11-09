import { createHash } from 'node:crypto';
import type { Job } from 'pg-boss';
import { pool,tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { config } from '../../../packages/server-infra/src/config.js';
import { openaiImageProvider,ImageProviderError,priceImageUsage,type ImageProvider } from '../../../packages/server-infra/src/openai-images.js';
import { getObject,putObject,stagingBucket } from '../../../packages/server-infra/src/storage.js';
import { ingestBufferAsset,registerCandidate,assertCandidateAvailable } from '../../../packages/server-domain/src/assets.js';
import { authorizeGeneration,lockGenerationProject,reserveQuota,settleQuota,refreshGeneration } from '../../../packages/server-domain/src/generations.js';
import { placeGenerationOutput } from '../../../packages/server-domain/src/recipes.js';
import { createJob } from '../../../packages/server-domain/src/jobs.js';
import { emit,id,HttpError,jobDto } from '../../../packages/server-domain/src/common.js';

type Delivery={data:any;id:string};
export async function submitGeneration(delivery:Delivery,provider:ImageProvider=openaiImageProvider()){
 const {workspaceId,jobId}=delivery.data;let attempt:any;
 attempt=await tenantTransaction(workspaceId,async tx=>{
  await lockGenerationProject(tx,jobId);
  const a=(await tx.query('SELECT a.*,j.queue_id,j.status AS job_status FROM generation_attempts a JOIN jobs j ON j.id=a.id WHERE a.id=$1 FOR UPDATE OF a,j',[jobId])).rows[0];
  if(!a||a.queue_id!==delivery.id||a.execution_status!=='queued'||a.job_status==='cancelled')return null;
  const fence=id();await tx.query("UPDATE generation_attempts SET execution_status='checking',fence=$1,deadline_at=now()+($2*interval '1 millisecond'),updated_at=now() WHERE id=$3",[fence,config.imageTimeoutMs+60000,jobId]);
  await tx.query("UPDATE jobs SET status='running',execution_token=$1,attempts=attempts+1,updated_at=now() WHERE id=$2",[fence,jobId]);
  return {...a,fence};
 });
 if(!attempt)return;
 let submitting=false,received=false;
 try{
  const active=await tenantTransaction(workspaceId,tx=>authorizeGeneration(tx,jobId,attempt.fence));
  if(!await provider.moderate(active.snapshot.prompt))throw new HttpError(422,'MODERATION_REJECTED','创作描述未通过审核');
  const references=[];
  for(const ref of active.snapshot.references){
   const object=await getObject(ref.objectKey,{bucket:ref.bucket,maxBytes:config.maxUploadBytes});
   if(object.bytes.length!==ref.bytes||createHash('sha256').update(object.bytes).digest('hex')!==ref.sha256)throw new Error('参考素材校验失败');
   if(!await provider.moderate(active.snapshot.prompt,object.bytes))throw new HttpError(422,'MODERATION_REJECTED','参考图片未通过审核');
   references.push({bytes:object.bytes,mime:ref.mime});
  }
  await tenantTransaction(workspaceId,async tx=>{
   await authorizeGeneration(tx,jobId,attempt.fence,'submit');await reserveQuota(tx,workspaceId,jobId);
   await tx.query("UPDATE generation_attempts SET execution_status='submitting',submitted_at=now(),updated_at=now() WHERE id=$1",[jobId]);
   await tx.query('INSERT INTO provider_calls(id,workspace_id,attempt_id,model,endpoint) VALUES($1,$2,$3,$4,$5)',[id(),workspaceId,jobId,active.snapshot.model,references.length?'images.edits':'images.generations']);
   await refreshGeneration(tx,workspaceId,active.request_id);
  });
  submitting=true;
  const result=await provider.generate({workspaceId,prompt:active.snapshot.prompt,size:active.snapshot.size,quality:active.snapshot.quality,model:active.snapshot.model,references});
  received=true;
  // Bounded DB spool closes the model-return / R2 outage gap. Only ingestion reads it;
  // it is removed in the same transaction that records the staging object.
  await tenantTransaction(workspaceId,async tx=>{
   await lockGenerationProject(tx,jobId);
   const a=(await tx.query('SELECT * FROM generation_attempts WHERE id=$1 FOR UPDATE',[jobId])).rows[0];
   const cost=priceImageUsage(result.usage);
   await tx.query("UPDATE provider_calls SET status='received',request_id=$1,usage=$2,cost_usd=$3,cost_status=$4,completed_at=now() WHERE attempt_id=$5",[result.requestId,JSON.stringify(result.usage),cost.costUsd,cost.costStatus,jobId]);
   if(a.fence!==attempt.fence||a.execution_status!=='submitting')return;
   if(new Date(a.deadline_at).getTime()<=Date.now()){
    await tx.query("UPDATE generation_attempts SET execution_status='unknown',error='供应商结果迟到；已阻止业务提交，等待核对',updated_at=now() WHERE id=$1",[jobId]);
    await tx.query("UPDATE jobs SET status='failed',error='供应商结果迟到，等待核对',updated_at=now() WHERE id=$1",[jobId]);await refreshGeneration(tx,workspaceId,a.request_id);return;
   }
   const r=(await tx.query('SELECT r.cancel_requested,p.deleted_at FROM creative_requests r JOIN projects p ON p.id=r.project_id WHERE r.id=$1',[a.request_id])).rows[0];
   if(r.cancel_requested||r.deleted_at){await tx.query("UPDATE generation_attempts SET execution_status='cancelled',settled_at=now() WHERE id=$1",[jobId]);await settleQuota(tx,workspaceId,jobId,false);}
   else{
    const bytes=Buffer.from(result.encoded,'base64'),outputId=id();if(!bytes.length||bytes.length>32*1024*1024)throw new Error('生成图片超出媒体预算');
    await tx.query('INSERT INTO generation_outputs(id,workspace_id,request_id,attempt_id,encoded_result,bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[outputId,workspaceId,a.request_id,jobId,result.encoded,bytes.length,createHash('sha256').update(bytes).digest('hex')]);
    await tx.query("UPDATE generation_attempts SET execution_status='received',updated_at=now() WHERE id=$1",[jobId]);
    await createJob(tx,workspaceId,'generation.ingest',{outputId,attemptId:jobId,fence:attempt.fence},active.project_id);
   }
   await tx.query("UPDATE jobs SET status='succeeded',progress=100,updated_at=now() WHERE id=$1",[jobId]);
   await refreshGeneration(tx,workspaceId,a.request_id);
  });
 }catch(error){
  const unknown=submitting&&(!(error instanceof ImageProviderError)||error.acceptance==='unknown');
  await tenantTransaction(workspaceId,async tx=>{
   await lockGenerationProject(tx,jobId);
   const a=(await tx.query('SELECT * FROM generation_attempts WHERE id=$1 FOR UPDATE',[jobId])).rows[0];
   if(!a||a.fence!==attempt.fence||!['checking','submitting'].includes(a.execution_status))return;
   const message=error instanceof ImageProviderError||error instanceof HttpError?error.message:received?'供应商已返回，但结果持久化未确认；需要核对':unknown?'供应商受理结果未知；不会自动重发':'生成准备失败，请检查服务或素材后重新提交';
   await tx.query('UPDATE generation_attempts SET execution_status=$1,error=$2,updated_at=now() WHERE id=$3',[unknown?'unknown':'failed',message,jobId]);
   await tx.query('UPDATE provider_calls SET status=$1,request_id=COALESCE(request_id,$2) WHERE attempt_id=$3',[unknown?'unknown':'rejected',error instanceof ImageProviderError?error.requestId:null,jobId]);
   if(!unknown)await settleQuota(tx,workspaceId,jobId,false);
   await tx.query("UPDATE jobs SET status='failed',error=$1,updated_at=now() WHERE id=$2",[message,jobId]);await refreshGeneration(tx,workspaceId,a.request_id);
  });
 }
}

export async function ingestGeneration(job:any,provider:ImageProvider=openaiImageProvider()){
 const {outputId,attemptId,fence}=job.payload;
 let output=await tenantTransaction(job.workspace_id,async tx=>(await tx.query('SELECT * FROM generation_outputs WHERE id=$1',[outputId])).rows[0]);
 if(!output)throw new Error('生成产物不存在');if(output.state==='ready')return {outputId,assetId:output.asset_id};
 try{
  const active=await tenantTransaction(job.workspace_id,tx=>authorizeGeneration(tx,attemptId,fence));
  const bytes=output.staging_key?(await getObject(output.staging_key,{bucket:output.staging_bucket||process.env.LEGACY_S3_STAGING_BUCKET||stagingBucket(),maxBytes:32*1024*1024})).bytes:Buffer.from(output.encoded_result||'','base64');
  if(bytes.length!==Number(output.bytes)||createHash('sha256').update(bytes).digest('hex')!==output.sha256)throw new Error('生成产物摘要不一致');
  if(!output.staging_key){const key=`${job.workspace_id}/generations/${output.request_id}/${attemptId}/${output.id}.png`;await tenantTransaction(job.workspace_id,tx=>registerCandidate(tx,job.workspace_id,stagingBucket(),key,'generation'));
   try{await putObject(key,bytes,'image/png',{bucket:stagingBucket(),ifAbsent:true});}catch(error:any){if(error.$metadata?.httpStatusCode!==412)throw error;const existing=await getObject(key,{bucket:stagingBucket(),maxBytes:32*1024*1024});if(existing.bytes.length!==bytes.length||createHash('sha256').update(existing.bytes).digest('hex')!==output.sha256)throw new Error('暂存对象身份不匹配');}
   await tenantTransaction(job.workspace_id,async tx=>{await authorizeGeneration(tx,attemptId,fence);await assertCandidateAvailable(tx,stagingBucket(),key);await tx.query('UPDATE generation_outputs SET staging_key=$1,staging_bucket=$3,encoded_result=NULL,updated_at=now() WHERE id=$2',[key,outputId,stagingBucket()]);});output.staging_key=key;
  }
  if(!await provider.moderate(active.snapshot.prompt,bytes))throw new HttpError(422,'MODERATION_REJECTED','生成结果未通过审核');
  const assertCurrent=async(tx:any)=>{await authorizeGeneration(tx,attemptId,fence);const j=(await tx.query("SELECT id FROM jobs WHERE id=$1 AND execution_token=$2 AND status='running' FOR SHARE",[job.id,job.execution_token])).rowCount;if(!j)throw new HttpError(409,'GENERATION_INACTIVE','媒体任务执行权已失效');};
  const asset=await ingestBufferAsset(job.workspace_id,{assetId:`gen-${outputId}`,bytes,mime:'image/png',title:active.snapshot.prompt.slice(0,120),projectId:active.project_id,attemptId:outputId,source:{kind:'generation',generationId:output.request_id,attemptId,model:active.snapshot.model},expectedSha256:output.sha256},assertCurrent,async(tx,asset)=>{
   await tx.query("UPDATE generation_outputs SET state='ready',asset_id=$1,asset_version_id=$2,encoded_result=NULL,updated_at=now() WHERE id=$3",[asset.assetId,asset.assetVersionId,outputId]);
   await tx.query("UPDATE generation_attempts SET execution_status='succeeded',settled_at=now(),updated_at=now() WHERE id=$1",[attemptId]);
   await settleQuota(tx,job.workspace_id,attemptId,true);
   // Invalid/conflicting placement never loses the generated asset.
   await tx.query('SAVEPOINT generation_placement');
   try{await placeGenerationOutput(tx,job.workspace_id,active,output,asset);await tx.query('RELEASE SAVEPOINT generation_placement');}
   catch{await tx.query('ROLLBACK TO SAVEPOINT generation_placement');await tx.query("UPDATE generation_outputs SET placement_status='library',placement_reason='placement_conflict' WHERE id=$1",[outputId]);}
   await refreshGeneration(tx,job.workspace_id,output.request_id);
  });
  return {outputId,assetId:asset.assetId,assetVersionId:asset.assetVersionId};
 }catch(error){
  await tenantTransaction(job.workspace_id,async tx=>{
   await lockGenerationProject(tx,attemptId);
   const media=(await tx.query('SELECT execution_token,queue_id FROM jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];if(!media||media.execution_token!==job.execution_token||media.queue_id!==job.queue_id)return;
   const a=(await tx.query('SELECT * FROM generation_attempts WHERE id=$1 FOR UPDATE',[attemptId])).rows[0];if(!a||a.fence!==fence||a.execution_status==='succeeded')return;
   const terminal=error instanceof HttpError||job.attempts>=3;
   await tx.query('UPDATE generation_outputs SET state=$1,updated_at=now() WHERE id=$2',[terminal?'failed':'ingest_retry',outputId]);
   if(terminal){await tx.query("UPDATE generation_attempts SET execution_status='failed',error=$1,settled_at=now() WHERE id=$2",[error instanceof HttpError?error.message:'媒体摄取失败；可以单独重试摄取',attemptId]);await settleQuota(tx,job.workspace_id,attemptId,false);}
   await refreshGeneration(tx,job.workspace_id,a.request_id);
  });throw error;
 }
}

export async function reconcileGenerations(){
 for(const {id:workspaceId} of (await pool.query('SELECT id FROM workspaces')).rows){
  const expired=await tenantTransaction(workspaceId,async tx=>(await tx.query("SELECT id FROM generation_attempts WHERE execution_status IN ('checking','submitting') AND deadline_at<now() ORDER BY deadline_at LIMIT 100")).rows);
  for(const candidate of expired)await tenantTransaction(workspaceId,async tx=>{
   await lockGenerationProject(tx,candidate.id);
   const a=(await tx.query("SELECT * FROM generation_attempts WHERE id=$1 AND execution_status IN ('checking','submitting') AND deadline_at<now() FOR UPDATE",[candidate.id])).rows[0];if(!a)return;
   const unknown=a.execution_status==='submitting';await tx.query('UPDATE generation_attempts SET execution_status=$1,error=$2,updated_at=now() WHERE id=$3',[unknown?'unknown':'failed',unknown?'提交进程中断，受理结果待核对':'准备进程中断，未提交供应商',a.id]);
   await tx.query("UPDATE jobs SET status='failed',error='执行超时，已记录恢复状态',updated_at=now() WHERE id=$1",[a.id]);if(!unknown)await settleQuota(tx,workspaceId,a.id,false);await refreshGeneration(tx,workspaceId,a.request_id);
  });
  const holds=await tenantTransaction(workspaceId,async tx=>(await tx.query("SELECT q.attempt_id,a.request_id FROM quota_reservations q JOIN generation_attempts a ON a.id=q.attempt_id WHERE q.status='reserved' AND q.expires_at<now() AND a.execution_status='unknown' ORDER BY q.expires_at LIMIT 100")).rows);
  for(const q of holds)await tenantTransaction(workspaceId,async tx=>{
   await lockGenerationProject(tx,q.attempt_id);
   const active=await tx.query("SELECT 1 FROM quota_reservations q JOIN generation_attempts a ON a.id=q.attempt_id WHERE q.attempt_id=$1 AND q.status='reserved' AND q.expires_at<now() AND a.execution_status='unknown' FOR UPDATE OF q,a",[q.attempt_id]);if(!active.rowCount)return;
   await settleQuota(tx,workspaceId,q.attempt_id,false);await refreshGeneration(tx,workspaceId,q.request_id);await emit(tx,workspaceId,'activity.updated',{kind:'reconciliation',generationId:q.request_id,message:'未知结果已满 24 小时，用户配额已释放；供应商成本仍待核对'});
  });
 }
}
