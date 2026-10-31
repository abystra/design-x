import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";

const production = process.env.NODE_ENV === "production";
// Process environment wins. Local AI overrides are read before .env, whose
// template deliberately contains AI_ENABLED=false and empty credential values.
if (!production)
  loadEnv({
    path: ["../../../.env.ai.local", "../../../.env"].map((path) =>
      fileURLToPath(new URL(path, import.meta.url)),
    ),
    quiet: true,
  });
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
  s3AccessKey: value("S3_ACCESS_KEY_ID", "designx-local"),
  s3SecretKey: value("S3_SECRET_ACCESS_KEY", "designx-local-only"),
  maxUploadBytes: 10 * 1024 * 1024,
  aiEnabled: process.env.AI_ENABLED === "true",
};
