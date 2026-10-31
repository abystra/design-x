import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Check,
  LoaderCircle,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { DesignPreview } from "./BoardWorld";
import "./agent-turns.css";

const stageText = {
  queued: "等待创作",
  preparing: "准备素材与创作环境",
  running: "正在构思设计",
  tool: "正在制作可编辑方案",
  validating: "正在检查设计",
  succeeded: "创作完成",
  cancelled: "已停止创作",
  failed: "创作未完成",
};
export default function AgentTurns({ agent, onLocate, onApply, onError }) {
  const [preview, setPreview] = useState(null),
    [applying, setApplying] = useState(false);
  const [pending, setPending] = useState(""),
    [previewError, setPreviewError] = useState("");
  const dialog = useRef(null);
  useEffect(() => {
    setPreviewError("");
    if (preview && dialog.current && !dialog.current.open)
      dialog.current.showModal();
  }, [preview]);
  const act = async (id, fn) => {
    setPending(id);
    try {
      await fn();
    } catch (e) {
      onError?.(e.message);
    } finally {
      setPending("");
    }
  };
  return (
    <>
      {agent.error && (
        <p role="status" className="st-agent-refresh-error">
          创作动态暂时无法刷新：{agent.error}
        </p>
      )}
      {agent.turns.map((turn) => (
        <React.Fragment key={turn.id}>
          <article
            className="st-message st-message-user"
            data-ai-prompt={turn.id}
          >
            <p>{turn.prompt}</p>
          </article>
          <article
            className="st-message st-message-assistant"
            data-ai-turn={turn.id}
            data-ai-status={turn.status}
          >
            <div className="st-assistant-label">
              <span>✳</span>
              <b>Design X</b>
              <small>创作助手</small>
            </div>
            <p>
              {turn.status === "succeeded"
                ? turn.summary
                : turn.status === "failed"
                  ? turn.error || "本次创作未完成，可以重试。"
                  : stageText[
                      turn.status === "running" ? turn.stage : turn.status
                    ] || "正在创作"}
            </p>
            {["queued", "running"].includes(turn.status) && (
              <div className="st-agent-progress" role="status">
                <LoaderCircle size={13} className="spin" />
                <span>
                  {stageText[turn.stage] || "任务正在后台执行，离开后仍可查看"}
                </span>
                <button
                  disabled={pending === turn.id}
                  onClick={() => act(turn.id, () => agent.cancel(turn))}
                  aria-label="停止本次创作"
                >
                  <Square size={11} />
                  停止
                </button>
              </div>
            )}
            {["failed", "cancelled"].includes(turn.status) && (
              <button
                className="st-result-link"
                disabled={pending === turn.id}
                onClick={() => act(turn.id, () => agent.retry(turn))}
              >
                <RotateCcw size={13} />
                重试本次创作
              </button>
            )}
            {turn.status === "succeeded" && turn.mode === "create" && (
              <button
                className="st-result-link"
                disabled={pending === turn.id}
                onClick={() => act(turn.id, () => onLocate(turn))}
              >
                <Check size={13} />
                {turn.artboardIds.length} 个方案已放入画布
                <ArrowUpRight size={13} />
              </button>
            )}
            {turn.status === "succeeded" && turn.mode === "revise" && (
              <div className="st-agent-proposals">
                {(turn.proposals || []).map((proposal, i) => (
                  <button
                    key={proposal.id}
                    className="st-result-link"
                    disabled={pending === proposal.id}
                    onClick={() =>
                      act(proposal.id, async () => {
                        const detail = await agent.details(turn);
                        const found = detail.proposals?.find(
                          (p) => p.id === proposal.id,
                        );
                        if (!found?.design)
                          throw new Error("修改方案暂时无法读取，请刷新后重试");
                        setPreview({ turn: detail, proposal: found });
                      })
                    }
                  >
                    预览修改方案 {i + 1}
                    {proposal.appliedRevision ? " · 已应用" : ""}
                    <ArrowUpRight size={13} />
                  </button>
                ))}
                <small>原作品保持不变，预览后可应用修改。</small>
              </div>
            )}
          </article>
        </React.Fragment>
      ))}
      {preview &&
        createPortal(
          <dialog
            className="st-agent-dialog"
            ref={dialog}
            aria-label="预览 AI 修改方案"
            onCancel={() => setPreview(null)}
            onClick={(e) => {
              if (e.target === e.currentTarget) setPreview(null);
            }}
          >
            <header>
              <div>
                <small>修改方案</small>
                <h2>{preview.proposal.title}</h2>
              </div>
              <button
                aria-label="关闭修改预览"
                onClick={() => setPreview(null)}
              >
                <X size={19} />
              </button>
            </header>
            <div className="st-agent-preview">
              <DesignPreview project={preview.proposal} />
            </div>
            {previewError && (
              <p role="alert" className="st-agent-preview-error">
                {previewError}
              </p>
            )}
            <footer>
              <span>应用前会检查作品版本，避免覆盖其他修改。</span>
              <button
                disabled={applying}
                onClick={async () => {
                  setApplying(true);
                  setPreviewError("");
                  try {
                    await onApply(preview.turn, preview.proposal);
                    setPreview(null);
                  } catch (e) {
                    setPreviewError(e.message || "修改方案未能应用，请重试");
                    onError?.(e.message);
                  } finally {
                    setApplying(false);
                  }
                }}
              >
                {applying ? "正在应用…" : "应用到原画板"}
              </button>
            </footer>
          </dialog>,
          document.body,
        )}
    </>
  );
}
