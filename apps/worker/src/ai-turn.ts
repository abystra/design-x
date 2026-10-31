import sharp from "sharp";
import {
  tenantTransaction,
  pool,
} from "../../../packages/server-infra/src/db.js";
import { getObject } from "../../../packages/server-infra/src/storage.js";
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
};
async function runtimeDefault(): Promise<AiRuntime> {
  return import("../../../packages/ai-runtime/src/index.js");
}
function safeUsage(value: unknown) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, value]) =>
        /^[a-z_]{1,50}$/.test(key) &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0,
    ),
  );
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
export async function runAiTurn(job: any, injectedRuntime?: AiRuntime) {
  const runtime = injectedRuntime || (await runtimeDefault());
  const turn = await tenantTransaction(job.workspace_id, async (tx) => {
    await lockActiveJob(tx, job);
    const turn = await readTurn(tx, job.id);
    await tx.query(
      "INSERT INTO ai_attempts(id,workspace_id,turn_id,queue_id,deadline_at) VALUES($1,$2,$3,$4,now()+$5*interval '1 second')",
      [
        job.execution_token,
        job.workspace_id,
        job.id,
        job.queue_id,
        aiTurnTimeoutSeconds,
      ],
    );
    await tx.query(
      "UPDATE ai_turns SET stage='preparing',updated_at=now() WHERE id=$1",
      [job.id],
    );
    return turn;
  });
  const controller = new AbortController();
  let polling = false,
    lastProgress = 0,
    lastStage = "";
  const deadline = setTimeout(
    () => controller.abort(new Error("AI 创作超时")),
    aiTurnTimeoutSeconds * 1000,
  );
  const poll = setInterval(async () => {
    if (polling || controller.signal.aborted) return;
    polling = true;
    try {
      await assertActive(job);
    } catch {
      controller.abort(new Error("AI 创作已取消或执行已失效"));
    } finally {
      polling = false;
    }
  }, 1000);
  try {
    const preferred = [
      ...turn.request.assetIds,
      ...turn.context.assets.map((a: any) => a.id),
    ];
    const imageIds = [...new Set<string>(preferred)].slice(0, 3);
    const assets = await tenantTransaction(
      job.workspace_id,
      async (tx) =>
        (
          await tx.query(
            "SELECT id,object_key FROM assets WHERE id=ANY($1::text[]) AND status='ready' AND deleted_at IS NULL",
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
      const object = await getObject(asset.object_key);
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
    const output = await runtime.runSandboxTurn({
      executionKey: job.execution_token,
      context,
      prompt: turn.request.prompt,
      images,
      signal: controller.signal,
      onSandbox: async (sandboxId) => {
        if (!/^[a-zA-Z0-9_-]{5,100}$/.test(sandboxId))
          throw new Error("沙箱标识无效");
        await tenantTransaction(job.workspace_id, (tx) =>
          tx.query(
            "UPDATE ai_attempts SET sandbox_id=$1,status='active',updated_at=now() WHERE id=$2",
            [sandboxId, job.execution_token],
          ),
        );
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
              "UPDATE ai_attempts SET thread_id=$1,usage=$2,updated_at=now() WHERE id=$3",
              [
                String(event.threadId).slice(0, 200),
                JSON.stringify(safeUsage(event.usage)),
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
    return await tenantTransaction(job.workspace_id, async (tx) => {
      const result = await commitTurn(tx, job, turn, output.manifest);
      await tx.query(
        "UPDATE ai_attempts SET thread_id=$1,model=$2,usage=$3,updated_at=now() WHERE id=$4",
        [
          String(output.runtime.threadId).slice(0, 200),
          String(output.runtime.model).slice(0, 100),
          JSON.stringify(safeUsage(output.runtime.usage)),
          job.execution_token,
        ],
      );
      return result;
    });
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error("AI 创作已取消、超时或执行已失效");
    if (error instanceof HttpError) throw error;
    // Never persist arbitrary SDK diagnostics, stdout or provider error objects.
    throw new Error("AI 创作未完成，请检查运行配置或稍后重试");
  } finally {
    clearInterval(poll);
    clearTimeout(deadline);
    await closeAttempt(job.workspace_id, job.execution_token, runtime);
  }
}
export async function reconcileAiAttempts(injectedRuntime?: AiRuntime) {
  const workspaces = (await pool.query("SELECT id FROM workspaces")).rows;
  let runtime = injectedRuntime;
  for (const workspace of workspaces) {
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
    }
  }
}
