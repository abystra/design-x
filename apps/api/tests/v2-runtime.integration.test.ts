import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AiRuntime } from '../../worker/src/ai-turn.js';
import { disposeTestDatabase } from './helpers/database.js';
const originalUrl = process.env.DATABASE_URL || 'postgres://designx:designx-local-only@127.0.0.1:55432/designx';
const admin = new pg.Client({connectionString: originalUrl}); await admin.connect();
const name=`designx_runtime_${randomUUID().replaceAll('-','')}`; await admin.query(`CREATE DATABASE "${name}"`);
const url=new URL(originalUrl); url.pathname='/'+name; process.env.DATABASE_URL=url.toString();
process.env.DESIGNX_RUNNER_V2='true';
const {migrate}=await import('../../../db/migrate.js');
const {pool,tenantTransaction}=await import('../../../packages/server-infra/src/db.js');
const {stopQueue}=await import('../../../packages/server-infra/src/queue.js');
const {buildApp}=await import('../src/server.js');
const {runBusinessJob}=await import('../../worker/src/process.js');
const {runAiTurn}=await import('../../worker/src/ai-turn.js');
await migrate(); const app=await buildApp({logger:false,aiEnabled:true});
const registered=await app.inject({method:'POST',url:'/api/auth/register',payload:{email:`runtime-${randomUUID()}@example.test`,password:'runtime-integration-password',name:'Runtime tester'}});
assert.equal(registered.statusCode,201,registered.body);
const cookie=String(registered.headers['set-cookie']).split(';')[0];
const request=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url:'/api'+url,payload,headers:{cookie,origin:'http://127.0.0.1:5173','idempotency-key':randomUUID()}});
const design={width:400,height:400,background:'#ffffff',nodes:[]};
async function createTurn(projectId?:string){
 const project=projectId ? {id:projectId} : (await request('POST','/projects',{title:'Session integration',design})).json();
 const response=await request('POST',`/projects/${project.id}/ai-turns`,{prompt:'Create editable poster'});assert.equal(response.statusCode,202,response.body);
 const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[response.json().id])).rows[0];
 return {project,job};
}
test.after(async()=>{await app.close();await stopQueue();await pool.end();await disposeTestDatabase(admin,name);});

test('native interactions persist, answers deduplicate, successful session pauses and reuses native context',async()=>{
 const {project,job}=await createTurn(); let paused=0;let killed=0;let threadIds:any[]=[];
 const runtime:AiRuntime={runSandboxTurn:async()=>{throw new Error('legacy fallback forbidden')},killSandbox:async()=>{killed++},findSandboxesForExecution:async()=>[],pauseSandbox:async()=>{paused++},runAppServerTurn:async input=>{
  const session=input.session!; threadIds.push(session.threadId);
  await input.onSandbox!('sandbox-v2-fixture');let sequence=0;
  const event=async(type:string,payload:any)=>input.onRuntimeEvent!({version:2,attemptId:session.attemptId,fence:session.fence,sequence:++sequence,type,payload});
  await event('session.ready',{threadId:'native-thread-1'});
  const tool = await input.onTool!({callId:'assets-call',name:'assets.list',arguments:{}});
  assert.equal(tool.success,true);
  await input.onTool!({callId:'assets-call',name:'assets.list',arguments:{}});
  await event('interaction.requested',{requestId:11,questions:[{id:'size',header:'Size',question:'Choose size',options:[{label:'Square',description:'1:1'}]}]});
  const visible=(await request('GET',`/projects/${project.id}/agent-session`)).json();
  assert.equal(visible.interactions[0].status,'pending');
  const body={commandId:randomUUID(),type:'answer',interactionId:visible.interactions[0].id,answers:{size:{answers:['Square']}}};
  const answer=await request('POST',`/ai-turns/${session.attemptId===job.execution_token?job.id:visible.interactions[0].turnId}/commands`,body);
  assert.equal(answer.statusCode,200,answer.body);
  assert.equal((await request('POST',`/ai-turns/${visible.interactions[0].turnId}/commands`,body)).statusCode,200);
  const commands=await input.pendingCommands!();assert.equal(commands.length,1);
  await event('command.ack',{commandId:body.commandId,status:'applied'});
  await event('interaction.resolved',{requestId:11,status:'answered'});
  return {manifest:{version:1,summary:'Editable poster',artboards:[{title:'Poster',design}]},runtime:{sandboxId:'sandbox-v2-fixture',threadId:'native-thread-1',model:'deepseek-flash',usage:{input_tokens:12}}};
 }};
 await runBusinessJob({id:job.queue_id,data:{jobId:job.id,workspaceId:job.workspace_id}},job=>runAiTurn(job,runtime));
 const second=await createTurn(project.id);
 const frozen=(await pool.query('SELECT context FROM ai_turns WHERE id=$1',[second.job.id])).rows[0].context;
 assert.match(JSON.stringify(frozen),/confirmed_answer/);
 await runBusinessJob({id:second.job.queue_id,data:{jobId:second.job.id,workspaceId:second.job.workspace_id}},job=>runAiTurn(job,runtime));
 assert.deepEqual(threadIds,[undefined,'native-thread-1']);assert.equal(paused,2);assert.equal(killed,0);
 const session=(await request('GET',`/projects/${project.id}/agent-session`)).json();
 assert.equal(session.session.status,'paused');assert.equal(session.messages.filter((m:any)=>m.role==='assistant').length,2);
 assert.equal(session.interactions.filter((i:any)=>i.status==='answered').length,2);
 assert.equal(session.messages.filter((m:any)=>m.role==='tool').length,2);
 assert.equal(session.messages.find((m:any)=>m.role==='tool').content.calls.length,1);
});

test('native usage snapshots persist once across duplicate delivery, progress and resumed threads',async()=>{
 const first=await createTurn();let round=0;
 const threadId=`usage-thread-${first.project.id}`;
 const runtime:AiRuntime={runSandboxTurn:async()=>{throw new Error('no legacy fallback')},killSandbox:async()=>{},pauseSandbox:async()=>{},findSandboxesForExecution:async()=>[],runAppServerTurn:async input=>{
  round++;const session=input.session!;await input.onSandbox!('sandbox-usage-fixture');
  const event=(sequence:number,type:string,payload:any)=>input.onRuntimeEvent!({version:2,attemptId:session.attemptId,fence:session.fence,sequence,type,payload});
  await event(1,'session.ready',{threadId,resumed:round>1});
  const initial={total:{inputTokens:round===1?20:40,outputTokens:round===1?4:8},last:{inputTokens:999,outputTokens:999},modelContextWindow:100000};
  await event(2,'usage.updated',{usage:initial});await event(2,'usage.updated',{usage:initial});
  await input.onProgress!({stage:'tool',threadId});
  const midway=(await pool.query('SELECT usage FROM ai_attempts WHERE id=$1',[session.attemptId])).rows[0].usage;
  assert.equal(midway.input_tokens,round===1?20:10);assert.equal(midway.native.sequence,2);
  const final={total:{inputTokens:round===1?30:45,outputTokens:round===1?6:9},last:{inputTokens:10,outputTokens:2}};
  await event(3,'usage.updated',{usage:final});await event(4,'run.completed',{threadId});
  return {manifest:{version:1,summary:'Usage fixture',artboards:[{title:'Usage',design}]},runtime:{sandboxId:'sandbox-usage-fixture',threadId,model:'native-fixture',usage:final}};
 }};
 await runBusinessJob({id:first.job.queue_id,data:{jobId:first.job.id,workspaceId:first.job.workspace_id}},job=>runAiTurn(job,runtime));
 const second=await createTurn(first.project.id);
 await runBusinessJob({id:second.job.queue_id,data:{jobId:second.job.id,workspaceId:second.job.workspace_id}},job=>runAiTurn(job,runtime));
 const a=(await pool.query('SELECT usage FROM ai_attempts WHERE turn_id=$1',[first.job.id])).rows[0].usage;
 const b=(await pool.query('SELECT usage FROM ai_attempts WHERE turn_id=$1',[second.job.id])).rows[0].usage;
 assert.equal(a.input_tokens,30);assert.equal(a.output_tokens,6);
 assert.equal(b.input_tokens,15);assert.equal(b.output_tokens,3);assert.equal(b.native.status,'known');
 assert.deepEqual(b.native.baseline,{input_tokens:30,output_tokens:6});
});

test('lost observer lease cannot submit, terminate replacement or overwrite job status',async()=>{
 const {job}=await createTurn(); let killed=0;
 const runtime:AiRuntime={runSandboxTurn:async()=>{throw new Error('no fallback')},killSandbox:async()=>{killed++},findSandboxesForExecution:async()=>[],runAppServerTurn:async input=>{
  await input.onSandbox!('sandbox-lease-fixture');
  await tenantTransaction(job.workspace_id,tx=>tx.query('UPDATE ai_attempts SET lease_owner=$1 WHERE id=$2',['replacement',input.session!.attemptId]));
  return {manifest:{version:1,summary:'stale',artboards:[{title:'Stale',design}]},runtime:{sandboxId:'sandbox-lease-fixture',threadId:'t',model:'deepseek-flash',usage:{}}};
 }};
 await assert.rejects(runBusinessJob({id:job.queue_id,data:{jobId:job.id,workspaceId:job.workspace_id}},job=>runAiTurn(job,runtime)),/租约/);
 const state=(await pool.query('SELECT status FROM jobs WHERE id=$1',[job.id])).rows[0];
 assert.equal(state.status,'running');assert.equal(killed,0);
 assert.equal((await pool.query("SELECT 1 FROM documents WHERE project_id=$1 AND title='Stale'",[job.project_id])).rowCount,0);
});

test('observer recovery reattaches the exact attempt without launching another native request',async()=>{
 const created=await createTurn(),attemptId=randomUUID();
 const {job}=created;
 await tenantTransaction(job.workspace_id,async tx=>{
  await tx.query("UPDATE jobs SET status='running',execution_token=$1 WHERE id=$2",[attemptId,job.id]);
  await tx.query("INSERT INTO ai_attempts(id,workspace_id,turn_id,queue_id,sandbox_id,fence,lease_owner,lease_until,deadline_at) VALUES($1,$2,$3,$4,'same-sandbox',1,'disconnected',now()-interval '1 minute',now()+interval '5 minutes')",[attemptId,job.workspace_id,job.id,job.queue_id]);
  await tx.query("UPDATE creative_sessions SET active_attempt_id=$1,fence=1,status='running',sandbox_id='same-sandbox',native_thread_id='existing-native' WHERE project_id=$2",[attemptId,job.project_id]);
 });
 const session=(await pool.query('SELECT * FROM creative_sessions WHERE project_id=$1',[job.project_id])).rows[0];
 const running=(await pool.query('SELECT * FROM jobs WHERE id=$1',[job.id])).rows[0];
 let reattached=0;
 const runtime:AiRuntime={runSandboxTurn:async()=>{throw new Error('must not fall back')},killSandbox:async()=>{},pauseSandbox:async()=>{},findSandboxesForExecution:async()=>[],runAppServerTurn:async input=>{
  assert.equal(input.session?.resumeAttempt,true);assert.equal(input.session?.attemptId,attemptId);assert.equal(input.session?.sandboxId,'same-sandbox');assert.equal(input.session?.threadId,'existing-native');reattached++;
  return {manifest:{version:1,summary:'Recovered',artboards:[{title:'Recovered',design}]},runtime:{sandboxId:'same-sandbox',threadId:'existing-native',model:'deepseek-flash',usage:{}}};
 }};
 await runAiTurn(running,runtime,{id:session.id,projectId:job.project_id,attemptId,fence:1,deadline:Date.now()+300000,sandboxId:'same-sandbox',threadId:'existing-native',resumeAttempt:true,cursor:0});
 assert.equal(reattached,1);assert.equal((await pool.query('SELECT count(*) FROM ai_attempts WHERE turn_id=$1',[job.id])).rows[0].count,'1');
 assert.equal((await pool.query('SELECT status FROM jobs WHERE id=$1',[job.id])).rows[0].status,'succeeded');
});

test('preparation failure before sandbox dispatch releases the session without uncertain-create cleanup',async()=>{
 const {job}=await createTurn();let discoveries=0,kills=0;
 const runtime:AiRuntime={runSandboxTurn:async()=>{throw new Error('legacy fallback forbidden')},killSandbox:async()=>{kills++},findSandboxesForExecution:async()=>{discoveries++;return [];}};
 await assert.rejects(runBusinessJob({id:job.queue_id,data:{jobId:job.id,workspaceId:job.workspace_id}},job=>runAiTurn(job,runtime)));
 const attempt=(await pool.query('SELECT status,outcome FROM ai_attempts WHERE turn_id=$1',[job.id])).rows[0];
 assert.equal(attempt.status,'closed');assert.equal(attempt.outcome,'not_dispatched');assert.equal(discoveries,0);assert.equal(kills,0);
 const session=(await pool.query('SELECT active_attempt_id FROM creative_sessions WHERE project_id=$1',[job.project_id])).rows[0];assert.equal(session.active_attempt_id,null);
});

test('a committed turn still pausing rejects a new turn before creating its job',async()=>{
 const {project,job}=await createTurn();let checked=false;
 const runtime:AiRuntime={runSandboxTurn:async()=>{throw new Error('no fallback')},killSandbox:async()=>{},findSandboxesForExecution:async()=>[],
  runAppServerTurn:async input=>{
   await input.onSandbox!('sandbox-finalizing-fixture');
   return {manifest:{version:1,summary:'Committed',artboards:[{title:'Committed',design}]},runtime:{sandboxId:'sandbox-finalizing-fixture',threadId:'finalizing-thread',model:'deepseek-flash',usage:{}}};
  },pauseSandbox:async()=>{
   assert.equal((await request('GET',`/jobs/${job.id}`)).json().status,'succeeded');
   const before=Number((await pool.query('SELECT count(*) FROM jobs WHERE project_id=$1',[project.id])).rows[0].count);
   const response=await request('POST',`/projects/${project.id}/ai-turns`,{prompt:'Continue before pause completes'});
   assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error,'SESSION_BUSY');
   assert.match(response.json().message,/收尾/);
   assert.equal(Number((await pool.query('SELECT count(*) FROM jobs WHERE project_id=$1',[project.id])).rows[0].count),before);
   checked=true;
  }};
 await runBusinessJob({id:job.queue_id,data:{jobId:job.id,workspaceId:job.workspace_id}},job=>runAiTurn(job,runtime));
 assert.equal(checked,true);
 assert.ok((await createTurn(project.id)).job.id);
});
