import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const execute=promisify(execFile);
const image='chrislusf/seaweedfs:3.85';
const docker=async(args,signal)=>execute('docker',args,{timeout:20000,maxBuffer:65536,signal});

/** A fresh local S3 process per API regression; it cannot reuse application volumes. */
export async function startDisposableTestStorage({runId,accessKey,secretKey,signal},runDocker=docker) {
  const name=`designx-test-s3-${runId}`,label=`designx.test.run=${runId}`;
  let directory,creationAttempted=false;
  async function close() {
    try {
      if(creationAttempted) {
        // Name plus unguessable ownership label also cover a lost docker-run receipt.
        const {stdout}=await runDocker(['container','ls','--all','--quiet','--filter',`name=^/${name}$`,'--filter',`label=${label}`]);
        const id=stdout.trim();
        if(id) {
          if(!/^[a-f0-9]{12,64}$/.test(id))throw new Error('Unexpected disposable test container identity');
          await runDocker(['container','rm','--force','--volumes',id]);
        }
      }
    } finally { if(directory)await rm(directory,{recursive:true,force:true}); }
  }
  try {
    let imageId;
    try { imageId=(await runDocker(['image','inspect',image,'--format','{{.Id}}'],signal)).stdout.trim(); }
    catch { throw new Error(`API tests require running Docker and the existing local ${image} image, or an explicit TEST_S3_ENDPOINT. Tests never build or pull images.`); }
    if(!/^sha256:[a-f0-9]{64}$/.test(imageId))throw new Error('Cannot identify the existing local test S3 image');
    signal?.throwIfAborted();
    directory=await mkdtemp(join(tmpdir(),'designx-test-s3-'));
    const configFile=join(directory,'s3.json');
    await writeFile(configFile,JSON.stringify({identities:[{name:'designx-test',credentials:[{accessKey,secretKey}],actions:['Admin','Read','Write','List','Tagging']}]}),{mode:0o600});
    creationAttempted=true;
    await runDocker(['run','--detach','--rm','--pull=never','--name',name,'--label',label,'--publish','127.0.0.1::8333','--mount',`type=bind,source=${configFile},target=/etc/seaweedfs/s3.json,readonly`,imageId,
      'server','-s3','-s3.config=/etc/seaweedfs/s3.json','-dir=/data','-volume.max=64','-master.volumeSizeLimitMB=32'],signal);
    const published=(await runDocker(['port',name,'8333/tcp'],signal)).stdout.trim();
    if(!/^127\.0\.0\.1:\d{1,5}$/.test(published))throw new Error('Test S3 did not publish a random loopback port');
    const endpoint=`http://${published}`,deadline=Date.now()+45000;
    while(Date.now()<deadline) {
      signal?.throwIfAborted();
      try {
        const response=await fetch(endpoint,{signal:AbortSignal.any([AbortSignal.timeout(1000),...(signal?[signal]:[])])});
        await response.body?.cancel();
        if(response.status===200||response.status===403)return {endpoint,close};
      } catch { signal?.throwIfAborted(); }
      await delay(250,undefined,{signal});
    }
    throw new Error('Disposable local S3 did not become ready within 45 seconds');
  } catch(error) {
    try { await close(); } catch { throw new Error(`Test S3 setup failed and cleanup needs inspection: ${name}`); }
    throw error;
  }
}
