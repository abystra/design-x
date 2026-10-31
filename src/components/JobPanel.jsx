import React, { useEffect, useState } from "react";
import {
  X,
  Download,
  RotateCcw,
  LoaderCircle,
  CheckCircle2,
} from "lucide-react";
import { api } from "../lib/api";
export default function JobPanel({ onClose, onToast, onOpenProject }) {
  const [jobs, setJobs] = useState([]),
    [error, setError] = useState("");
  async function load() {
    try {
      setJobs(await api("/jobs"));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, []);
  async function action(id, action) {
    try {
      await api(`/jobs/${id}/${action}`, { method: "POST" });
      await load();
    } catch (e) {
      onToast?.(e.message);
    }
  }
  return (
    <div className="notification-panel job-panel">
      <h3>
        创作动态{" "}
        <button className="icon-button" onClick={onClose} aria-label="关闭消息">
          <X size={15} />
        </button>
      </h3>
      {error && <p role="alert">{error}</p>}
      {!jobs.length && (
        <p>上传素材、导入项目和导出作品后，可以在这里查看进度。</p>
      )}
      {jobs.slice(0, 30).map((j) => (
        <article key={j.id} className="job-row">
          <div>
            {j.status === "succeeded" ? (
              <CheckCircle2 size={17} />
            ) : ["running", "queued"].includes(j.status) ? (
              <LoaderCircle size={17} className="st-spin" />
            ) : (
              <RotateCcw size={17} />
            )}
            <b>
              {j.kind === "project.import"
                ? "项目导入"
                : j.kind?.startsWith("render")
                  ? "作品导出"
                  : j.kind?.startsWith("media")
                    ? "素材处理"
                    : j.kind}
            </b>
          </div>
          <span>
            {{
              queued: "等待处理",
              running: "处理中",
              succeeded: "已完成",
              failed: "处理失败",
              cancelled: "已取消",
            }[j.status] || j.status}
            {j.progress != null ? ` · ${j.progress}%` : ""}
          </span>
          {j.error && <small>{j.error}</small>}
          <div className="job-actions">
            {["failed", "cancelled"].includes(j.status) && (
              <button onClick={() => action(j.id, "retry")}>重试</button>
            )}
            {["queued", "running"].includes(j.status) && (
              <button onClick={() => action(j.id, "cancel")}>取消</button>
            )}
            {j.status === "succeeded" && j.kind?.startsWith("render") && (
              <a
                href={`/api/exports/${j.result?.exportId || j.exportId || j.id}/file`}
                download
              >
                <Download size={13} />
                下载
              </a>
            )}
            {j.status === "succeeded" &&
              j.kind === "project.import" &&
              j.result?.projectId &&
              onOpenProject && (
                <button
                  onClick={() => {
                    onClose();
                    onOpenProject({ id: j.result.projectId });
                  }}
                >
                  打开项目
                </button>
              )}
          </div>
        </article>
      ))}
    </div>
  );
}
