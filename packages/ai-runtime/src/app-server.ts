import { Sandbox } from 'e2b';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeConfig, safeRuntimeError } from './config.js';
import { validateManifest } from './manifest.js';
import { CODEX_VERSION, parseJournal, shellQuote, type RuntimeSession, type RunnerCommand } from './protocol.js';
import type { SandboxTurnInput } from './index.js';

const python = '/opt/designx/venv/bin/python';
function paths(session: RuntimeSession) {
  for (const value of [session.id, session.projectId, session.attemptId])
    if (!/^[a-zA-Z0-9_-]{1,150}$/.test(value)) throw new Error('Invalid Runner identity');
  return { root: `/var/lib/designx/runs/${session.attemptId}`, cwd: `/workspaces/designx/runs/${session.attemptId}`, state: `/workspaces/designx/sessions/${session.id}` };
}

export async function prepareRunDirectories(sandbox: Pick<Sandbox, 'commands'>, session: RuntimeSession) {
  const { root, cwd, state } = paths(session);
  // A resumed VM still has the previous read-only FUSE view mounted. Unmount
  // before install chmods the mountpoint, including rounds with no materials.
  // An unmount failure must stop preparation rather than retain old authority.
  await sandbox.commands.run('if mountpoint -q /workspaces/designx/materials; then umount /workspaces/designx/materials; fi', { user: 'root', timeoutMs: 10000 });
  await sandbox.commands.run(`test ! -L ${shellQuote(cwd)} && test ! -L ${shellQuote(state)} && install -d -m 700 ${shellQuote(root)} && install -d -m 700 -o user -g user ${shellQuote(cwd)} ${shellQuote(state)} && install -d -m 755 /workspaces/designx/materials`, { user: 'root', timeoutMs: 10000 });
}

export async function refreshRunNetwork(sandbox: Pick<Sandbox, 'updateNetwork'>, session: RuntimeSession, network: Parameters<Sandbox['updateNetwork']>[0]) {
  // Reattached observers have no new material credentials. Their existing
  // attempt network remains authoritative until a fresh turn is authorized.
  if (!session.resumeAttempt) await sandbox.updateNetwork(network);
}

export async function pauseSandbox(sandboxId: string) {
  const cfg = runtimeConfig();
  // Full pause is a version-bound optimization; database history remains authoritative.
  return Sandbox.pause(sandboxId, { apiKey: cfg.apiKey, requestTimeoutMs: 10000 });
}

export async function sendRunnerCommand(sandbox: Sandbox, session: RuntimeSession, command: RunnerCommand) {
  const { root } = paths(session);
  if (!/^[a-zA-Z0-9_-]{1,150}$/.test(command.commandId)) throw new Error('Invalid command ID');
  const wire = JSON.stringify({ ...command, attemptId: session.attemptId, fence: session.fence });
  if (Buffer.byteLength(wire) > 256 * 1024) throw new Error('Runner command too large');
  // Write into root-private incoming storage; helper validates and atomically publishes.
  const incoming = `${root}/${command.commandId}.incoming`;
  await sandbox.files.write(incoming, wire, { user: 'root' });
  await sandbox.commands.run(`${python} -m designx_runner command --root ${shellQuote(root)} < ${shellQuote(incoming)}`, { user: 'root', timeoutMs: 10000 });
}

export async function runAppServerTurn(input: SandboxTurnInput) {
  if (!input.session) throw new Error('Persisted creative session is required');
  const session = input.session;
  const { root, cwd, state } = paths(session);
  const cfg = runtimeConfig();
  const template = process.env.DESIGNX_E2B_TEMPLATE;
  if (!template || !/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(template))
    throw new Error('DESIGNX_E2B_TEMPLATE must pin an immutable template build');
  input.signal?.throwIfAborted();
  const mount = input.materialMount;
  const allowedStorage = mount ? new URL(mount.endpoint).hostname : undefined;
  const network = {
    allowPublicTraffic: false, denyOut: ['0.0.0.0/0'],
    allowOut: ['api.deepseek.com', ...(allowedStorage ? [allowedStorage] : [])],
    rules: { 'api.deepseek.com': [{ transform: { headers: { Authorization: `Bearer ${cfg.modelKey}` } } }] },
  };
  const runKey = createHash('sha256').update(session.attemptId).digest('hex');
  let sandbox: Sandbox | undefined;
  let completed = false;
  let cursor = session.cursor || 0;
  let threadId = session.threadId || '';
  let usage: unknown;
  let observationFailures = 0;
  try {
    sandbox = session.sandboxId
      ? await Sandbox.connect(session.sandboxId, { apiKey: cfg.apiKey, timeoutMs: 600000 })
      : await Sandbox.create(template, { apiKey: cfg.apiKey, timeoutMs: 600000, idempotencyKey: runKey,
        metadata: { purpose: 'designx-ai-turn', runKey, sessionId: session.id, runner: 'v2' }, network });
    await input.onSandbox?.(sandbox.sandboxId);
    // An observer reattaches to the same authorized attempt without new mount
    // credentials. Preserve its existing R2 egress, just as journal reconnects
    // below do; a new turn still installs freshly authorized network rules.
    await refreshRunNetwork(sandbox, session, network);
    if (!session.resumeAttempt) {
      await sandbox.commands.run(`pkill -KILL -u user || true`, { user: 'root', timeoutMs: 10000 });
      await prepareRunDirectories(sandbox, session);
      if (mount) {
        await sandbox.files.write(`${root}/materials.json.gz`, new Uint8Array(mount.manifestBytes).buffer, { user: 'root' });
        const command = ['/opt/designx/bin/designx-matfs', '--manifest', `${root}/materials.json.gz`, '--mount', '/workspaces/designx/materials', '--cache', `${root}/cache`, '--endpoint', mount.endpoint, '--bucket', mount.bucket, '--prefix', mount.prefix, '--budget-bytes', String(mount.readBudgetBytes), '--ready', `${root}/mount.ready`].map(shellQuote).join(' ');
        await sandbox.commands.run(command, { user: 'root', background: true, timeoutMs: 0, envs: {
          DESIGNX_MATFS_ACCESS_KEY_ID: mount.credentials.accessKeyId,
          DESIGNX_MATFS_SECRET_ACCESS_KEY: mount.credentials.secretAccessKey,
          DESIGNX_MATFS_SESSION_TOKEN: mount.credentials.sessionToken,
        }, retainOutput: false });
        let ready = false;
        for (let i = 0; i < 40; i++) {
          input.signal?.throwIfAborted();
          if (await sandbox.files.exists(`${root}/mount.ready`, { user: 'root' })) { ready = true; break; }
          await delay(250);
        }
        if (!ready) throw new Error('Project material mount failed; execution was not started');
      }
      await sandbox.files.write(`${cwd}/context.json`, JSON.stringify(input.context), { user: 'user' });
      const images = input.images || [];
      if (images.length > 3 || images.reduce((n, image) => n + image.bytes.byteLength, 0) > 10 * 1024 * 1024) throw new Error('Reference image budget exceeded');
      for (const [index, image] of images.entries()) await sandbox.files.write(`${cwd}/reference-${index}.png`, new Uint8Array(image.bytes).buffer, { user: 'user' });
      const spec = { version: 2, codexVersion: CODEX_VERSION, runId: input.executionKey || session.attemptId,
        attemptId: session.attemptId, sessionId: session.id, projectId: session.projectId, fence: session.fence,
        deadline: session.deadline / 1000, cwd, stateDir: state, runRoot: root, binary: '/usr/local/bin/codex',
        modelCatalog: '/opt/designx/models.json', model: cfg.model, prompt: input.prompt, threadId: session.threadId,
        limits: { toolCalls: 60, outputBytes: 1024 * 1024 }, tools: input.tools || [], imagePaths: images.map((_, index) => `${cwd}/reference-${index}.png`) };
      await sandbox.files.write(`${root}/spec.json`, JSON.stringify(spec), { user: 'root' });
      // O_EXCL inside the Runner prevents re-submission if this launch reply is lost.
      try {
        await sandbox.commands.run(`${python} -m designx_runner run --root ${shellQuote(root)}`, { user: 'root', background: true, timeoutMs: 0, retainOutput: false });
      } catch {
        // Do not launch again. The persisted root journal is the only next observation.
      }
    }
    await input.onProgress?.({ stage: 'running', sandboxId: sandbox.sandboxId });
    while (Date.now() < session.deadline) {
      input.signal?.throwIfAborted();
      const commands = await input.pendingCommands?.() || [];
      for (const command of commands) await sendRunnerCommand(sandbox, session, command);
      let response;
      try {
        response = await sandbox.commands.run(`${python} -m designx_runner journal --root ${shellQuote(root)} --after ${cursor}`, { user: 'root', timeoutMs: 10000 });
        observationFailures = 0;
      } catch {
        if (++observationFailures > 12) throw new Error('Runner observation unavailable; native outcome requires reconciliation');
        // Reconnect to the existing sandbox/attempt; never start another Runner.
        await delay(Math.min(5000, observationFailures * 500));
        sandbox = await Sandbox.connect(sandbox.sandboxId, { apiKey: cfg.apiKey, timeoutMs: 600000 });
        continue;
      }
      const batch = parseJournal(response.stdout, session, cursor);
      for (const event of batch.events) {
        await input.onRuntimeEvent?.(event);
        if (event.type === 'session.ready') threadId = String(event.payload.threadId || '');
        if (event.type === 'usage.updated') usage = event.payload.usage;
        if (event.type === 'tool.requested') {
          const result = input.onTool ? await input.onTool(event.payload) : { success: false, result: { error: 'Tool not enabled' } };
          await sendRunnerCommand(sandbox, session, { commandId: createHash('sha256').update(`tool:${event.payload.callId}`).digest('hex'), type: 'toolResult', requestId: String(event.payload.requestId), ...result });
        }
        if (event.type === 'tool.completed') await input.onProgress?.({ stage: 'tool', threadId });
        cursor = event.sequence;
        if (event.type === 'run.failed') throw new Error(`Runner failed (${event.payload.outcome === 'unknown' ? 'outcome requires reconciliation' : 'before submission'})`);
        if (event.type === 'run.cancelled') throw new Error('Runner was stopped');
        if (event.type === 'run.completed') { completed = true; break; }
      }
      if (completed) break;
      await delay(300, undefined, { signal: input.signal });
    }
    if (!completed) throw new Error('Runner deadline exceeded; outcome requires reconciliation');
    const stream = await sandbox.files.read(`${root}/result.json`, { user: 'root', format: 'stream' });
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Runner output exceeded limit'); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    const serialized = Buffer.concat(chunks).toString('utf8');
    if (serialized.includes(cfg.apiKey) || serialized.includes(cfg.modelKey)) throw new Error('Runner output contains prohibited configuration');
    const result = JSON.parse(serialized);
    const manifest = validateManifest(result.manifest, (input.context as any)?.count || 1);
    return { manifest, runtime: { sandboxId: sandbox.sandboxId, threadId, model: cfg.model, usage } };
  } catch (error) {
    if (sandbox && (!input.ownsRuntime || await input.ownsRuntime().catch(() => false))) {
      // A stop is an independent durable command, followed by VM termination.
      const pendingStops = (await input.pendingCommands?.().catch(() => []) || []).filter(command => command.type === 'stop');
      for (const stop of pendingStops.length ? pendingStops : [{ commandId: randomUUID(), type: 'stop' as const }])
        await sendRunnerCommand(sandbox, session, stop).catch(() => undefined);
      await sandbox.kill({ requestTimeoutMs: 10000 }).catch(() => undefined);
    }
    throw new Error(safeRuntimeError(error));
  }
}
