import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Tx } from '../../server-infra/src/db.js';
import { emit, HttpError, id, notFound } from './common.js';

export const AgentCommandInput = z.object({
  commandId: z.string().uuid(), type: z.enum(['answer', 'stop']),
  interactionId: z.string().uuid().optional(),
  answers: z.record(z.string().min(1).max(200), z.object({ answers: z.array(z.string().max(16384)).max(32) }).strict()).optional(),
}).strict();

export async function ensureCreativeSession(tx: Tx, workspaceId: string, projectId: string) {
  if (!(await tx.query('SELECT id FROM projects WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [projectId])).rowCount) notFound();
  await tx.query('INSERT INTO creative_sessions(id,workspace_id,project_id) VALUES($1,$2,$3) ON CONFLICT(project_id) DO NOTHING', [id(), workspaceId, projectId]);
  return (await tx.query('SELECT * FROM creative_sessions WHERE project_id=$1', [projectId])).rows[0];
}

export async function sessionContext(tx: Tx, sessionId: string) {
  const rows = (await tx.query("SELECT role,content,created_at FROM creative_messages WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 24", [sessionId])).rows;
  const answered = (await tx.query("SELECT questions,answers,resolved_at FROM agent_interactions WHERE session_id=$1 AND status='answered' AND answers IS NOT NULL ORDER BY resolved_at DESC LIMIT 24", [sessionId])).rows;
  for (const answer of answered) rows.push({role:'user',content:{kind:'confirmed_answer',questions:answer.questions,answers:answer.answers},created_at:answer.resolved_at});
  rows.sort((a:any,b:any)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime());
  const bounded = [];
  let size = 0;
  for (const row of rows) {
    const message = { role: row.role, content: row.content };
    size += Buffer.byteLength(JSON.stringify(message));
    if (size > 48000) break;
    bounded.unshift(message);
  }
  return bounded;
}

export async function attachTurnToSession(tx: Tx, workspaceId: string, projectId: string, turnId: string, prompt: string) {
  const session = await ensureCreativeSession(tx, workspaceId, projectId);
  await tx.query('UPDATE ai_turns SET session_id=$1,runtime_protocol=$2 WHERE id=$3', [session.id, process.env.DESIGNX_RUNNER_V2 === 'true' ? 'designx-runner-v2' : 'legacy', turnId]);
  await tx.query("INSERT INTO creative_messages(id,workspace_id,session_id,turn_id,role,content) VALUES($1,$2,$3,$4,'user',$5) ON CONFLICT(turn_id,role) DO NOTHING", [id(), workspaceId, session.id, turnId, JSON.stringify({ text: prompt })]);
  return session.id as string;
}

export async function readCreativeSession(tx: Tx, projectId: string) {
  const session = (await tx.query('SELECT s.* FROM creative_sessions s JOIN projects p ON p.id=s.project_id WHERE s.project_id=$1 AND p.deleted_at IS NULL', [projectId])).rows[0];
  if (!session) return { projectId, session: null, messages: [], interactions: [], commands: [] };
  const messages = (await tx.query('SELECT id,turn_id AS "turnId",role,content,created_at AS "createdAt" FROM creative_messages WHERE session_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [session.id])).rows.reverse();
  const interactions = (await tx.query('SELECT id,turn_id AS "turnId",questions,status,answers,created_at AS "createdAt" FROM agent_interactions WHERE session_id=$1 ORDER BY created_at DESC LIMIT 100', [session.id])).rows;
  const commands = (await tx.query('SELECT c.id,c.turn_id AS "turnId",c.interaction_id AS "interactionId",c.type,c.status,c.created_at AS "createdAt" FROM agent_commands c JOIN ai_turns t ON t.id=c.turn_id WHERE t.session_id=$1 ORDER BY c.created_at DESC LIMIT 100', [session.id])).rows;
  return { projectId, session: { id: session.id, status: session.status, boundaryReason: session.boundary_reason, updatedAt: session.updated_at }, messages, interactions, commands };
}

export async function submitAgentCommand(tx: Tx, workspaceId: string, turnId: string, raw: unknown) {
  const input = AgentCommandInput.parse(raw);
  const turn = (await tx.query('SELECT t.*,j.status AS job_status,j.execution_token FROM ai_turns t JOIN jobs j ON j.id=t.id JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.deleted_at IS NULL FOR UPDATE OF t,j', [turnId])).rows[0];
  if (!turn) notFound();
  const requestHash = createHash('sha256').update(JSON.stringify({ turnId, ...input })).digest('hex');
  const existing = (await tx.query('SELECT * FROM agent_commands WHERE id=$1', [input.commandId])).rows[0];
  if (existing) {
    if (existing.request_hash !== requestHash) throw new HttpError(409, 'COMMAND_ID_REUSED', '控制命令 ID 已用于其他请求');
    return { id: existing.id, status: existing.status };
  }
  if (!['running', 'queued'].includes(turn.job_status)) throw new HttpError(409, 'TURN_FINISHED', '此轮创作已结束');
  let interaction;
  if (input.type === 'answer') {
    if (!input.interactionId || !input.answers) throw new HttpError(400, 'ANSWER_REQUIRED', '请选择问题并填写回答');
    interaction = (await tx.query("SELECT * FROM agent_interactions WHERE id=$1 AND turn_id=$2 AND status='pending' FOR UPDATE", [input.interactionId, turnId])).rows[0];
    if (!interaction || interaction.attempt_id !== turn.execution_token) throw new HttpError(409, 'INTERACTION_CLOSED', '此问题已结束或运行已变化');
    const ids = interaction.questions.map((q: any) => q.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(Object.keys(input.answers).sort())) throw new HttpError(400, 'INVALID_ANSWERS', '回答必须对应当前问题');
    if ((await tx.query("SELECT 1 FROM agent_commands WHERE interaction_id=$1 AND status IN ('pending','delivered','applied')", [interaction.id])).rowCount) throw new HttpError(409, 'ANSWER_PENDING', '回答正在处理');
  }
  const payload = input.type === 'answer' ? { answers: input.answers, requestId: interaction.native_request_id } : {};
  await tx.query('INSERT INTO agent_commands(id,workspace_id,turn_id,attempt_id,interaction_id,type,payload,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [input.commandId, workspaceId, turnId, turn.execution_token, input.interactionId || null, input.type, JSON.stringify(payload), requestHash]);
  // Cancellation intent is effective even if the observer or Runner is disconnected.
  if (input.type === 'stop') {
    await tx.query("UPDATE jobs SET status='cancelled',updated_at=now() WHERE id=$1 AND status IN ('queued','running')", [turnId]);
    await tx.query("UPDATE agent_interactions SET status='cancelled',resolved_at=now() WHERE turn_id=$1 AND status='pending'", [turnId]);
  }
  await emit(tx, workspaceId, 'interaction.command', { projectId: turn.project_id, turnId, commandId: input.commandId, type: input.type, status: 'pending' });
  return { id: input.commandId, status: 'pending' };
}

export async function recordSessionCompletion(tx: Tx, workspaceId: string, turn: any, summary: string, result: unknown) {
  if (!turn.session_id) return;
  await tx.query("INSERT INTO creative_messages(id,workspace_id,session_id,turn_id,role,content) VALUES($1,$2,$3,$4,'assistant',$5) ON CONFLICT(turn_id,role) DO NOTHING", [id(), workspaceId, turn.session_id, turn.id, JSON.stringify({ text: summary, result })]);
}

export async function recordSessionTool(tx:Tx,workspaceId:string,turn:any,callId:string,name:string,result:unknown) {
  if(!turn.session_id)return;
  const entry={callId,name,result};
  await tx.query("INSERT INTO creative_messages(id,workspace_id,session_id,turn_id,role,content) VALUES($1,$2,$3,$4,'tool',$5) ON CONFLICT(turn_id,role) DO UPDATE SET content=jsonb_set(creative_messages.content,'{calls}',(creative_messages.content->'calls') || (EXCLUDED.content->'calls')) WHERE NOT creative_messages.content @> $6::jsonb",[id(),workspaceId,turn.session_id,turn.id,JSON.stringify({calls:[entry]}),JSON.stringify({calls:[{callId}]})]);
}
