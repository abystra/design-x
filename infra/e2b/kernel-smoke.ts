// No model or R2 calls: verifies the exact binary and FUSE/root boundary in E2B.
import '../../packages/server-infra/src/env.js';
import { Sandbox } from 'e2b';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
const apiKey=process.env.E2B_API_KEY;
if(!apiKey)throw new Error('E2B_API_KEY is required for the kernel smoke test');
const build=JSON.parse(await readFile('infra/e2b/dist/build.json','utf8'));
let sandbox:Sandbox|undefined;
try {
 sandbox=await Sandbox.create(build.pinnedTemplate,{apiKey,timeoutMs:120000,network:{allowPublicTraffic:false,denyOut:['0.0.0.0/0']}});
 await sandbox.commands.run('install -d -m 700 /var/lib/designx/fuse-smoke && install -d -m 755 /workspaces/designx/fuse-smoke',{user:'root',timeoutMs:20000});
 const digest=await sandbox.commands.run('sha256sum /opt/designx/bin/designx-matfs',{user:'root',timeoutMs:10000});
 if(digest.stdout.trim().split(/\s+/)[0]!==build.sourceHashes['runtime/matfs/dist/designx-matfs'])throw new Error('Template matfs binary digest differs from build manifest');
 await sandbox.files.write('/var/lib/designx/fuse-smoke/manifest.gz',new Uint8Array(gzipSync(JSON.stringify({version:1,entries:[]}))).buffer,{user:'root'});
 const process=await sandbox.commands.run('/opt/designx/bin/designx-matfs --manifest /var/lib/designx/fuse-smoke/manifest.gz --mount /workspaces/designx/fuse-smoke --cache /var/lib/designx/fuse-smoke/cache --endpoint https://invalid.example --bucket fixture --prefix project/ --budget-bytes 1 --ready /var/lib/designx/fuse-smoke/ready',{user:'root',background:true,timeoutMs:0,retainOutput:false,envs:{DESIGNX_MATFS_ACCESS_KEY_ID:'fixture-not-a-real-key',DESIGNX_MATFS_SECRET_ACCESS_KEY:'fixture-not-a-real-secret',DESIGNX_MATFS_SESSION_TOKEN:'fixture-not-a-real-token'}});
 await sandbox.commands.run('for i in $(seq 1 50); do if test -f /var/lib/designx/fuse-smoke/ready; then exit 0; fi; sleep 0.1; done; exit 1',{user:'root',timeoutMs:10000});
 const probe=await sandbox.commands.run(`python3 -c 'import os,json,pathlib; p=pathlib.Path("/workspaces/designx/fuse-smoke"); denied=False\ntry:p.joinpath("forbidden").write_text("no")\nexcept OSError:denied=True\nprint(json.dumps({"files":os.listdir(p),"writeDenied":denied,"rootProcessDenied":not os.access("/proc/${process.pid}/environ",os.R_OK),"rootCacheDenied":not os.access("/var/lib/designx/fuse-smoke/cache",os.R_OK)}))'`,{user:'user',timeoutMs:20000});
 const checks=JSON.parse(probe.stdout.trim());
 if(checks.files.length||!checks.writeDenied||!checks.rootProcessDenied||!checks.rootCacheDenied)throw new Error('FUSE isolation smoke test failed');
 const report={template:build.pinnedTemplate,passed:true,binarySha256:build.sourceHashes['runtime/matfs/dist/designx-matfs'],checks,network:'deny-all; no R2 request or real storage credentials',verifiedAt:new Date().toISOString()};
 await mkdir('artifacts/v2',{recursive:true});await writeFile('artifacts/v2/e2b-fuse-kernel.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,template:build.pinnedTemplate,checks}));
} finally {if(sandbox)await sandbox.kill({requestTimeoutMs:10000});}
