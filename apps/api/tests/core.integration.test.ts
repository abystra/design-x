import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/server.js';
import {pool,tenantTransaction} from '../../../packages/server-infra/src/db.js';
import {stopQueue} from '../../../packages/server-infra/src/queue.js';
import {migrate} from '../../../db/migrate.js';

await migrate();
const app=await buildApp({logger:false});
const unique=randomUUID();
const cookies:string[]=[];
const request=async(method:string,url:string,payload?:any,actor=0,extra:any={})=>app.inject({method:method as any,url,payload,headers:{origin:'http://127.0.0.1:5173',...(cookies[actor]?{cookie:cookies[actor]}:{}),...extra}});
let project:any,workspaceId:string,secondWorkspaceId:string;
test.after(async()=>{await app.close();await stopQueue();await pool.end();});
test('registration, session cookie and authentication survive fresh API instance',async()=>{
 for(let i=0;i<2;i++){
  const response=await request('POST','/api/auth/register',{email:`integration-${unique}-${i}@example.test`,password:'correct-horse-designx',name:`Tester ${i}`},i);
  assert.equal(response.statusCode,201,response.body);
  cookies[i]=String(response.headers['set-cookie']).split(';')[0];
  assert.match(String(response.headers['set-cookie']),/HttpOnly/);
  if(i===0)workspaceId=response.json().workspace.id;else secondWorkspaceId=response.json().workspace.id;
 }
 assert.equal((await request('GET','/api/auth/me')).statusCode,200);
 assert.equal((await app.inject('/api/projects')).statusCode,401);
 const wrong=await request('POST','/api/auth/login',{email:`integration-${unique}-0@example.test`,password:'wrong-password'});assert.equal(wrong.statusCode,401);
 const csrf=await request('POST','/api/projects',{title:'No'},0,{origin:'https://attacker.invalid'});assert.equal(csrf.statusCode,403);
});
test('project create is durable, idempotent and isolated by workspace',async()=>{
 const body={title:'Persistent poster'};
 const response=await request('POST','/api/projects',body,0,{'idempotency-key':`project-${unique}`});assert.equal(response.statusCode,201,response.body);project=response.json();
 const replay=await request('POST','/api/projects',body,0,{'idempotency-key':`project-${unique}`});assert.equal(replay.json().id,project.id);
 const reused=await request('POST','/api/projects',{title:'Different'},0,{'idempotency-key':`project-${unique}`});assert.equal(reused.statusCode,409);
 assert.equal((await request('GET',`/api/projects/${project.id}`,undefined,1)).statusCode,404);
 assert.equal((await request('PATCH',`/api/projects/${project.id}`,{title:'Stolen'},1)).statusCode,404);
 const otherRows=await tenantTransaction(secondWorkspaceId,async tx=>(await tx.query('SELECT id FROM projects WHERE id=$1',[project.id])).rows);assert.equal(otherRows.length,0,'RLS must hide even a raw query missing workspace WHERE');
});
test('document saves reject lost updates and restore immutable versions',async()=>{
 const design={width:600,height:800,background:'#ffffff',nodes:[{id:'title',type:'text',text:'Saved 中文',x:20,y:20,w:400,h:70,size:28}]};
 const saved=await request('PATCH',`/api/projects/${project.id}`,{design,baseRevision:project.revision});assert.equal(saved.statusCode,200,saved.body);project=saved.json();
 assert.equal(project.design.nodes[0].text,'Saved 中文');assert.equal(project.revision,2);
 const stale=await request('PATCH',`/api/projects/${project.id}`,{design,baseRevision:1});assert.equal(stale.statusCode,409);
 const versions=(await request('GET',`/api/projects/${project.id}/versions`)).json();assert.equal(versions.length,2);
 const restored=await request('POST',`/api/projects/${project.id}/versions/${versions.find((v:any)=>v.revision===1).id}/restore`,{});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().design.nodes.length,0);
 const reopened=(await request('GET',`/api/projects/${project.id}`)).json();assert.equal(reopened.revision,3);
});
test('Board save hydrates authoritative Artboards and checks revision',async()=>{
 const current=(await request('GET',`/api/projects/${project.id}/studio`)).json();
 current.snapshot.draft='草稿内容';current.snapshot.results[0].position={x:130,y:75};
 current.snapshot.results[0].design={width:600,height:800,background:'#ff0000',nodes:[]};
 const response=await request('PUT',`/api/projects/${project.id}/studio`,{snapshot:current.snapshot,baseRevision:current.revision});assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().snapshot.results[0].design.background,'#ffffff','Board autosave must not overwrite Artboard contents');
 assert.equal(response.json().snapshot.results[0].position.x,130);assert.equal(response.json().snapshot.draft,'草稿内容');
 assert.equal((await request('PUT',`/api/projects/${project.id}/studio`,{snapshot:current.snapshot,baseRevision:current.revision})).statusCode,409);
});
test('folders, preferences, trash and restore persist without localStorage',async()=>{
 const folder=(await request('POST','/api/folders',{name:`Folder ${unique}`})).json();
 assert.equal((await request('PATCH',`/api/projects/${project.id}`,{title:'Renamed',folderId:folder.id})).statusCode,200);
 assert.equal((await request('PUT','/api/preferences/asset-favorites',['stock-coffee'])).statusCode,200);
 assert.deepEqual((await request('GET','/api/preferences/asset-favorites')).json(),['stock-coffee']);
 assert.equal((await request('GET','/api/preferences/asset-favorites',undefined,1)).json(),null);
 assert.equal((await request('DELETE',`/api/projects/${project.id}`)).statusCode,200);
 assert.equal((await request('GET',`/api/projects/${project.id}`)).statusCode,404);
 assert.ok((await request('GET','/api/projects?trash=1')).json().some((p:any)=>p.id===project.id));
 assert.equal((await request('POST',`/api/projects/${project.id}/restore`,{})).statusCode,200);
 assert.equal((await request('DELETE',`/api/folders/${folder.id}`)).statusCode,200);
 assert.equal((await request('GET',`/api/projects/${project.id}`)).json().folderId,null);
});
test('logout revokes the durable session',async()=>{
 assert.equal((await request('POST','/api/auth/logout',{})).statusCode,200);
 assert.equal((await request('GET','/api/auth/me')).statusCode,401);
});
