import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { disposeTestDatabase } from './helpers/database.js';
const adminUrl=process.env.DATABASE_URL||'postgres://designx:designx-local-only@127.0.0.1:55432/designx',admin=new pg.Client({connectionString:adminUrl});await admin.connect();
const databaseName=`designx_review_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${databaseName}"`);const isolated=new URL(adminUrl);isolated.pathname=`/${databaseName}`;process.env.DATABASE_URL=isolated.toString();
const {migrate}=await import('../../../db/migrate.js');
const {pool,tenantTransaction}=await import('../../../packages/server-infra/src/db.js');
const {config}=await import('../../../packages/server-infra/src/config.js');
const {stopQueue}=await import('../../../packages/server-infra/src/queue.js');
const {ensureUploadStorage,deleteObject}=await import('../../../packages/server-infra/src/storage.js');
const {buildApp}=await import('../src/server.js');
const {submitGeneration,ingestGeneration,reconcileGenerations}=await import('../../worker/src/generation.js');
const {runBusinessJob}=await import('../../worker/src/process.js');
const {ingestBufferAsset}=await import('../../../packages/server-domain/src/assets.js');
const {executeAgentTool}=await import('../../../packages/server-domain/src/agent-tools.js');
await migrate();await ensureUploadStorage();config.imageEnabled=true;if(!config.openaiApiKey)config.openaiApiKey='test-only-not-sent';
const app=await buildApp({logger:false,aiEnabled:true});let cookie='',ws='';
const bytes=await sharp({create:{width:48,height:64,channels:3,background:'#507b52'}}).png().toBuffer();let calls=0;
const provider={moderate:async()=>true,generate:async()=>{calls++;return {encoded:bytes.toString('base64'),usage:null,requestId:'fixture-'+calls};}};
const api=(method:string,url:string,payload?:any,key=randomUUID())=>app.inject({method:method as any,url,payload,headers:{cookie,origin:config.webOrigin,'idempotency-key':key}});
async function project(){return (await api('POST','/api/projects',{title:'Review regression'})).json();}
async function start(projectId:string){const r=await api('POST',`/api/projects/${projectId}/generations`,{prompt:'a product image'});assert.equal(r.statusCode,202,r.body);return r.json().generation;}
async function submitJob(g:any){return (await pool.query('SELECT j.* FROM jobs j JOIN generation_attempts a ON a.id=j.id WHERE a.request_id=$1',[g.id])).rows[0];}
async function mediaJob(g:any){return (await pool.query("SELECT j.* FROM jobs j JOIN generation_outputs o ON o.id=j.payload->>'outputId' WHERE o.request_id=$1 ORDER BY j.created_at DESC LIMIT 1",[g.id])).rows[0];}
async function submit(g:any,p=provider){const j=await submitJob(g);await submitGeneration({id:j.queue_id,data:{workspaceId:ws,jobId:j.id}},p);}
const delivery=(j:any)=>({id:j.queue_id,data:{workspaceId:ws,jobId:j.id}});
test.before(async()=>{const r=await app.inject({method:'POST',url:'/api/auth/register',payload:{email:`review-${randomUUID()}@example.test`,password:'review-fixture-password',name:'Reviewer'}});assert.equal(r.statusCode,201);cookie=String(r.headers['set-cookie']).split(';')[0];ws=r.json().workspace.id;});
test.after(async()=>{await app.close();await stopQueue();for(const c of(await pool.query('SELECT bucket,object_key FROM storage_candidates')).rows)await deleteObject(c.object_key,{bucket:c.bucket}).catch(()=>{});await pool.end();await disposeTestDatabase(admin,databaseName);});
test('an expired checking execution cannot submit after delayed moderation returns',async()=>{
 const p=await project(),g=await start(p.id),j=await submitJob(g),baseline=calls;
 let entered!:()=>void,release!:()=>void;const arrived=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const pending=submitGeneration(delivery(j),{...provider,moderate:async()=>{entered();await gate;return true;}});
 await arrived;await pool.query("UPDATE generation_attempts SET deadline_at=now()-interval '1 minute' WHERE id=$1",[j.id]);await reconcileGenerations();release();await pending;
 assert.equal(calls,baseline,'no billable side effect after execution expiry');assert.equal((await pool.query('SELECT execution_status FROM generation_attempts WHERE id=$1',[j.id])).rows[0].execution_status,'failed');
});
test('multiple explicit media retry cycles re-reserve once and consume exactly once without regenerating',async()=>{
 const p=await project(),g=await start(p.id),baseline=calls;await submit(g);
 const before=(await pool.query('SELECT used FROM quota_accounts WHERE workspace_id=$1',[ws])).rows[0].used;
 for(let cycle=0;cycle<2;cycle++){
  const j=await mediaJob(g);await pool.query('UPDATE jobs SET attempts=2 WHERE id=$1',[j.id]);
  await assert.rejects(runBusinessJob(delivery(j),active=>ingestGeneration(active,{...provider,moderate:async()=>{throw new Error('temporary moderation transport failure');}})));
  const reservation=(await pool.query('SELECT q.* FROM quota_reservations q JOIN generation_attempts a ON a.id=q.attempt_id WHERE a.request_id=$1',[g.id])).rows[0];assert.equal(reservation.status,'released');
  const key=randomUUID();const retry=await api('POST',`/api/generations/${g.id}/retry-ingestion`,{},key);assert.equal(retry.statusCode,202,retry.body);assert.equal((await api('POST',`/api/generations/${g.id}/retry-ingestion`,{},key)).statusCode,202);
  const reopened=(await pool.query('SELECT * FROM quota_reservations WHERE id=$1',[reservation.id])).rows[0];assert.equal(reopened.status,'reserved');assert.equal(reopened.cycle,reservation.cycle+1);
 }
 const j=await mediaJob(g);await runBusinessJob(delivery(j),active=>ingestGeneration(active,provider));
 const quota=(await pool.query('SELECT * FROM quota_accounts WHERE workspace_id=$1',[ws])).rows[0];assert.equal(quota.used,before+1);assert.equal(quota.reserved,0);assert.equal(calls,baseline+1);
 const ledger=(await pool.query('SELECT l.action,l.cycle FROM quota_ledger l JOIN quota_reservations q ON q.id=l.reservation_id JOIN generation_attempts a ON a.id=q.attempt_id WHERE a.request_id=$1',[g.id])).rows;
 assert.equal(ledger.filter(r=>r.action==='reserve').length,3);assert.equal(ledger.filter(r=>r.action==='release').length,2);assert.equal(ledger.filter(r=>r.action==='consume').length,1);
});
test('a stale media execution cannot fail or settle the current execution',async()=>{
 const p=await project(),g=await start(p.id);await submit(g);const j=await mediaJob(g),token=randomUUID();
 await pool.query("UPDATE jobs SET status='running',execution_token=$2,attempts=1 WHERE id=$1",[j.id,token]);
 await assert.rejects(ingestGeneration({...j,status:'running',attempts:1,execution_token:'stale-token'},provider));
 assert.equal((await pool.query('SELECT a.execution_status FROM generation_attempts a WHERE a.request_id=$1',[g.id])).rows[0].execution_status,'received');
 assert.equal((await pool.query('SELECT q.status FROM quota_reservations q JOIN generation_attempts a ON a.id=q.attempt_id WHERE a.request_id=$1',[g.id])).rows[0].status,'reserved');
 await runBusinessJob(delivery(j),active=>ingestGeneration(active,provider));
 assert.equal((await api('GET',`/api/generations/${g.id}`)).json().status,'succeeded');
});
test('agent tool asset IDs resolve to frozen versions, and previews reject newly introduced versions',async()=>{
 const p=await project(),first=await ingestBufferAsset(ws,{bytes,mime:'image/png',title:'reference',projectId:p.id,source:{kind:'test'},attemptId:randomUUID()});
 const turnResponse=await api('POST',`/api/projects/${p.id}/ai-turns`,{prompt:'use project references'});assert.equal(turnResponse.statusCode,202,turnResponse.body);const turnId=turnResponse.json().id,attemptId=randomUUID();
 const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[turnId])).rows[0];
 await pool.query("UPDATE jobs SET status='running',execution_token=$2 WHERE id=$1",[turnId,attemptId]);
 await pool.query("INSERT INTO ai_attempts(id,workspace_id,turn_id,queue_id,deadline_at,fence,lease_until) VALUES($1,$2,$3,$4,now()+interval '5 minutes',1,now()+interval '1 minute')",[attemptId,ws,turnId,job.queue_id]);
 const second=await ingestBufferAsset(ws,{assetId:first.assetId,bytes,mime:'image/png',title:'new version',projectId:p.id,source:{kind:'test'},attemptId:randomUUID()});
 const tool=(name:string,args:any,callId=randomUUID())=>tenantTransaction(ws,tx=>executeAgentTool(tx,ws,{turnId,attemptId,fence:1,callId,name,arguments:args}));
 for(const [name,args] of [['generation.create',{prompt:'frozen reference',referenceAssetIds:[first.assetId]}],['recipe.run',{recipeId:'product-set',recipeVersion:1,parameters:{headline:'产品',assetId:first.assetId}}]] as const){
  const callId=randomUUID(),result=await tool(name,args,callId),again=await tool(name,args,callId);assert.ok('generation' in result);assert.ok('generation' in again);assert.equal(result.generation.id,again.generation.id);
  const snapshot=(await pool.query('SELECT snapshot FROM creative_requests WHERE id=$1',[result.generation.id])).rows[0].snapshot;assert.deepEqual(snapshot.references.map((r:any)=>r.assetVersionId),[first.assetVersionId]);
 }
 const changed=await api('PATCH',`/api/projects/${p.id}/artboards/${p.documentId}`,{baseRevision:p.revision,design:{...p.design,nodes:[{id:'new',type:'image',src:second.image,x:0,y:0,w:100,h:100}]}});assert.equal(changed.statusCode,200,changed.body);
 await assert.rejects(tool('render.preview',{documentId:p.documentId}),(error:any)=>error.code==='TOOL_ASSET_SCOPE');
});

test('provider receipt and concurrent cancellation use one lock order and retain provider accounting',async()=>{
 const p=await project(),g=await start(p.id),j=await submitJob(g),barrier=new pg.Client({connectionString:isolated.toString()});await barrier.connect();
 const lockId=9231786;await barrier.query('SELECT pg_advisory_lock($1)',[lockId]);
 await pool.query(`CREATE FUNCTION receipt_review_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='receipt-race' THEN PERFORM pg_advisory_xact_lock(${lockId}); END IF; RETURN NEW; END $$; CREATE TRIGGER receipt_review_pause BEFORE UPDATE ON provider_calls FOR EACH ROW EXECUTE FUNCTION receipt_review_barrier();`);
 const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
 async function waiting(pattern:string){for(let i=0;i<200;i++){if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query LIKE $1",[pattern])).rowCount)return;await delay(10);}throw new Error('Expected receipt/cancellation barrier was not reached');}
 let pending:Promise<unknown>|undefined,cancelling:Promise<any>|undefined;
 try{
  pending=submitGeneration(delivery(j),{...provider,generate:async()=>({encoded:bytes.toString('base64'),usage:{input_tokens:7,output_tokens:11},requestId:'receipt-race'})});
  await waiting('%UPDATE provider_calls%');
  cancelling=Promise.resolve(api('POST',`/api/generations/${g.id}/cancel`,{}));
  // The old implementation waited on attempt after locking project. The corrected
  // implementation waits on project before touching attempt; either reaches a barrier.
  for(let i=0;i<200;i++){
   const waits=await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query NOT LIKE '%UPDATE provider_calls%' AND pid<>pg_backend_pid()");
   if(waits.rowCount)break;if(i===199)throw new Error('Cancellation did not reach its lock wait');await delay(10);
  }
  await barrier.query('SELECT pg_advisory_unlock($1)',[lockId]);
  const cancelled=await cancelling;assert.equal(cancelled.statusCode,200,cancelled.body);await pending;
  const call=(await pool.query('SELECT status,usage FROM provider_calls WHERE attempt_id=$1',[j.id])).rows[0];assert.equal(call.status,'received');assert.equal(call.usage.output_tokens,11);
  const state=(await api('GET',`/api/generations/${g.id}`)).json();assert.equal(state.cancelRequested,true);assert.ok(state.outputs.every((o:any)=>!o.assetId));
 }finally{
  await barrier.query('SELECT pg_advisory_unlock_all()');await Promise.allSettled([pending,cancelling].filter(Boolean) as Promise<unknown>[]);await pool.query('DROP TRIGGER receipt_review_pause ON provider_calls; DROP FUNCTION receipt_review_barrier()');await barrier.end();
 }
});
