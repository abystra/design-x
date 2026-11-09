import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import sharp from 'sharp';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {config} from '../../../packages/server-infra/src/config.js';
import { buildApp } from '../src/server.js';
import { migrate } from '../../../db/migrate.js';
import { pool,tenantTransaction } from '../../../packages/server-infra/src/db.js';
import { stopQueue } from '../../../packages/server-infra/src/queue.js';
import { putObject,getObject,ensureBucket } from '../../../packages/server-infra/src/storage.js';
import { ingestAsset,runBusinessJob } from '../../worker/src/process.js';
import { ingestBufferAsset,registerCandidate } from '../../../packages/server-domain/src/assets.js';
import { freezeProjectMaterials,authorizeFrozenMaterials } from '../../../packages/server-domain/src/project-materials.js';
await migrate();
const app=await buildApp({logger:false}),actors:string[]=[];
let workspaceId:string,project:any,asset:any,upload:any,bytes:Buffer;
async function req(method:string,url:string,payload?:any,actor=0){return app.inject({method:method as any,url,payload,headers:{origin:'http://127.0.0.1:5173',cookie:actors[actor]}});}
test.after(async()=>{await app.close();await stopQueue();await pool.end();});
test('presigned upload freezes bytes before ingestion, duplicate complete does not enqueue twice',async()=>{
 for(let i=0;i<2;i++){const result=await app.inject({method:'POST',url:'/api/auth/register',payload:{email:`v2-storage-${randomUUID()}@example.test`,password:'correct-horse-designx',name:'Storage tester'}});assert.equal(result.statusCode,201);actors.push(String(result.headers['set-cookie']).split(';')[0]);}
 project=(await req('POST','/api/projects',{title:'Project materials',design:{width:320,height:240,background:'#fff',nodes:[]}})).json();
 workspaceId=(await pool.query('SELECT workspace_id FROM projects WHERE id=$1',[project.id])).rows[0].workspace_id;
 bytes=await sharp({create:{width:64,height:48,channels:3,background:'#ff8811'}}).png().toBuffer();
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const created=await req('POST','/api/uploads',{filename:'产品.png',mime:'image/png',bytes:bytes.length,sha256,projectId:project.id});assert.equal(created.statusCode,201,created.body);upload=created.json();
 const put=await fetch(upload.upload.url,{method:'PUT',headers:upload.upload.headers,body:new Uint8Array(bytes)});assert.equal(put.status,200);
 const completed=await req('POST',`/api/uploads/${upload.id}/complete`,{});assert.equal(completed.statusCode,202,completed.body);
 const repeated=await req('POST',`/api/uploads/${upload.id}/complete`,{});assert.equal(repeated.json().jobId,completed.json().jobId);
 const row=(await pool.query('SELECT * FROM upload_sessions WHERE id=$1',[upload.id])).rows[0];
 await putObject(row.staging_key,Buffer.from('overwritten-after-complete'),'image/png',{bucket:row.staging_bucket});
 const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[completed.json().jobId])).rows[0];
 await runBusinessJob({id:job.queue_id,data:{jobId:job.id,workspaceId}},ingestAsset);
 const state=(await req('GET',`/api/uploads/${upload.id}`)).json();assert.equal(state.status,'ready');asset=state.asset;
 assert.match(asset.image,/\/versions\//);assert.equal(asset.width,64);assert.equal(asset.height,48);
 const file=await req('GET',asset.image);assert.equal(file.statusCode,200,file.body);assert.equal((await sharp(file.rawPayload).metadata()).width,64);
 assert.equal((await req('GET',asset.image,undefined,1)).statusCode,404);
 assert.equal((await req('GET',`/api/uploads/${upload.id}`,undefined,1)).statusCode,404);
 assert.equal((await req('GET',`/api/projects/${project.id}/assets`)).json()[0].id,asset.id);
 const versions=(await req('GET',`/api/assets/${asset.id}/versions`)).json();assert.equal(versions.length,1);assert.equal(versions[0].sha256,createHash('sha256').update(file.rawPayload).digest('hex'));
});
test('project manifests isolate linked assets and pin versions across new versions and rename',async()=>{
 const other=(await req('POST','/api/projects',{title:'Unrelated',design:{width:200,height:200,background:'#fff',nodes:[]}})).json();
 const frozen=await tenantTransaction(workspaceId,tx=>freezeProjectMaterials(tx,project.id));assert.equal(frozen.entries.length,1);
 assert.equal((await tenantTransaction(workspaceId,tx=>freezeProjectMaterials(tx,other.id))).entries.length,0);
 const legacyBefore=(await req('GET',`/api/assets/${asset.id}/file`)).rawPayload;
 const changedBytes=await sharp({create:{width:32,height:24,channels:3,background:'#1188ff'}}).png().toBuffer();
 const version=await ingestBufferAsset(workspaceId,{assetId:asset.id,bytes:changedBytes,mime:'image/png',title:'New revision',source:{kind:'test'},attemptId:randomUUID()});
 assert.notEqual(version.assetVersionId,frozen.entries[0].assetVersionId);
 assert.deepEqual((await req('GET',`/api/assets/${asset.id}/file`)).rawPayload,legacyBefore,'legacy alias remains pinned to baseline');
 assert.equal((await sharp((await req('GET',version.image)).rawPayload).metadata()).width,32);
 await tenantTransaction(workspaceId,tx=>tx.query('UPDATE assets SET title=$2 WHERE id=$1',[asset.id,'renamed']));
 await tenantTransaction(workspaceId,tx=>authorizeFrozenMaterials(tx,frozen));
 assert.equal((await req('GET',asset.image)).statusCode,200,'old immutable version remains available');
 await req('DELETE',`/api/projects/${project.id}/assets/${asset.id}`);
 await assert.rejects(tenantTransaction(workspaceId,tx=>authorizeFrozenMaterials(tx,frozen)),/授权已撤销/);
 assert.equal((await req('GET',`/api/projects/${project.id}/assets`)).json().length,0);
});
test('media publication rechecks authorization after object writes and does not publish stale results',async()=>{
 const assetId=randomUUID(),attemptId=randomUUID();let checks=0;
 await assert.rejects(ingestBufferAsset(workspaceId,{assetId,bytes,mime:'image/png',title:'Fenced',source:{kind:'test'},attemptId},async()=>{checks++;if(checks===3)throw new Error('stale execution');}),/stale execution/);
 assert.equal((await pool.query('SELECT 1 FROM asset_versions WHERE asset_id=$1',[assetId])).rowCount,0);
 assert.equal((await pool.query('SELECT 1 FROM storage_candidates WHERE object_key LIKE $1',[`%/${assetId}/%`])).rowCount,2,'unpublished objects are tracked for cleanup');
 const input={assetId,bytes,mime:'image/png',title:'Recovered',source:{kind:'test'},attemptId};
 const one=await ingestBufferAsset(workspaceId,input),two=await ingestBufferAsset(workspaceId,input);assert.equal(one.assetVersionId,two.assetVersionId);
 assert.equal((await pool.query('SELECT 1 FROM asset_versions WHERE asset_id=$1',[assetId])).rowCount,1);
});
test('checksum mismatch rejects completion, and versions reject SQL mutation',async()=>{
 const created=(await req('POST','/api/uploads',{filename:'bad.png',mime:'image/png',bytes:bytes.length,sha256:'0'.repeat(64)})).json();
 assert.equal((await fetch(created.upload.url,{method:'PUT',headers:created.upload.headers,body:new Uint8Array(bytes)})).status,200);
 const completed=await req('POST',`/api/uploads/${created.id}/complete`,{});assert.equal(completed.statusCode,202);
 const job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[completed.json().jobId])).rows[0];
 await assert.rejects(runBusinessJob({id:job.queue_id,data:{jobId:job.id,workspaceId}},ingestAsset),/校验失败/);
 assert.equal((await req('GET',`/api/uploads/${created.id}`)).json().status,'failed');
 await assert.rejects(tenantTransaction(workspaceId,tx=>tx.query('UPDATE asset_versions SET object_key=$1 WHERE asset_id=$2',['replacement',asset.id])),/immutable/);
});

test('legacy storage copies and verifies before switch, and rollback preserves original bytes',async()=>{
 const legacyId=randomUUID(),legacyKey=`${workspaceId}/legacy/${legacyId}.png`,legacyBucket=process.env.TEST_LEGACY_BUCKET||`${config.s3Bucket}-legacy`;
 await ensureBucket(legacyBucket);await putObject(legacyKey,bytes,'image/png',{bucket:legacyBucket});
 await tenantTransaction(workspaceId,tx=>tx.query("INSERT INTO assets(id,workspace_id,title,mime,bytes,object_key,status,width,height,storage_bucket) VALUES($1,$2,'Legacy','image/png',$3,$4,'ready',64,48,$5)",[legacyId,workspaceId,bytes.length,legacyKey,legacyBucket]));
 await assert.rejects(ingestBufferAsset(workspaceId,{assetId:legacyId,bytes,mime:'image/png',title:'blocked',source:{kind:'test'},attemptId:randomUUID()}),/版本迁移/);
 const run=promisify(execFile);
 const copied=await run(process.execPath,['--import','tsx','scripts/migrate-storage.ts','--workspace',workspaceId],{timeout:30000});
 const migration=JSON.parse(copied.stdout.trim().split('\n').find(line=>line.startsWith('{'))!);assert.equal(migration.status,'copied');
 let row=(await pool.query('SELECT * FROM assets WHERE id=$1',[legacyId])).rows[0];assert.equal(row.current_version_id,null);assert.equal(row.object_key,legacyKey);
 await run(process.execPath,['--import','tsx','scripts/migrate-storage.ts','--workspace',workspaceId,'--apply'],{timeout:30000});
 row=(await pool.query('SELECT * FROM assets WHERE id=$1',[legacyId])).rows[0];assert.ok(row.current_version_id);assert.notEqual(row.object_key,legacyKey);
 assert.deepEqual((await getObject(row.object_key,{bucket:row.storage_bucket})).bytes,bytes);
 await run(process.execPath,['--import','tsx','scripts/migrate-storage.ts','--workspace',workspaceId,'--rollback',migration.migrationId],{timeout:30000});
 row=(await pool.query('SELECT * FROM assets WHERE id=$1',[legacyId])).rows[0];assert.equal(row.object_key,legacyKey);assert.equal(row.current_version_id,null);
 assert.equal(row.storage_bucket,legacyBucket);assert.deepEqual((await getObject(legacyKey,{bucket:legacyBucket})).bytes,bytes);
 assert.equal((await pool.query('SELECT status FROM storage_migrations WHERE id=$1',[migration.migrationId])).rows[0].status,'rolled_back');
 await run(process.execPath,['--import','tsx','scripts/migrate-storage.ts','--workspace',workspaceId,'--apply'],{timeout:30000});
 const newer=await ingestBufferAsset(workspaceId,{assetId:legacyId,bytes,mime:'image/png',title:'After rollback',source:{kind:'test'},attemptId:randomUUID()});
 await run(process.execPath,['--import','tsx','scripts/migrate-storage.ts','--workspace',workspaceId,'--rollback',migration.migrationId],{timeout:30000});
 row=(await pool.query('SELECT * FROM assets WHERE id=$1',[legacyId])).rows[0];
 assert.equal(row.current_version_id,newer.assetVersionId,'repeating a prior rollback cannot overwrite a newer version');
});

test('cleanup reclaims only aged unreferenced registered objects and retains immutable versions',async()=>{
 const orphan=`${workspaceId}/verification-orphan/${randomUUID()}`;await putObject(orphan,bytes,'image/png');
 await tenantTransaction(workspaceId,async tx=>{
  await registerCandidate(tx,workspaceId,config.s3Bucket,orphan,'fixture');
  await tx.query("UPDATE storage_candidates SET created_at=now()-interval '49 hours' WHERE object_key=$1 OR object_key IN (SELECT object_key FROM asset_versions WHERE asset_id=$2)",[orphan,asset.id]);
 });
 const version=(await pool.query('SELECT * FROM asset_versions WHERE asset_id=$1 ORDER BY created_at LIMIT 1',[asset.id])).rows[0];
 await promisify(execFile)(process.execPath,['--import','tsx','scripts/cleanup-storage.ts','--workspace',workspaceId,'--apply'],{timeout:30000});
 await assert.rejects(getObject(orphan),(error:any)=>error.$metadata?.httpStatusCode===404);
 assert.ok((await getObject(version.object_key,{bucket:version.bucket})).bytes.length>0);
 assert.equal((await pool.query('SELECT 1 FROM storage_candidates WHERE object_key=$1',[orphan])).rowCount,0);
});

test('batch migration reads historical aliases and excludes only explicitly audited missing assets',async()=>{
 const legacyId=randomUUID(),missingId=randomUUID(),key=`${workspaceId}/legacy/${legacyId}.png`,logicalBucket='migration-prefix-alias';
 const prefix='_legacy/migration-prefix-alias/',dir=await mkdtemp(join(tmpdir(),'designx-migration-'));
 const workspacesFile=join(dir,'workspaces.json'),excludedFile=join(dir,'excluded.json');
 await putObject(prefix+key,bytes,'image/png');
 await tenantTransaction(workspaceId,async tx=>{
  await tx.query("INSERT INTO assets(id,workspace_id,title,mime,bytes,object_key,status,width,height,storage_bucket) VALUES($1,$2,'Aliased legacy','image/png',$3,$4,'ready',64,48,$5)",[legacyId,workspaceId,bytes.length,key,logicalBucket]);
  await tx.query("INSERT INTO assets(id,workspace_id,title,mime,bytes,object_key,status) VALUES($1,$2,'Historical missing fixture','image/png',1,$3,'ready')",[missingId,workspaceId,`${workspaceId}/missing/${missingId}`]);
 });
 await writeFile(workspacesFile,JSON.stringify([workspaceId]));await writeFile(excludedFile,JSON.stringify([missingId]));
 const run=promisify(execFile),env={...process.env,S3_BUCKET_ALIASES_JSON:JSON.stringify({[logicalBucket]:{bucket:config.s3Bucket,prefix}})};
 try{
  const output=await run(process.execPath,['--import','tsx','scripts/migrate-storage.ts','--workspaces',workspacesFile,'--exclude-assets',excludedFile,'--apply'],{env,timeout:30000});
  const records=output.stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(records.find(row=>row.assetId===missingId)?.status,'excluded');
  assert.equal(records.find(row=>row.assetId===legacyId)?.status,'switched');
  const rows=(await pool.query('SELECT * FROM assets WHERE id=ANY($1)',[[legacyId,missingId]])).rows;
  const aliased=rows.find(row=>row.id===legacyId),missing=rows.find(row=>row.id===missingId);
  assert.ok(aliased.current_version_id);assert.deepEqual((await getObject(aliased.object_key)).bytes,bytes);
  assert.deepEqual((await getObject(prefix+key)).bytes,bytes,'historical bytes remain available');
  assert.equal(missing.current_version_id,null);assert.equal(missing.storage_bucket,null,'exclusion cannot alter historical metadata');
  await assert.rejects(run(process.execPath,['--import','tsx','scripts/migrate-storage.ts','--workspace',workspaceId,'--apply'],{env,timeout:30000}),/NoSuchKey|not exist|not found/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
