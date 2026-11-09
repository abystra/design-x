import {pool,tenantTransaction} from '../packages/server-infra/src/db.js';
import {id,emit} from '../packages/server-domain/src/common.js';
import {settleQuota,refreshGeneration,lockGenerationProject} from '../packages/server-domain/src/generations.js';
const arg=(key:string)=>{const i=process.argv.indexOf(key);return i<0?'':process.argv[i+1]||'';};
const callId=arg('--call'),evidence=arg('--evidence'),actor=arg('--actor'),outcome=arg('--outcome'),cost=Number(arg('--cost-usd'));
try{
 if(!callId||!evidence||!actor||!['rejected','completed-unavailable'].includes(outcome)||!Number.isFinite(cost)||cost<0)throw new Error('Required: --call ID --outcome rejected|completed-unavailable --cost-usd AMOUNT --evidence RECEIPT --actor OPERATOR [--apply]');
 const call=(await pool.query('SELECT p.*,a.request_id,a.execution_status FROM provider_calls p JOIN generation_attempts a ON a.id=p.attempt_id WHERE p.id=$1',[callId])).rows[0];
 if(!call||call.execution_status!=='unknown')throw new Error('Only a recorded unknown submission can be reconciled; successful outputs are never rewritten');
 if(!process.argv.includes('--apply'))console.log(JSON.stringify({dryRun:true,callId,outcome,costUsd:cost}));
 else await tenantTransaction(call.workspace_id,async tx=>{
  await lockGenerationProject(tx,call.attempt_id);
  const current=(await tx.query('SELECT execution_status FROM generation_attempts WHERE id=$1 FOR UPDATE',[call.attempt_id])).rows[0];if(current.execution_status!=='unknown')throw new Error('Attempt changed; inspect again');
  await tx.query('INSERT INTO provider_reconciliations(id,workspace_id,call_id,outcome,cost_usd,evidence,actor) VALUES($1,$2,$3,$4,$5,$6,$7)',[id(),call.workspace_id,callId,outcome,cost,evidence.slice(0,1000),actor.slice(0,200)]);
  await tx.query("UPDATE provider_calls SET status='reconciled',cost_usd=$1,cost_status='actual:manual',completed_at=now() WHERE id=$2",[cost,callId]);
  await tx.query("UPDATE generation_attempts SET execution_status='failed',error=$1,settled_at=now(),updated_at=now() WHERE id=$2",[outcome==='rejected'?'核对确认供应商未受理':'核对确认供应商已完成，但产物不可恢复；再次生成需新请求',call.attempt_id]);
  await settleQuota(tx,call.workspace_id,call.attempt_id,false);await refreshGeneration(tx,call.workspace_id,call.request_id);
  await emit(tx,call.workspace_id,'activity.updated',{kind:'reconciliation',generationId:call.request_id,outcome,costUsd:cost});console.log(JSON.stringify({reconciled:true,callId,outcome}));
 });
}finally{await pool.end();}
