import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";

export const production = process.env.NODE_ENV === "production";
const isolatedTest = process.env.DESIGNX_TEST_ENV === "true";
// Process environment wins. Local AI overrides are read before .env, whose
// template deliberately contains AI_ENABLED=false and empty credential values.
if (!production && !isolatedTest && !process.env.E2B_API_KEY) {
  const local = loadEnv({path:fileURLToPath(new URL('../../../.env',import.meta.url)),processEnv:{},quiet:true});
  if(local.parsed?.E2B_API_KEY)process.env.E2B_API_KEY=local.parsed.E2B_API_KEY;
}
if (!production && !isolatedTest)
  loadEnv({
    path: ["../../../.env.ai.local", "../../../.env"].map((path) =>
      fileURLToPath(new URL(path, import.meta.url)),
    ),
    quiet: true,
  });
