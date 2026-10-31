import { Sandbox } from 'e2b';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const artifactDir = 'tests/ai/.artifacts';
await mkdir(artifactDir, { recursive: true });
const redact = (s: string) => [process.env.E2B_API_KEY,process.env.DEEPSEEK_API_KEY]
  .filter(Boolean).reduce((v,k) => v.split(k!).join('[REDACTED]'),s)
  .replace(/(?:sk-|e2b_)[A-Za-z0-9_-]+/g, '[REDACTED]');
let sandbox: Sandbox | undefined;
const events: object[] = [];
try {
  assert(process.env.E2B_API_KEY && process.env.DEEPSEEK_API_KEY, 'Private runtime credentials are required');
  const template = process.env.E2B_TEMPLATE_ID || 'u1yrkaokyjzef8qchho5';
  // Reuse only an explicitly recorded, still-live verification sandbox; never silently retry a model run.
  const active = await readFile(`${artifactDir}/active-sandbox.json`, 'utf8').then(JSON.parse).catch(()=>null);
  sandbox = active ? await Sandbox.connect(active.sandboxId) : await Sandbox.create(template, {
    timeoutMs: 600000, network: { allowPublicTraffic: false, denyOut: ['0.0.0.0/0'], allowOut: ['api.deepseek.com'] },
    metadata: { purpose: 'designx-runtime-verification' },
  });
  await sandbox.updateNetwork({ denyOut: ['0.0.0.0/0'], allowOut: ['api.deepseek.com'] });
  const versions = await sandbox.commands.run('node --version && codex --version', { timeoutMs: 10000 });
  const bundle = await build({entryPoints:['apps/harness/src/main.ts'], bundle:true,platform:'node',format:'esm',write:false});
  const nonce = randomUUID();
  const outputSchema = {type:'object',properties:{nonce:{type:'string'},total:{type:'number'},phase:{type:'string'}},required:['nonce','total','phase'],additionalProperties:false};
  await sandbox.commands.run('mkdir -p /home/user/designx/work /home/user/designx/codex');
  await sandbox.files.write([
    {path:'/home/user/designx/harness.mjs',data:bundle.outputFiles[0].text},
    {path:'/home/user/designx/models.json',data:await readFile('packages/ai-runtime/src/deepseek-models.json','utf8')},
    {path:'/home/user/designx/work/input.json',data:JSON.stringify({nonce,numbers:[7,19,31]})},
    {path:'/home/user/designx/request.json',data:JSON.stringify({
      model:process.env.DEEPSEEK_MODEL || 'deepseek-flash',turnTimeoutMs:180000,
      turns:[
        {prompt:'Use your shell tool to read input.json in the working directory. Compute the sum of its numbers. Write proof.json with the input nonce, total, and phase="first". Return the same JSON. Do not read environment variables or credentials.',outputSchema,artifactFile:'proof.json'},
        {prompt:'Continue the previous task. Use a shell tool to read proof.json, add 5 to its total, preserve the nonce, and change phase to "second". Write proof.json and return its JSON.',outputSchema,artifactFile:'proof.json'},
      ],
    })},
  ]);
  let buffer='';
  await sandbox.commands.run('node /home/user/designx/harness.mjs',{
    timeoutMs:420000,retainOutput:false,
    envs:{DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY!},
    onStdout(chunk){
      buffer+=chunk;
      const lines=buffer.split('\n');buffer=lines.pop()||'';
      for(const line of lines)try {const event=JSON.parse(redact(line));events.push(event);console.log(JSON.stringify(event));}catch{/* Only the structured Harness protocol is surfaced. */}
    },
    onStderr(){/* CLI diagnostics may contain model input; never forward raw stderr. */},
  });
  const result=JSON.parse(await sandbox.files.read('/home/user/designx/result.json'));
  assert.equal(result.turns.length,2);
  for(const [i,turn] of result.turns.entries()) {
    assert(turn.toolCount>0,'The turn must actually execute a tool');
    assert.deepEqual(turn.artifact,{nonce,total:i===0?57:62,phase:i===0?'first':'second'});
  }
  assert.equal(result.turns[0].threadId,result.turns[1].threadId);
  assert.deepEqual(JSON.parse(await sandbox.files.read('/home/user/designx/work/proof.json')),{nonce,total:62,phase:'second'});
  const report={verifiedAt:new Date().toISOString(),templateId:template,sandboxId:sandbox.sandboxId,sdkVersion:'0.166.0',e2bVersion:'2.62.0',versions:versions.stdout.trim(),model:result.model,checks:{streaming:true,toolExecution:true,sameThreadFollowup:true,fileArtifact:true,validatedArtifact:true},turns:result.turns.map(({usage,toolCount,threadId}:any)=>({usage,toolCount,threadId}))};
  await writeFile(`${artifactDir}/runtime-verification.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,...report}));
} catch(error:any) {
  const message=redact(String(error.message || 'Runtime verification failed')).slice(0,800);
  await writeFile(`${artifactDir}/runtime-failure.json`,JSON.stringify({failedAt:new Date().toISOString(),message,events},null,2));
  console.error(JSON.stringify({passed:false,message}));process.exitCode=1;
} finally {
  if(sandbox) {
    await sandbox.kill();await rm(`${artifactDir}/active-sandbox.json`,{force:true});
    console.log(JSON.stringify({sandboxCleaned:true}));
  }
}
