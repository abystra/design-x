import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {ImageProvider} from '../../../packages/server-infra/src/openai-images.js';
import 'dotenv/config';
import pg from 'pg';
import { disposeTestDatabase } from './helpers/database.js';
const adminUrl=process.env.DATABASE_URL||'postgres://designx:designx-local-only@127.0.0.1:55432/designx';
const admin=new pg.Client({connectionString:adminUrl});await admin.connect();
const databaseName=`designx_generation_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${databaseName}"`);
const isolatedUrl=new URL(adminUrl);isolatedUrl.pathname='/'+databaseName;process.env.DATABASE_URL=isolatedUrl.toString();
const {buildApp}=await import('../src/server.js');
const {migrate}=await import('../../../db/migrate.js');
const {pool,tenantTransaction}=await import('../../../packages/server-infra/src/db.js');
const {stopQueue}=await import('../../../packages/server-infra/src/queue.js');
const {ensureUploadStorage,getObject}=await import('../../../packages/server-infra/src/storage.js');
const {config}=await import('../../../packages/server-infra/src/config.js');
const {ImageProviderError}=await import('../../../packages/server-infra/src/openai-images.js');
const {submitGeneration,ingestGeneration,reconcileGenerations}=await import('../../worker/src/generation.js');
const {runBusinessJob}=await import('../../worker/src/process.js');
const {readGeneration}=await import('../../../packages/server-domain/src/generations.js');
const {ingestBufferAsset,linkProjectAsset}=await import('../../../packages/server-domain/src/assets.js');
await migrate();await ensureUploadStorage();
config.imageEnabled=true;if(!config.openaiApiKey)config.openaiApiKey='test-only-never-sent';
const app=await buildApp({logger:false,aiEnabled:true});let cookie='',ws='';
const bytes=await sharp({create:{width:96,height:128,channels:3,background:'#ddaa77'}}).png().toBuffer();
let calls=0;const provider:ImageProvider={moderate:async()=>true,generate:async()=>{calls++;return {encoded:bytes.toString('base64'),usage:{input_tokens:10,output_tokens:20},requestId:'fake-request-'+calls};}};
async function api(method:string,url:string,body?:any,key=randomUUID()){return app.inject({method:method as any,url,payload:body,headers:{cookie,origin:config.webOrigin,'idempotency-key':key}});}
async function project(){return (await api('POST','/api/projects',{title:'v2 generation test'})).json();}
async function start(projectId:string,body:any={},key=randomUUID()){const response=await api('POST',`/api/projects/${projectId}/generations`,{prompt:'a clear product photograph',...body},key);assert.equal(response.statusCode,202,response.body);return response.json().generation;}
async function submit(g:any,p=provider){const jobs=(await pool.query("SELECT j.* FROM jobs j JOIN generation_attempts a ON a.id=j.id WHERE a.request_id=$1 ORDER BY a.ordinal",[g.id])).rows;for(const job of jobs)await submitGeneration({id:job.queue_id,data:{jobId:job.id,workspaceId:ws}},p);return jobs;}
async function ingest(g:any,p=provider){const jobs=(await pool.query("SELECT j.* FROM jobs j JOIN generation_outputs o ON o.id=j.payload->>'outputId' WHERE j.kind='generation.ingest' AND o.request_id=$1 ORDER BY j.created_at",[g.id])).rows;for(const job of jobs)await runBusinessJob({id:job.queue_id,data:{jobId:job.id,workspaceId:ws}},j=>ingestGeneration(j,p));return jobs;}
async function read(g:any){return tenantTransaction(ws,tx=>readGeneration(tx,g.id));}
test.before(async()=>{const r=await app.inject({method:'POST',url:'/api/auth/register',payload:{email:`generation-${randomUUID()}@example.test`,password:'generation-tests-password',name:'Generation tester'}});assert.equal(r.statusCode,201,r.body);cookie=String(r.headers['set-cookie']).split(';')[0];ws=r.json().workspace.id;});
test.after(async()=>{await app.close();await stopQueue();await pool.end();await disposeTestDatabase(admin,databaseName);});
test('idempotent generation, duplicate deliveries and real media produce one immutable image Board item',async()=>{
 const p=await project(),key=randomUUID(),g=await start(p.id,{},key);assert.equal((await start(p.id,{},key)).id,g.id);
 const baseline=calls,jobs=await submit(g);await submit(g);assert.equal(calls,baseline+1);await ingest(g);await ingest(g);
 const result=await read(g);assert.equal(result.status,'succeeded');assert.equal(result.outputs.length,1);assert.equal(result.outputs[0].placementStatus,'board');
 const board=(await api('GET',`/api/projects/${p.id}/studio`)).json();const image=board.snapshot.results.find((r:any)=>r.kind==='image');assert.ok(image);assert.equal(image.assetVersionId,result.outputs[0].assetVersionId);assert.equal(image.documentId,undefined);
 assert.equal((await api('PUT',`/api/projects/${p.id}/studio`,{snapshot:board.snapshot,baseRevision:board.revision})).statusCode,200);
 const q=(await pool.query('SELECT used,reserved FROM quota_accounts WHERE workspace_id=$1',[ws])).rows[0];assert.equal(q.used,1);assert.equal(q.reserved,0);
 assert.equal((await api('POST',`/api/jobs/${jobs[0].id}/retry`,{})).statusCode,409);
});
test('partial success is explicit and unknown submission is never replayed; 24h releases user hold only',async()=>{
 const p=await project(),g=await start(p.id,{count:3});let n=0;
 const mixed:ImageProvider={...provider,generate:async(input)=>{n++;if(n===2)throw new ImageProviderError('rejected','rejected');if(n===3)throw new ImageProviderError('unknown','unknown');return provider.generate(input);}};
 await submit(g,mixed);await submit(g,mixed);assert.equal(n,3);await ingest(g);
 assert.equal((await read(g)).status,'unknown');
 await pool.query("UPDATE quota_reservations SET expires_at=now()-interval '1 minute' WHERE attempt_id IN (SELECT id FROM generation_attempts WHERE request_id=$1)",[g.id]);await reconcileGenerations();
 const result=await read(g);assert.equal(result.settlementStatus,'reconciliation_required');
 const call=(await pool.query("SELECT p.* FROM provider_calls p JOIN generation_attempts a ON a.id=p.attempt_id WHERE a.request_id=$1 AND a.execution_status='unknown'",[g.id])).rows[0];assert.equal(call.cost_usd,null);
});
test('project scoped input is frozen across versions and revoked permission blocks publication',async()=>{
 const p=await project(),p2=await project(),asset=await ingestBufferAsset(ws,{bytes,mime:'image/png',title:'reference',attemptId:randomUUID(),source:{kind:'test'},projectId:p.id});
 assert.equal((await api('POST',`/api/projects/${p2.id}/generations`,{prompt:'edit',referenceAssetIds:[asset.assetId]})).statusCode,403);
 const g=await start(p.id,{referenceAssetIds:[asset.assetId]});
 await ingestBufferAsset(ws,{assetId:asset.assetId,bytes,mime:'image/png',title:'new version',attemptId:randomUUID(),source:{kind:'test'},projectId:p.id});
 assert.equal((await read(g)).references[0].assetVersionId,asset.assetVersionId);await submit(g);
 await api('DELETE',`/api/projects/${p.id}/assets/${asset.assetId}`);
 await assert.rejects(()=>ingest(g));assert.equal((await read(g)).outputs[0].assetId,null);
});
test('deleted/changed target keeps generated media in library, and cancel during provider call prevents attachment',async()=>{
 const p=await project(),g=await start(p.id,{targetDocumentId:p.documentId,baseRevision:p.revision});await submit(g);
 await api('PATCH',`/api/projects/${p.id}/artboards/${p.documentId}`,{baseRevision:p.revision,design:{...p.design,background:'#000000'}});await ingest(g);assert.equal((await read(g)).outputs[0].placementStatus,'library');
 const cancelled=await start(p.id);await submit(cancelled,{...provider,generate:async(input)=>{await api('POST',`/api/generations/${cancelled.id}/cancel`,{});return provider.generate(input);}});assert.equal((await read(cancelled)).status,'cancelled');assert.equal((await read(cancelled)).outputs.length,0);
});
test('Recipe creates independently editable text/brand layers and resize preserves source',async()=>{
 const p=await project();const response=await api('POST',`/api/projects/${p.id}/recipes`,{recipeId:'marketing-poster',recipeVersion:1,parameters:{prompt:'a product on stone',headline:'中文标题',brand:'品牌',subheadline:'独立文案',cta:'了解更多'}});assert.equal(response.statusCode,202,response.body);
 const g=response.json().generation;await submit(g);await ingest(g);const result=await read(g),board=(await api('GET',`/api/projects/${p.id}/studio`)).json();const art=board.snapshot.results.find((r:any)=>r.id===result.outputs[0].documentIds[0]);
 assert.ok(art.design.nodes.some((n:any)=>n.id==='brand'&&n.type==='text'));assert.ok(art.design.nodes.some((n:any)=>n.id==='headline'&&n.type==='text'));
 const resized=await api('POST',`/api/projects/${p.id}/recipes`,{recipeId:'multi-size',recipeVersion:1,parameters:{documentId:art.id,sizes:[{width:800,height:800}]}});assert.equal(resized.statusCode,201,resized.body);assert.equal(resized.json().artboards[0].design.width,800);assert.notEqual(resized.json().artboards[0].id,art.id);
});
test('a two-image batch retains partial success and generation records are tenant isolated',async()=>{
 const p=await project(),g=await start(p.id,{count:2});let counter=0;
 await submit(g,{...provider,generate:async input=>{if(++counter===2)throw new ImageProviderError('rejected','rejected');return provider.generate(input);}});await ingest(g);
 const result=await read(g);assert.equal(result.status,'partial');assert.equal(result.outputs.filter((o:any)=>o.status==='ready').length,1);
 const foreign=await app.inject({method:'POST',url:'/api/auth/register',payload:{email:`foreign-${randomUUID()}@example.test`,password:'foreign-generation-test',name:'Other workspace'}});
 const rejected=await app.inject({method:'GET',url:`/api/generations/${g.id}`,headers:{cookie:String(foreign.headers['set-cookie']).split(';')[0]}});assert.equal(rejected.statusCode,404);
});
