import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptAiMutation,
  aiTurnFromJob,
  upsertAiTurn,
} from "../../src/lib/useAiTurns.js";

const turn = () => ({
  id: "turn-1",
  jobId: "turn-1",
  projectId: "project-1",
  prompt: "设计三张秋日咖啡海报",
  mode: "create",
  count: 3,
  status: "failed",
  stage: "running",
  error: "旧错误",
  referenceDocumentIds: ["doc-1"],
  assetIds: ["asset-1"],
  proposals: [],
  artboardIds: [],
  summary: "",
});

// These are isolated callback/state tests. No API responses are intercepted and
// no backend, Sandbox, or model is contacted by this file.
test("accepted mutation returns its write response even when the follow-up read rejects", async () => {
  const accepted = {
    id: "turn-1",
    status: "queued",
    turn: { ...turn(), status: "queued" },
  };
  const order: string[] = [];
  let writes = 0;
  const response = await acceptAiMutation(
    async () => {
      writes++;
      return accepted;
    },
    (value: unknown) => {
      assert.strictEqual(value, accepted);
      order.push("accepted");
    },
    async () => {
      order.push("read");
      throw new Error("GET temporarily unavailable");
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.strictEqual(response, accepted);
  assert.equal(writes, 1);
  assert.deepEqual(order, ["accepted", "read"]);
});

test(
  "accepted apply does not wait for a slow follow-up read before returning the committed revision",
  { timeout: 1000 },
  async () => {
    const applied = {
      turn: { ...turn(), status: "succeeded" },
      artboard: { id: "doc-1", revision: 2 },
    };
    const response = await acceptAiMutation(
      async () => applied,
      () => {},
      () => new Promise(() => {}),
    );
    assert.strictEqual(response, applied);
    assert.equal(response.artboard.revision, 2);
  },
);

test("a rejected mutation neither publishes success nor runs its background refresh", async () => {
  const failure = new Error(
    "POST transport failed before an acknowledged response",
  );
  let accepted = false,
    refreshed = false;
  await assert.rejects(
    acceptAiMutation(
      async () => {
        throw failure;
      },
      () => {
        accepted = true;
      },
      () => {
        refreshed = true;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(accepted, false);
  assert.equal(refreshed, false);
});

test("a synchronous refresh exception cannot turn an accepted cancel into a failed write", async () => {
  const cancelled = { id: "turn-1", status: "cancelled", error: null };
  assert.strictEqual(
    await acceptAiMutation(
      async () => cancelled,
      () => {},
      () => {
        throw new Error("refresh component no longer available");
      },
    ),
    cancelled,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("turn upsert retains unrelated conversations and applies a response only once", () => {
  const previous = [
    turn(),
    { ...turn(), id: "turn-2", jobId: "turn-2", prompt: "另一项请求" },
  ];
  const copy = structuredClone(previous);
  const updated = upsertAiTurn(previous, {
    id: "turn-1",
    status: "queued",
    error: null,
  });
  assert.equal(updated.length, 2);
  assert.equal(updated[0].prompt, previous[0].prompt);
  assert.equal(updated[0].status, "queued");
  assert.equal(updated[1].prompt, "另一项请求");
  assert.deepEqual(previous, copy);
  const created = {
    ...turn(),
    id: "turn-3",
    jobId: "turn-3",
    status: "queued",
  };
  assert.equal(upsertAiTurn(upsertAiTurn(updated, created), created).length, 3);
  assert.strictEqual(upsertAiTurn(updated, undefined), updated);
});

test("cancel and retry Job DTOs preserve prompt and references while applying authoritative status", () => {
  const original = turn();
  for (const status of ["cancelled", "queued"]) {
    const patched = aiTurnFromJob(original, {
      id: original.jobId,
      type: "ai.turn",
      status,
      error: null,
    });
    assert.equal(patched.id, original.id);
    assert.equal(patched.status, status);
    assert.equal(patched.stage, status);
    assert.equal(patched.error, null);
    assert.equal(patched.prompt, original.prompt);
    assert.deepEqual(patched.assetIds, ["asset-1"]);
    assert.deepEqual(patched.referenceDocumentIds, ["doc-1"]);
    assert.equal(original.status, "failed");
  }
});

test("late cancellation that returns a succeeded Job preserves its actual completed result", () => {
  const patched = aiTurnFromJob(
    { ...turn(), status: "running" },
    {
      id: "turn-1",
      status: "succeeded",
      error: null,
      result: {
        summary: "已完成三张海报",
        artboardIds: ["a", "b", "c"],
        boardRevision: 9,
      },
    },
  );
  assert.equal(patched.status, "succeeded");
  assert.equal(patched.summary, "已完成三张海报");
  assert.deepEqual(patched.artboardIds, ["a", "b", "c"]);
  assert.equal(patched.boardRevision, 9);
});
