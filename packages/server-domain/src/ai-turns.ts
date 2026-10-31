import { createHash } from "node:crypto";
import { z } from "zod";
import { ArtboardSchema } from "../../doc-core/src/index.js";
import { BoardSchema } from "../../doc-core/src/board.js";
import type { Tx } from "../../server-infra/src/db.js";
import { createJob } from "./jobs.js";
import { getProjectMetadata, artboardDto } from "./projects.js";
import {
  emit,
  HttpError,
  notFound,
  syncAssetRefs,
  saveVersion,
  jobDto,
  assetUrlPattern,
} from "./common.js";
import { recordOps } from "./document-ops.js";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,150}$/);
export const TurnInput = z
  .object({
    prompt: z.string().trim().min(1).max(12000),
    count: z.number().int().min(1).max(3).default(1),
    mode: z.enum(["create", "revise"]).default("create"),
    ratio: z.enum(["自动", "1:1", "3:4", "16:9", "9:16", "4:3"]).optional(),
    referenceDocumentIds: z.array(identifier).max(6).default([]),
    assetIds: z.array(identifier).max(12).default([]),
    targetDocumentId: identifier.optional(),
    baseRevision: z.number().int().positive().optional(),
    baseBoardRevision: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.mode === "revise" &&
      (!value.targetDocumentId || !value.baseRevision)
    )
      ctx.addIssue({
        code: "custom",
        message: "修改作品需要目标画板和当前版本",
      });
    if (
      value.mode === "create" &&
      (value.targetDocumentId || value.baseRevision)
    )
      ctx.addIssue({ code: "custom", message: "新建模式不能指定覆盖目标" });
  });
export const builtinSources = [
  "coffee",
  "skincare",
  "interior",
  "fashion",
  "headphones",
  "nature",
].map((name) => `/assets/${name}.jpg`);
function stableId(turnId: string, index: number) {
  const h = createHash("sha256").update(`ai:${turnId}:${index}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function turnDto(row: any, includeDesign = true) {
  const request = row.request;
  return {
    id: row.id,
    jobId: row.id,
    projectId: row.project_id,
    ...request,
    status: row.job_status,
    stage: row.stage,
    error: row.job_error,
    summary: row.summary,
    proposals: (row.proposals || []).map((p: any) =>
      includeDesign ? p : (({ design, ...rest }: any) => rest)(p),
    ),
    artboardIds: row.artboard_ids,
    boardRevision: row.board_revision,
    appliedRevision: row.applied_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export async function readTurn(tx: Tx, turnId: string) {
  const row = (
    await tx.query(
      "SELECT t.*,j.status AS job_status,j.error AS job_error FROM ai_turns t JOIN jobs j ON j.id=t.id JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.deleted_at IS NULL",
      [turnId],
    )
  ).rows[0];
  if (!row) notFound();
  return row;
}
export async function startTurn(
  tx: Tx,
  workspaceId: string,
  projectId: string,
  input: z.infer<typeof TurnInput>,
) {
  const project = await getProjectMetadata(tx, projectId);
  const board = (
    await tx.query(
      "SELECT revision,content FROM documents WHERE project_id=$1 AND kind='board'",
      [projectId],
    )
  ).rows[0];
  if (
    input.baseBoardRevision !== undefined &&
    board?.revision !== input.baseBoardRevision
  )
    throw new HttpError(
      409,
      "DOC_REVISION_CONFLICT",
      "工作区已更新，请先同步再开始创作",
    );
  const refs = [
    ...new Set([
      ...input.referenceDocumentIds,
      ...(input.targetDocumentId ? [input.targetDocumentId] : []),
    ]),
  ];
  if (!refs.length && project.document_id) refs.push(project.document_id);
  const docs = (
    await tx.query(
      "SELECT id,title,revision,content FROM documents WHERE project_id=$1 AND kind='artboard' AND id=ANY($2::text[])",
      [projectId, refs],
    )
  ).rows;
  if (docs.length !== refs.length) notFound();
  if (
    input.mode === "revise" &&
    docs.find((d) => d.id === input.targetDocumentId)?.revision !==
      input.baseRevision
  )
    throw new HttpError(
      409,
      "DOC_REVISION_CONFLICT",
      "目标画板版本已变化，请重新载入",
    );
  const assetIds = new Set(input.assetIds);
  for (const doc of docs)
    for (const node of doc.content.nodes || []) {
      const match = node.src?.match(assetUrlPattern);
      if (match) assetIds.add(match[1]);
    }
  if (assetIds.size > 30)
    throw new HttpError(
      413,
      "AI_CONTEXT_TOO_LARGE",
      "参考素材过多，请减少所选画板",
    );
  const assets = (
    await tx.query(
      "SELECT id,title,mime,width,height FROM assets WHERE id=ANY($1::text[]) AND deleted_at IS NULL AND status='ready'",
      [[...assetIds]],
    )
  ).rows;
  if (assets.length !== assetIds.size)
    throw new HttpError(400, "INVALID_ASSET", "参考素材不可用或不属于此空间");
  const context = {
    project: { id: projectId, title: project.title },
    referenceArtboards: docs.map((d) => ({
      id: d.id,
      title: d.title,
      revision: d.revision,
      design: d.content,
    })),
    assets: assets.map((a) => ({
      ...a,
      src: `/api/assets/${a.id}/file`,
      thumbnail: `/api/assets/${a.id}/thumbnail`,
    })),
    builtinSources,
    count: input.count,
    mode: input.mode,
    ratio: input.ratio || "自动",
    targetDocumentId: input.targetDocumentId,
    boardRevision: board?.revision,
  };
  if (Buffer.byteLength(JSON.stringify(context)) > 250000)
    throw new HttpError(
      413,
      "AI_CONTEXT_TOO_LARGE",
      "参考内容过大，请减少所选画板",
    );
  const job = await createJob(tx, workspaceId, "ai.turn", {}, projectId);
  await tx.query(
    "INSERT INTO ai_turns(id,workspace_id,project_id,request,context) VALUES($1,$2,$3,$4,$5)",
    [
      job.id,
      workspaceId,
      projectId,
      JSON.stringify(input),
      JSON.stringify(context),
    ],
  );
  return { ...job, turn: turnDto(await readTurn(tx, job.id)) };
}

const manifestSchema = z
  .object({
    version: z.literal(1),
    summary: z.string().max(4000),
    artboards: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            design: ArtboardSchema,
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
export function validateManifest(input: unknown, turn: any) {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success)
    throw new HttpError(
      422,
      "INVALID_AI_ARTIFACT",
      "AI 成果格式无效，请调整描述后重试",
    );
  const manifest = parsed.data;
  if (manifest.artboards.length !== turn.request.count)
    throw new HttpError(422, "INVALID_AI_ARTIFACT", "AI 成果数量与请求不一致");
  if (Buffer.byteLength(JSON.stringify(manifest)) > 3 * 1024 * 1024)
    throw new HttpError(413, "AI_ARTIFACT_TOO_LARGE", "AI 成果超出大小限制");
  const allowed = new Set<string>([
    ...builtinSources,
    ...turn.context.assets.flatMap((a: any) => [a.src, a.thumbnail]),
  ]);
  const color =
    /^(?:#[a-f0-9]{3,4}|#[a-f0-9]{6}|#[a-f0-9]{8}|transparent|black|white|(?:rgb|rgba|hsl|hsla)\([\d.,%\s+-]+\))$/i;
  for (const { design } of manifest.artboards) {
    if (
      !color.test(design.background) ||
      design.width * design.height > 40000000
    )
      throw new HttpError(422, "INVALID_AI_ARTIFACT", "AI 画布尺寸或背景无效");
    for (const node of design.nodes) {
      if (
        (node.type === "image" && !node.src) ||
        (node.src && !allowed.has(node.src))
      )
        throw new HttpError(
          422,
          "INVALID_AI_ASSET",
          "AI 成果只能引用本回合已授权的素材",
        );
      if (
        (node.color && !color.test(node.color)) ||
        (node.font && !/^[\p{L}\p{N} _,'"-]+$/u.test(node.font))
      )
        throw new HttpError(
          422,
          "INVALID_AI_ARTIFACT",
          "AI 成果包含不支持的样式",
        );
    }
  }
  return manifest;
}
export async function lockActiveJob(tx: Tx, job: any) {
  const project = (
    await tx.query(
      "SELECT id FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
      [job.project_id],
    )
  ).rows[0];
  if (!project)
    throw new HttpError(409, "AI_TURN_INACTIVE", "项目已删除，停止本次创作");
  const current = (
    await tx.query("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [job.id])
  ).rows[0];
  if (current?.status === "succeeded") return current;
  if (
    current?.status !== "running" ||
    current.execution_token !== job.execution_token ||
    current.queue_id !== job.queue_id
  )
    throw new HttpError(409, "AI_TURN_INACTIVE", "创作已取消或由新的执行接管");
  return current;
}
export async function commitTurn(
  tx: Tx,
  job: any,
  turn: any,
  rawManifest: unknown,
) {
  const current = await lockActiveJob(tx, job);
  if (current.status === "succeeded") return current.result;
  if (
    !(
      await tx.query(
        "SELECT id FROM ai_attempts WHERE id=$1 AND turn_id=$2 AND deadline_at>now()",
        [job.execution_token, job.id],
      )
    ).rowCount
  )
    throw new HttpError(409, "AI_TURN_EXPIRED", "创作执行已过期，成果未提交");
  const manifest = validateManifest(rawManifest, turn);
  const proposals = manifest.artboards.map((a, index) => ({
    id: `${job.id}-p${index + 1}`,
    ...a,
  }));
  const artboardIds: string[] = [];
  let boardRevision: number | undefined;
  if (turn.request.mode === "create") {
    const board = (
      await tx.query(
        "SELECT * FROM documents WHERE project_id=$1 AND kind='board' FOR UPDATE",
        [job.project_id],
      )
    ).rows[0];
    if (!board) notFound();
    const results = [...(board.content.results || [])];
    const y = Math.min(
      99000,
      Math.max(0, ...results.map((r: any) => r.position?.y || 0)) + 360,
    );
    for (let index = 0; index < proposals.length; index++) {
      const proposal = proposals[index],
        documentId = stableId(job.id, index);
      const doc = (
        await tx.query(
          "INSERT INTO documents(id,workspace_id,project_id,kind,title,content) VALUES($1,$2,$3,'artboard',$4,$5) RETURNING *",
          [
            documentId,
            job.workspace_id,
            job.project_id,
            proposal.title,
            JSON.stringify(proposal.design),
          ],
        )
      ).rows[0];
      await syncAssetRefs(tx, job.workspace_id, doc.id, doc.content);
      await saveVersion(tx, job.workspace_id, doc, "AI 创作");
      const { design, revision, ...reference } = artboardDto(doc, {
        x: 40 + index * 310,
        y,
      });
      results.push(reference);
      artboardIds.push(doc.id);
    }
    const content = BoardSchema.parse({ ...board.content, results });
    const updated = (
      await tx.query(
        "UPDATE documents SET content=$1,revision=revision+1,updated_at=now() WHERE id=$2 RETURNING *",
        [JSON.stringify(content), board.id],
      )
    ).rows[0];
    await recordOps(tx, job.workspace_id, updated, board.content);
    boardRevision = updated.revision;
    await tx.query("UPDATE projects SET updated_at=now() WHERE id=$1", [
      job.project_id,
    ]);
    for (const documentId of artboardIds)
      await emit(tx, job.workspace_id, "artboard.created", {
        projectId: job.project_id,
        documentId,
        turnId: job.id,
        boardRevision,
      });
    await emit(tx, job.workspace_id, "board.committed", {
      projectId: job.project_id,
      revision: boardRevision,
      turnId: job.id,
      artboardIds,
    });
  } else {
    // Proposals do not mutate the target. Recheck asset ownership/readiness before retaining them.
    for (const proposal of proposals) {
      const { validateSources } = await import("./common.js");
      await validateSources(tx, proposal.design);
    }
  }
  await tx.query(
    "UPDATE ai_turns SET stage='completed',summary=$1,proposals=$2,artboard_ids=$3,board_revision=$4,updated_at=now() WHERE id=$5",
    [
      manifest.summary,
      JSON.stringify(proposals),
      JSON.stringify(artboardIds),
      boardRevision || null,
      job.id,
    ],
  );
  const result = {
    turnId: job.id,
    mode: turn.request.mode,
    artboardIds,
    boardRevision,
    proposalIds: proposals.map((p) => p.id),
    summary: manifest.summary,
  };
  const updatedJob = (
    await tx.query(
      "UPDATE jobs SET status='succeeded',progress=100,error=NULL,result=$1,updated_at=now() WHERE id=$2 RETURNING *",
      [JSON.stringify(result), job.id],
    )
  ).rows[0];
  await emit(tx, job.workspace_id, "job.updated", jobDto(updatedJob));
  return result;
}
export async function applyProposal(
  tx: Tx,
  workspaceId: string,
  turnId: string,
  proposalId: string,
  baseRevision: number,
) {
  const initial = await readTurn(tx, turnId);
  if (
    !(
      await tx.query(
        "SELECT id FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE",
        [initial.project_id],
      )
    ).rowCount
  )
    notFound();
  const turn = (
    await tx.query(
      "SELECT t.*,j.status AS job_status FROM ai_turns t JOIN jobs j ON j.id=t.id WHERE t.id=$1 FOR UPDATE OF t",
      [turnId],
    )
  ).rows[0];
  if (turn.job_status !== "succeeded" || turn.request.mode !== "revise")
    throw new HttpError(
      409,
      "INVALID_TURN_STATE",
      "只有完成的修改提案可以应用",
    );
  const proposal = turn.proposals.find((p: any) => p.id === proposalId);
  if (!proposal) notFound();
  const doc = (
    await tx.query(
      "SELECT * FROM documents WHERE id=$1 AND project_id=$2 AND kind='artboard' FOR UPDATE",
      [turn.request.targetDocumentId, turn.project_id],
    )
  ).rows[0];
  if (!doc) notFound();
  const expected = turn.applied_revision ?? turn.request.baseRevision;
  if (baseRevision !== expected || doc.revision !== baseRevision)
    throw new HttpError(
      409,
      "DOC_REVISION_CONFLICT",
      "画板已变化；提案已保留，请重新发起修改或先检查版本",
    );
  await syncAssetRefs(tx, workspaceId, doc.id, proposal.design);
  const updated = (
    await tx.query(
      "UPDATE documents SET content=$1,revision=revision+1,updated_at=now() WHERE id=$2 RETURNING *",
      [JSON.stringify(proposal.design), doc.id],
    )
  ).rows[0];
  await recordOps(
    tx,
    workspaceId,
    updated,
    doc.content,
    `ai:${turnId}:${proposalId}:${baseRevision}`,
  );
  await saveVersion(tx, workspaceId, updated, "应用 AI 提案");
  await tx.query(
    "UPDATE projects SET updated_at=now(),image=CASE WHEN primary_artboard_id=$1 THEN $2 ELSE image END WHERE id=$3",
    [
      doc.id,
      proposal.design.nodes.find((n: any) => n.type === "image")?.src || null,
      turn.project_id,
    ],
  );
  const proposals = turn.proposals.map((p: any) =>
    p.id === proposalId
      ? { ...p, appliedDocumentId: doc.id, appliedRevision: updated.revision }
      : p,
  );
  await tx.query(
    "UPDATE ai_turns SET proposals=$1,applied_revision=$2,updated_at=now() WHERE id=$3",
    [JSON.stringify(proposals), updated.revision, turnId],
  );
  await emit(tx, workspaceId, "document.committed", {
    projectId: turn.project_id,
    documentId: doc.id,
    revision: updated.revision,
    turnId,
  });
  return {
    turn: turnDto(await readTurn(tx, turnId)),
    artboard: artboardDto(updated),
  };
}
