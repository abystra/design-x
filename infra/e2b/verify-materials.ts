/** Opt-in E2B + Design X R2 acceptance. No WorkX bucket/prefix or credentials are inferred.
 * Input is the disposable fixture report from scripts/verify-r2-runtime.ts --live --keep.
 * Scoped credentials are passed only to root matfs processes and never written to reports.
 */
import { config as loadEnv } from 'dotenv';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Sandbox } from 'e2b';
loadEnv({ path: '.env.r2.local', quiet: true });
if (!process.argv.includes('--live')) throw new Error('Use --live only after the independent Design X R2 fixture passes');
const fixtureIndex=process.argv.indexOf('--fixture');
const fixturePath=fixtureIndex>=0 ? process.argv[fixtureIndex+1] : 'artifacts/v2/r2-acceptance.json';
const fixtureReport=JSON.parse(await readFile(fixturePath,'utf8'));
if(!['passed','partial'].includes(fixtureReport.status)||fixtureReport.fixtureRetained!==true||fixtureReport.materialFixtureReady!==true)throw new Error('A retained R2 fixture with all material data-plane checks passed is required');
for(const name of ['signed PUT + conditional snapshot + media ingestion','temporary project credential reads verified content','cross-project pool access denied','temporary credential writes denied','expired temporary credential denied'])if(!fixtureReport.checks?.some((check:any)=>check.name===name&&check.status==='passed'))throw new Error(`R2 material fixture is missing a passed prerequisite: ${name}`);
if(fixtureReport.checks?.some((check:any)=>check.status==='failed'&&check.name!=='browser PUT CORS preflight'))throw new Error('R2 fixture has failed checks beyond browser CORS');
if(fixtureReport.singleBucketTest&&(process.env.NODE_ENV==='production'||!process.argv.includes('--single-bucket-test')))throw new Error('A single-bucket fixture requires explicit --single-bucket-test outside production');
const fixture=fixtureReport.fixture;
const build=JSON.parse(await readFile('infra/e2b/dist/build.json','utf8'));
process.env.DESIGNX_E2B_TEMPLATE=build.pinnedTemplate;
const { config }=await import('../../packages/server-infra/src/config.js');
const { pool }=await import('../../packages/server-infra/src/db.js');
const { stopQueue }=await import('../../packages/server-infra/src/queue.js');
const { putObject,deleteObject,stagingBucket }=await import('../../packages/server-infra/src/storage.js');
const storageTarget=createHash('sha256').update(JSON.stringify([config.s3Endpoint,config.s3Bucket,stagingBucket()])).digest('hex');
if(fixtureReport.storageTarget!==storageTarget)throw new Error('R2 fixture storage target differs from the current profile; rerun verify-r2 with this profile');
const { prepareProjectMaterialMount,signR2ReadOnly }=await import('../../packages/server-domain/src/project-materials.js');
const { runtimeConfig,safeRuntimeError }=await import('../../packages/ai-runtime/src/config.js');
const { runAppServerTurn,killSandbox,findSandboxesForExecution }=await import('../../packages/ai-runtime/src/index.js');
const { shellQuote }=await import('../../packages/ai-runtime/src/protocol.js');
const runtime=runtimeConfig();
const verificationId=randomUUID();
const report:any={startedAt:new Date().toISOString(),status:'running',verificationId,template:build.pinnedTemplate,sourceCommit:build.sourceCommit,singleBucketTest:fixtureReport.singleBucketTest===true,storageTarget,checks:[],fixture:{workspaceId:fixture.workspaceId,projectId:fixture.projectId},attemptIds:[]};
let sandbox:Sandbox|undefined,agentSandboxId:string|undefined;
const extraObjects:string[]=[];
const privateValues=new Set([config.s3AccessKey,config.s3SecretKey]);
const saveReport=async()=>{await mkdir('artifacts/v2',{recursive:true});await writeFile('artifacts/v2/e2b-r2-acceptance.json',JSON.stringify(report,null,2));};
const safeError=(error:unknown)=>{let message=error instanceof Error?error.message:'E2B material verification failed';for(const value of privateValues)if(value)message=message.split(value).join('[REDACTED]');return safeRuntimeError(new Error(message.replace(/https?:\/\/[^\s"'<>]+/g,'[URL REDACTED]'))).slice(0,600);};
const check=(name:string,details?:unknown)=>{report.checks.push({name,status:'passed',...(details?{details}:{})});console.log(`${name}: passed`);};
const manifestBytes=(entries:unknown[])=>gzipSync(Buffer.from(JSON.stringify({version:1,entries})));
const rememberCredentials=(credentials:{accessKeyId:string,secretAccessKey:string,sessionToken:string})=>{for(const value of Object.values(credentials))if(typeof value==='string')privateValues.add(value);return credentials;};
const credentialEnv=(credentials:{accessKeyId:string,secretAccessKey:string,sessionToken:string})=>{rememberCredentials(credentials);return {DESIGNX_MATFS_ACCESS_KEY_ID:credentials.accessKeyId,DESIGNX_MATFS_SECRET_ACCESS_KEY:credentials.secretAccessKey,DESIGNX_MATFS_SESSION_TOKEN:credentials.sessionToken};};
try {
 await saveReport();
 const mount=await prepareProjectMaterialMount(fixture.workspaceId,fixture.projectId,randomUUID());
 rememberCredentials(mount.credentials);
 const entry=mount.manifest.entries.find(e=>e.assetVersionId===fixture.assetVersionId);
 if(!entry)throw new Error('The retained project material version is unavailable');
 sandbox=await Sandbox.create(build.pinnedTemplate,{apiKey:runtime.apiKey,timeoutMs:600000,idempotencyKey:verificationId,metadata:{purpose:'designx-material-verification',verificationId},network:{allowPublicTraffic:false,denyOut:['0.0.0.0/0'],allowOut:[new URL(mount.endpoint).hostname]}});
 const run=async(command:string,user:'root'|'user'='root')=>sandbox!.commands.run(command,{user,timeoutMs:20000,requestTimeoutMs:30000});
 await run('install -d -m 755 /workspaces/designx/material-tests && install -d -m 700 /var/lib/designx/material-tests');
 let sequence=0;
 async function startMount(options:{bytes?:Uint8Array,prefix?:string,credentials?:typeof mount.credentials,budget?:number,expectFailure?:boolean}={}) {
  const name=`case-${++sequence}`,root=`/var/lib/designx/material-tests/${name}`,view=`/workspaces/designx/material-tests/${name}`;
  await run(`install -d -m 700 ${shellQuote(root)} && install -d -m 755 ${shellQuote(view)}`);
  await sandbox!.files.write(root+'/manifest.gz',new Uint8Array(options.bytes||mount.manifestBytes).buffer,{user:'root'});
  const command=['/opt/designx/bin/designx-matfs','--manifest',root+'/manifest.gz','--mount',view,'--cache',root+'/cache','--endpoint',mount.endpoint,'--bucket',mount.bucket,'--prefix',options.prefix||mount.prefix,'--budget-bytes',String(options.budget??mount.readBudgetBytes),'--ready',root+'/ready'].map(shellQuote).join(' ');
  const process=await sandbox!.commands.run(command,{user:'root',background:true,timeoutMs:0,envs:credentialEnv(options.credentials||mount.credentials),retainOutput:false});
  let ready=false;
  try {await run(`for i in $(seq 1 50); do if test -f ${shellQuote(root+'/ready')}; then exit 0; fi; sleep 0.1; done; exit 1`);ready=true;}catch{}
  if(ready===!!options.expectFailure)throw new Error(options.expectFailure?'Invalid manifest unexpectedly mounted':'Material mount failed');
  if(options.expectFailure)await run(`if kill -0 ${process.pid} 2>/dev/null; then exit 1; fi`);
  return {root,view,pid:process.pid,ready,close:async()=>{await run(`if mountpoint -q ${shellQuote(view)}; then umount ${shellQuote(view)}; fi`);}};
 }
 async function probe(path:string,write=false){
  const code=`import pathlib,hashlib,json\np=pathlib.Path(${JSON.stringify(path)})\ntry:\n ${write?"p.write_bytes(b'forbidden-write'); result={'opened':True}":"data=p.read_bytes(); result={'opened':True,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()}"}\nexcept OSError as error:\n result={'opened':False,'errno':error.errno,'errorType':type(error).__name__}\nprint(json.dumps(result))`;
  const result=await run('python3 -c '+shellQuote(code),'user');return JSON.parse(result.stdout.trim());
 }
 const visible=await startMount();
 const allowed=await probe(visible.view+'/'+entry.path);
 if(!allowed.opened||allowed.sha256!==entry.sha256||allowed.size!==entry.size)throw new Error('Authorized mounted file did not pass digest verification');
 check('authorized project material opens with exact size and SHA-256');
 const hiddenBody=Buffer.from('unlisted-'+randomUUID()),hiddenSha=createHash('sha256').update(hiddenBody).digest('hex'),hiddenKey=mount.prefix+hiddenSha;
 extraObjects.push(hiddenKey);await putObject(hiddenKey,hiddenBody,'application/octet-stream',{bucket:mount.bucket});
 if((await probe(visible.view+'/'+hiddenSha)).opened||(await probe(visible.view+'/unlisted.txt')).opened)throw new Error('Manifest-excluded object was visible');
 check('objects outside the manifest remain invisible even inside the authorized pool');
 if((await probe(visible.view+'/'+entry.path,true)).opened||(await probe(visible.view+'/new-file.txt',true)).opened)throw new Error('Read-only material view allowed writes');
 check('file changes and file creation denied by read-only mount');
 if((await probe(`/proc/${visible.pid}/environ`)).opened||(await probe(visible.root+'/manifest.gz')).opened)throw new Error('Agent could read privileged mount process or control files');
 const privateProbe=await run(`test ! -r ${shellQuote(visible.root+'/cache/'+entry.sha256)} && test ! -x /usr/bin/sudo && test ! -w /var/lib/designx`,'user');
 if(privateProbe.exitCode!==0)throw new Error('Private material cache or supervisor boundary failed');
 check('temporary credentials, root cache and supervisor files are inaccessible to the agent');
 await visible.close();

 const otherPrefix=`${fixture.workspaceId}/projects/${fixture.otherProjectId}/content-pool/`,otherBody=Buffer.from('other-project-'+randomUUID()),otherSha=createHash('sha256').update(otherBody).digest('hex'),otherKey=otherPrefix+otherSha;
 extraObjects.push(otherKey);await putObject(otherKey,otherBody,'application/octet-stream',{bucket:mount.bucket});
 const otherManifest=manifestBytes([{path:'other.txt',size:otherBody.length,sha256:otherSha}]);
 const cross=await startMount({bytes:otherManifest,prefix:otherPrefix});
 if((await probe(cross.view+'/other.txt')).opened)throw new Error('Project A credentials read project B content');
 await cross.close();check('cross-project content is denied at the R2 credential boundary');
 const signer={accountId:new URL(mount.endpoint).hostname.split('.')[0],endpoint:mount.endpoint,parentAccessKeyId:config.s3AccessKey,parentSecretAccessKey:config.s3SecretKey,bucket:mount.bucket};
 const ownB=await startMount({bytes:otherManifest,prefix:otherPrefix,credentials:signR2ReadOnly({...signer,prefixes:[otherPrefix],ttlSeconds:300})});
 if((await probe(ownB.view+'/other.txt')).sha256!==otherSha)throw new Error('Project B authorized mount failed');
 await ownB.close();check('independently authorized project B mount reads only its own pool');

 const original=Buffer.from('verified-original-'+randomUUID()),tamperSha=createHash('sha256').update(original).digest('hex'),tamperKey=mount.prefix+tamperSha;
 extraObjects.push(tamperKey);await putObject(tamperKey,Buffer.alloc(original.length,120),'application/octet-stream',{bucket:mount.bucket});
 const tamperManifest=manifestBytes([{path:'tampered.txt',size:original.length,sha256:tamperSha}]);
 const tampered=await startMount({bytes:tamperManifest,budget:2*(original.length+1)});
 if((await probe(tampered.view+'/tampered.txt')).opened)throw new Error('Same-size content tampering passed verification');
 if(await sandbox.files.exists(tampered.root+'/cache/'+tamperSha,{user:'root'}))throw new Error('Tampered material entered verified cache');
 if((await probe(tampered.view+'/tampered.txt')).opened)throw new Error('Repeated tampered read unexpectedly succeeded');
 await putObject(tamperKey,original,'application/octet-stream',{bucket:mount.bucket});
 if((await probe(tampered.view+'/tampered.txt')).opened)throw new Error('Failed integrity reads were refunded and bypassed the attempt budget');
 await tampered.close();check('same-size tampering is rejected and failed reads remain charged after object repair');
 const repaired=await startMount({bytes:tamperManifest});
 if((await probe(repaired.view+'/tampered.txt')).sha256!==tamperSha)throw new Error('Repaired object was not readable by a fresh authorized attempt');
 await repaired.close();check('a new authorized attempt can verify the repaired object');

 const budget=await startMount({budget:Math.max(0,entry.size-1)});
 if((await probe(budget.view+'/'+entry.path)).opened)throw new Error('Read budget limit was bypassed');
 await budget.close();check('per-attempt byte budget prevents oversized reads');
 const expired=await startMount({credentials:signR2ReadOnly({...signer,prefixes:[mount.prefix],ttlSeconds:1,now:Math.floor(Date.now()/1000)-120})});
 if((await probe(expired.view+'/'+entry.path)).opened)throw new Error('Expired credentials fetched a previously uncached object');
 await expired.close();check('expired credentials cannot fetch new material bytes');
 const invalid=manifestBytes([{path:'../escape',size:entry.size,sha256:entry.sha256}]);
 await startMount({bytes:invalid,expectFailure:true});check('invalid manifest fails mounting without exposing a view');
 await sandbox.kill();sandbox=undefined;

 let eventsBeforeMountFailure=0;const invalidAttempt=randomUUID();
 report.attemptIds.push(invalidAttempt);await saveReport();
 try {
  await runAppServerTurn({executionKey:invalidAttempt,session:{id:randomUUID(),projectId:fixture.projectId,attemptId:invalidAttempt,fence:1,deadline:Date.now()+60000},materialMount:{...mount,manifestBytes:invalid},context:{count:1,assets:[]},prompt:'A failed material mount must prevent this turn from starting.',onSandbox:async id=>{agentSandboxId=id;},onRuntimeEvent:async()=>{eventsBeforeMountFailure++;}});
  throw new Error('Runner unexpectedly started with an invalid material mount');
 }catch(error){if(!(error instanceof Error)||!error.message.includes('material mount failed'))throw error;}
 if(eventsBeforeMountFailure!==0)throw new Error('Runner emitted native events after a mount failure');
 if(agentSandboxId)await killSandbox(agentSandboxId);agentSandboxId=undefined;
 check('mount failure prevents native Agent submission');

 const attempt=randomUUID(),fresh=await prepareProjectMaterialMount(fixture.workspaceId,fixture.projectId,attempt),src=`/api/assets/${entry.assetId}/versions/${entry.assetVersionId}/file`;
 rememberCredentials(fresh.credentials);report.attemptIds.push(attempt);await saveReport();
 const output=await runAppServerTurn({executionKey:attempt,session:{id:randomUUID(),projectId:fixture.projectId,attemptId:attempt,fence:1,deadline:Date.now()+300000},materialMount:fresh,
  context:{count:1,assets:[{id:entry.assetId,assetVersionId:entry.assetVersionId,src,width:64,height:48,title:'R2 产品素材'}],referenceArtboards:[],materials:[{path:entry.path}]},
  prompt:`读取只读素材 /workspaces/designx/materials/${entry.path} 的实际字节，用 Python 计算 SHA-256。创建一张1080×720可编辑画板，包含该素材的独立图片图层（src使用context.assets[0].src），和独立文字图层，文字中写入读取的完整64位SHA-256。不得猜测摘要。必须写artifact.json并运行 node /opt/designx/validate.mjs 验证。`,
  onSandbox:async id=>{agentSandboxId=id;},onRuntimeEvent:async event=>{if(event.type==='run.failed')report.nativeErrorClass=event.payload.errorClass;},
 });
 const design=output.manifest.artboards[0]?.design;
 if(!design?.nodes.some((node:any)=>node.type==='image'&&node.src===src)||!design.nodes.some((node:any)=>node.type==='text'&&String(node.text).includes(entry.sha256)))throw new Error('Agent artifact did not preserve the versioned image and verified digest in editable layers');
 const observer=await Sandbox.connect(agentSandboxId!,{apiKey:runtime.apiKey,timeoutMs:60000});
 const cached=await observer.commands.run('python3 -c '+shellQuote(`import hashlib,pathlib; print(hashlib.sha256(pathlib.Path(${JSON.stringify(`/var/lib/designx/runs/${attempt}/cache/${entry.sha256}`)}).read_bytes()).hexdigest())`),{user:'root',timeoutMs:20000});
 if(cached.stdout.trim()!==entry.sha256)throw new Error('Agent did not trigger a verified read through the material mount');
 await mkdir('artifacts/v2',{recursive:true});await writeFile('artifacts/v2/e2b-r2-artifact.json',JSON.stringify(output.manifest,null,2));
 check('real Agent opens mounted R2 bytes and returns an editable artifact with version-pinned image and independently verified digest',{artifact:'artifacts/v2/e2b-r2-artifact.json'});
 report.status='passed';
}catch(error:any){report.status='failed';report.error=safeError(error);process.exitCode=1;}
finally {
 let cleaned=true;
 if(sandbox)await sandbox.kill().catch(()=>{cleaned=false;});
 if(agentSandboxId)await killSandbox(agentSandboxId).catch(()=>{cleaned=false;});
 // Recover sandbox IDs even when create accepted but its response was lost.
 try {
  const pages=Sandbox.list({apiKey:runtime.apiKey,query:{metadata:{purpose:'designx-material-verification',verificationId}}});
  while(pages.hasNext)for(const item of await pages.nextItems())if(item.metadata?.verificationId===verificationId)await killSandbox(item.sandboxId);
  for(const attempt of report.attemptIds)for(const id of await findSandboxesForExecution(attempt))await killSandbox(id);
 }catch{cleaned=false;}
 for(const key of extraObjects)await deleteObject(key,{bucket:config.s3Bucket}).catch(()=>{cleaned=false;});
 if(!cleaned){report.status='failed';report.cleanupError='Temporary resources could not all be confirmed cleaned';process.exitCode=1;}
 report.cleaned=cleaned;report.fixtureRetained=true;report.finishedAt=new Date().toISOString();
 await saveReport();
 console.log(JSON.stringify({status:report.status,cleaned,checks:report.checks.length,report:'artifacts/v2/e2b-r2-acceptance.json'}));
 await stopQueue();await pool.end();
}
