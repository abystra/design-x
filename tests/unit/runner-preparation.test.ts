import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRunDirectories, refreshRunNetwork } from '../../packages/ai-runtime/src/app-server.js';
import type { RuntimeSession } from '../../packages/ai-runtime/src/protocol.js';

const session = { id: 'session-1', projectId: 'project-1', attemptId: 'attempt-2' } as RuntimeSession;

test('resumed material mount is removed before directory permissions are changed', async () => {
  let mounted = true, prepared = false;
  const sandbox = { commands: { run: async (command: string, options: any) => {
    assert.equal(options.user, 'root');
    if (command.startsWith('if mountpoint')) mounted = false;
    else if (command.includes('install -d')) {
      if (mounted) throw new Error('Read-only file system');
      prepared = true;
    }
  } } };
  await prepareRunDirectories(sandbox as any, session);
  assert.equal(mounted, false);
  assert.equal(prepared, true);
});

test('failed unmount stops preparation and does not modify or reuse the old material view', async () => {
  let calls = 0;
  const sandbox = { commands: { run: async () => { calls++; throw new Error('target is busy'); } } };
  await assert.rejects(prepareRunDirectories(sandbox as any, session), /target is busy/);
  assert.equal(calls, 1);
});

test('observer recovery keeps authorized R2 access while a new turn replaces the network', async () => {
  const original = { allowOut: ['api.deepseek.com', 'project.r2.cloudflarestorage.com'] };
  let network = original;
  const sandbox = { updateNetwork: async (value: typeof original) => { network = value; } };
  const withoutMountCredentials = { allowOut: ['api.deepseek.com'] };
  await refreshRunNetwork(sandbox as any, { ...session, resumeAttempt: true }, withoutMountCredentials);
  assert.equal(network, original, 'observer recovery must retain R2 for uncached material reads');
  await refreshRunNetwork(sandbox as any, { ...session, resumeAttempt: false }, withoutMountCredentials);
  assert.equal(network, withoutMountCredentials, 'a new material-free turn removes the previous R2 authorization');
});
