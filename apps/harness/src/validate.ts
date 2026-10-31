import { readFile } from "node:fs/promises";
import { validateManifest } from "../../../packages/ai-runtime/src/manifest.js";

try {
  validateManifest(
    JSON.parse(await readFile("/home/user/designx/work/artifact.json", "utf8")),
  );
  process.stdout.write("Artifact schema is valid.\n");
} catch (error: any) {
  process.stderr.write(`${String(error.message).slice(0, 4000)}\n`);
  process.exitCode = 1;
}
