import { createHash } from 'node:crypto';
import type { Tx } from '../../server-infra/src/db.js';
import { emit, HttpError, id } from './common.js';
import { lockActiveJob } from './ai-turns.js';
import { ensureCreativeSession } from './creative-sessions.js';
import type { RunnerEvent, RuntimeSession, RunnerCommand } from '../../ai-runtime/src/protocol.js';
import { beginNativeUsage, nativeUsageTotal, updateNativeUsage } from '../../ai-runtime/src/usage.js';

export async function claimRuntimeSession(tx: Tx, job: any, turn: any, leaseOwner: string, toolCatalog: unknown[] = []) {
  await ensureCreativeSession(tx, job.workspace_id, turn.project_id);
  const session = (await tx.query('SELECT * FROM creative_sessions WHERE project_id=$1 FOR UPDATE', [turn.project_id])).rows[0];
  if (session.active_attempt_id) {
    const prior = (await tx.query('SELECT a.*,j.status AS job_status FROM ai_attempts a JOIN jobs j ON j.id=a.turn_id WHERE a.id=$1', [session.active_attempt_id])).rows[0];
    if (prior && prior.status !== 'closed') throw new HttpError(409, 'SESSION_BUSY', '前一轮创作仍在运行或等待对账，请稍后再试');
  }
  const manifest = turn.context.materialManifest;
  // Versions are frozen per request. Scope boundaries depend on authorized identities,
  // not titles or current version pointers, so renaming/new versions do not revoke a run.
  const scope = createHash('sha256').update(JSON.stringify({ projectId: turn.project_id,
    assets: (manifest?.entries || []).map((e: any) => e.assetId).sort(), model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    codex: '0.166.0', template: process.env.DESIGNX_E2B_TEMPLATE || null, tools: toolCatalog })).digest('hex');
  const boundary = session.scope_fingerprint && session.scope_fingerprint !== scope ? 'authorization_or_runtime_changed'
    : session.retained_until && new Date(session.retained_until).getTime() < Date.now() ? 'retention_expired' : null;
  const retiredSandboxId = boundary ? session.sandbox_id : undefined;
  const fence = Number(session.fence) + 1;
  await tx.query("UPDATE creative_sessions SET active_attempt_id=$1,fence=$2,status='running',scope_fingerprint=$3,boundary_reason=$4,sandbox_id=$5,native_thread_id=$6,native_version='0.166.0',updated_at=now() WHERE id=$7", [job.execution_token, fence, scope, boundary, boundary ? null : session.sandbox_id, boundary ? null : session.native_thread_id, session.id]);
  await tx.query("UPDATE ai_attempts SET fence=$1,lease_owner=$2,lease_until=now()+interval '30 seconds' WHERE id=$3", [fence, leaseOwner, job.execution_token]);
  if (boundary) {
    await tx.query("INSERT INTO creative_messages(id,workspace_id,session_id,role,content) VALUES($1,$2,$3,'boundary',$4)", [id(), job.workspace_id, session.id, JSON.stringify({ reason: boundary })]);
    await emit(tx, job.workspace_id, 'activity.sessionBoundary', { projectId: turn.project_id, sessionId: session.id, reason: boundary });
  }
  const attempt = (await tx.query('SELECT deadline_at FROM ai_attempts WHERE id=$1', [job.execution_token])).rows[0];
  return { retiredSandboxId, session: { id: session.id, projectId: turn.project_id, attemptId: job.execution_token,
    fence, deadline: new Date(attempt.deadline_at).getTime(), sandboxId: boundary ? undefined : session.sandbox_id || undefined,
    threadId: boundary ? undefined : session.native_thread_id || undefined } as RuntimeSession };
}

export async function renewRuntimeLease(tx: Tx, job: any, leaseOwner: string) {
  await lockActiveJob(tx, job);
  const renewed = await tx.query("UPDATE ai_attempts a SET lease_until=now()+interval '30 seconds',updated_at=now() FROM creative_sessions s WHERE a.id=$1 AND a.lease_owner=$2 AND a.status='active' AND a.deadline_at>now() AND a.lease_until>now() AND s.active_attempt_id=a.id AND s.fence=a.fence RETURNING a.id", [job.execution_token, leaseOwner]);
  if (!renewed.rowCount) throw new HttpError(409, 'EXECUTION_LEASE_LOST', '执行租约已失效');
}

export async function ingestRuntimeEvent(tx: Tx, job: any, session: RuntimeSession, event: RunnerEvent, leaseOwner: string) {
  await lockActiveJob(tx, job);
  const attempt = (await tx.query('SELECT * FROM ai_attempts WHERE id=$1 FOR UPDATE', [job.execution_token])).rows[0];
  if (!attempt || Number(attempt.fence) !== event.fence || event.attemptId !== attempt.id || attempt.lease_owner !== leaseOwner || new Date(attempt.lease_until).getTime() <= Date.now())
    throw new HttpError(409, 'EXECUTION_FENCED', '执行已失效');
  if (event.sequence <= Number(attempt.event_cursor)) {
    const duplicate = await tx.query('SELECT 1 FROM agent_runtime_events WHERE attempt_id=$1 AND sequence=$2 AND fence=$3 AND type=$4 AND payload=$5::jsonb', [event.attemptId, event.sequence, event.fence, event.type, JSON.stringify(event.payload)]);
    if (!duplicate.rowCount) throw new HttpError(409, 'EVENT_CONFLICT', '执行事件内容不一致');
    return;
  }
  if (event.sequence !== Number(attempt.event_cursor) + 1) throw new HttpError(409, 'EVENT_GAP', '执行事件序号不连续');
  await tx.query('INSERT INTO agent_runtime_events(workspace_id,attempt_id,sequence,fence,type,payload) VALUES($1,$2,$3,$4,$5,$6)', [job.workspace_id, event.attemptId, event.sequence, event.fence, event.type, JSON.stringify(event.payload)]);
  await tx.query('UPDATE ai_attempts SET event_cursor=$1,updated_at=now() WHERE id=$2', [event.sequence, event.attemptId]);
  if (event.type === 'session.ready') {
    const threadId = String(event.payload.threadId).slice(0, 200);
    const resumed = typeof event.payload.resumed === 'boolean' ? event.payload.resumed : session.threadId === threadId;
    let baseline: ReturnType<typeof nativeUsageTotal> = null;
    if (resumed) {
      // Use the immediately preceding attempt on this project's same native
      // thread. Do not skip a missing usage record and accidentally bill old work.
      const prior = (await tx.query('SELECT a.id FROM ai_attempts a JOIN ai_turns t ON t.id=a.turn_id WHERE t.project_id=$1 AND a.thread_id=$2 AND a.id<>$3 AND a.created_at<=$4 ORDER BY a.created_at DESC,a.id DESC LIMIT 1', [session.projectId, threadId, event.attemptId, attempt.created_at])).rows[0];
      if (prior) {
        const usage = (await tx.query("SELECT payload->'usage' AS usage FROM agent_runtime_events WHERE attempt_id=$1 AND type='usage.updated' ORDER BY sequence DESC LIMIT 1", [prior.id])).rows[0];
        baseline = nativeUsageTotal(usage?.usage);
      }
    }
    await tx.query('UPDATE ai_attempts SET thread_id=$1,usage=$2 WHERE id=$3', [threadId, JSON.stringify(beginNativeUsage(threadId, resumed, baseline)), event.attemptId]);
    await tx.query('UPDATE creative_sessions SET native_thread_id=$1,updated_at=now() WHERE id=$2 AND active_attempt_id=$3 AND fence=$4', [String(event.payload.threadId).slice(0, 200), session.id, event.attemptId, event.fence]);
  } else if (event.type === 'usage.updated') {
    const previous = attempt.usage?.native?.version === 1 ? attempt.usage : beginNativeUsage(attempt.thread_id || '', true, null);
    await tx.query('UPDATE ai_attempts SET usage=$1 WHERE id=$2', [JSON.stringify(updateNativeUsage(previous, event.payload.usage, event.sequence)), event.attemptId]);
  } else if (event.type === 'session.boundary') {
    await tx.query('UPDATE creative_sessions SET boundary_reason=$1,native_thread_id=NULL WHERE id=$2 AND active_attempt_id=$3', [String(event.payload.reason).slice(0, 200), session.id, event.attemptId]);
    await tx.query("INSERT INTO creative_messages(id,workspace_id,session_id,turn_id,role,content) VALUES($1,$2,$3,$4,'boundary',$5) ON CONFLICT(turn_id,role) DO NOTHING", [id(), job.workspace_id, session.id, job.id, JSON.stringify(event.payload)]);
  } else if (event.type === 'interaction.requested') {
    await tx.query('INSERT INTO agent_interactions(id,workspace_id,session_id,turn_id,attempt_id,native_request_id,questions) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(attempt_id,native_request_id) DO NOTHING', [id(), job.workspace_id, session.id, job.id, event.attemptId, JSON.stringify(event.payload.requestId), JSON.stringify(event.payload.questions)]);
    await tx.query("UPDATE ai_turns SET stage='awaiting_input',updated_at=now() WHERE id=$1", [job.id]);
  } else if (event.type === 'interaction.resolved') {
    await tx.query("UPDATE agent_interactions SET status=$1,resolved_at=now() WHERE attempt_id=$2 AND native_request_id=$3 AND status='pending'", [event.payload.status === 'answered' ? 'answered' : 'cancelled', event.attemptId, JSON.stringify(event.payload.requestId)]);
    await tx.query("UPDATE ai_turns SET stage='running',updated_at=now() WHERE id=$1", [job.id]);
  } else if (event.type === 'command.ack') {
    await tx.query("UPDATE agent_commands SET status=$1,updated_at=now() WHERE id=$2 AND attempt_id=$3 AND status IN ('pending','delivered')", [event.payload.status === 'applied' ? 'applied' : 'rejected', event.payload.commandId, event.attemptId]);
    if (event.payload.status === 'applied') await tx.query("UPDATE agent_interactions i SET answers=c.payload->'answers' FROM agent_commands c WHERE c.id=$1 AND c.interaction_id=i.id", [event.payload.commandId]);
  } else if (event.type === 'run.failed') {
    await tx.query('UPDATE ai_attempts SET outcome=$1 WHERE id=$2', [event.payload.outcome === 'unknown' ? 'unknown' : 'not_submitted', event.attemptId]);
  }
  await emit(tx, job.workspace_id, event.type.startsWith('interaction.') ? 'interaction.updated' : 'activity.agent', { projectId: turnProject(session), turnId: job.id, sessionId: session.id, type: event.type, sequence: event.sequence, ...event.payload });
}
function turnProject(session: RuntimeSession) { return session.projectId; }

export async function pendingRuntimeCommands(tx: Tx, job: any): Promise<RunnerCommand[]> {
  const rows = (await tx.query("SELECT * FROM agent_commands WHERE turn_id=$1 AND (attempt_id=$2 OR attempt_id IS NULL) AND status IN ('pending','delivered') ORDER BY CASE type WHEN 'stop' THEN 0 ELSE 1 END,created_at LIMIT 32", [job.id, job.execution_token])).rows;
  return rows.map((row: any) => ({ commandId: row.id, type: row.type, ...row.payload }));
}

export async function finishRuntimeSession(tx: Tx, job: any, session: RuntimeSession, paused: boolean, success: boolean) {
  const result = await tx.query("UPDATE creative_sessions SET active_attempt_id=NULL,status=$1,sandbox_id=CASE WHEN $2 THEN sandbox_id ELSE NULL END,native_thread_id=CASE WHEN $2 THEN native_thread_id ELSE NULL END,retained_until=CASE WHEN $2 THEN now()+interval '24 hours' ELSE NULL END,boundary_reason=CASE WHEN $2 THEN boundary_reason ELSE 'previous_execution_ended' END,updated_at=now() WHERE id=$3 AND active_attempt_id=$4 AND fence=$5", [paused ? 'paused' : success ? 'idle' : 'recovery_required', paused, session.id, job.execution_token, session.fence]);
  if (result.rowCount) await tx.query("UPDATE ai_attempts SET status='closed',lease_until=NULL,updated_at=now() WHERE id=$1", [job.execution_token]);
  await tx.query("UPDATE agent_interactions SET status='cancelled',resolved_at=now() WHERE attempt_id=$1 AND status='pending'", [job.execution_token]);
  await tx.query("UPDATE agent_commands SET status=CASE WHEN type='stop' THEN 'applied' ELSE 'unknown' END,updated_at=now() WHERE attempt_id=$1 AND status IN ('pending','delivered')", [job.execution_token]);
}
