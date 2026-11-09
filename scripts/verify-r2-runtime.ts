/** Real Design X R2 acceptance; uses only this project's configured private buckets.
 * --live runs and cleans disposable fixtures; --keep leaves a fixture for E2B matfs.
 * --cleanup <workspaceId> cleans only a workspace created by this verifier.
 * --single-bucket-test explicitly permits one user-authorized bucket outside production.
 * --browser performs the signed PUT inside Chromium at the configured application origin.
 * Existing cloud bucket CORS/policies are never modified; OPTIONS checks actual CORS.
 * Never serializes credentials or signed URLs into reports.
 */
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {S3Client,GetObjectCommand,PutObjectCommand,ListObjectsV2Command} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import {config} from '../packages/server-infra/src/config.js';
import {pool,tenantTransaction,transaction} from '../packages/server-infra/src/db.js';
import {stopQueue} from '../packages/server-infra/src/queue.js';
import {ensureBucket,storage,stagingBucket,putObject,deleteObject} from '../packages/server-infra/src/storage.js';
import {createUpload,completeUpload,getUpload} from '../packages/server-domain/src/assets.js';
import {createProject} from '../packages/server-domain/src/projects.js';
import {prepareProjectMaterialMount,signR2ReadOnly} from '../packages/server-domain/src/project-materials.js';
import {runBusinessJob,ingestAsset} from '../apps/worker/src/process.js';

export async function cleanupR2Fixture(workspaceId:string){
 const fixture=(await pool.query("SELECT w.owner_id FROM workspaces w JOIN users u ON u.id=w.owner_id WHERE w.id=$1 AND u.email LIKE 'r2-acceptance-%@example.test'",[workspaceId])).rows[0];
 if(!fixture)throw new Error('Not a disposable R2 verification workspace');
 for(const bucket of new Set([config.s3Bucket,stagingBucket()])){
  let cursor:string|undefined;
  do{const objects=await storage.send(new ListObjectsV2Command({Bucket:bucket,Prefix:`${workspaceId}/`,ContinuationToken:cursor}));for(const object of objects.Contents||[])if(object.Key)await deleteObject(object.Key,{bucket});cursor=objects.NextContinuationToken;}while(cursor);
 }
 await tenantTransaction(workspaceId,async tx=>{
  await tx.query('UPDATE assets SET current_version_id=NULL');
  // New tables with a workspace key are included automatically. Constraint failures
  // defer parent tables to another pass; every DELETE remains under tenant RLS.
  const tables=(await tx.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id' ORDER BY table_name")).rows.map(row=>row.table_name as string);
  let pending=tables;
  for(let pass=0;pending.length&&pass<tables.length+1;pass++){
   const next:string[]=[];
   for(const table of pending){if(!/^[a-z_]+$/.test(table))throw new Error('Unexpected table identifier');
    // Audit tables deliberately withhold DELETE from the application role. An
    // empty table needs no mutation; do not weaken audit permissions for fixtures.
    if(!(await tx.query(`SELECT 1 FROM "${table}" WHERE workspace_id=$1 LIMIT 1`,[workspaceId])).rowCount)continue;
    await tx.query('SAVEPOINT fixture_cleanup');try{await tx.query(`DELETE FROM "${table}" WHERE workspace_id=$1`,[workspaceId]);await tx.query('RELEASE SAVEPOINT fixture_cleanup');}catch(error:any){await tx.query('ROLLBACK TO SAVEPOINT fixture_cleanup');await tx.query('RELEASE SAVEPOINT fixture_cleanup');if(error.code!=='23503')throw error;next.push(table);}}
   if(next.length===pending.length)throw new Error('Verification cleanup found an unresolved foreign-key dependency');pending=next;
  }
 });
 await transaction(async tx=>{await tx.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);await tx.query('DELETE FROM users WHERE id=$1',[fixture.owner_id]);});
}
export function validateR2VerificationMode(assetsBucket:string,uploadBucket:string,production:boolean,singleBucketTest:boolean){
 if(singleBucketTest&&production)throw new Error('--single-bucket-test is prohibited in production');
 if(assetsBucket===uploadBucket&&!singleBucketTest)throw new Error('R2 staging and assets must be different private buckets; local shared-bucket verification requires --single-bucket-test');
}
export async function verifyR2Runtime(keep=false,singleBucketTest=false,browserCheck=false){
 if(!/^https:\/\/[a-zA-Z0-9]+\.r2\.cloudflarestorage\.com\/?$/.test(config.s3Endpoint))throw new Error('Configure the independent Design X R2 account endpoint before --live');
 validateR2VerificationMode(config.s3Bucket,stagingBucket(),config.production,singleBucketTest);
 const storageTarget=createHash('sha256').update(JSON.stringify([config.s3Endpoint,config.s3Bucket,stagingBucket()])).digest('hex');
 const report:any={startedAt:new Date().toISOString(),status:'running',provider:'R2',singleBucketTest,browserCheck,materialFixtureReady:false,storageTarget,checks:[]};
 const workspaceId=randomUUID(),userId=randomUUID();let created=false;
 const check=(name:string)=>{report.checks.push({name,status:'passed'});console.log(`${name}: passed`);};
 try{
  await ensureBucket();await ensureBucket(stagingBucket());
  await transaction(async tx=>{await tx.query("INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'R2 acceptance','login-disabled')",[userId,`r2-acceptance-${userId}@example.test`]);await tx.query("INSERT INTO workspaces(id,owner_id,name) VALUES($1,$2,'R2 acceptance')",[workspaceId,userId]);});created=true;
  const a=await tenantTransaction(workspaceId,tx=>createProject(tx,workspaceId,{title:'R2 project A'})),b=await tenantTransaction(workspaceId,tx=>createProject(tx,workspaceId,{title:'R2 project B'}));
  report.fixture={workspaceId,projectId:a.id,otherProjectId:b.id};
  const bytes=await sharp({create:{width:64,height:48,channels:3,background:'#49765c'}}).png().toBuffer(),sha256=createHash('sha256').update(bytes).digest('hex');
  const upload=await createUpload(workspaceId,{filename:'r2-产品.png',mime:'image/png',bytes:bytes.length,sha256,projectId:a.id});
  try{
   const preflight=await fetch(upload.upload.url,{method:'OPTIONS',headers:{Origin:config.webOrigin,'Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'content-type'},signal:AbortSignal.timeout(30000)});
   const allowedOrigin=preflight.headers.get('access-control-allow-origin'),allowedMethods=preflight.headers.get('access-control-allow-methods')||'',body=await preflight.text();
   report.cors={origin:config.webOrigin,httpStatus:preflight.status,allowedOrigin,allowedMethods,allowedHeaders:preflight.headers.get('access-control-allow-headers'),errorCode:body.match(/<Code>([^<]+)<\/Code>/)?.[1],errorMessage:body.match(/<Message>([^<]+)<\/Message>/)?.[1]};
   if(!preflight.ok||![config.webOrigin,'*'].includes(allowedOrigin||'')||!/(PUT|\*)/i.test(allowedMethods))throw new Error('R2 direct-upload browser CORS preflight failed');check('browser PUT CORS preflight');
  }catch{
   report.checks.push({name:'browser PUT CORS preflight',status:'failed',error:'Configured browser origin did not pass OPTIONS preflight; bucket CORS was not modified'});
   console.log('browser PUT CORS preflight: failed (continuing isolated data-plane verification)');
  }
  let browserUploaded=false;
  if(browserCheck){
   report.browser={engine:'Chromium',stage:'launch',expectedOrigin:config.webOrigin,bytes:bytes.length};
   try{
    const {chromium}=await import('playwright'),browser=await chromium.launch({headless:true});
    try{
     report.browser.version=browser.version();report.browser.stage='navigation';
     const page=await browser.newPage();await page.goto(config.webOrigin,{waitUntil:'domcontentloaded',timeout:30000});
     const origin=await page.evaluate(()=>location.origin);if(origin!==new URL(config.webOrigin).origin)throw new Error('Unexpected application origin');
     report.browser.origin=origin;report.browser.stage='signed-put';
     const response=await page.evaluate(async({url,headers,body})=>{
      const result=await fetch(url,{method:'PUT',headers,body:new Uint8Array(body),signal:AbortSignal.timeout(30000)});
      await result.body?.cancel();return {ok:result.ok,status:result.status};
     },{url:upload.upload.url,headers:upload.upload.headers,body:Array.from(bytes)});
     report.browser.httpStatus=response.status;
     if(!response.ok)throw new Error('Browser signed PUT was rejected');
     report.browser.stage='completed';
     browserUploaded=true;check('real Chromium page-origin signed PUT');
    }finally{await browser.close();}
   }catch{
    const error=report.browser.stage==='navigation'?'Chromium could not load the configured application origin; browser upload was not exercised':report.browser.stage==='launch'?'Chromium could not launch; browser upload was not exercised':'Chromium page could not complete the signed PUT; no browser security bypass was used';
    report.checks.push({name:'real Chromium page-origin signed PUT',status:'failed',error});
    console.log('real Chromium page-origin signed PUT: failed (continuing isolated data-plane verification)');
   }
  }
  if(!browserUploaded){
   const response=await fetch(upload.upload.url,{method:'PUT',headers:upload.upload.headers,body:new Uint8Array(bytes),signal:AbortSignal.timeout(30000)});await response.body?.cancel();if(!response.ok)throw new Error(`R2 signed PUT HTTP ${response.status}`);
  }
  const complete=await completeUpload(workspaceId,upload.id),job=(await pool.query('SELECT * FROM jobs WHERE id=$1',[complete.jobId])).rows[0];
  await runBusinessJob({id:job.queue_id,data:{jobId:job.id,workspaceId}},ingestAsset);
  const state=await getUpload(workspaceId,upload.id);if(state.status!=='ready')throw new Error('R2 upload ingestion did not become ready');
  report.fixture.assetId=state.asset!.id;report.fixture.assetVersionId=state.asset!.versionId;check('signed PUT + conditional snapshot + media ingestion');
  const mount=await prepareProjectMaterialMount(workspaceId,a.id,randomUUID());
  if(mount.manifest.entries.length!==1)throw new Error('Project manifest scope mismatch');
  const scoped=new S3Client({endpoint:mount.endpoint,region:'auto',forcePathStyle:true,credentials:mount.credentials,requestChecksumCalculation:'WHEN_REQUIRED'});
  try{
   const key=mount.prefix+mount.manifest.entries[0].sha256;
   const allowed=await scoped.send(new GetObjectCommand({Bucket:mount.bucket,Key:key}));const received=Buffer.from(await allowed.Body!.transformToByteArray());
   if(createHash('sha256').update(received).digest('hex')!==mount.manifest.entries[0].sha256)throw new Error('Scoped R2 read digest mismatch');check('temporary project credential reads verified content');
   const otherKey=`${workspaceId}/projects/${b.id}/content-pool/${sha256}`;await putObject(otherKey,bytes,'image/png');
   async function denied(action:()=>Promise<unknown>,name:string){try{await action();throw new Error(`${name} unexpectedly permitted`);}catch(error:any){if(error.$metadata?.httpStatusCode!==403)throw error;}check(name);}
   await denied(()=>scoped.send(new GetObjectCommand({Bucket:mount.bucket,Key:otherKey})),'cross-project pool access denied');
   await denied(()=>scoped.send(new PutObjectCommand({Bucket:mount.bucket,Key:mount.prefix+'forbidden-write',Body:bytes})),'temporary credential writes denied');
   const accountId=new URL(mount.endpoint).hostname.split('.')[0],expired=signR2ReadOnly({accountId,endpoint:mount.endpoint,parentAccessKeyId:config.s3AccessKey,parentSecretAccessKey:config.s3SecretKey,bucket:mount.bucket,prefixes:[mount.prefix],ttlSeconds:1,now:Math.floor(Date.now()/1000)-120});
   const expiredClient=new S3Client({endpoint:mount.endpoint,region:'auto',forcePathStyle:true,credentials:expired});
   try{await denied(()=>expiredClient.send(new GetObjectCommand({Bucket:mount.bucket,Key:key})),'expired temporary credential denied');}finally{expiredClient.destroy();}
  }finally{scoped.destroy();}
  report.materialFixtureReady=true;
  report.status=report.checks.some((item:any)=>item.status==='failed')?'partial':'passed';
  if(report.status==='partial')process.exitCode=1;
 }catch(error:any){report.status='failed';report.error=error instanceof Error?error.message:'R2 verification failed';process.exitCode=1;}
 finally{
  report.fixtureRetained=keep&&created;
  if(created&&!keep){try{await cleanupR2Fixture(workspaceId);report.cleaned=true;}catch(error){report.cleaned=false;report.fixtureRetained=true;report.cleanupError='Fixture cleanup incomplete; rerun --cleanup with the reported workspaceId';report.status='failed';process.exitCode=1;}}
  report.finishedAt=new Date().toISOString();await mkdir('artifacts/v2',{recursive:true});await writeFile('artifacts/v2/r2-acceptance.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,singleBucketTest,browserCheck,materialFixtureReady:report.materialFixtureReady,cleaned:report.cleaned,fixtureRetained:report.fixtureRetained,report:'artifacts/v2/r2-acceptance.json'}));
 }
 return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{const index=process.argv.indexOf('--cleanup');if(index>=0)await cleanupR2Fixture(process.argv[index+1]);else if(process.argv.includes('--live'))await verifyR2Runtime(process.argv.includes('--keep'),process.argv.includes('--single-bucket-test'),process.argv.includes('--browser'));else throw new Error('Use --live [--single-bucket-test] [--browser] for real R2 verification, or --cleanup <fixtureWorkspaceId>');}
 finally{await stopQueue();await pool.end();}
}
