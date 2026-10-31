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
export async function uploadAsset(file: File) {
  if (file.size > 10 * 1024 * 1024) throw new Error("图片不能超过 10 MB");
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
    throw new Error("请选择 PNG、JPG、WebP 或 GIF 图片");
  const body = new FormData();
  body.append("file", file);
  const result = await api<any>("/assets", { method: "POST", body });
  const asset = result.asset || result;
  for (let i = 0; i < 120; i++) {
    const list = await api<any[]>("/assets");
    const ready = list.find((a) => a.id === asset.id);
    if (ready?.status === "ready") {
      refreshWorkspace();
      return ready;
    }
    if (ready?.status === "failed") throw new Error("素材处理失败，请重新上传");
    await delay(500);
  }
  throw new Error("素材仍在处理，请稍后在资产库查看");
}
