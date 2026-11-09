import sharp from "sharp";
import { randomUUID } from 'node:crypto';
import {
  tenantTransaction,
  pool,
} from "../../../packages/server-infra/src/db.js";
import { getObject, legacyReadBucket } from "../../../packages/server-infra/src/storage.js";
import { aiTurnTimeoutSeconds } from "../../../packages/server-infra/src/queue.js";
import {
  readTurn,
  commitTurn,
  lockActiveJob,
} from "../../../packages/server-domain/src/ai-turns.js";
import {
  emit,
  jobDto,
  HttpError,
} from "../../../packages/server-domain/src/common.js";
import { updateJob } from "../../../packages/server-domain/src/jobs.js";
import { assertActive } from "./process.js";
import type { SandboxTurnInput } from "../../../packages/ai-runtime/src/index.js";
import type { RuntimeSession } from '../../../packages/ai-runtime/src/protocol.js';
import { authorizeFrozenMaterials, prepareProjectMaterialMount } from '../../../packages/server-domain/src/project-materials.js';
import { recordSessionCompletion, recordSessionTool } from '../../../packages/server-domain/src/creative-sessions.js';
import { claimRuntimeSession, renewRuntimeLease, ingestRuntimeEvent, pendingRuntimeCommands, finishRuntimeSession } from '../../../packages/server-domain/src/runtime-sessions.js';
import { executeAgentTool, agentToolCatalog } from '../../../packages/server-domain/src/agent-tools.js';
import { safeTokenUsage } from '../../../packages/ai-runtime/src/usage.js';
export type AiRuntime = {
  runSandboxTurn: (input: SandboxTurnInput) => Promise<{
    manifest: unknown;
    runtime: {
      sandboxId: string;
      threadId: string;
      model: string;
      usage: unknown;
    };
  }>;
  killSandbox: (id: string) => Promise<unknown>;
  findSandboxesForExecution: (executionKey: string) => Promise<string[]>;
  runAppServerTurn?: AiRuntime['runSandboxTurn'];
  pauseSandbox?: (id: string) => Promise<unknown>;
};
async function runtimeDefault(): Promise<AiRuntime> {
  return import("../../../packages/ai-runtime/src/index.js");
}
function legacyUsage(value: unknown) {
  const counters = safeTokenUsage(value);
  return Object.keys(counters).length ? JSON.stringify(counters) : null;
}
async function closeAttempt(
  workspaceId: string,
  attemptId: string,
  runtime: AiRuntime,
) {
  const attempt = await tenantTransaction(
    workspaceId,
    async (tx) =>
      (await tx.query("SELECT * FROM ai_attempts WHERE id=$1", [attemptId]))
        .rows[0],
  );
  if (!attempt || attempt.status === "closed") return;
  if (attempt.outcome === 'not_dispatched') {
    // Preparation failed before the E2B create/connect intent. There is no
    // uncertain remote creation to wait for, so release the session immediately.
    await tenantTransaction(workspaceId, tx => tx.query("UPDATE ai_attempts SET status='closed',lease_until=NULL,updated_at=now() WHERE id=$1 AND outcome='not_dispatched'", [attemptId]));
    return;
  }
  try {
    const sandboxIds = attempt.sandbox_id
      ? [attempt.sandbox_id]
      : await runtime.findSandboxesForExecution(attempt.id);
    if (
      !sandboxIds.length &&
      new Date(attempt.deadline_at).getTime() > Date.now()
    ) {
      // Create may still be in flight: a successful empty lookup is not proof
      // that no sandbox will appear. Keep the attempt discoverable until its deadline.
      await tenantTransaction(workspaceId, (tx) =>
        tx.query(
          "UPDATE ai_attempts SET status='active',updated_at=now() WHERE id=$1 AND sandbox_id IS NULL",
          [attemptId],
        ),
      );
      return;
    }
    for (const sandboxId of new Set<string>(sandboxIds))
      await runtime.killSandbox(sandboxId);
    await tenantTransaction(workspaceId, (tx) =>
      tx.query(
        "UPDATE ai_attempts SET status='closed',sandbox_id=COALESCE(sandbox_id,$2),updated_at=now() WHERE id=$1 AND sandbox_id IS NOT DISTINCT FROM $3",
        [attemptId, sandboxIds[0] || null, attempt.sandbox_id],
      ),
    );
  } catch {
    await tenantTransaction(workspaceId, (tx) =>
      tx.query(
        "UPDATE ai_attempts SET status='cleanup_failed',updated_at=now() WHERE id=$1",
        [attemptId],
      ),
    );
  }
}
export async function runAiTurn(job: any, injectedRuntime?: AiRuntime, resumeSession?: RuntimeSession) {
  const runtime = injectedRuntime || (await runtimeDefault());
  const leaseOwner = randomUUID();
  let runtimeSession: RuntimeSession | undefined;
  let retiredSandboxId: string | undefined;
  let committed = false;
  let observedSandboxId: string | undefined;
  const turn = await tenantTransaction(job.workspace_id, async (tx) => {
    await lockActiveJob(tx, job);
    const turn = await readTurn(tx, job.id);
    if (!resumeSession) await tx.query(
      "INSERT INTO ai_attempts(id,workspace_id,turn_id,queue_id,deadline_at,outcome) VALUES($1,$2,$3,$4,now()+$5*interval '1 second',$6)",
      [
        job.execution_token,
        job.workspace_id,
        job.id,
        job.queue_id,
        aiTurnTimeoutSeconds,
        turn.runtime_protocol === 'designx-runner-v2' ? 'not_dispatched' : null,
      ],
    );
    if (!resumeSession) await tx.query(
      "UPDATE ai_turns SET stage='preparing',updated_at=now() WHERE id=$1",
      [job.id],
    );
    if (resumeSession) {
      const reclaimed = await tx.query("UPDATE ai_attempts SET lease_owner=$1,lease_until=now()+interval '30 seconds' WHERE id=$2 AND lease_until<now() AND status='active' AND deadline_at>now() RETURNING id", [leaseOwner, job.execution_token]);
      if (!reclaimed.rowCount) throw new HttpError(409, 'EXECUTION_ALREADY_OBSERVED', '已有观察者恢复本轮执行');
      runtimeSession = resumeSession;
      observedSandboxId = resumeSession.sandboxId;
    } else if (turn.runtime_protocol === 'designx-runner-v2') {
      const claimed = await claimRuntimeSession(tx, job, turn, leaseOwner, agentToolCatalog);
      runtimeSession = claimed.session;
      retiredSandboxId = claimed.retiredSandboxId;
    }
    return turn;
  });
  const controller = new AbortController();
  let polling = false,
    lastProgress = 0,
    lastStage = "";
  const deadline = setTimeout(
    () => controller.abort(new Error("AI 创作超时")),
    runtimeSession ? Math.max(1, runtimeSession.deadline - Date.now()) : aiTurnTimeoutSeconds * 1000,
  );
  const poll = setInterval(async () => {
    if (polling || controller.signal.aborted) return;
    polling = true;
    try {
      await assertActive(job);
      if (runtimeSession || turn.context.materialManifest) await tenantTransaction(job.workspace_id, async tx => {
        if (runtimeSession) await renewRuntimeLease(tx, job, leaseOwner);
        if (turn.context.materialManifest) await authorizeFrozenMaterials(tx, turn.context.materialManifest);
      });
    } catch {
      controller.abort(new Error("AI 创作已取消或执行已失效"));
    } finally {
      polling = false;
    }
  }, 1000);
  try {
    if (retiredSandboxId) await runtime.killSandbox(retiredSandboxId);
    const materialMount = runtimeSession && !resumeSession && turn.context.materialManifest?.entries?.length
      ? await prepareProjectMaterialMount(job.workspace_id, turn.project_id, job.execution_token, turn.context.materialManifest, { signal:controller.signal, deadlineAt:runtimeSession.deadline })
      : undefined;
    const preferred = [
      ...turn.request.assetIds,
      ...turn.context.assets.map((a: any) => a.id),
    ];
    const imageIds = [...new Set<string>(preferred)].slice(0, 3);
    const frozen = turn.context.materialManifest?.entries;
    const assets = frozen ? imageIds.map(id => {
      const entry = frozen.find((a: any) => a.assetId === id);
      return entry ? { id, object_key: entry.objectKey, bucket: entry.bucket } : undefined;
    }).filter(Boolean) : await tenantTransaction(
      job.workspace_id,
      async (tx) =>
        (
          await tx.query(
            "SELECT id,object_key,storage_bucket AS bucket FROM assets WHERE id=ANY($1::text[]) AND status='ready' AND deleted_at IS NULL",
            [imageIds],
          )
        ).rows,
    );
    if (assets.length !== imageIds.length)
      throw new HttpError(
        422,
        "INVALID_AI_ASSET",
        "参考素材已被删除，请重新选择",
      );
    const images: Array<{ name: string; bytes: Uint8Array }> = [];
    for (const assetId of imageIds) {
      controller.signal.throwIfAborted();
      const asset = assets.find((a) => a.id === assetId)!;
      const object = await getObject(asset.object_key, { bucket: asset.bucket || (frozen ? undefined : legacyReadBucket()) });
      const bytes = await sharp(object.bytes, {
        limitInputPixels: 40000000,
        animated: false,
      })
        .rotate()
        .resize({
          width: 1600,
          height: 1600,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
      images.push({ name: asset.id, bytes });
    }
    if (
      images.reduce((size, image) => size + image.bytes.byteLength, 0) >
      10 * 1024 * 1024
    )
      throw new HttpError(
        413,
        "AI_CONTEXT_TOO_LARGE",
        "参考图片过大，请减少引用",
      );
    const context = {
      ...turn.context,
      imageReferences: imageIds.map((id, index) => ({
        assetId: id,
        path: `reference-${index}.png`,
      })),
    };
    const run = runtimeSession ? runtime.runAppServerTurn : runtime.runSandboxTurn;
    if (!run) throw new Error('Requested Runner protocol is not installed');
    if (runtimeSession && !resumeSession) await tenantTransaction(job.workspace_id, async tx => {
      await renewRuntimeLease(tx, job, leaseOwner);
      await tx.query('UPDATE ai_attempts SET outcome=NULL WHERE id=$1 AND lease_owner=$2', [job.execution_token,leaseOwner]);
    });
    const output = await run({
      executionKey: job.execution_token,
      context,
      prompt: turn.request.prompt,
      images,
      signal: controller.signal,
      session: runtimeSession,
      materialMount,
      tools: runtimeSession ? agentToolCatalog : undefined,
      ownsRuntime: runtimeSession ? () => tenantTransaction(job.workspace_id, async tx => (await tx.query("UPDATE ai_attempts SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND lease_owner=$2 RETURNING id", [job.execution_token, leaseOwner])).rowCount === 1) : undefined,
      pendingCommands: runtimeSession ? () => tenantTransaction(job.workspace_id, tx => pendingRuntimeCommands(tx, job)) : undefined,
      onRuntimeEvent: runtimeSession ? event => tenantTransaction(job.workspace_id, tx => ingestRuntimeEvent(tx, job, runtimeSession!, event, leaseOwner)) : undefined,
      onTool: runtimeSession ? async event => {
        const result = await tenantTransaction(job.workspace_id, async tx => {
          await renewRuntimeLease(tx, job, leaseOwner);
          const result = await executeAgentTool(tx, job.workspace_id, {
          turnId: job.id, attemptId: job.execution_token, fence: runtimeSession!.fence,
          callId: String(event.callId), name: String(event.name), arguments: event.arguments,
          });
          await recordSessionTool(tx,job.workspace_id,turn,String(event.callId),String(event.name),result);
          return result;
        });
        return { success: true, result };
      } : undefined,
      onSandbox: async (sandboxId) => {
        if (!/^[a-zA-Z0-9_-]{5,100}$/.test(sandboxId))
          throw new Error("沙箱标识无效");
        observedSandboxId = sandboxId;
        await tenantTransaction(job.workspace_id, async (tx) => {
          await tx.query(
            "UPDATE ai_attempts SET sandbox_id=$1,status='active',updated_at=now() WHERE id=$2",
            [sandboxId, job.execution_token],
          );
          if (runtimeSession) await tx.query('UPDATE creative_sessions SET sandbox_id=$1,updated_at=now() WHERE id=$2 AND active_attempt_id=$3 AND fence=$4', [sandboxId, runtimeSession.id, job.execution_token, runtimeSession.fence]);
        });
        await assertActive(job);
        controller.signal.throwIfAborted();
      },
      onProgress: async (event) => {
        controller.signal.throwIfAborted();
        if (
          !["preparing", "running", "tool", "validating"].includes(event.stage)
        )
          return;
        if (event.stage === lastStage && Date.now() - lastProgress < 1000)
          return;
        lastProgress = Date.now();
        lastStage = event.stage;
        await tenantTransaction(job.workspace_id, async (tx) => {
          await lockActiveJob(tx, job);
          await tx.query(
            "UPDATE ai_turns SET stage=$1,updated_at=now() WHERE id=$2",
            [event.stage, job.id],
          );
          if (event.threadId)
            await tx.query(
              "UPDATE ai_attempts SET thread_id=$1,usage=COALESCE($2::jsonb,usage),updated_at=now() WHERE id=$3",
              [
                String(event.threadId).slice(0, 200),
                runtimeSession ? null : legacyUsage(event.usage),
                job.execution_token,
              ],
            );
          const progress =
            { preparing: 10, running: 20, tool: 45, validating: 80 }[
              event.stage
            ] || 20;
          const updated = (
            await tx.query(
              "UPDATE jobs SET progress=$1,updated_at=now() WHERE id=$2 RETURNING *",
              [progress, job.id],
            )
          ).rows[0];
          await emit(tx, job.workspace_id, "job.updated", jobDto(updated));
        });
      },
    });
    controller.signal.throwIfAborted();
    await assertActive(job);
    const result = await tenantTransaction(job.workspace_id, async (tx) => {
      if (runtimeSession) await renewRuntimeLease(tx, job, leaseOwner);
      if (turn.context.materialManifest) await authorizeFrozenMaterials(tx, turn.context.materialManifest);
      const result = await commitTurn(tx, job, turn, output.manifest);
      await recordSessionCompletion(tx, job.workspace_id, turn, String((output.manifest as any)?.summary || ''), result);
      await tx.query(
        "UPDATE ai_attempts SET thread_id=$1,model=$2,usage=COALESCE($3::jsonb,usage),updated_at=now() WHERE id=$4",
        [
          String(output.runtime.threadId).slice(0, 200),
          String(output.runtime.model).slice(0, 100),
          // Native usage is already committed with its journal cursor and fixed
          // attempt baseline. The output carries a whole-thread cumulative total.
          runtimeSession ? null : legacyUsage(output.runtime.usage),
          job.execution_token,
        ],
      );
      return result;
    });
    committed = true;
    return result;
  } catch (error) {
    if (runtimeSession) {
      const stillOwner = await tenantTransaction(job.workspace_id, async tx => (await tx.query('SELECT 1 FROM ai_attempts WHERE id=$1 AND lease_owner=$2', [job.execution_token, leaseOwner])).rowCount === 1);
      if (!stillOwner) throw new HttpError(409, 'EXECUTION_LEASE_LOST', '本观察者已失去执行租约');
    }
    if (controller.signal.aborted)
      throw new Error("AI 创作已取消、超时或执行已失效");
    if (error instanceof HttpError) throw error;
    // Never persist arbitrary SDK diagnostics, stdout or provider error objects.
    throw new Error("AI 创作未完成，请检查运行配置或稍后重试");
  } finally {
    clearInterval(poll);
    clearTimeout(deadline);
    const ownsRuntime = !runtimeSession || await tenantTransaction(job.workspace_id, async tx => (await tx.query("UPDATE ai_attempts SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND lease_owner=$2 RETURNING id", [job.execution_token, leaseOwner])).rowCount === 1);
    if (runtimeSession && ownsRuntime) {
      let paused = false;
      if (committed && observedSandboxId && runtime.pauseSandbox) {
        try { await runtime.pauseSandbox(observedSandboxId); paused = true; }
        catch { /* A pause error can leave the VM running; terminate below. */ }
      }
      let cleanupConfirmed = paused;
      if (!paused && observedSandboxId) {
        try { await runtime.killSandbox(observedSandboxId); cleanupConfirmed = true; }
        catch { await tenantTransaction(job.workspace_id, tx => tx.query("UPDATE ai_attempts SET status='cleanup_failed' WHERE id=$1", [job.execution_token])); }
      }
      if (!observedSandboxId) {
        await closeAttempt(job.workspace_id, job.execution_token, runtime);
        cleanupConfirmed = await tenantTransaction(job.workspace_id, async tx => (await tx.query("SELECT 1 FROM ai_attempts WHERE id=$1 AND status='closed'", [job.execution_token])).rowCount === 1);
      }
      if (cleanupConfirmed) await tenantTransaction(job.workspace_id, tx => finishRuntimeSession(tx, job, runtimeSession!, paused, committed));
    } else if (!runtimeSession) await closeAttempt(job.workspace_id, job.execution_token, runtime);
  }
}
export async function reconcileAiAttempts(injectedRuntime?: AiRuntime) {
  const workspaces = (await pool.query("SELECT id FROM workspaces")).rows;
  let runtime = injectedRuntime;
  for (const workspace of workspaces) {
    // Reclaim only the observer lease. The same Runner, attempt and native turn remain
    // in the same VM; replaying the journal is safe and never resubmits provider work.
    const detached = await tenantTransaction(workspace.id, async tx => (await tx.query("SELECT j.*,a.id AS attempt_id,a.fence,a.deadline_at,a.sandbox_id,s.id AS session_id,s.project_id AS session_project_id,s.native_thread_id FROM ai_attempts a JOIN ai_turns t ON t.id=a.turn_id JOIN jobs j ON j.id=t.id JOIN creative_sessions s ON s.active_attempt_id=a.id AND s.fence=a.fence WHERE t.runtime_protocol='designx-runner-v2' AND j.status='running' AND a.id=j.execution_token AND a.status='active' AND a.lease_until<now() AND a.deadline_at>now() AND a.sandbox_id IS NOT NULL LIMIT 4")).rows);
    for (const job of detached) {
      runtime ||= await runtimeDefault();
      void runAiTurn(job, runtime, { id: job.session_id, projectId: job.session_project_id, attemptId: job.attempt_id, fence: Number(job.fence), deadline: new Date(job.deadline_at).getTime(), sandboxId: job.sandbox_id, threadId: job.native_thread_id, cursor: 0, resumeAttempt: true })
        .catch(async error => {
          if (error instanceof HttpError && error.code === 'EXECUTION_ALREADY_OBSERVED') return;
          await updateJob(workspace.id, job.id, { status: 'failed', error: '执行恢复未完成，已保留运行事件供核对；不会自动重发生成请求' }, job.execution_token);
        });
    }
    const attempts = await tenantTransaction(
      workspace.id,
      async (tx) =>
        (
          await tx.query(
            "SELECT a.*,j.status AS job_status,j.execution_token FROM ai_attempts a JOIN jobs j ON j.id=a.turn_id WHERE a.status<>'closed' AND (a.status='cleanup_failed' OR j.status IN ('cancelled','failed','succeeded') OR a.id IS DISTINCT FROM j.execution_token OR a.deadline_at<now()) ORDER BY a.created_at LIMIT 50",
          )
        ).rows,
    );
    for (const attempt of attempts) {
      runtime ||= await runtimeDefault();
      if (
        attempt.job_status === "running" &&
        attempt.id === attempt.execution_token &&
        new Date(attempt.deadline_at).getTime() < Date.now()
      )
        await updateJob(
          workspace.id,
          attempt.turn_id,
          { status: "failed", error: "AI 创作执行已超时，可重新尝试" },
          attempt.id,
        );
      await closeAttempt(workspace.id, attempt.id, runtime);
      await tenantTransaction(workspace.id, async tx => {
        const closed = (await tx.query("SELECT 1 FROM ai_attempts WHERE id=$1 AND status='closed'", [attempt.id])).rowCount;
        if (closed) await tx.query("UPDATE creative_sessions SET active_attempt_id=NULL,status='recovery_required',sandbox_id=NULL,native_thread_id=NULL,boundary_reason='previous_execution_ended',updated_at=now() WHERE active_attempt_id=$1", [attempt.id]);
      });
    }
    const expired = await tenantTransaction(workspace.id, async tx => (await tx.query("SELECT id,sandbox_id FROM creative_sessions WHERE status='paused' AND retained_until<now() AND active_attempt_id IS NULL LIMIT 20")).rows);
    for (const session of expired) {
      runtime ||= await runtimeDefault();
      try {
        if (session.sandbox_id) await runtime.killSandbox(session.sandbox_id);
        await tenantTransaction(workspace.id, tx => tx.query("UPDATE creative_sessions SET sandbox_id=NULL,native_thread_id=NULL,status='idle',boundary_reason='retention_expired',retained_until=NULL,updated_at=now() WHERE id=$1 AND status='paused' AND active_attempt_id IS NULL", [session.id]));
      } catch { /* Retain the sandbox reference so the next reconciliation can retry. */ }
    }
  }
}
