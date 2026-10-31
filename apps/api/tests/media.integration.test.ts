import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import sharp from 'sharp';
import {buildApp} from '../src/server.js';
import {pool} from '../../../packages/server-infra/src/db.js';
import {stopQueue} from '../../../packages/server-infra/src/queue.js';
import {migrate} from '../../../db/migrate.js';

await migrate();
const app=await buildApp({logger:false});
const actors:string[]=[];let asset:any,project:any;
const children:ChildProcess[]=[];let logs='';
function child(path:string){const processHandle=spawn(process.execPath,['--import','tsx',path],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});children.push(processHandle);processHandle.stdout?.on('data',d=>{logs+=String(d);});processHandle.stderr?.on('data',d=>{logs+=String(d);});return processHandle;}
async function request(method:string,url:string,payload?:any,actor=0,headers:any={}){return app.inject({method:method as any,url,payload,headers:{origin:'http://127.0.0.1:5173',cookie:actors[actor],...headers}});}
async function until(fn:()=>Promise<any>,predicate:(v:any)=>boolean,ms=45000){const start=Date.now();let value:any;while(Date.now()-start<ms){value=await fn();if(predicate(value))return value;await sleep(250);}throw new Error(`Timed out: ${JSON.stringify(value)}\n${logs}`);}
async function waitJob(jobId:string){return until(async()=>(await request('GET',`/api/jobs/${jobId}`)).json(),j=>['succeeded','failed','cancelled'].includes(j.status));}
test.after(async()=>{
 for(const c of children)c.kill('SIGTERM');
 await Promise.all(children.map(c=>c.exitCode!==null?Promise.resolve():new Promise<void>(resolve=>{c.once('exit',()=>resolve());setTimeout(()=>{c.kill('SIGKILL');resolve();},5000).unref();})));
 await app.close();await stopQueue();await pool.end();
});
test('real upload enters S3 and is decoded by a separate media worker',async()=>{
 for(let i=0;i<2;i++){const r=await app.inject({method:'POST',url:'/api/auth/register',payload:{email:`media-${randomUUID()}@example.test`,password:'correct-horse-designx',name:'Media tester'}});assert.equal(r.statusCode,201,r.body);actors.push(String(r.headers['set-cookie']).split(';')[0]);}
 child('apps/worker/src/main.ts');
 const bytes=await sharp({create:{width:240,height:180,channels:3,background:'#ef644d'}}).png().toBuffer();
 const boundary=`dx-${randomUUID()}`;
 const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 const response=await request('POST','/api/assets',payload,0,{'content-type':`multipart/form-data; boundary=${boundary}`});assert.equal(response.statusCode,202,response.body);asset=response.json();
 asset=await until(async()=>(await request('GET','/api/assets')).json().find((a:any)=>a.id===asset.id),a=>a?.status==='ready');
 assert.equal(asset.width,240);assert.equal(asset.height,180);
 const file=await request('GET',asset.image);assert.equal(file.statusCode,200,file.body);assert.equal((await sharp(file.rawPayload).metadata()).width,240);
 assert.equal((await request('GET',asset.image,undefined,1)).statusCode,404);
 const thumb=await request('GET',asset.thumbnail);assert.equal((await sharp(thumb.rawPayload).metadata()).format,'webp');
});
test('export jobs persist while renderer is offline, queued cancellation is durable',async()=>{
 const design={width:320,height:240,background:'#ffffff',nodes:[{id:'image',type:'image',src:asset.image,x:0,y:0,w:320,h:240},{id:'text',type:'text',text:'中文导出测试',x:20,y:30,w:280,h:70,size:25,color:'#ffffff'}]};
 const created=await request('POST','/api/projects',{title:'真实导出',design});assert.equal(created.statusCode,201,created.body);project=created.json();
 assert.equal((await request('DELETE',`/api/assets/${asset.id}`)).statusCode,409,'Referenced media cannot be deleted');
 const cancelled=await request('POST',`/api/projects/${project.id}/exports`,{format:'png'});assert.equal(cancelled.statusCode,202,cancelled.body);
 assert.equal((await request('POST',`/api/jobs/${cancelled.json().id}/cancel`,{})).json().status,'cancelled');
 const queued=await request('POST',`/api/projects/${project.id}/exports`,{format:'png',scale:2});assert.equal(queued.statusCode,202,queued.body);assert.equal(queued.json().status,'queued');
 const stored=(await pool.query('SELECT status FROM jobs WHERE id=$1',[queued.json().id])).rows[0];assert.equal(stored.status,'queued');
 child('apps/renderer/src/main.ts');
 const completed=await waitJob(queued.json().id);assert.equal(completed.status,'succeeded',JSON.stringify(completed)+'\n'+logs);
 const output=await request('GET',completed.downloadUrl);assert.equal(output.statusCode,200,output.body);
 const meta=await sharp(output.rawPayload).metadata();assert.equal(meta.width,640);assert.equal(meta.height,480);
 assert.equal((await request('GET',completed.downloadUrl,undefined,1)).statusCode,404);
 assert.equal((await request('GET',`/api/jobs/${cancelled.json().id}`)).json().status,'cancelled');
});
test('JPEG, WebP, PDF, SVG and portable project exports contain real output',async()=>{
 for(const format of ['jpeg','webp','pdf','svg','dxproj']){
  const response=await request('POST',`/api/projects/${project.id}/exports`,{format,scale:1});assert.equal(response.statusCode,202,response.body);
  const completed=await waitJob(response.json().id);assert.equal(completed.status,'succeeded',`${format}: ${JSON.stringify(completed)}\n${logs}`);
  const output=await request('GET',completed.downloadUrl);assert.equal(output.statusCode,200);assert.ok(output.rawPayload.length>100);
  if(format==='jpeg'||format==='webp')assert.equal((await sharp(output.rawPayload).metadata()).format,format);
  if(format==='pdf')assert.equal(output.rawPayload.subarray(0,5).toString(),'%PDF-');
  if(format==='svg')assert.match(output.rawPayload.toString(),/^<svg/);
  if(format==='dxproj'){const exported=output.json();assert.equal(exported.format,'designx.project');assert.ok(exported.documents.some((d:any)=>d.kind==='board'));assert.ok(exported.assets[asset.image].startsWith('data:image/png;base64,'));}
 }
});
