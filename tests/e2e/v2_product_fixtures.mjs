import assert from 'node:assert/strict';
import { tenantTransaction } from '../../packages/server-infra/src/db.ts';

export const nativeQuestionRequest = { mode: 'create', prompt: '请选择活动海报主色', count: 1, ratio: '1:1' };
export const nativeQuestions = [{ id: 'color', header: '主色', question: '选择主色', options: [{ label: '暖橙色', description: '温暖的秋日氛围' }, { label: '墨绿色', description: '自然清新' }] }];

// These browser fixtures deliberately have no Runner, queue dispatch or sandbox.
// Stop acceptance cannot finish a non-existent observer, so the test owns its
// terminal bookkeeping. Never use this helper for actual executions.
export async function cleanupNativeQuestionFixture(fixture) {
  const { workspaceId, turnId, attemptId, interactionId, sessionId } = fixture;
  return tenantTransaction(workspaceId, async tx => {
    const row = (await tx.query(`SELECT a.*,t.request,t.context,t.stage,j.status AS job_status,j.payload,j.execution_token
      FROM ai_attempts a JOIN ai_turns t ON t.id=a.turn_id JOIN jobs j ON j.id=t.id
      WHERE a.id=$1 AND a.turn_id=$2 AND a.workspace_id=$3 AND t.session_id=$4 FOR UPDATE OF a,t,j`, [attemptId, turnId, workspaceId, sessionId])).rows[0];
    assert.ok(row, 'Refusing fixture cleanup: execution identity does not match');
    assert.deepEqual(row.request, nativeQuestionRequest, 'Refusing cleanup of a non-fixture request');
    assert.deepEqual(row.context, {}, 'Refusing cleanup of a native execution context');
    assert.deepEqual(row.payload, {}, 'Refusing cleanup of a dispatched job');
    assert.equal(row.execution_token, attemptId);
    for (const field of ['sandbox_id', 'thread_id', 'model', 'usage', 'lease_owner', 'lease_until', 'fence']) assert.equal(row[field], null, `Refusing fixture cleanup: ${field} exists`);
    assert.equal(Number(row.event_cursor), 0);
    assert.ok(['active', 'closed'].includes(row.status));
    assert.ok(row.outcome === null || row.outcome === 'not_dispatched');
    assert.ok(['running', 'cancelled'].includes(row.job_status));
    const session = (await tx.query('SELECT * FROM creative_sessions WHERE id=$1 FOR UPDATE', [sessionId])).rows[0];
    assert.ok(session && session.active_attempt_id === null && session.sandbox_id === null && session.native_thread_id === null, 'Refusing cleanup of an attached native session');
    const interactions = (await tx.query('SELECT * FROM agent_interactions WHERE attempt_id=$1 FOR UPDATE', [attemptId])).rows;
    assert.equal(interactions.length, 1);
    assert.equal(interactions[0].id, interactionId);
    assert.equal(interactions[0].native_request_id, 1);
    assert.deepEqual(interactions[0].questions, nativeQuestions);
    assert.equal(Number((await tx.query('SELECT count(*) FROM agent_runtime_events WHERE attempt_id=$1', [attemptId])).rows[0].count), 0, 'Refusing cleanup of observed runtime events');
    await tx.query("UPDATE ai_attempts SET status='closed',outcome='not_dispatched',updated_at=now() WHERE id=$1", [attemptId]);
    await tx.query("UPDATE jobs SET status='cancelled',updated_at=now() WHERE id=$1 AND status='running'", [turnId]);
    await tx.query("UPDATE ai_turns SET stage='cancelled',updated_at=now() WHERE id=$1", [turnId]);
    await tx.query("UPDATE agent_interactions SET status='cancelled',resolved_at=now() WHERE attempt_id=$1 AND status='pending'", [attemptId]);
    await tx.query("UPDATE agent_commands SET status=CASE WHEN type='stop' THEN 'applied' ELSE 'rejected' END,updated_at=now() WHERE attempt_id=$1 AND status IN ('pending','delivered')", [attemptId]);
    return { attemptId, status: 'closed', outcome: 'not_dispatched' };
  });
}
