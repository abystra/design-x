// CI/manual template build only. Credentials remain process environment, never image layers.
import { Template } from 'e2b';
import { build } from 'esbuild';
import { config as loadEnv } from 'dotenv';
import { mkdir, mkdtemp, readFile, readdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.env.NODE_ENV !== 'production') loadEnv({ path: [root + '.env', root + '.env.ai.local'], quiet: true });
if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required to build the sandbox template');
execFileSync('python3', [root + 'runtime/matfs/build.py'], { stdio: 'inherit' });
await mkdir(root + 'infra/e2b/dist', { recursive: true });
const validator = await build({ absWorkingDir: root, entryPoints: ['apps/harness/src/validate.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
await writeFile(root + 'infra/e2b/dist/validate.mjs', validator.outputFiles[0].text);
const provenance = JSON.parse(await readFile(root + 'runtime/provenance.json', 'utf8'));
const hashedFiles = ['infra/e2b/Dockerfile','runtime/runner/pyproject.toml','packages/ai-runtime/src/deepseek-models.json','runtime/matfs/dist/designx-matfs','runtime/matfs/dist/provenance.json','runtime/provenance.json','infra/e2b/dist/validate.mjs',
  ...(await readdir(root + 'runtime/runner/src/designx_runner')).filter(name => name.endsWith('.py')).sort().map(name => `runtime/runner/src/designx_runner/${name}`)];
const sourceHashes:Record<string,string> = {};
for (const path of hashedFiles) sourceHashes[path] = createHash('sha256').update(await readFile(root + path)).digest('hex');
const digest = createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex');
// Snapshot an allowlisted build context. Neither repository ignore rules nor future
// concurrent edits can accidentally upload secrets or remove required binary inputs.
const context = await mkdtemp(`${tmpdir()}/designx-template-`);
let info;
try {
  for (const path of hashedFiles) { await mkdir(dirname(context + '/' + path), { recursive: true }); await cp(root + path, context + '/' + path); }
  const template = Template({ fileContextPath: context }).fromDockerfile(context + '/infra/e2b/Dockerfile');
  info = await Template.build(template, 'designx-runner-v2', { apiKey: process.env.E2B_API_KEY, cpuCount: 2, memoryMB: 2048,
    onBuildLogs: event => { if (event.message?.startsWith('[')) process.stdout.write(event.message.slice(0, 500) + '\n'); } });
} finally { await rm(context, { recursive: true, force: true }); }
const result = { ...info, pinnedTemplate: `${info.templateId}:${info.buildId}`, codexVersion: '0.166.0', sourceCommit: provenance.commit, buildDigest: digest, sourceHashes, createdAt: new Date().toISOString() };
await writeFile(root + 'infra/e2b/dist/build.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
