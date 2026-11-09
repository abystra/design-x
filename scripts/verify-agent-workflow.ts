/** Opt-in paid acceptance: authenticated API -> real Worker -> E2B/R2 -> durable documents.
 * Uses only a retained R2-verifier fixture; leaves its database records for verifier cleanup.
 * No image generation, Docker builds, bucket configuration changes or secret reports.
 */
import {config as loadEnv} from 'dotenv';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {Sandbox} from 'e2b';
import sharp from 'sharp';
loadEnv({path:'.env.r2.local',quiet:true});
if(!process.argv.includes('--live'))throw new Error('Use --live to authorize one real Agent acceptance turn');
const fixtureArg=process.argv.indexOf('--fixture');
const fixtureReport=JSON.parse(await readFile(fixtureArg<0?'artifacts/v2/r2-domain-fixture.json':process.argv[fixtureArg+1],'utf8'));
assert.ok(['passed','partial'].includes(fixtureReport.status)&&fixtureReport.materialFixtureReady===true&&fixtureReport.fixtureRetained===true,'a retained verified material fixture is required');
if(fixtureReport.singleBucketTest&&(process.env.NODE_ENV==='production'||!process.argv.includes('--single-bucket-test')))throw new Error('Single-bucket acceptance requires --single-bucket-test outside production');
const fixture=fixtureReport.fixture,build=JSON.parse(await readFile('infra/e2b/dist/build.json','utf8'));
process.env.DESIGNX_RUNNER_V2='true';process.env.DESIGNX_E2B_TEMPLATE=build.pinnedTemplate;process.env.IMAGE_GENERATION_ENABLED='false';process.env.AI_TURN_TIMEOUT_SECONDS='600';
const {config}=await import('../packages/server-infra/src/config.js');
const {pool,tenantTransaction}=await import('../packages/server-infra/src/db.js');
const {stopQueue,startQueue}=await import('../packages/server-infra/src/queue.js');
const {stagingBucket}=await import('../packages/server-infra/src/storage.js');
assert.equal(createHash('sha256').update(JSON.stringify([config.s3Endpoint,config.s3Bucket,stagingBucket()])).digest('hex'),fixtureReport.storageTarget,'fixture storage target matches the active profile');
const {buildApp}=await import('../apps/api/src/server.js');
const {runBusinessJob}=await import('../apps/worker/src/process.js');
const {runAiTurn}=await import('../apps/worker/src/ai-turn.js');
const {renderExport,closeBrowser}=await import('../apps/renderer/src/render.js');
const {killSandbox,findSandboxesForExecution}=await import('../packages/ai-runtime/src/index.js');
const {runtimeConfig,safeRuntimeError}=await import('../packages/ai-runtime/src/config.js');
const {shellQuote}=await import('../packages/ai-runtime/src/protocol.js');
const runtime=runtimeConfig(),token=randomBytes(32).toString('base64url'),tokenHash=createHash('sha256').update(token).digest('hex');
const report:any={startedAt:new Date().toISOString(),status:'running',template:build.pinnedTemplate,sourceCommit:build.sourceCommit,singleBucketTest:fixtureReport.singleBucketTest===true,fixture:{workspaceId:fixture.workspaceId,projectId:fixture.projectId},checks:[]};
let app:Awaited<ReturnType<typeof buildApp>>|undefined,job:any,attemptId:string|undefined,watchdog:NodeJS.Timeout|undefined,stopRequest:Promise<unknown>|undefined;
const save=async()=>{await mkdir('artifacts/v2',{recursive:true});await writeFile('artifacts/v2/agent-workflow-acceptance.json',JSON.stringify(report,null,2));};
const check=(name:string)=>{report.checks.push({name,status:'passed'});console.log(`${name}: passed`);};
const api=(method:string,url:string,payload?:any)=>app!.inject({method:method as any,url:'/api'+url,payload,headers:{cookie:`dx_session=${token}`,origin:config.webOrigin,'idempotency-key':randomUUID()}});
try{
 await save();
 const owner=(await pool.query("SELECT w.owner_id FROM workspaces w JOIN users u ON u.id=w.owner_id WHERE w.id=$1 AND u.email LIKE 'r2-acceptance-%@example.test'",[fixture.workspaceId])).rows[0];
 assert.ok(owner,'only the disposable R2-verifier workspace is allowed');
 await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')",[tokenHash,owner.owner_id]);
 app=await buildApp({logger:false,aiEnabled:true});
 assert.equal((await api('GET','/auth/me')).json().workspace.id,fixture.workspaceId);
 const denied=await api('POST',`/projects/${fixture.otherProjectId}/ai-turns`,{prompt:'This unauthorized reference must be rejected before execution',assetIds:[fixture.assetId]});
 assert.equal(denied.statusCode,403,'the same workspace cannot reference an unlinked project material');
 check('authenticated project authorization rejects an unlinked material before dispatch');
 const before=await tenantTransaction(fixture.workspaceId,async tx=>({
  documentIds:(await tx.query('SELECT id FROM documents WHERE project_id=$1',[fixture.projectId])).rows.map(r=>r.id),
  generations:Number((await tx.query('SELECT count(*) FROM creative_requests')).rows[0].count),
 }));
 const response=await api('POST',`/projects/${fixture.projectId}/ai-turns`,{
  count:1,mode:'create',assetIds:[fixture.assetId],ratio:'4:3',
  prompt:'只使用当前项目已有且已授权的第一张素材，禁止调用 generation.create、recipe.run 或任何生图接口。先读取 context.json，再从 /workspaces/designx/materials/ 加 context.materialManifest.entries[0].path 组成的路径实际打开图片并读取字节。创建一张 960×720 可编辑画板，包含该图片的独立 image 图层（src 必须原样使用 context.assets[0].src）和独立 text 图层，中文标题为「素材创作已完成」。无需提问，不要编辑旧画板。写入 artifact.json 并运行 node /opt/designx/validate.mjs 验证。',
 });
 assert.equal(response.statusCode,202,`Agent API accepted the fixture turn (${response.statusCode})`);
 job=await tenantTransaction(fixture.workspaceId,async tx=>(await tx.query('SELECT * FROM jobs WHERE id=$1',[response.json().id])).rows[0]);
 report.turnId=job.id;await save();
 const frozen=await tenantTransaction(fixture.workspaceId,async tx=>(await tx.query('SELECT * FROM ai_turns WHERE id=$1',[job.id])).rows[0]);
 assert.equal(frozen.runtime_protocol,'designx-runner-v2');
 const entry=frozen.context.materialManifest.entries.find((e:any)=>e.assetVersionId===fixture.assetVersionId);assert.ok(entry);
 assert.equal(frozen.context.assets[0].assetVersionId,fixture.assetVersionId);
 check('API persists a v2 turn with an immutable project material version');
 // The accepted business job is delivered explicitly below; cancel its transport
 // record to prevent a later local consumer from taking this verification job.
 await (await startQueue()).cancel('ai.turn',job.queue_id);
 watchdog=setTimeout(()=>{report.watchdogTriggered=true;stopRequest=api('POST',`/ai-turns/${job.id}/commands`,{commandId:randomUUID(),type:'stop'}).then(r=>{if(r.statusCode>=400)throw new Error('Verification stop command failed');}).catch(()=>{report.stopCommandFailed=true;});},180000);
 await runBusinessJob({id:job.queue_id,data:{jobId:job.id,workspaceId:fixture.workspaceId}},async active=>{
  attemptId=active.execution_token;report.attemptId=attemptId;await save();return runAiTurn(active);
 });
 clearTimeout(watchdog);watchdog=undefined;
 const state=await tenantTransaction(fixture.workspaceId,async tx=>({
  job:(await tx.query('SELECT status,result FROM jobs WHERE id=$1',[job.id])).rows[0],
  turn:(await tx.query('SELECT * FROM ai_turns WHERE id=$1',[job.id])).rows[0],
  attempt:(await tx.query('SELECT status,model,usage,event_cursor,sandbox_id FROM ai_attempts WHERE id=$1',[attemptId])).rows[0],
  session:(await tx.query('SELECT * FROM creative_sessions WHERE project_id=$1',[fixture.projectId])).rows[0],
  events:(await tx.query('SELECT sequence,type FROM agent_runtime_events WHERE attempt_id=$1 ORDER BY sequence',[attemptId])).rows,
  board:(await tx.query("SELECT content,revision FROM documents WHERE project_id=$1 AND kind='board'",[fixture.projectId])).rows[0],
  generations:Number((await tx.query('SELECT count(*) FROM creative_requests')).rows[0].count),
 }));
 assert.equal(state.job.status,'succeeded');assert.equal(state.attempt.status,'closed');
 assert.ok(state.events.some(e=>e.type==='run.completed')&&state.events.some(e=>e.type==='session.ready'));
 state.events.forEach((e,i)=>assert.equal(Number(e.sequence),i+1));
 assert.equal(Number(state.attempt.event_cursor),state.events.length);
 report.nativeEventCount=state.events.length;report.model=state.attempt.model;report.usage=state.attempt.usage;
 assert.equal(state.attempt.usage?.native?.status,'known','native token usage must be present; an empty object is not acceptance');
 assert.ok(state.attempt.usage.input_tokens>0&&state.attempt.usage.output_tokens>0);
 check('real Worker completes once and persists contiguous native events and per-attempt token usage');
 assert.equal(state.session.status,'paused');assert.equal(state.session.active_attempt_id,null);assert.ok(state.session.sandbox_id&&state.session.native_thread_id&&state.session.retained_until);
 check('the completed creative session pauses its real sandbox and releases its active attempt');
 assert.equal(state.turn.artboard_ids.length,1);const documentId=state.turn.artboard_ids[0];assert.ok(!before.documentIds.includes(documentId));
 const output=await tenantTransaction(fixture.workspaceId,async tx=>({
  document:(await tx.query('SELECT * FROM documents WHERE id=$1 AND project_id=$2',[documentId,fixture.projectId])).rows[0],
  versions:(await tx.query('SELECT revision,content FROM document_versions WHERE document_id=$1 ORDER BY revision',[documentId])).rows,
  refs:(await tx.query('SELECT version_id FROM asset_version_refs WHERE document_id=$1',[documentId])).rows,
  messages:(await tx.query('SELECT role FROM creative_messages WHERE turn_id=$1',[job.id])).rows,
 }));
 const src=`/api/assets/${fixture.assetId}/versions/${fixture.assetVersionId}/file`;
 assert.ok(output.document.content.nodes.some((n:any)=>n.type==='image'&&n.src===src));assert.ok(output.document.content.nodes.some((n:any)=>n.type==='text'&&String(n.text).includes('素材创作已完成')));
 assert.ok(output.versions.some(v=>v.revision===output.document.revision&&v.content.nodes.some((n:any)=>n.type==='image'&&n.src===src)));
 assert.ok(output.refs.some(r=>r.version_id===fixture.assetVersionId));
 assert.ok(state.board.content.results.some((r:any)=>r.documentId===documentId||r.id===documentId));
 assert.ok(output.messages.some(m=>m.role==='assistant'));assert.equal(state.generations,before.generations);
 report.documentId=documentId;report.documentRevision=output.document.revision;report.boardRevision=state.board.revision;report.assetVersionId=fixture.assetVersionId;
 await writeFile('artifacts/v2/agent-workflow-artboard.json',JSON.stringify(output.document.content,null,2));
 check('authorized editable document, history version, Board reference and immutable asset-version reference commit together');
 const observed=await Sandbox.connect(state.session.sandbox_id,{apiKey:runtime.apiKey,timeoutMs:60000});
 const cached=await observed.commands.run('python3 -c '+shellQuote(`import pathlib,hashlib; print(hashlib.sha256(pathlib.Path(${JSON.stringify(`/var/lib/designx/runs/${attemptId}/cache/${entry.sha256}`)}).read_bytes()).hexdigest())`),{user:'root',timeoutMs:20000});
 assert.equal(cached.stdout.trim(),entry.sha256);
 check('the real Agent opened the R2 material through the verified root cache without another image-generation request');
 assert.equal((await api('GET',`/ai-turns/${job.id}`)).json().status,'succeeded');
 assert.equal((await api('GET',`/projects/${fixture.projectId}/agent-session`)).json().session.status,'paused');
 check('refresh through the authenticated API restores the completed turn and persistent session');
 const exportRequest=await api('POST',`/projects/${fixture.projectId}/exports`,{documentId,format:'png',scale:1});assert.equal(exportRequest.statusCode,202);
 const exportJob=await tenantTransaction(fixture.workspaceId,async tx=>(await tx.query('SELECT * FROM jobs WHERE id=$1',[exportRequest.json().id])).rows[0]);
 assert.ok(exportJob.payload.assetVersions.some((v:any)=>v.assetVersionId===fixture.assetVersionId||v.versionId===fixture.assetVersionId));
 await (await startQueue()).cancel('render.export',exportJob.queue_id);
 await runBusinessJob({id:exportJob.queue_id,data:{jobId:exportJob.id,workspaceId:fixture.workspaceId}},renderExport);
 const exported=(await api('GET',`/jobs/${exportJob.id}`)).json();assert.equal(exported.status,'succeeded');
 const file=await api('GET',`/exports/${exportJob.id}/file`);assert.equal(file.statusCode,200);
 const metadata=await sharp(file.rawPayload).metadata();assert.equal(metadata.format,'png');assert.equal(metadata.width,output.document.content.width);assert.equal(metadata.height,output.document.content.height);
 assert.equal(createHash('sha256').update(file.rawPayload).digest('hex'),exported.result.sha256);
 assert.ok((await tenantTransaction(fixture.workspaceId,tx=>tx.query('SELECT 1 FROM storage_candidates WHERE object_key=$1 AND bucket=$2',[exported.result.objectKey,exported.result.storageBucket]))).rowCount);
 await writeFile('artifacts/v2/agent-workflow-export.png',file.rawPayload);
 report.export={jobId:exportJob.id,format:'png',width:metadata.width,height:metadata.height,bytes:file.rawPayload.length,sha256:exported.result.sha256,rendererVersion:exported.result.rendererVersion};
 check('real Renderer freezes the R2 asset version and exports a verified PNG through the authenticated download route');
 report.status='passed';
}catch(error){report.status='failed';report.error=safeRuntimeError(error).split(token).join('[REDACTED]').replace(/https?:\/\/[^\s"'<>]+/g,'[URL REDACTED]');process.exitCode=1;}
finally{
 if(watchdog)clearTimeout(watchdog);await stopRequest;
 let cleaned=true;
 try{
  if(attemptId){
   const row=await tenantTransaction(fixture.workspaceId,async tx=>(await tx.query('SELECT sandbox_id FROM ai_attempts WHERE id=$1',[attemptId])).rows[0]);
   const ids=new Set<string>([...(row?.sandbox_id?[row.sandbox_id]:[]),...await findSandboxesForExecution(attemptId)]);
   for(const id of ids)await killSandbox(id);
   await tenantTransaction(fixture.workspaceId,async tx=>{
    await tx.query("UPDATE creative_sessions SET status='idle',sandbox_id=NULL,native_thread_id=NULL,active_attempt_id=NULL,retained_until=NULL,boundary_reason='acceptance_cleanup',updated_at=now() WHERE project_id=$1 AND (active_attempt_id IS NULL OR active_attempt_id=$2)",[fixture.projectId,attemptId]);
    await tx.query("UPDATE ai_attempts SET status='closed',lease_until=NULL,updated_at=now() WHERE id=$1",[attemptId]);
   });
  }
  await pool.query('DELETE FROM sessions WHERE token_hash=$1',[tokenHash]);
 }catch{cleaned=false;report.status='failed';report.cleanupError='Acceptance sandbox or login-session cleanup incomplete';process.exitCode=1;}
 report.cleaned=cleaned;report.fixtureRetained=true;report.finishedAt=new Date().toISOString();await save();
 await closeBrowser();await app?.close();await stopQueue();await pool.end();
 console.log(JSON.stringify({status:report.status,checks:report.checks.length,cleaned,report:'artifacts/v2/agent-workflow-acceptance.json'}));
}
