import { production } from './env.js';
function value(key: string, fallback: string) {
  const result = process.env[key];
  if (!result && production)
    throw new Error(`${key} is required in production`);
  return result || fallback;
}
export const config = {
  production,
  databaseUrl: value(
    "DATABASE_URL",
    "postgres://designx:designx-local-only@127.0.0.1:55432/designx",
  ),
  port: Number(process.env.PORT || 3001),
  host: process.env.API_HOST || "127.0.0.1",
  webOrigin: value("WEB_ORIGIN", "http://127.0.0.1:5173"),
  s3Endpoint: value("S3_ENDPOINT", "http://127.0.0.1:58333"),
  s3Region: process.env.S3_REGION || "us-east-1",
  s3Bucket: value("S3_BUCKET", "designx"),
  s3StagingBucket: process.env.S3_STAGING_BUCKET || `${process.env.S3_BUCKET || "designx"}-staging`,
  storageDirectUploadsEnabled: process.env.STORAGE_DIRECT_UPLOADS_ENABLED !== "false",
  s3AccessKey: value("S3_ACCESS_KEY_ID", "designx-local"),
  s3SecretKey: value("S3_SECRET_ACCESS_KEY", "designx-local-only"),
  maxUploadBytes: 10 * 1024 * 1024,
  aiEnabled: process.env.AI_ENABLED === "true",
  imageEnabled: process.env.IMAGE_GENERATION_ENABLED === "true" || (!production && process.env.IMAGE_GENERATION_ENABLED !== "false" && !!process.env.OPENAI_API_KEY),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  imageModel: "gpt-image-2.5-sunburst-2026-09-08",
  imageQuality: "medium" as const,
  generationQuota: Math.max(1, Number(process.env.GENERATION_QUOTA) || 100),
  imageTimeoutMs: Math.max(1000, Math.min(900000, Number(process.env.IMAGE_TIMEOUT_MS) || 300000)),
  generationUnknownHoldHours: 24,
};
