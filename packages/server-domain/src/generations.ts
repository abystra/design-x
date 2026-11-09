import { z } from 'zod';
import type { Tx } from '../../server-infra/src/db.js';
import { config } from '../../server-infra/src/config.js';
import { id,emit,HttpError,notFound } from './common.js';
import { createJob } from './jobs.js';
import { getProjectMetadata } from './projects.js';
import { MAX_REFERENCES,MAX_GENERATION_COUNT } from './capabilities.js';
const identifier=z.string().regex(/^[A-Za-z0-9_-]{1,150}$/);
export const GenerationInput=z.object({prompt:z.string().trim().min(1).max(12000),count:z.number().int().min(1).max(MAX_GENERATION_COUNT).default(1),size:z.enum(['1024x1024','1024x1536','1536x1024']).default('1024x1024'),quality:z.literal('medium').default('medium'),referenceAssetIds:z.array(identifier).max(MAX_REFERENCES).default([]),referenceAssetVersionIds:z.array(identifier).max(MAX_REFERENCES).default([]),baseBoardRevision:z.number().int().positive().optional(),targetDocumentId:identifier.optional(),baseRevision:z.number().int().positive().optional(),placement:z.enum(['board','library']).default('board')}).strict().superRefine((v,ctx)=>{if(!!v.targetDocumentId!==!!v.baseRevision)ctx.addIssue({code:'custom',message:'目标画板和版本必须同时提供'});});
export type GenerationRequest=z.infer<typeof GenerationInput>;
export async function freezeGenerationInputs(tx:Tx,projectId:string,input:GenerationRequest){
 const versions=(await tx.query(`SELECT a.id AS asset_id,v.* FROM project_assets p JOIN assets a ON a.id=p.asset_id JOIN asset_versions v ON v.asset_id=a.id AND (v.id=ANY($3::text[]) OR (a.id=ANY($2::text[]) AND v.id=COALESCE(p.version_id,a.current_version_id))) WHERE p.project_id=$1 AND p.revoked_at IS NULL AND a.deleted_at IS NULL AND a.status='ready'`,[projectId,input.referenceAssetIds,input.referenceAssetVersionIds])).rows;
 const unique=[...new Map(versions.map(v=>[v.id,v])).values()];
 if(input.referenceAssetIds.some(a=>!unique.some(v=>v.asset_id===a))||input.referenceAssetVersionIds.some(v=>!unique.some(a=>a.id===v)))throw new HttpError(403,'ASSET_NOT_LINKED','参考素材必须先关联到当前项目');
 if(unique.length>MAX_REFERENCES)throw new HttpError(400,'TOO_MANY_REFERENCES',`最多 ${MAX_REFERENCES} 张参考图`);
 return unique.map(v=>({assetId:v.asset_id,assetVersionId:v.id,objectKey:v.object_key,bucket:v.bucket,sha256:v.sha256,bytes:Number(v.bytes),mime:v.mime,width:v.width,height:v.height}));
}
export async function createGeneration(tx:Tx,workspaceId:string,projectId:string,input:GenerationRequest,recipe?:unknown){
 await getProjectMetadata(tx,projectId,false,true);
 const board=(await tx.query("SELECT revision FROM documents WHERE project_id=$1 AND kind='board'",[projectId])).rows[0];
 if(input.baseBoardRevision!==undefined&&board.revision!==input.baseBoardRevision)throw new HttpError(409,'DOC_REVISION_CONFLICT','工作区已变化，请同步后提交');
 if(input.targetDocumentId){const target=(await tx.query("SELECT revision FROM documents WHERE id=$1 AND project_id=$2 AND kind='artboard'",[input.targetDocumentId,projectId])).rows[0];if(!target)notFound();if(target.revision!==input.baseRevision)throw new HttpError(409,'DOC_REVISION_CONFLICT','目标画板已变化');}
 const references=await freezeGenerationInputs(tx,projectId,input),requestId=id();
 const snapshot={...input,model:config.imageModel,quality:config.imageQuality,references,baseBoardRevision:board.revision,...(recipe?{recipe}:{})};
 await tx.query('INSERT INTO creative_requests(id,workspace_id,project_id,snapshot) VALUES($1,$2,$3,$4)',[requestId,workspaceId,projectId,JSON.stringify(snapshot)]);
 for(const ref of references)await tx.query('INSERT INTO generation_inputs(workspace_id,request_id,asset_id,asset_version_id) VALUES($1,$2,$3,$4)',[workspaceId,requestId,ref.assetId,ref.assetVersionId]);
 for(let ordinal=0;ordinal<input.count;ordinal++){
  const job=await createJob(tx,workspaceId,'generation.submit',{requestId,ordinal},projectId);
  await tx.query('INSERT INTO generation_attempts(id,workspace_id,request_id,ordinal) VALUES($1,$2,$3,$4)',[job.id,workspaceId,requestId,ordinal]);
 }
 await emit(tx,workspaceId,'generation.updated',{id:requestId,projectId,status:'queued'});
 return {generation:await readGeneration(tx,requestId)};
}
export async function readGeneration(tx:Tx,requestId:string){
 const r=(await tx.query('SELECT r.* FROM creative_requests r JOIN projects p ON p.id=r.project_id WHERE r.id=$1 AND p.deleted_at IS NULL',[requestId])).rows[0];if(!r)notFound();
 const outputs=(await tx.query(`SELECT o.id,o.asset_id,o.asset_version_id,o.state,o.placement_status,o.placement_reason,o.document_ids,v.width,v.height FROM generation_outputs o LEFT JOIN asset_versions v ON v.id=o.asset_version_id WHERE o.request_id=$1 ORDER BY o.created_at`,[requestId])).rows;
 const attempts=(await tx.query('SELECT id,ordinal,execution_status,error FROM generation_attempts WHERE request_id=$1 ORDER BY ordinal',[requestId])).rows;
 return {id:r.id,projectId:r.project_id,status:r.execution_status,executionStatus:r.execution_status,assetStatus:r.asset_status,cancelRequested:r.cancel_requested,settlementStatus:r.settlement_status,prompt:r.snapshot.prompt,count:r.snapshot.count,model:r.snapshot.model,recipe:r.snapshot.recipe||null,createdAt:r.created_at,updatedAt:r.updated_at,error:r.error,references:r.snapshot.references.map((v:any)=>({assetId:v.assetId,assetVersionId:v.assetVersionId,sha256:v.sha256,width:v.width,height:v.height})),attempts:attempts.map(a=>({id:a.id,ordinal:a.ordinal,status:a.execution_status,error:a.error})),outputs:outputs.map(o=>({id:o.id,assetId:o.asset_id,assetVersionId:o.asset_version_id,status:o.state,placementStatus:o.placement_status,placementReason:o.placement_reason,documentIds:o.document_ids,width:o.width,height:o.height,image:o.asset_id?`/api/assets/${o.asset_id}/versions/${o.asset_version_id}/file`:null,thumbnail:o.asset_id?`/api/assets/${o.asset_id}/versions/${o.asset_version_id}/thumbnail`:null}))};
}
export async function lockGenerationProject(tx:Tx,attemptId:string){
 // All generation writers take the project lock before attempts, requests, or jobs.
 // Include soft-deleted projects: late supplier usage still requires durable accounting.
 await tx.query('SELECT p.id FROM projects p JOIN creative_requests r ON r.project_id=p.id JOIN generation_attempts a ON a.request_id=r.id WHERE a.id=$1 FOR UPDATE OF p',[attemptId]);
}
export async function authorizeGeneration(tx:Tx,attemptId:string,fence?:string,phase?:'submit'){
 await lockGenerationProject(tx,attemptId);
 const row=(await tx.query('SELECT a.*,r.project_id,r.snapshot,r.cancel_requested,p.deleted_at FROM generation_attempts a JOIN creative_requests r ON r.id=a.request_id JOIN projects p ON p.id=r.project_id WHERE a.id=$1 FOR UPDATE OF a FOR SHARE OF r,p',[attemptId])).rows[0];
 if(!row||row.deleted_at||row.cancel_requested||fence&&row.fence!==fence||row&&!['checking','submitting','received'].includes(row.execution_status))throw new HttpError(409,'GENERATION_INACTIVE','生成已取消、失租或项目已删除');
 if(phase==='submit'&&(row.execution_status!=='checking'||new Date(row.deadline_at).getTime()<=Date.now()))throw new HttpError(409,'GENERATION_EXPIRED','提交执行已过期；未调用供应商');
 const inputs=(await tx.query('SELECT asset_id FROM generation_inputs WHERE request_id=$1',[row.request_id])).rows;
 for(const input of inputs){
  const allowed=await tx.query('SELECT pa.asset_id FROM project_assets pa JOIN assets a ON a.id=pa.asset_id WHERE pa.project_id=$1 AND pa.asset_id=$2 AND pa.revoked_at IS NULL AND a.deleted_at IS NULL FOR SHARE OF pa,a',[row.project_id,input.asset_id]);
  if(!allowed.rowCount)throw new HttpError(403,'ASSET_REVOKED','项目素材权限已撤销');
 }
 return row;
}
export async function reserveQuota(tx:Tx,workspaceId:string,attemptId:string,reopen=false){
 await tx.query('INSERT INTO quota_accounts(workspace_id,quota_limit) VALUES($1,$2) ON CONFLICT DO NOTHING',[workspaceId,config.generationQuota]);
 const account=(await tx.query('SELECT * FROM quota_accounts WHERE workspace_id=$1 FOR UPDATE',[workspaceId])).rows[0];
 const existing=(await tx.query('SELECT * FROM quota_reservations WHERE attempt_id=$1 FOR UPDATE',[attemptId])).rows[0];
 if(existing&&(!reopen||existing.status!=='released'))return;
 if(account.used+account.reserved>=account.quota_limit)throw new HttpError(429,'QUOTA_EXCEEDED','图片创作配额不足');
 if(existing){
  const cycle=existing.cycle+1;
  await tx.query("UPDATE quota_reservations SET status='reserved',cycle=$1,settled_at=NULL,expires_at=now()+interval '24 hours' WHERE id=$2",[cycle,existing.id]);
  await tx.query('UPDATE quota_accounts SET reserved=reserved+1 WHERE workspace_id=$1',[workspaceId]);
  await tx.query("INSERT INTO quota_ledger(id,workspace_id,reservation_id,action,units,cycle) VALUES($1,$2,$3,'reserve',1,$4)",[id(),workspaceId,existing.id,cycle]);return;
 }
 const reservationId=id();await tx.query("INSERT INTO quota_reservations(id,workspace_id,attempt_id,units,expires_at) VALUES($1,$2,$3,1,now()+interval '24 hours')",[reservationId,workspaceId,attemptId]);
 await tx.query('UPDATE quota_accounts SET reserved=reserved+1 WHERE workspace_id=$1',[workspaceId]);
 await tx.query("INSERT INTO quota_ledger(id,workspace_id,reservation_id,action,units) VALUES($1,$2,$3,'reserve',1)",[id(),workspaceId,reservationId]);
}
export async function settleQuota(tx:Tx,workspaceId:string,attemptId:string,consume:boolean){
 const reservation=(await tx.query('SELECT * FROM quota_reservations WHERE attempt_id=$1 FOR UPDATE',[attemptId])).rows[0];if(!reservation||reservation.status!=='reserved')return;
 await tx.query('UPDATE quota_reservations SET status=$1,settled_at=now() WHERE id=$2',[consume?'consumed':'released',reservation.id]);
 await tx.query('UPDATE quota_accounts SET reserved=reserved-$1,used=used+$2 WHERE workspace_id=$3',[reservation.units,consume?reservation.units:0,workspaceId]);
 await tx.query('INSERT INTO quota_ledger(id,workspace_id,reservation_id,action,units,cycle) VALUES($1,$2,$3,$4,$5,$6)',[id(),workspaceId,reservation.id,consume?'consume':'release',reservation.units,reservation.cycle]);
}
export function aggregateGeneration(statuses:string[],ready:number,cancelled:boolean){
 if(statuses.some(s=>['queued','checking','submitting','received'].includes(s)))return 'running';
 if(statuses.includes('unknown'))return 'unknown';
 if(ready===statuses.length)return 'succeeded';
 if(ready>0)return 'partial';
 return cancelled?'cancelled':'failed';
}
export async function refreshGeneration(tx:Tx,workspaceId:string,requestId:string){
 const r=(await tx.query('SELECT * FROM creative_requests WHERE id=$1 FOR UPDATE',[requestId])).rows[0];
 const attempts=(await tx.query('SELECT execution_status,error FROM generation_attempts WHERE request_id=$1',[requestId])).rows;
 const outputs=(await tx.query('SELECT state FROM generation_outputs WHERE request_id=$1',[requestId])).rows;
 const reservations=(await tx.query('SELECT q.status FROM quota_reservations q JOIN generation_attempts a ON a.id=q.attempt_id WHERE a.request_id=$1',[requestId])).rows;
 const ready=outputs.filter(o=>o.state==='ready').length,status=aggregateGeneration(attempts.map(a=>a.execution_status),ready,r.cancel_requested);
 const assetStatus=ready===attempts.length?'ready':ready?'partial':outputs.length?'pending':'none';
 const settlement=reservations.some(q=>q.status==='reserved')?'reserved':status==='unknown'?'reconciliation_required':'settled';
 await tx.query('UPDATE creative_requests SET execution_status=$1,asset_status=$2,settlement_status=$3,error=$4,updated_at=now() WHERE id=$5',[status,assetStatus,settlement,attempts.find(a=>a.error)?.error||null,requestId]);
 await emit(tx,workspaceId,'generation.updated',{id:requestId,projectId:r.project_id,status,assetStatus,settlementStatus:settlement});
 await emit(tx,workspaceId,'activity.updated',{projectId:r.project_id,kind:'generation',id:requestId});
}
export async function cancelGeneration(tx:Tx,workspaceId:string,requestId:string){
 const r=await readGeneration(tx,requestId);await getProjectMetadata(tx,r.projectId,false,true);
 await tx.query('UPDATE creative_requests SET cancel_requested=true,updated_at=now() WHERE id=$1',[requestId]);
 const attempts=(await tx.query("UPDATE generation_attempts SET execution_status='cancelled',updated_at=now() WHERE request_id=$1 AND execution_status IN ('queued','checking') RETURNING id",[requestId])).rows;
 for(const attempt of attempts){await settleQuota(tx,workspaceId,attempt.id,false);await tx.query("UPDATE jobs SET status='cancelled',updated_at=now() WHERE id=$1",[attempt.id]);}
 await refreshGeneration(tx,workspaceId,requestId);return {generation:await readGeneration(tx,requestId)};
}
