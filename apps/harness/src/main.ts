// Executed only inside E2B. The control plane supplies files, never a database credential.
import { Codex } from "@openai/codex-sdk";
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";

const root = "/home/user/designx";
const secret = process.env.DEEPSEEK_API_KEY || "";
const redact = (text: string) =>
  (secret ? text.split(secret).join("[REDACTED]") : text).replace(
    /(?:sk-|e2b_)[A-Za-z0-9_-]+/g,
    "[REDACTED]",
  );
const emit = (value: object) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);

async function main() {
  if (!secret) throw new Error("Missing model credential");
  const request = JSON.parse(await readFile(`${root}/request.json`, "utf8"));
  await mkdir(`${root}/codex`, { recursive: true });
  await mkdir(`${root}/work`, { recursive: true });
  const codex = new Codex({
    codexPathOverride: "/usr/local/bin/codex",
    env: {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/user",
      CODEX_HOME: `${root}/codex`,
      DEEPSEEK_API_KEY: secret,
    },
    config: {
      model_provider: "deepseek",
      model_catalog_json: `${root}/models.json`,
      model_providers: {
        deepseek: {
          name: "DeepSeek",
          base_url: "https://api.deepseek.com",
          wire_api: "responses",
          env_key: "DEEPSEEK_API_KEY",
          requires_openai_auth: false,
          supports_websockets: false,
        },
      },
      web_search: "disabled",
      model_reasoning_summary: "none",
    },
  });
  const thread = codex.startThread({
    model: request.model || "deepseek-flash",
    workingDirectory: `${root}/work`,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    modelReasoningEffort: "low",
    webSearchMode: "disabled",
  });
  const results: object[] = [];
  for (const [turnIndex, turn] of request.turns.entries()) {
    let finalResponse = "",
      usage: unknown,
      toolCount = 0,
      completed = false;
    const { events } = await thread.runStreamed(turn.prompt, {
      outputSchema: turn.outputSchema,
      signal: AbortSignal.timeout(request.turnTimeoutMs || 180000),
    });
    for await (const event of events) {
      if (event.type === "thread.started")
        emit({ type: "thread", threadId: event.thread_id });
      if (event.type === "item.completed") {
        const item = event.item;
        if (item.type === "agent_message") finalResponse = item.text;
        if (
          ["command_execution", "file_change", "mcp_tool_call"].includes(
            item.type,
          )
        ) {
          toolCount++;
          emit({ type: "tool", turnIndex, kind: item.type });
        }
      }
      if (event.type === "turn.completed") {
        usage = event.usage;
        completed = true;
      }
      if (event.type === "turn.failed")
        throw new Error(redact(event.error.message));
      if (event.type === "error") throw new Error(redact(event.message));
    }
    if (!completed || !finalResponse)
      throw new Error("Model turn ended without a completed response");
    // The model's final text is a user-facing message, not a trusted document.
    // Read the actual file written by its tools; the control plane validates it again.
    let artifact: unknown;
    if (turn.artifactFile) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(turn.artifactFile))
        throw new Error("Invalid artifact filename");
      const stat = await lstat(`${root}/work/${turn.artifactFile}`);
      if (!stat.isFile() || stat.size > 1024 * 1024)
        throw new Error("Artifact must be a regular JSON file under 1 MiB");
      artifact = JSON.parse(
        await readFile(`${root}/work/${turn.artifactFile}`, "utf8"),
      );
    }
    results.push({
      finalResponse: redact(finalResponse),
      artifact,
      usage,
      toolCount,
      threadId: thread.id,
    });
    emit({ type: "turn.completed", turnIndex, toolCount, usage });
  }
  await writeFile(
    `${root}/result.json`,
    JSON.stringify({ model: request.model, turns: results }),
    { mode: 0o600 },
  );
  emit({ type: "result.ready" });
}

main().catch((error) => {
  emit({
    type: "failed",
    message: redact(String(error.message || "Harness failed")).slice(0, 800),
  });
  process.exitCode = 1;
});
