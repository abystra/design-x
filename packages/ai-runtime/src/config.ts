import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);
// A local worker configuration only. No VITE_ variables, browser imports or diagnostic output.
if (process.env.NODE_ENV !== "production")
  loadEnv({ path: `${repositoryRoot}.env.ai.local`, quiet: true });

export function runtimeConfig() {
  const apiKey = process.env.E2B_API_KEY;
  const modelKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";
  if (!apiKey || !modelKey) throw new Error("AI 运行凭证尚未配置");
  if (!["deepseek-flash", "deepseek-v4-pro"].includes(model))
    throw new Error("不支持的 DeepSeek 型号");
  return {
    apiKey,
    modelKey,
    model,
    templateId: process.env.E2B_TEMPLATE_ID || "u1yrkaokyjzef8qchho5",
  };
}

export function safeRuntimeError(error: unknown): string {
  let message = error instanceof Error ? error.message : "AI 运行失败";
  for (const key of [process.env.E2B_API_KEY, process.env.DEEPSEEK_API_KEY])
    if (key) message = message.split(key).join("[REDACTED]");
  return message
    .replace(/(?:sk-|e2b_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .slice(0, 800);
}
