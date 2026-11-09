import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {S3Client,HeadBucketCommand,CreateBucketCommand,PutObjectCommand,GetObjectCommand,ListObjectsV2Command,DeleteObjectCommand,DeleteBucketCommand} from '@aws-sdk/client-s3';
import {buildTestEnvironment} from './test-environment.mjs';
import {startDisposableTestStorage} from './test-storage.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const suite=process.argv[2];
if (!['api','unit'].includes(suite)) throw new Error('Usage: run-tests.mjs api|unit [node test options]');
const runId=randomUUID().replaceAll('-','');
const env=buildTestEnvironment(process.env,runId);
const directory=suite==='api'?'apps/api/tests':'tests/unit';
let files=(await readdir(new URL('../'+directory+'/',import.meta.url))).filter(name=>name.endsWith('.test.ts')).sort().map(name=>`${directory}/${name}`);
const extra=process.argv.slice(3).filter(value=>value!=='--');
const fileOption=extra.indexOf('--file');
if(fileOption!==-1) {
  const requested=extra[fileOption+1];
  const selected=files.find(file=>file===requested||file===`${directory}/${requested}`);
  if(!selected)throw new Error('--file must select an existing test in the requested suite');
  files=[selected];extra.splice(fileOption,2);
}
const databaseName=`designx_regression_${runId}`;
let admin,storage,disposableStorage,child,databaseCreated=false;
const stopped=new AbortController();
const interrupt=()=>{stopped.abort();child?.kill('SIGTERM');};
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
const ownedBuckets=[];
const send=command=>storage.send(command,{abortSignal:AbortSignal.timeout(15000)});
try {
  if (suite==='api') {
    admin=new pg.Client({connectionString:env.DATABASE_URL}); await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);databaseCreated=true;
    const databaseUrl=new URL(env.DATABASE_URL);databaseUrl.pathname='/'+databaseName;env.DATABASE_URL=databaseUrl.toString();
    if(!process.env.TEST_S3_ENDPOINT) {
      disposableStorage=await startDisposableTestStorage({runId,accessKey:env.S3_ACCESS_KEY_ID,secretKey:env.S3_SECRET_ACCESS_KEY,signal:stopped.signal});
      env.S3_ENDPOINT=disposableStorage.endpoint;
    }
    storage=new S3Client({endpoint:env.S3_ENDPOINT,region:env.S3_REGION,forcePathStyle:true,maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',credentials:{accessKeyId:env.S3_ACCESS_KEY_ID,secretAccessKey:env.S3_SECRET_ACCESS_KEY}});
    for(const bucket of [env.S3_BUCKET,env.S3_STAGING_BUCKET,env.TEST_LEGACY_BUCKET]) {
      stopped.signal.throwIfAborted();
      try { await send(new HeadBucketCommand({Bucket:bucket}));throw new Error('Refusing to reuse an existing test bucket: '+bucket); }
      catch(error) { if(error.$metadata?.httpStatusCode!==404&&error.name!=='NotFound')throw error; }
      await send(new CreateBucketCommand({Bucket:bucket}));ownedBuckets.push(bucket);
      // Bucket creation alone does not prove Seaweed has a writable volume.
      // Fail before launching tests if the local service cannot store bytes.
      const Key='_test-infrastructure-probe',Body=Buffer.from(runId);
      try {
        await send(new PutObjectCommand({Bucket:bucket,Key,Body}));
        const result=await send(new GetObjectCommand({Bucket:bucket,Key}));
        if(await result.Body?.transformToString()!==runId)throw new Error('Probe bytes did not match');
        await send(new DeleteObjectCommand({Bucket:bucket,Key}));
      } catch { throw new Error('Local test storage write/read check failed for '+bucket+'. Check service health and available volumes, or use TEST_S3_ENDPOINT for a separate local S3 service.'); }
    }
    console.log(`API regression uses a disposable local database and three disposable local buckets (${disposableStorage?'temporary S3 container':'explicit TEST_S3_ENDPOINT'}).`);
  }
  stopped.signal.throwIfAborted();
  const args=['--import','tsx','--test',...(suite==='api'?['--test-concurrency=1']:[]),...extra,...files];
  const exitCode=await new Promise((resolve,reject)=>{
    child=spawn(process.execPath,args,{cwd:root,env,stdio:'inherit'});
    child.on('error',reject);child.on('close',code=>{child=undefined;resolve(code??1);});
  });
  process.exitCode=exitCode;
} catch(error) {
  console.error(error instanceof Error?error.message:'Test setup failed');process.exitCode=1;
} finally {
  for(const bucket of ownedBuckets) {
    try {
      while(true) {
        const objects=await send(new ListObjectsV2Command({Bucket:bucket,MaxKeys:1000}));
        const keys=(objects.Contents||[]).flatMap(item=>item.Key?[item.Key]:[]);if(!keys.length)break;
        for(let i=0;i<keys.length;i+=8)await Promise.all(keys.slice(i,i+8).map(Key=>send(new DeleteObjectCommand({Bucket:bucket,Key}))));
      }
      await send(new DeleteBucketCommand({Bucket:bucket}));
    } catch { console.error('Could not clean disposable local test bucket: '+bucket);process.exitCode=1; }
  }
  storage?.destroy();
  if(disposableStorage) {
    try { await disposableStorage.close(); }
    catch { console.error('Could not remove this run\'s disposable local S3 container: designx-test-s3-'+runId);process.exitCode=1; }
  }
  if (databaseCreated) {
    try {
      const deadline=Date.now()+5000;
      while((await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[databaseName])).rowCount) {
        if(Date.now()>=deadline)throw new Error('Test database still has open connections: '+databaseName);
        await delay(50);
      }
      await admin.query(`DROP DATABASE "${databaseName}"`);
    } catch(error) { console.error(error instanceof Error?error.message:'Test database cleanup failed');process.exitCode=1; }
  }
  await admin?.end();
  process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
}
