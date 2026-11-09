import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildTestEnvironment} from '../../scripts/test-environment.mjs';

const inherited={
  DATABASE_URL:'postgres://live:secret@production.example.com/real',
  S3_ENDPOINT:'https://live.r2.cloudflarestorage.com',S3_BUCKET:'live-assets',
  S3_ACCESS_KEY_ID:'live-storage-key',S3_SECRET_ACCESS_KEY:'live-storage-secret',
  S3_BUCKET_ALIASES_JSON:'{"old":{"bucket":"live"}}',
  LEGACY_S3_ENDPOINT:'https://legacy.example.com',LEGACY_S3_BUCKET:'live-legacy',
  LEGACY_S3_ACCESS_KEY_ID:'live-legacy-key',LEGACY_S3_SECRET_ACCESS_KEY:'live-legacy-secret',
  AWS_SESSION_TOKEN:'live-token',WORKX_R2_ACCESS_KEY_ID:'live-workx-key',
  OPENAI_API_KEY:'live-image-key',OPENAI_BASE_URL:'https://images.example.com',
  E2B_API_KEY:'live-sandbox-key',DEEPSEEK_API_KEY:'live-model-key',
  AI_ENABLED:'true',IMAGE_GENERATION_ENABLED:'true',DESIGNX_RUNNER_V2:'true',
};

test('ordinary regression replaces inherited live infrastructure and credentials',()=>{
  const env=buildTestEnvironment(inherited,'00112233445566778899aabbccddeeff');
  assert.match(env.DATABASE_URL,/@127\.0\.0\.1:55432\/designx$/);
  assert.equal(env.S3_ENDPOINT,'http://127.0.0.1:58333');
  assert.equal(env.S3_BUCKET,'designx-test-00112233445566778899');
  assert.equal(new Set([env.S3_BUCKET,env.S3_STAGING_BUCKET,env.TEST_LEGACY_BUCKET]).size,3);
  assert.equal(env.S3_BUCKET_ALIASES_JSON,'{}');
  for(const key of Object.keys(inherited)) {
    if(key.startsWith('LEGACY_S3_'))assert.equal(env[key],'');
    if(key.startsWith('AWS_')||key.startsWith('WORKX_')||key==='OPENAI_BASE_URL')assert.equal(env[key],undefined);
  }
  for(const key of ['OPENAI_API_KEY','DEEPSEEK_API_KEY','E2B_API_KEY'])assert.match(env[key],/^test-only-/);
  for(const key of ['AI_ENABLED','IMAGE_GENERATION_ENABLED','DESIGNX_RUNNER_V2'])assert.equal(env[key],'false');
  assert.equal(Object.values(env).some(value=>typeof value==='string'&&value.includes('live-')),false);
});

test('explicit test overrides only accept local disposable infrastructure',()=>{
  const env=buildTestEnvironment({...inherited,TEST_DATABASE_URL:'postgres://tester:fixture@localhost:55433/tests',TEST_S3_ENDPOINT:'http://minio:9000',TEST_S3_BUCKET:'fixture-run-assets',TEST_S3_STAGING_BUCKET:'fixture-run-stage'},'123');
  assert.equal(env.DATABASE_URL,'postgres://tester:fixture@localhost:55433/tests');
  assert.equal(env.S3_ENDPOINT,'http://minio:9000');
  assert.equal(env.S3_BUCKET,'fixture-run-assets');
  for(const override of [
    {TEST_DATABASE_URL:'postgres://live:do-not-log-me@production.example.com/real'},
    {TEST_S3_ENDPOINT:'https://live.r2.cloudflarestorage.com'},
    {TEST_S3_ENDPOINT:'http://127.0.0.1@production.example.com'},
  ])assert.throws(()=>buildTestEnvironment(override,'123'),error=>error instanceof Error&&/local/.test(error.message)&&!error.message.includes('do-not-log-me'));
});

test('actual server config and direct dotenv imports cannot reload developer cloud settings',async()=>{
  const env=buildTestEnvironment({...process.env,...inherited},'00112233445566778899aabbccddeeff');
  const code=`import 'dotenv/config';
    const {config}=await import('./packages/server-infra/src/config.ts');
    console.log(JSON.stringify({endpoint:config.s3Endpoint,bucket:config.s3Bucket,imageEnabled:config.imageEnabled,aiEnabled:config.aiEnabled,key:config.openaiApiKey,aliases:process.env.S3_BUCKET_ALIASES_JSON,legacy:process.env.LEGACY_S3_ENDPOINT,runner:process.env.DESIGNX_RUNNER_V2}));`;
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',code],{env,timeout:10000});
  assert.deepEqual(JSON.parse(stdout.trim()),{endpoint:env.S3_ENDPOINT,bucket:env.S3_BUCKET,imageEnabled:false,aiEnabled:false,key:'test-only-no-image-credential',aliases:'{}',legacy:'',runner:'false'});
});
