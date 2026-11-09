import React, { useState } from "react";
import {
  ArrowUpRight,
  Images,
  LoaderCircle,
  RotateCcw,
  Square,
} from "lucide-react";
import {
  isGenerationPending,
  generationPrompt,
} from "../lib/useCreativeActivity";

export const generationStatus = {
  queued: "等待生成",
  running: "正在生成",
  submitting: "正在提交",
  succeeded: "生成完成",
  partial: "部分完成",
  partially_succeeded: "部分完成",
  failed: "生成未完成",
  cancelled: "已取消",
  unknown: "供应商受理待核对",
  reconciling: "供应商受理待核对",
  awaiting_reconciliation: "供应商受理待核对",
  processing: "正在处理图片",
  ready: "图片已就绪",
  pending: "等待处理",
};
export function GenerationTurns({
  creative,
  recipes = [],
  onReference,
  onAdd,
  onLocate,
  onError,
}) {
  const [pending, setPending] = useState("");
  const act = async (id, action) => {
    setPending(id);
    try {
      await action();
    } catch (failure) {
      onError(failure.message);
    } finally {
      setPending("");
    }
  };
  return creative.generations
    .slice()
    .reverse()
    .map((generation) => (
      <article
        className="st-message st-message-assistant st-generation"
        key={generation.id}
        data-generation={generation.id}
      >
        <div className="st-assistant-label">
          <Images size={15} />
          <b>
            {recipes.find((recipe) => recipe.id === generation.recipe?.recipeId)
              ?.name || "图片生成"}
          </b>
          <small>
            {generationStatus[generation.status] ||
              generationStatus[generation.executionStatus] ||
              generation.status}
          </small>
        </div>
        <p>{generationPrompt(generation)}</p>
        {generation.error && (
          <p className="st-error" role="status">
            {typeof generation.error === "string"
              ? generation.error
              : generation.error.message}
          </p>
        )}
        {isGenerationPending(generation) && (
          <div className="st-agent-progress">
            <LoaderCircle size={13} className="spin" />
            <span>
              {generationStatus[generation.executionStatus] ||
                "任务在后台继续，刷新后可恢复"}
            </span>
            <button
              disabled={pending === generation.id || generation.cancelRequested}
              onClick={() =>
                act(generation.id, () => creative.cancel(generation))
              }
            >
              <Square size={11} />
              {generation.cancelRequested ? "已申请停止" : "停止"}
            </button>
          </div>
        )}
        {(generation.executionStatus === "unknown" ||
          generation.settlementStatus === "reconciliation_required") && (
          <small>实际成本待核对；再次生成会创建新的请求。</small>
        )}
        {!!generation.outputs?.length && (
          <div className="st-generation-outputs">
            {generation.outputs
              .filter(
                (output) =>
                  output.assetId &&
                  output.assetVersionId &&
                  output.status === "ready",
              )
              .map((output) => (
                <div key={output.assetVersionId || output.assetId}>
                  <button
                    className="st-generation-image"
                    onClick={() => onLocate(generation, output)}
                  >
                    <img
                      src={output.thumbnail || output.image}
                      alt="生成的图片资产"
                    />
                    <span>
                      图片资产 · {output.width} × {output.height}
                    </span>
                  </button>
                  <div>
                    <button onClick={() => onReference(output)}>
                      参考图编辑
                    </button>
                    <button
                      disabled={pending === output.assetId}
                      onClick={() => act(output.assetId, () => onAdd(output))}
                    >
                      加入画板
                    </button>
                  </div>
                  {!!output.documentIds?.length && (
                    <small>已生成可编辑画板 · 点击预览定位</small>
                  )}
                  {output.placementStatus === "library" && (
                    <small>已保留到素材库，可按需加入画板。</small>
                  )}
                </div>
              ))}
          </div>
        )}
        {generation.outputs?.some((output) =>
          ["failed", "ingest_retry"].includes(output.status),
        ) && (
          <button
            className="st-result-link"
            disabled={pending === generation.id}
            onClick={() =>
              act(generation.id, () => creative.retryIngestion(generation))
            }
          >
            <RotateCcw size={13} />
            重试图片处理 · 不重新生成
          </button>
        )}
        {!isGenerationPending(generation) && (
          <button
            className="st-result-link"
            disabled={pending === generation.id}
            onClick={() =>
              act(generation.id, () => creative.regenerate(generation))
            }
          >
            <RotateCcw size={13} />
            再次生成 · 新请求
          </button>
        )}
      </article>
    ));
}

export default function ProjectActivity({
  creative,
  agent,
  onReuse,
  onLocate,
}) {
  const activities = creative.activities.length
    ? creative.activities.map((item) => {
        const turn = agent.turns.find(
          (turn) => turn.jobId === item.sourceId || turn.id === item.sourceId,
        );
        const generation = creative.generations.find(
          (generation) => generation.id === item.sourceId,
        );
        return {
          ...item,
          ...(turn
            ? {
                title: turn.prompt,
                prompt: turn.prompt,
                projectId: turn.projectId,
                artboardIds: turn.artboardIds,
                boardRevision: turn.boardRevision,
              }
            : {}),
          ...(generation
            ? {
                prompt: generationPrompt(generation),
                title: generationPrompt(generation),
              }
            : {}),
        };
      })
    : [
        ...agent.turns.map((turn) => ({
          ...turn,
          type: "agent",
          title: turn.prompt,
          detail: turn.summary,
        })),
        ...creative.generations.map((item) => ({
          ...item,
          type: "generation",
          title: generationPrompt(item),
          prompt: generationPrompt(item),
        })),
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return (
    <div className="st-project-activity">
      {creative.error && (
        <p className="st-error" role="status">
          活动刷新失败：{creative.error}
          <button onClick={creative.refresh}>重试读取</button>
        </p>
      )}
      {!activities.length ? (
        <div className="st-panel-empty">
          <Images size={30} />
          <h3>创作的每一步，都留在这里</h3>
          <p>生成、对话、审核、版本与导出会自动记录。</p>
        </div>
      ) : (
        activities.map((item) => (
          <article key={`${item.type}:${item.id}`}>
            <div>
              <b>
                {{
                  agent: "可编辑设计",
                  generation: "图片生成",
                  document: "文档版本",
                  version: "文档版本",
                  "render.export": "导出",
                  "interaction.updated": "提问与回答",
                  "interaction.command": "交互命令",
                  "activity.updated": "项目活动",
                  export: "导出",
                  review: "审核",
                  interaction: "提问",
                  proposal: "修改方案",
                }[item.type] || "项目活动"}
              </b>
              <small>
                {item.createdAt
                  ? new Date(item.createdAt).toLocaleString("zh-CN")
                  : ""}
              </small>
            </div>
            <p>{item.title || item.prompt || item.detail || "项目活动"}</p>
            <small>
              {generationStatus[item.status] || item.status}
              {item.detail && typeof item.detail === "string"
                ? ` · ${item.detail}`
                : ""}
            </small>
            {item.prompt && (
              <button onClick={() => onReuse(item.prompt)}>
                复用需求
                <ArrowUpRight size={12} />
              </button>
            )}
            {item.projectId && item.artboardIds?.length > 0 && (
              <button onClick={() => onLocate(item)}>定位方案</button>
            )}
          </article>
        ))
      )}
    </div>
  );
}
