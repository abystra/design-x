export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: any,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: Omit<RequestInit, "body"> & { body?: any } = {},
): Promise<T> {
  const { body, ...rest } = options;
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: {
      "X-Requested-With": "Design-X",
      ...(body !== undefined && !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const data =
    response.status === 204
      ? null
      : await response
          .json()
          .catch(() => ({ message: "服务返回了无法读取的结果" }));
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined")
      window.dispatchEvent(new Event("designx:unauthorized"));
    throw new ApiError(
      response.status,
      data?.message || data?.error || `请求失败 (${response.status})`,
      data,
    );
  }
  return data;
}
export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export function refreshWorkspace() {
  window.dispatchEvent(new Event("designx:refresh"));
}
export async function waitForJob(id: string, onProgress?: (job: any) => void) {
  for (let i = 0; i < 180; i++) {
    const jobs = await api<any[]>("/jobs");
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error("任务不存在");
    onProgress?.(job);
    if (job.status === "succeeded" || job.status === "completed") return job;
    if (["failed", "cancelled", "blocked"].includes(job.status))
      throw new Error(job.error || "任务未完成，请重试");
    await delay(1000);
  }
  throw new Error("任务仍在后台执行，可以在创作动态中查看");
}
export async function uploadAsset(file: File, projectId?: string) {
  if (file.size > 10 * 1024 * 1024) throw new Error("图片不能超过 10 MB");
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
    throw new Error("请选择 PNG、JPG、WebP 或 GIF 图片");
  const capabilities = await api<any>("/capabilities");
  if (capabilities.uploads?.direct === false) {
    const body = new FormData();
    body.append("file", file);
    const response = await api<any>("/assets", { method: "POST", body });
    const asset = response.asset || response;
    for (let i = 0; i < 120; i++) {
      const ready = (await api<any[]>("/assets")).find(
        (item) => item.id === asset.id,
      );
      if (ready?.status === "ready") {
        if (projectId)
          await api(`/projects/${projectId}/assets`, {
            method: "POST",
            body: { assetId: ready.id, versionId: ready.versionId },
          });
        refreshWorkspace();
        return ready;
      }
      if (ready?.status === "failed")
        throw new Error("素材处理失败，请重新上传");
      await delay(1000);
    }
    throw new Error("素材仍在后台处理，请稍后在素材库查看");
  }
  const session = await api<any>("/uploads", {
    method: "POST",
    body: {
      filename: file.name,
      mime: file.type,
      bytes: file.size,
      ...(projectId ? { projectId } : {}),
    },
  });
  const uploaded = await fetch(session.upload.url, {
    method: "PUT",
    headers: session.upload.headers,
    body: file,
  });
  if (!uploaded.ok)
    throw new Error(`素材上传失败 (${uploaded.status})，请重新上传`);
  let state = await api<any>(`/uploads/${session.id}/complete`, {
    method: "POST",
  });
  for (let i = 0; i < 120; i++) {
    if (state.asset?.status === "ready" || state.status === "ready") {
      const ready =
        state.asset ||
        (await api<any[]>("/assets")).find(
          (asset) => asset.id === session.assetId,
        );
      if (ready) {
        refreshWorkspace();
        return ready;
      }
    }
    if (
      ["failed", "rejected", "expired"].includes(state.status) ||
      state.asset?.status === "failed"
    )
      throw new Error(state.error || "素材处理失败，请重新上传");
    await delay(1000);
    state = await api<any>(`/uploads/${session.id}`);
  }
  throw new Error("素材仍在后台处理，请稍后在素材库查看");
}
