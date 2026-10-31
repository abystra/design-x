import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileUp, LoaderCircle, Upload, X } from "lucide-react";
import { api, refreshWorkspace } from "../lib/api";
import "./project-import.css";

const MAX_BYTES = 40 * 1024 * 1024;
const terminal = (status) =>
  ["succeeded", "failed", "cancelled"].includes(status);

export default function ProjectImport({ onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [job, setJob] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);
  const modal = useRef(null);
  const uploadRequest = useRef(null);
  const openButton = useRef(null);
  const requestKey = useRef(crypto.randomUUID());
  const working = uploading || acting || (job && !terminal(job.status));

  useEffect(() => {
    const previous = document.activeElement;
    modal.current?.querySelector("button")?.focus();
    return () => {
      uploadRequest.current?.abort();
      previous?.focus?.();
    };
  }, []);
  const close = () => {
    uploadRequest.current?.abort();
    onClose();
  };
  useEffect(() => {
    if (job?.status === "succeeded") openButton.current?.focus();
  }, [job?.status]);
  useEffect(() => {
    const key = (event) => {
      if (event.key === "Escape") close();
      if (event.key !== "Tab") return;
      const controls = [
        ...modal.current.querySelectorAll("button,a[href],input:not([hidden])"),
      ].filter((element) => !element.disabled);
      const first = controls[0],
        last = controls.at(-1);
      if (!controls.length || !modal.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
        if (!controls.length) modal.current.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [uploading, onClose]);
  useEffect(() => {
    if (!job?.id || terminal(job.status)) return;
    let stopped = false,
      timer;
    const poll = async () => {
      try {
        const current = await api(`/jobs/${job.id}`);
        if (stopped) return;
        setJob(current);
        setError("");
        if (current.status === "succeeded") refreshWorkspace();
        if (terminal(current.status)) return;
      } catch (failure) {
        if (stopped) return;
        setError(
          `暂时无法读取导入进度：${failure.message}。正在重连，也可稍后在创作动态中查看。`,
        );
      }
      timer = setTimeout(poll, 1000);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [job?.id, job?.status]);

  function choose(candidate) {
    if (working || !candidate) return;
    setError("");
    setJob(null);
    if (!/\.dxproj$/i.test(candidate.name)) {
      setFile(null);
      setError("请选择 Design X 导出的 .dxproj 项目文件。");
      return;
    }
    if (!candidate.size || candidate.size > MAX_BYTES) {
      setFile(null);
      setError("项目文件不能为空，且不能超过 40 MB。");
      return;
    }
    requestKey.current = crypto.randomUUID();
    setFile(candidate);
  }
  async function start() {
    if (!file || working) return;
    setUploading(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      uploadRequest.current = new AbortController();
      const created = await api("/projects/import", {
        method: "POST",
        body,
        signal: uploadRequest.current.signal,
        headers: { "Idempotency-Key": requestKey.current },
      });
      setJob(created);
      refreshWorkspace();
    } catch (failure) {
      if (failure.name !== "AbortError") setError(failure.message);
    } finally {
      setUploading(false);
    }
  }
  async function action(name) {
    if (acting || !job) return;
    setActing(true);
    setError("");
    try {
      setJob(await api(`/jobs/${job.id}/${name}`, { method: "POST" }));
      refreshWorkspace();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setActing(false);
    }
  }
  async function open() {
    setActing(true);
    setError("");
    try {
      await onImported(job.result.projectId);
      onClose();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setActing(false);
    }
  }
  return (
    <div
      className="ws-modal-shade"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        ref={modal}
        className="ws-modal dx-import-modal"
        role="dialog"
        aria-modal="true"
        aria-label="导入项目"
        tabIndex={-1}
      >
        <header>
          <div>
            <h2>让创作，接着发生。</h2>
            <p>导入 .dxproj 文件，继续编辑画板、便签与分区。</p>
          </div>
          <button
            className="ws-icon-btn"
            aria-label="关闭导入项目"
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        {job?.status === "succeeded" ? (
          <div className="dx-import-success" role="status">
            <CheckCircle2 size={38} />
            <h3>项目已导入</h3>
            <p>已保存为当前空间的新项目，素材也已独立保存。</p>
          </div>
        ) : (
          <>
            <input
              ref={input}
              hidden
              type="file"
              accept=".dxproj"
              aria-label="选择项目文件"
              onChange={(e) => {
                choose(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className={`dx-import-drop ${dragging ? "is-dragging" : ""}`}
              disabled={!!working}
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                if (!working) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                choose(e.dataTransfer.files[0]);
              }}
            >
              <FileUp size={30} />
              <strong>{file ? file.name : "选择文件，或拖到这里"}</strong>
              <span>
                {file
                  ? `${(file.size / 1024 / 1024).toFixed(2)} MB · 点击重新选择`
                  : "Design X 项目 · .dxproj · 最大 40 MB"}
              </span>
            </button>
            <p className="dx-import-hint">
              导入会创建新项目，不会覆盖已有作品。项目中的图片会复制到你的个人空间。
              关闭后，可在创作动态查看已提交的导入任务。
            </p>
            {(uploading || job) && (
              <div className="dx-import-progress" role="status">
                {uploading || (job && !terminal(job.status)) ? (
                  <LoaderCircle className="st-spin" size={18} />
                ) : null}
                <span>
                  {uploading
                    ? "正在上传并检查文件…"
                    : {
                        queued: "已排队，等待导入",
                        running: "正在恢复项目和素材",
                        failed: "导入未完成",
                        cancelled: "导入已取消",
                      }[job?.status]}
                </span>
                {!uploading && job && (
                  <progress
                    aria-label="项目导入进度"
                    max="100"
                    value={job.progress || 0}
                  />
                )}
              </div>
            )}
            {job?.error && (
              <p className="dx-import-error" role="alert">
                {job.error}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="dx-import-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button className="ws-secondary" onClick={close}>
            {job && !terminal(job.status) ? "稍后查看" : "关闭"}
          </button>
          {job?.status === "succeeded" ? (
            <button
              ref={openButton}
              className="ws-primary"
              disabled={acting}
              onClick={open}
            >
              打开项目
            </button>
          ) : job && !terminal(job.status) ? (
            <button
              className="ws-secondary"
              disabled={acting}
              onClick={() => action("cancel")}
            >
              取消导入
            </button>
          ) : job ? (
            <button
              className="ws-primary"
              disabled={acting}
              onClick={() => action("retry")}
            >
              重新尝试
            </button>
          ) : (
            <button
              className="ws-primary"
              disabled={!file || uploading}
              onClick={start}
            >
              <Upload size={16} />
              {uploading ? "正在上传…" : "开始导入"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
