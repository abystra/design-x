import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import pg from 'pg';
import sharp from 'sharp';

// An isolated real database makes the test safe while the local development workers keep running.
const adminUrl=process.env.DATABASE_URL||'postgres://designx:designx-local-only@127.0.0.1:55432/designx';
const dbName=`designx_import_test_${randomUUID().replaceAll('-','')}`;
const admin=new pg.Client({connectionString:adminUrl});await admin.connect();
await admin.query(`CREATE DATABASE "${dbName}"`);
const isolatedUrl=new URL(adminUrl);isolatedUrl.pathname=`/${dbName}`;process.env.DATABASE_URL=isolatedUrl.toString();
const {buildApp}=await import('../src/server.js');
const {pool,tenantTransaction}=await import('../../../packages/server-infra/src/db.js');
const {stopQueue}=await import('../../../packages/server-infra/src/queue.js');
const {storage,deleteObject,putObject}=await import('../../../packages/server-infra/src/storage.js');
const {config}=await import('../../../packages/server-infra/src/config.js');
const {ListObjectsV2Command}=await import('@aws-sdk/client-s3');
const {migrate}=await import('../../../db/migrate.js');
await migrate();const app=await buildApp({logger:false});
const actors:{cookie:string,workspaceId:string}[]=[];const children:ChildProcess[]=[];let logs='';
for(let i=0;i<2;i++){
 const registered=await app.inject({method:'POST',url:'/api/auth/register',payload:{email:`import-${randomUUID()}@example.test`,password:'correct-horse-designx',name:`Importer ${i}`}});
 assert.equal(registered.statusCode,201,registered.body);actors.push({cookie:String(registered.headers['set-cookie']).split(';')[0],workspaceId:registered.json().workspace.id});
}
function start(path:string){const child=spawn(process.execPath,['--import','tsx',path],{env:process.env,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout?.on('data',data=>{logs+=data;});child.stderr?.on('data',data=>{logs+=data;});}
let fixtureClient=0;
test.beforeEach(()=>{fixtureClient++;});
// Distinct test clients retain the real per-IP import rate limit without a production bypass.
const request=(method:string,url:string,payload?:any,actor=0,headers:any={})=>app.inject({method:method as any,url,payload,remoteAddress:`192.0.2.${fixtureClient}`,headers:{cookie:actors[actor].cookie,origin:'http://127.0.0.1:5173',...headers}});
async function upload(packet:any,actor=0,key?:string){
 const bytes=Buffer.isBuffer(packet)?packet:Buffer.from(JSON.stringify(packet));const boundary=`dx-${randomUUID()}`;
 const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="project.dxproj"\r\nContent-Type: application/json\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 return request('POST','/api/projects/import',payload,actor,{'content-type':`multipart/form-data; boundary=${boundary}`,...(key?{'idempotency-key':key}:{})});
}
async function until<T>(get:()=>Promise<T>,ready:(value:T)=>boolean,timeout=45000){const start=Date.now();let last:T|undefined;while(Date.now()-start<timeout){last=await get();if(ready(last))return last;await sleep(200);}throw new Error(`Timed out: ${JSON.stringify(last)}\n${logs}`);}
const waitJob=(id:string,actor=0)=>until(async()=>(await request('GET',`/api/jobs/${id}`,undefined,actor)).json(),(job:any)=>job.status==='succeeded'||(job.status==='failed'&&job.attempts>=3));
const imageA=await sharp({create:{width:80,height:60,channels:3,background:'#ef644d'}}).png().toBuffer();
const imageB=await sharp({create:{width:40,height:30,channels:3,background:'#254f3a'}}).png().toBuffer();
const oldImage='/api/assets/source-private-one/file',boardImage='/api/assets/source-private-two/file';
const fixture={format:'designx.project',schemaVersion:1,title:'便签与分区项目',primaryArtboardId:'hidden-primary',documents:[
 {id:'visible-artboard',kind:'artboard',title:'可见画板',revision:7,content:{width:200,height:150,background:'#ffffff',nodes:[{id:'source-image-node',type:'image',src:oldImage,x:0,y:0,w:200,h:150},{id:'source-title-node',type:'text',text:'可编辑中文',groupId:'old-group',x:10,y:15,w:160,h:40,size:20}]}},
 {id:'hidden-primary',kind:'artboard',title:'保留的主画板',revision:4,content:{width:100,height:100,background:'#ffccaa',nodes:[{id:'hidden-label',type:'text',text:'主图不是数组第一项',x:5,y:5,w:90,h:80,size:16}]}},
 {id:'source-board-document',kind:'board',title:'源工作区',revision:9,content:{id:'source-project',title:'便签与分区项目',results:[{id:'visible-artboard',documentId:'visible-artboard',projectId:'source-project',title:'可见画板',image:oldImage,position:{x:120,y:80}}],notes:[{id:'source-note',text:'/assets/logo.png\nhttps://example.test\njavascript:literal text',position:{x:480,y:90},width:240,height:180,color:'#fff0b3'}],sections:[{id:'source-section',title:'资料分区',position:{x:80,y:50},width:800,height:400,color:'#edf2ef',itemIds:['visible-artboard','source-note']}],assets:[{id:'source-private-two',name:'仅工作区引用的图片',url:boardImage,assetId:'source-private-two'}],attached:[{id:'source-private-two',url:boardImage,asset_id:'source-private-two'}],messages:[{id:'source-message',role:'user',text:'文字保留',assets:[{id:'source-private-two',url:boardImage}],resultIds:['visible-artboard']}],selected:'source-note',selection:['visible-artboard','source-note'],view:{x:17,y:34,zoom:0.75},draft:'/api/assets/source-private-one/file',workspaceId:'old-workspace',ownerId:'old-owner'}},
],assets:{[oldImage]:`data:image/png;base64,${imageA.toString('base64')}`,[boardImage]:`data:image/png;base64,${imageB.toString('base64')}`}};
let imported:any,firstJobId='',firstKey=randomUUID();

test.after(async()=>{
 for(const child of children)child.kill('SIGTERM');
 await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():new Promise<void>(resolve=>{child.once('exit',()=>resolve());setTimeout(()=>{child.kill('SIGKILL');resolve();},5000).unref();})));
 await app.close();await stopQueue();
 try{
  const assets=(await pool.query('SELECT object_key,thumbnail_key FROM assets')).rows;
  const jobs=(await pool.query('SELECT payload,result FROM jobs')).rows;
  const keys=new Set<string>([...assets.flatMap(row=>[row.object_key,row.thumbnail_key]),...jobs.flatMap(row=>[row.payload.sourceKey,...(row.payload.importStaging||[]),row.result?.objectKey])].filter(Boolean));
  for(const key of keys)await deleteObject(key).catch(()=>{});
 }finally{await pool.end();await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);await admin.end();}
});

test('invalid JSON, versions, references, duplicate IDs and resource limits reject before project creation',async()=>{
 const variants:any[]=[Buffer.from('{bad json'),{...fixture,schemaVersion:2},{...fixture,documents:[...fixture.documents,fixture.documents[0]]},{...fixture,assets:{[oldImage]:fixture.assets[oldImage]}},{...fixture,assets:{...fixture.assets,'https://attacker.invalid/a.png':fixture.assets[oldImage]}},{...fixture,documents:[{...fixture.documents[0],kind:'script'}]}, {...fixture,assets:{...fixture.assets,[oldImage]:'data:image/png;base64,invalid==='}}];
 for(const packet of variants){const response=await upload(packet);assert.equal(response.statusCode,422,response.body);}
 for(const src of [undefined,'']){const packet=structuredClone(fixture) as any;packet.documents[0].content.nodes[0].src=src;const response=await upload(packet);assert.equal(response.statusCode,422,response.body);}
 const oversized=await upload(Buffer.alloc(40*1024*1024+1,32));assert.equal(oversized.statusCode,413,oversized.body);assert.match(oversized.json().message,/40/);
 const projects=(await request('GET','/api/projects')).json();assert.equal(projects.length,0);
 const jobs=(await request('GET','/api/jobs')).json();assert.equal(jobs.length,0);
});

test('cancelled queued import creates no project or assets',async()=>{
 const response=await upload(fixture);assert.equal(response.statusCode,202,response.body);
 assert.equal((await request('POST',`/api/jobs/${response.json().id}/cancel`,{})).json().status,'cancelled');
 assert.equal((await request('GET','/api/projects')).json().length,0);assert.equal((await request('GET','/api/assets')).json().length,0);
 // Emulate a process killed after uploading an object: no catch handler gets to run.
 const abandonedKey=`${actors[0].workspaceId}/imports/${response.json().id}/abandoned-attempt/object.png`;
 await putObject(abandonedKey,imageA,'image/png');
 await tenantTransaction(actors[0].workspaceId,tx=>tx.query("UPDATE jobs SET payload=jsonb_set(payload,'{importStaging}',$1::jsonb),updated_at=now()-interval '1 minute' WHERE id=$2",[JSON.stringify([abandonedKey]),response.json().id]));
 const {reconcileJobs}=await import('../../worker/src/reconcile.js');await reconcileJobs();
 const abandoned=await storage.send(new ListObjectsV2Command({Bucket:config.s3Bucket,Prefix:abandonedKey}));assert.equal(abandoned.Contents?.length||0,0);
 const afterCleanup=await tenantTransaction(actors[0].workspaceId,async tx=>(await tx.query('SELECT payload FROM jobs WHERE id=$1',[response.json().id])).rows[0]);assert.deepEqual(afterCleanup.payload.importStaging,[]);
 start('apps/worker/src/main.ts');start('apps/renderer/src/main.ts');
});

test('portable import copies private media and remaps documents, nodes, notes, sections and every selection',async()=>{
 const response=await upload(fixture,0,firstKey);assert.equal(response.statusCode,202,response.body);firstJobId=response.json().id;
 const completed=await waitJob(firstJobId);assert.equal(completed.status,'succeeded',JSON.stringify(completed)+'\n'+logs);
 imported=(await request('GET',`/api/projects/${completed.result.projectId}`)).json();
 assert.equal(imported.title,fixture.title);assert.equal(imported.design.nodes[0].text,'主图不是数组第一项');
 assert.notEqual(imported.id,'source-project');assert.notEqual(imported.documentId,'hidden-primary');
 const state=(await request('GET',`/api/projects/${imported.id}/studio`)).json().snapshot;
 assert.equal(state.results.length,1);assert.equal(state.notes[0].text,(fixture.documents[2].content as any).notes[0].text);
 assert.notEqual(state.notes[0].id,'source-note');assert.notEqual(state.sections[0].id,'source-section');
 assert.deepEqual(state.sections[0].itemIds,[state.results[0].id,state.notes[0].id]);assert.deepEqual(state.selection,[state.results[0].id,state.notes[0].id]);assert.equal(state.selected,state.notes[0].id);
 assert.equal(state.view.zoom,0.75);assert.equal(state.draft,'/api/assets/source-private-one/file','Human draft text must remain literal');assert.equal(state.workspaceId,undefined);assert.equal(state.ownerId,undefined);
 assert.equal(state.results[0].projectId,imported.id);assert.notEqual(state.results[0].design.nodes[0].id,'source-image-node');assert.notEqual(state.results[0].design.nodes[1].groupId,'old-group');
 const assets=(await request('GET','/api/assets')).json();assert.equal(assets.length,2);
 assert.ok(assets.some((asset:any)=>asset.id===state.attached[0].asset_id));assert.ok(assets.some((asset:any)=>asset.id===state.assets[0].assetId));
 for(const asset of assets){assert.equal((await request('GET',asset.image)).statusCode,200);assert.equal((await request('GET',asset.image,undefined,1)).statusCode,404);}
 const count=await tenantTransaction(actors[0].workspaceId,async tx=>(await tx.query("SELECT id FROM documents WHERE project_id=$1 AND kind='artboard'",[imported.id])).rowCount);assert.equal(count,2,'Hidden retained Artboards must survive import');
});

test('replaying import request or delivery cannot duplicate a successful project',async()=>{
 const before=(await request('GET','/api/projects')).json().length;
 const replay=await upload(fixture,0,firstKey);assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().id,firstJobId);
 const row=await tenantTransaction(actors[0].workspaceId,async tx=>(await tx.query('SELECT * FROM jobs WHERE id=$1',[firstJobId])).rows[0]);
 const {runBusinessJob}=await import('../../worker/src/process.js');const {importProject}=await import('../../worker/src/import-project.js');
 await runBusinessJob({id:row.queue_id,data:{jobId:row.id,workspaceId:row.workspace_id}},importProject);
 assert.equal((await request('GET','/api/projects')).json().length,before);
});

test('real export reimported into a second account remains editable with independently owned assets',async()=>{
 const initial=(await request('GET',`/api/projects/${imported.id}/studio`)).json();
 const fileUrl=initial.snapshot.assets[0].url,thumbnailUrl=fileUrl.replace('/file','/thumbnail');
 initial.snapshot.assets[0].thumbnail=thumbnailUrl;
 initial.snapshot.attached.push({id:initial.snapshot.assets[0].id,assetId:initial.snapshot.assets[0].id,url:thumbnailUrl});
 const stored=await request('PUT',`/api/projects/${imported.id}/studio`,{snapshot:initial.snapshot,baseRevision:initial.revision});assert.equal(stored.statusCode,200,stored.body);
 const originalFile=await request('GET',fileUrl),originalThumbnail=await request('GET',thumbnailUrl);
 assert.equal(originalFile.headers['content-type'],'image/png');assert.equal(originalThumbnail.headers['content-type'],'image/webp');
 const exported=await request('POST',`/api/projects/${imported.id}/exports`,{format:'dxproj'});assert.equal(exported.statusCode,202,exported.body);
 const done=await waitJob(exported.json().id);assert.equal(done.status,'succeeded',JSON.stringify(done)+'\n'+logs);
 const downloaded=await request('GET',done.downloadUrl);assert.equal(downloaded.statusCode,200);
 const packet=downloaded.json();assert.equal(packet.title,fixture.title);assert.equal(packet.primaryArtboardId,imported.documentId);
 const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
 for(const [url,response] of [[fileUrl,originalFile],[thumbnailUrl,originalThumbnail]] as const){
  assert.ok(packet.assets[url].startsWith(`data:${response.headers['content-type']};base64,`));
  assert.equal(hash(Buffer.from(packet.assets[url].split(',')[1],'base64')),hash(response.rawPayload),'Export must preserve each exact authorized object');
 }
 assert.notEqual(packet.assets[fileUrl],packet.assets[thumbnailUrl]);
 const sourceState=(await request('GET',`/api/projects/${imported.id}/studio`)).json().snapshot;
 assert.ok(packet.assets[sourceState.assets[0].url],'Board-only private material must be embedded');
 const accepted=await upload(downloaded.rawPayload,1);assert.equal(accepted.statusCode,202,accepted.body);
 const importedAgain=await waitJob(accepted.json().id,1);assert.equal(importedAgain.status,'succeeded',JSON.stringify(importedAgain));
 assert.notEqual(importedAgain.result.projectId,imported.id);
 const dest=(await request('GET',`/api/projects/${importedAgain.result.projectId}/studio`,undefined,1)).json().snapshot;
 assert.equal(dest.notes[0].text,sourceState.notes[0].text);assert.notEqual(dest.notes[0].id,sourceState.notes[0].id);assert.notEqual(dest.assets[0].url,sourceState.assets[0].url);
 assert.equal((await request('GET',dest.assets[0].url,undefined,1)).statusCode,200);assert.equal((await request('GET',dest.assets[0].url,undefined,0)).statusCode,404);
 assert.equal((await request('GET',sourceState.assets[0].url,undefined,1)).statusCode,404);
 const importedThumbnail=await request('GET',dest.assets[0].thumbnail,undefined,1);assert.equal(importedThumbnail.statusCode,200);
 assert.equal(importedThumbnail.headers['content-type'],'image/png');
 assert.equal(hash(importedThumbnail.rawPayload),hash(await sharp(originalThumbnail.rawPayload).rotate().png().toBuffer()),'Imported thumbnail keeps the selected bytes through safe PNG normalization');
 assert.notEqual(dest.assets[0].thumbnail,dest.assets[0].url);
 const thumbnailRecord=dest.attached.at(-1);assert.equal(thumbnailRecord.url,dest.assets[0].thumbnail);assert.equal(thumbnailRecord.assetId,thumbnailRecord.id);
 const artboard=dest.results[0];artboard.design.nodes.find((node:any)=>node.type==='text').text='再次导入后仍可编辑';
 const saved=await request('PATCH',`/api/projects/${importedAgain.result.projectId}/artboards/${artboard.documentId}`,{design:artboard.design,baseRevision:artboard.revision},1);assert.equal(saved.statusCode,200,saved.body);
});

test('schemaVersion 1 packages without primary ID or authored Board objects remain importable',async()=>{
 const legacy=structuredClone(fixture) as any;delete legacy.primaryArtboardId;delete legacy.documents[2].content.notes;delete legacy.documents[2].content.sections;delete legacy.documents[2].content.selection;delete legacy.documents[2].content.selected;
 const accepted=await upload(legacy);assert.equal(accepted.statusCode,202,accepted.body);
 const completed=await waitJob(accepted.json().id);assert.equal(completed.status,'succeeded',JSON.stringify(completed));
 const state=(await request('GET',`/api/projects/${completed.result.projectId}/studio`)).json().snapshot;assert.deepEqual(state.notes,[]);assert.deepEqual(state.sections,[]);
});

test('bad image decoding never creates a partial project or asset library entry',async()=>{
 const packet=structuredClone(fixture);packet.assets[oldImage]='data:image/png;base64,'+Buffer.from('not an image').toString('base64');
 const beforeProjects=(await request('GET','/api/projects')).json().length,beforeAssets=(await request('GET','/api/assets')).json().length;
 const accepted=await upload(packet);assert.equal(accepted.statusCode,202,accepted.body);
 const done=await waitJob(accepted.json().id);assert.equal(done.status,'failed');assert.match(done.error,/解码/);
 assert.equal((await request('GET','/api/projects')).json().length,beforeProjects);assert.equal((await request('GET','/api/assets')).json().length,beforeAssets);
});

test('database failure rolls back the whole project, cleans staging objects and retries once into the fixed target',async()=>{
 const title=`forced-rollback-${randomUUID()}`;
 await pool.query(`CREATE FUNCTION reject_import_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM projects WHERE id=NEW.project_id AND title='${title}') THEN RAISE EXCEPTION 'Intentional import transaction failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER import_fixture_failure BEFORE INSERT ON document_versions FOR EACH ROW EXECUTE FUNCTION reject_import_fixture();`);
 const packet={...fixture,title};
 const response=await upload(packet);assert.equal(response.statusCode,202,response.body);const failed=await waitJob(response.json().id);assert.equal(failed.status,'failed',JSON.stringify(failed));
 const row=await tenantTransaction(actors[0].workspaceId,async tx=>(await tx.query('SELECT * FROM jobs WHERE id=$1',[failed.id])).rows[0]);
 assert.equal((await request('GET',`/api/projects/${row.payload.targetProjectId}`)).statusCode,404);
 const counts=await tenantTransaction(actors[0].workspaceId,async tx=>({assets:(await tx.query('SELECT id FROM assets WHERE object_key LIKE $1',[`${actors[0].workspaceId}/imports/${failed.id}/%`])).rowCount,documents:(await tx.query('SELECT id FROM documents WHERE project_id=$1',[row.payload.targetProjectId])).rowCount}));assert.deepEqual(counts,{assets:0,documents:0});
 const objects=await storage.send(new ListObjectsV2Command({Bucket:config.s3Bucket,Prefix:`${actors[0].workspaceId}/imports/${failed.id}/`}));assert.equal(objects.Contents?.length||0,0);
 await pool.query('DROP TRIGGER import_fixture_failure ON document_versions; DROP FUNCTION reject_import_fixture();');
 assert.equal((await request('POST',`/api/jobs/${failed.id}/retry`,{})).statusCode,200);
 const retried=await waitJob(failed.id);assert.equal(retried.status,'succeeded',JSON.stringify(retried));assert.equal(retried.result.projectId,row.payload.targetProjectId);
 const matches=(await request('GET','/api/projects')).json().filter((project:any)=>project.title===title);assert.equal(matches.length,1);
});

test('records select their exact original or thumbnail bytes when an old asset ID appears twice',async()=>{
 const packet=structuredClone(fixture) as any;
 const thumbnail=oldImage.replace('/file','/thumbnail');packet.assets[thumbnail]=fixture.assets[boardImage];
 packet.documents[2].content.attached=[{id:'source-private-one',assetId:'source-private-one',url:oldImage},{id:'source-private-one',asset_id:'source-private-one',url:thumbnail}];
 const accepted=await upload(packet);assert.equal(accepted.statusCode,202,accepted.body);
 const completed=await waitJob(accepted.json().id);assert.equal(completed.status,'succeeded',JSON.stringify(completed));
 const snapshot=(await request('GET',`/api/projects/${completed.result.projectId}/studio`)).json().snapshot;
 const [original,preview]=snapshot.attached;
 assert.notEqual(original.id,preview.id);assert.equal(original.assetId,original.id);assert.equal(preview.asset_id,preview.id);
 assert.equal(original.url,`/api/assets/${original.id}/file`);assert.equal(preview.url,`/api/assets/${preview.id}/file`);
 assert.equal((await sharp((await request('GET',original.url)).rawPayload).metadata()).width,80);
 assert.equal((await sharp((await request('GET',preview.url)).rawPayload).metadata()).width,40);
});

test('actual MIME and image pixel budgets are enforced by the durable decoder',async()=>{
 const excessive=await sharp({create:{width:6400,height:6400,channels:3,background:'#ffffff'}}).png().toBuffer();
 for(const data of [`data:image/jpeg;base64,${imageA.toString('base64')}`,`data:image/png;base64,${excessive.toString('base64')}`]){
  const packet=structuredClone(fixture);packet.assets[oldImage]=data;
  const accepted=await upload(packet);assert.equal(accepted.statusCode,202,accepted.body);
  const completed=await waitJob(accepted.json().id);assert.equal(completed.status,'failed');assert.match(completed.error,/MIME|pixel limit/);
  const row=await tenantTransaction(actors[0].workspaceId,async tx=>(await tx.query('SELECT payload FROM jobs WHERE id=$1',[completed.id])).rows[0]);
  assert.equal((await request('GET',`/api/projects/${row.payload.targetProjectId}`)).statusCode,404);
 }
});
