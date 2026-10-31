import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/server.js';
import {pool,tenantTransaction} from '../../../packages/server-infra/src/db.js';
import {startQueue,stopQueue} from '../../../packages/server-infra/src/queue.js';
import {createJob,updateJob} from '../../../packages/server-domain/src/jobs.js';
import {migrate} from '../../../db/migrate.js';
await migrate();
const app=await buildApp({logger:false});
const register=await app.inject({method:'POST',url:'/api/auth/register',payload:{email:`safety-${randomUUID()}@example.test`,password:'correct-horse-designx',name:'Safety'}});
const cookie=String(register.headers['set-cookie']).split(';')[0],workspace=register.json().workspace.id;
const request=(method:string,url:string,payload?:any,headers:any={})=>app.inject({method:method as any,url,payload,headers:{cookie,...headers}});
let project:any;
test.after(async()=>{await app.close();await stopQueue();await pool.end();});
test('atomic business writes and queue dispatch roll back together',async()=>{
 let jobId='',queueId='';
 await assert.rejects(tenantTransaction(workspace,async tx=>{
  const job=await createJob(tx,workspace,'render.export',{design:{width:16,height:16,background:'#ffffff',nodes:[]},format:'png'});jobId=job.id;
  queueId=(await tx.query('SELECT queue_id FROM jobs WHERE id=$1',[jobId])).rows[0].queue_id;
  throw new Error('Abort business transaction');
 }),/Abort business transaction/);
 assert.equal((await tenantTransaction(workspace,tx=>tx.query('SELECT id FROM jobs WHERE id=$1',[jobId]))).rowCount,0);
 assert.equal(await(await startQueue()).getJobById('render.export',queueId),null);
});
test('shared document ops are replay-safe, reversible and reject invalid sources',async()=>{
 project=(await request('POST','/api/projects',{title:'Ops test'})).json();
 const node={id:'title',type:'text',x:10,y:10,w:200,h:50,text:'文档操作',size:20};
 const body={baseRevision:1,clientOpId:randomUUID(),ops:[{type:'put',node,index:0}]};
 const response=await request('POST',`/api/documents/${project.documentId}/ops`,body);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().revision,2);
 assert.equal((await request('POST',`/api/documents/${project.documentId}/ops`,body)).json().revision,2);
 assert.equal((await request('POST',`/api/documents/${project.documentId}/ops`,{...body,ops:[]})).statusCode,409);
 const logged=(await request('GET',`/api/documents/${project.documentId}/ops?since=1`)).json();assert.equal(logged.length,1);assert.deepEqual(logged[0].ops,body.ops);
 const invalid=await request('POST',`/api/documents/${project.documentId}/ops`,{baseRevision:2,clientOpId:randomUUID(),ops:[{type:'put',index:1,node:{id:'unsafe',type:'image',x:0,y:0,w:20,h:20,src:'http://169.254.169.254/latest/meta-data/'}}]});assert.equal(invalid.statusCode,400);
 const undo=await request('POST',`/api/documents/${project.documentId}/ops`,{baseRevision:2,clientOpId:randomUUID(),ops:[{type:'remove',id:'title'}]});assert.equal(undo.statusCode,200,undo.body);assert.equal(undo.json().content.nodes.length,0);
});
test('an expired execution cannot overwrite a newer fenced attempt',async()=>{
 const jobId=randomUUID(),currentToken=randomUUID();
 await tenantTransaction(workspace,tx=>tx.query("INSERT INTO jobs(id,workspace_id,kind,status,payload,execution_token) VALUES($1,$2,'render.export','running','{}',$3)",[jobId,workspace,currentToken]));
 await updateJob(workspace,jobId,{status:'succeeded',result:{bad:true}},'obsolete-execution');
 const afterOld=await tenantTransaction(workspace,async tx=>(await tx.query('SELECT * FROM jobs WHERE id=$1',[jobId])).rows[0]);assert.equal(afterOld.status,'running');assert.equal(afterOld.result,null);
 await updateJob(workspace,jobId,{status:'succeeded',progress:100,result:{valid:true}},currentToken);
 const afterNew=await tenantTransaction(workspace,async tx=>(await tx.query('SELECT * FROM jobs WHERE id=$1',[jobId])).rows[0]);assert.equal(afterNew.status,'succeeded');assert.equal(afterNew.result.valid,true);
});
test('concurrent export retries share one immutable job',async()=>{
 const headers={'idempotency-key':randomUUID()},body={format:'png',scale:1};
 const [a,b]=await Promise.all([request('POST',`/api/projects/${project.id}/exports`,body,headers),request('POST',`/api/projects/${project.id}/exports`,body,headers)]);
 assert.equal(a.statusCode,202,a.body);assert.equal(b.statusCode,202,b.body);assert.equal(a.json().id,b.json().id);
});

test('trash hides exports/jobs and cancels pending work until project restore',async()=>{
 const created=(await request('POST','/api/projects',{title:'Trash boundaries'})).json();
 const jobId=randomUUID();
 await tenantTransaction(workspace,tx=>tx.query("INSERT INTO jobs(id,workspace_id,project_id,kind,status,payload) VALUES($1,$2,$3,'render.export','queued','{}')",[jobId,workspace,created.id]));
 assert.equal((await request('DELETE',`/api/projects/${created.id}`)).statusCode,200);
 assert.equal((await request('GET',`/api/jobs/${jobId}`)).statusCode,404);
 assert.equal((await request('POST',`/api/jobs/${jobId}/retry`,{})).statusCode,404);
 assert.equal((await request('GET',`/api/exports/${jobId}/file`)).statusCode,404);
 assert.equal((await request('POST',`/api/projects/${created.id}/versions`,{})).statusCode,404);
 assert.equal((await request('POST',`/api/projects/${created.id}/restore`,{})).statusCode,200);
 assert.equal((await request('GET',`/api/jobs/${jobId}`)).json().status,'cancelled');
});
test('asset deletion protects historical designs and brand references',async()=>{
 const assetId=randomUUID(),brandAssetId=randomUUID();
 for(const a of [assetId,brandAssetId])await tenantTransaction(workspace,tx=>tx.query("INSERT INTO assets(id,workspace_id,title,mime,bytes,object_key,status) VALUES($1,$2,'Reference fixture','image/png',1,$3,'ready')",[a,workspace,`${workspace}/fixtures/${a}`]));
 const image=`/api/assets/${assetId}/file`;
 const design={width:100,height:100,background:'#ffffff',nodes:[{id:'photo',type:'image',x:0,y:0,w:100,h:100,src:image}]};
 const created=(await request('POST','/api/projects',{title:'Version reference',design})).json();
 assert.equal((await request('PATCH',`/api/projects/${created.id}`,{design:{...design,nodes:[]},baseRevision:created.revision})).statusCode,200);
 assert.equal((await request('DELETE',`/api/assets/${assetId}`)).statusCode,409,'Historical version must remain restorable');
 assert.equal((await request('PUT','/api/preferences/brand',{name:'Reference brand',colors:['#ffffff'],logo:`/api/assets/${brandAssetId}/file`})).statusCode,200);
 assert.equal((await request('DELETE',`/api/assets/${brandAssetId}`)).statusCode,409);
 assert.equal((await request('PUT','/api/preferences/brand',{name:'Reference brand',colors:['#ffffff']})).statusCode,200);
 assert.equal((await request('DELETE',`/api/assets/${brandAssetId}`)).statusCode,200);
});
