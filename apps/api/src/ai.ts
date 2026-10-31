import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tenantTransaction } from "../../../packages/server-infra/src/db.js";
import { idempotent } from "../../../packages/server-domain/src/idempotency.js";
import {
  TurnInput,
  startTurn,
  readTurn,
  turnDto,
  applyProposal,
} from "../../../packages/server-domain/src/ai-turns.js";
import { getProjectMetadata } from "../../../packages/server-domain/src/projects.js";
import { HttpError } from "../../../packages/server-domain/src/common.js";
function key(req: any) {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string" || !value.trim())
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "请提供请求标识以避免重复创作",
    );
  return value;
}
export async function aiRoutes(
  app: FastifyInstance,
  options: { enabled: boolean },
) {
  app.post(
    "/api/projects/:id/ai-turns",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (req: any, reply) => {
      if (!options.enabled)
        throw new HttpError(
          503,
          "AI_UNAVAILABLE",
          "AI 创作尚未配置，请稍后再试",
        );
      const input = TurnInput.parse(req.body),
        requestKey = key(req);
      const result = await tenantTransaction(
        req.identity.workspace.id,
        async (tx) => {
          // Replays still require a live authorized project; lock before dispatch/deletion.
          await getProjectMetadata(tx, req.params.id, false, true);
          return idempotent(
            tx,
            req.identity.workspace.id,
            requestKey,
            { route: "ai.turn", projectId: req.params.id, input },
            () =>
              startTurn(tx, req.identity.workspace.id, req.params.id, input),
          );
        },
      );
      reply.code(202);
      return result;
    },
  );
  app.get("/api/projects/:id/ai-turns", async (req: any) =>
    tenantTransaction(req.identity.workspace.id, async (tx) => {
      await getProjectMetadata(tx, req.params.id);
      const rows = (
        await tx.query(
          "SELECT t.*,j.status AS job_status,j.error AS job_error FROM ai_turns t JOIN jobs j ON j.id=t.id WHERE t.project_id=$1 ORDER BY t.created_at DESC LIMIT 50",
          [req.params.id],
        )
      ).rows;
      return rows.map((row) => turnDto(row, false));
    }),
  );
  app.get("/api/ai-turns/:id", async (req: any) =>
    tenantTransaction(req.identity.workspace.id, async (tx) =>
      turnDto(await readTurn(tx, req.params.id)),
    ),
  );
  app.post("/api/ai-turns/:id/apply", async (req: any) => {
    const input = z
        .object({
          proposalId: z.string().min(1).max(200),
          baseRevision: z.number().int().positive(),
        })
        .strict()
        .parse(req.body),
      requestKey = key(req);
    return tenantTransaction(req.identity.workspace.id, async (tx) => {
      const existing = await readTurn(tx, req.params.id);
      await getProjectMetadata(tx, existing.project_id, false, true);
      return idempotent(
        tx,
        req.identity.workspace.id,
        requestKey,
        { route: "ai.apply", turnId: req.params.id, input },
        () =>
          applyProposal(
            tx,
            req.identity.workspace.id,
            req.params.id,
            input.proposalId,
            input.baseRevision,
          ),
      );
    });
  });
}
