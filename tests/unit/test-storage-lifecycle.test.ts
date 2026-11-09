import test from 'node:test';
import assert from 'node:assert/strict';
import {startDisposableTestStorage} from '../../scripts/test-storage.mjs';

const options={runId:'00112233445566778899aabbccddeeff',accessKey:'fixture-access',secretKey:'fixture-secret',signal:undefined};

test('missing local S3 image fails without building, pulling or starting a container',async()=>{
  const calls:string[][]=[];
  await assert.rejects(startDisposableTestStorage(options,async(args:string[])=>{
    calls.push(args);throw new Error('No local image');
  }),/existing local .* image.*TEST_S3_ENDPOINT.*never build or pull/);
  assert.deepEqual(calls,[['image','inspect','chrislusf/seaweedfs:3.85','--format','{{.Id}}']]);
});

test('a lost container-start receipt only removes the exact container carrying this run ownership label',async()=>{
  const calls:string[][]=[];
  await assert.rejects(startDisposableTestStorage(options,async(args:string[])=>{
    calls.push(args);
    if(args[0]==='image')return {stdout:`sha256:${'a'.repeat(64)}`,stderr:''};
    if(args[0]==='run')throw new Error('Injected lost start receipt');
    if(args[1]==='ls')return {stdout:'b'.repeat(12),stderr:''};
    return {stdout:'',stderr:''};
  }),/Injected lost start receipt/);
  const start=calls[1];
  assert.ok(start.includes('--pull=never'));
  assert.equal(start[start.indexOf('--publish')+1],'127.0.0.1::8333');
  assert.deepEqual(calls.slice(2),[
    ['container','ls','--all','--quiet','--filter',`name=^/designx-test-s3-${options.runId}$`,'--filter',`label=designx.test.run=${options.runId}`],
    ['container','rm','--force','--volumes','b'.repeat(12)],
  ]);
});
