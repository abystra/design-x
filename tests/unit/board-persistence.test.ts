import test from "node:test";
import assert from "node:assert/strict";
import {
  boardPersistenceSnapshot,
  initialPersistenceBaseline,
} from "../../src/components/board-state.js";

const initial = () => ({
  id: "project",
  title: "Board",
  draft: "",
  skill: null,
  mode: "Agent",
  assets: [] as any[],
  attached: [] as any[],
  messages: [] as any[],
  results: [
    {
      id: "artboard",
      revision: 1,
      position: { x: 0, y: 0 },
      design: { width: 600, height: 800, nodes: [] },
    },
  ],
  notes: [],
  sections: [],
  view: { x: 70, y: 140, zoom: 1 },
});

test("a plain restored Board matches its initial baseline without serializing designs", () => {
  const snapshot = initial();
  Object.defineProperty(snapshot.results[0].design, "nodes", {
    get() {
      throw new Error("Serialized authoritative design nodes");
    },
  });
  assert.equal(
    JSON.stringify(boardPersistenceSnapshot(snapshot)),
    JSON.stringify(initialPersistenceBaseline(snapshot, {})),
  );
  assert.equal(
    "design" in boardPersistenceSnapshot(snapshot).results[0],
    false,
  );
  assert.equal(
    "revision" in boardPersistenceSnapshot(snapshot).results[0],
    false,
  );
});

test("Home prompt, skill, mode and asset handoffs remain dirty until first save", () => {
  const snapshot = {
    ...initial(),
    draft: "Home 中填写的需求",
    skill: { id: "skill" },
    mode: "图片生成",
    assets: [{ id: "asset", url: "/api/assets/asset/file" }],
    attached: [{ id: "asset", url: "/api/assets/asset/file" }],
  };
  const server = { draft: "", assets: [], attached: [] };
  const baseline = initialPersistenceBaseline(snapshot, server);
  assert.notEqual(
    JSON.stringify(boardPersistenceSnapshot(snapshot)),
    JSON.stringify(baseline),
  );
  assert.equal(baseline.draft, "");
  assert.equal(baseline.skill, null);
  assert.deepEqual(baseline.assets, []);
  assert.equal(
    snapshot.draft,
    "Home 中填写的需求",
    "Building a baseline must not discard handoff data",
  );
});

test("normalized unfinished messages are persisted while existing server text is retained", () => {
  const stored = {
    ...initial(),
    draft: "已有草稿",
    messages: [{ id: "m", status: "running", text: "旧需求" }],
  };
  const snapshot = {
    ...stored,
    messages: [{ id: "m", status: "cancelled", text: "AI 尚未开放" }],
  };
  assert.equal(
    initialPersistenceBaseline(snapshot, stored).messages[0].status,
    "running",
  );
  assert.equal(
    boardPersistenceSnapshot(snapshot).messages[0].status,
    "cancelled",
  );
  assert.equal(initialPersistenceBaseline(snapshot, stored).draft, "已有草稿");
});
