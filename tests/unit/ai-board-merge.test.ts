import test from "node:test";
import assert from "node:assert/strict";
import {
  BoardMergeConflict,
  mergeAiBoardSnapshots,
  rebaseAiBoardHistory,
} from "../../src/lib/ai-board-merge.js";

const result = (id: string, x = 0): any => ({
  id,
  title: id,
  position: { x, y: 20 },
  revision: 1,
  design: {
    width: 600,
    height: 500,
    background: "#ffffff",
    nodes: [{ id: "text", type: "text", text: id }],
  },
});
const note = (id = "note-1"): any => ({
  id,
  text: "原始便签",
  position: { x: 15, y: 25 },
  width: 240,
  height: 180,
  color: "#FFF2C6",
});
const section = (
  id = "section-1",
  itemIds = ["artboard-1", "note-1"],
): any => ({
  id,
  title: "原始分区",
  position: { x: 0, y: 0 },
  width: 800,
  height: 600,
  color: "#E9EFE8",
  itemIds,
});
const board = (): any => ({
  id: "project-1",
  title: "创作空间",
  results: [result("artboard-1")],
  notes: [note()],
  sections: [section()],
  view: { x: 70, y: 140, zoom: 1 },
  draft: "",
  selected: null,
  selection: [],
  reference: null,
  messages: [],
  assets: [],
  attached: [],
  skill: null,
  mode: "Agent",
  count: "自动",
  ratio: "自动",
});
const persisted = (snapshot: any): any => ({
  ...structuredClone(snapshot),
  results: snapshot.results.map(({ design, revision, ...item }: any) =>
    structuredClone(item),
  ),
});
const scenario = () => {
  const local = board();
  return { base: persisted(local), local, remote: structuredClone(local) };
};
test("server AI additions survive every prior undo and redo checkpoint without mutating history", () => {
  const base = board(),
    remote = board();
  remote.results.push(result("ai-new", 500));
  const history = {
    past: [
      {
        results: [{ id: "artboard-1", position: { x: -80, y: 20 } }],
        notes: [note()],
        sections: [section()],
      },
    ],
    future: [{ results: [], notes: [], sections: [] }],
  };
  const rebased = rebaseAiBoardHistory(history, base, remote);
  assert.deepEqual(
    rebased.past[0].results.map((item: any) => item.id),
    ["artboard-1", "ai-new"],
  );
  assert.deepEqual(
    rebased.future[0].results.map((item: any) => item.id),
    ["ai-new"],
  );
  assert.equal(rebased.past[0].results[0].position.x, -80);
  assert.equal(history.past[0].results.length, 1);
  assert.equal(history.future[0].results.length, 0);
});
test("remote organization changes invalidate stale history, document-only revisions preserve it", () => {
  const base = board(),
    remote = board();
  const history = {
    past: [{ results: [], notes: [], sections: [] }],
    future: [],
  };
  remote.results[0].design.nodes[0].text = "new document";
  remote.results[0].revision++;
  assert.equal(rebaseAiBoardHistory(history, base, remote).past.length, 1);
  remote.results[0].position.x++;
  assert.deepEqual(rebaseAiBoardHistory(history, base, remote), {
    past: [],
    future: [],
  });
});
function conflict(action: () => unknown, path: string, reason: string) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof BoardMergeConflict);
    assert.equal(error.code, "BOARD_MERGE_CONFLICT");
    assert.equal(error.path, path);
    assert.equal(error.reason, reason);
    return true;
  });
}

test("remote AI append preserves unsaved local movement, notes, sections and UI state", () => {
  const { base, local, remote } = scenario();
  local.results[0].position.x = 480;
  local.notes[0].text = "尚未保存的中文便签";
  local.sections[0].title = "本地分区标题";
  Object.assign(local, {
    view: { x: -340, y: 225, zoom: 0.65 },
    draft: "下一步的需求",
    selected: "note-1",
    selection: ["note-1", "artboard-1"],
    reference: { id: "artboard-1" },
    attached: [{ id: "asset-1" }],
    assets: [{ url: "/api/assets/asset-1/file" }],
    skill: { id: "poster" },
    mode: "Agent",
    ratio: "4:5",
    count: 2,
    messages: [{ id: "message-1", text: "本地对话" }],
  });
  remote.results.push(result("ai-result-1", 700));
  const before = structuredClone({ base, local, remote });
  const { snapshot, addedResultIds } = mergeAiBoardSnapshots(
    base,
    local,
    remote,
  );
  assert.deepEqual(snapshot, {
    ...local,
    results: [local.results[0], remote.results[1]],
  });
  assert.deepEqual(addedResultIds, ["ai-result-1"]);
  assert.deepEqual(
    { base, local, remote },
    before,
    "merge does not mutate any input",
  );
});

test("local deletion of an unchanged old item survives a remote append without reporting the deleted ID as added", () => {
  const { base, local, remote } = scenario();
  local.results = [];
  local.sections[0].itemIds = ["note-1"];
  remote.results.push(result("ai-result-1"));
  const merged = mergeAiBoardSnapshots(base, local, remote);
  assert.deepEqual(
    merged.snapshot.results.map((item: any) => item.id),
    ["ai-result-1"],
  );
  assert.deepEqual(merged.snapshot.sections[0].itemIds, ["note-1"]);
  assert.deepEqual(merged.addedResultIds, ["ai-result-1"]);
});

test("remote design and revision remain authoritative while local Board position survives", () => {
  const { base, local, remote } = scenario();
  local.results[0].position.y = 600;
  local.results[0].design.nodes[0].text = "过时的本地文档";
  remote.results[0].revision = 8;
  remote.results[0].design.nodes[0].text = "服务器已保存的编辑器结果";
  const { snapshot } = mergeAiBoardSnapshots(base, local, remote);
  assert.equal(snapshot.results[0].revision, 8);
  assert.strictEqual(snapshot.results[0].design, remote.results[0].design);
  assert.deepEqual(snapshot.results[0].position, { x: 0, y: 600 });
});

test("Board comparison never traverses document layers, including document data in a hydrated base", () => {
  const { local, remote } = scenario();
  const base = structuredClone(local);
  for (const source of [base, local, remote]) {
    Object.defineProperty(source.results[0].design, "nodes", {
      get() {
        throw new Error("Board merge traversed authoritative document layers");
      },
    });
  }
  local.results[0].position.x = 25;
  assert.equal(
    mergeAiBoardSnapshots(base, local, remote).snapshot.results[0].position.x,
    25,
  );
});

test("a document-only remote change does not resurrect a locally removed Board item", () => {
  const { base, local, remote } = scenario();
  local.results = [];
  local.sections[0].itemIds = ["note-1"];
  remote.results[0].revision = 9;
  remote.results[0].design.nodes[0].text = "编辑器的新版本";
  assert.deepEqual(
    mergeAiBoardSnapshots(base, local, remote).snapshot.results,
    [],
  );
});

test("concurrent edits to distinct fields merge; identical changes are accepted", () => {
  const { base, local, remote } = scenario();
  local.results[0].position.x = 35;
  remote.results[0].position.y = 60;
  local.notes[0].text = "本地正文";
  remote.notes[0].color = "#AABBCC";
  local.title = remote.title = "双方相同标题";
  const { snapshot } = mergeAiBoardSnapshots(base, local, remote);
  assert.deepEqual(snapshot.results[0].position, { x: 35, y: 60 });
  assert.equal(snapshot.notes[0].text, "本地正文");
  assert.equal(snapshot.notes[0].color, "#AABBCC");
  assert.equal(snapshot.title, "双方相同标题");
});

test("same-field Board or draft changes reject without altering local state", () => {
  for (const kind of ["result", "note", "section", "draft"]) {
    const { base, local, remote } = scenario();
    let path: string;
    if (kind === "result") {
      local.results[0].position.x = 100;
      remote.results[0].position.x = 200;
      path = "results[artboard-1].position.x";
    } else if (kind === "note") {
      local.notes[0].text = "本地";
      remote.notes[0].text = "远端";
      path = "notes[note-1].text";
    } else if (kind === "section") {
      local.sections[0].title = "本地";
      remote.sections[0].title = "远端";
      path = "sections[section-1].title";
    } else {
      local.draft = "本地";
      remote.draft = "远端";
      path = "draft";
    }
    const before = structuredClone(local);
    conflict(
      () => mergeAiBoardSnapshots(base, local, remote),
      path,
      "concurrent-change",
    );
    assert.deepEqual(local, before);
  }
});

test("delete versus Board modification conflicts in either direction", () => {
  for (const deleting of ["local", "remote"]) {
    const { base, local, remote } = scenario();
    const removed = deleting === "local" ? local : remote;
    const changed = deleting === "local" ? remote : local;
    removed.notes = [];
    removed.sections[0].itemIds = ["artboard-1"];
    changed.notes[0].text = "并发修改";
    conflict(
      () => mergeAiBoardSnapshots(base, local, remote),
      "notes[note-1]",
      "delete-modify",
    );
  }
});

test("section membership arrays merge atomically instead of silently unioning incompatible assignments", () => {
  const { base, local, remote } = scenario();
  local.sections[0].itemIds = ["note-1"];
  remote.sections[0].itemIds = ["artboard-1"];
  conflict(
    () => mergeAiBoardSnapshots(base, local, remote),
    "sections[section-1].itemIds",
    "concurrent-change",
  );
});

test("merged membership rejects a dangling member or a member independently assigned to two sections", () => {
  const first = scenario();
  first.base.sections = first.local.sections = first.remote.sections = [];
  first.local.notes = [];
  first.remote.sections = [section("remote-section", ["note-1"])];
  conflict(
    () => mergeAiBoardSnapshots(first.base, first.local, first.remote),
    "sections[remote-section].itemIds",
    "invalid-membership",
  );
  const second = scenario();
  second.base.sections = second.local.sections = second.remote.sections = [];
  second.local.sections = [section("local-section", ["note-1"])];
  second.remote.sections = [section("remote-section", ["note-1"])];
  conflict(
    () => mergeAiBoardSnapshots(second.base, second.local, second.remote),
    "sections[remote-section].itemIds",
    "invalid-membership",
  );
});

test("omitted remote UI fields inherit the acknowledged baseline, not local unsaved values", () => {
  const { base, local, remote } = scenario();
  local.draft = "本地草稿";
  local.view.zoom = 0.5;
  local.selection = ["note-1"];
  const { snapshot } = mergeAiBoardSnapshots(base, local, {
    results: remote.results,
  });
  assert.equal(snapshot.draft, "本地草稿");
  assert.deepEqual(snapshot.view, local.view);
  assert.deepEqual(snapshot.selection, ["note-1"]);
  assert.deepEqual(snapshot.notes, local.notes);
  assert.deepEqual(snapshot.sections, local.sections);
});

test("explicit remote empty arrays, null and empty text are meaningful clears", () => {
  const { base, local, remote } = scenario();
  for (const source of [base, local, remote]) {
    source.messages = [{ id: "old-message" }];
    source.selection = ["note-1"];
    source.selected = "note-1";
    source.reference = { id: "artboard-1" };
    source.draft = "旧草稿";
  }
  Object.assign(remote, {
    messages: [],
    selection: [],
    selected: null,
    reference: null,
    draft: "",
    notes: [],
    sections: [],
  });
  const { snapshot } = mergeAiBoardSnapshots(base, local, remote);
  for (const key of ["messages", "selection", "notes", "sections"])
    assert.deepEqual(snapshot[key], []);
  assert.equal(snapshot.selected, null);
  assert.equal(snapshot.reference, null);
  assert.equal(snapshot.draft, "");
});

test("metadata takes independent remote edits while keeping local drafts and nested custom fields", () => {
  const { base, local, remote } = scenario();
  for (const source of [base, local, remote])
    source.preferences = { theme: "light", density: "normal" };
  local.draft = "未保存需求";
  local.preferences.density = "compact";
  remote.title = "其他用户修改的标题";
  remote.preferences.theme = "dark";
  const { snapshot } = mergeAiBoardSnapshots(base, local, remote);
  assert.equal(snapshot.title, remote.title);
  assert.equal(snapshot.draft, local.draft);
  assert.deepEqual(snapshot.preferences, { theme: "dark", density: "compact" });
});

test("duplicate IDs in an input or across independently created item kinds reject", () => {
  const first = scenario();
  first.remote.results.push(result("artboard-1"));
  conflict(
    () => mergeAiBoardSnapshots(first.base, first.local, first.remote),
    "remote.results[artboard-1]",
    "duplicate-id",
  );
  const second = scenario();
  second.local.notes.push(note("collision"));
  second.remote.results.push(result("collision"));
  conflict(
    () => mergeAiBoardSnapshots(second.base, second.local, second.remote),
    "merged.notes[collision]",
    "duplicate-id",
  );
});

test("same-ID concurrent creation must agree, while an already-present remote result is not added twice", () => {
  const { base, local, remote } = scenario();
  local.results.push(result("new"));
  remote.results.push(result("new"));
  remote.results[1].revision = 2;
  const merged = mergeAiBoardSnapshots(base, local, remote);
  assert.deepEqual(merged.addedResultIds, []);
  assert.equal(
    merged.snapshot.results.filter((item: any) => item.id === "new").length,
    1,
  );
  assert.equal(merged.snapshot.results[1].revision, 2);
  remote.results[1].position.x = 99;
  conflict(
    () => mergeAiBoardSnapshots(base, local, remote),
    "results[new]",
    "concurrent-create",
  );
});

test("local-only new result retains its document alongside a remote AI result", () => {
  const { base, local, remote } = scenario();
  const pending = result("local-new");
  local.results.push(pending);
  remote.results.push(result("ai-new"));
  const { snapshot, addedResultIds } = mergeAiBoardSnapshots(
    base,
    local,
    remote,
  );
  assert.deepEqual(
    snapshot.results.map((item: any) => item.id),
    ["artboard-1", "local-new", "ai-new"],
  );
  assert.strictEqual(snapshot.results[1].design, pending.design);
  assert.deepEqual(addedResultIds, ["ai-new"]);
});

test("remote reorder and insertion are retained when local only edits an item", () => {
  const { base, local, remote } = scenario();
  for (const source of [base, local, remote])
    source.results.push(result("b"), result("c"));
  local.results[0].position.x = 50;
  remote.results = [
    remote.results[2],
    remote.results[0],
    result("ai-middle"),
    remote.results[1],
  ];
  const { snapshot } = mergeAiBoardSnapshots(base, local, remote);
  assert.deepEqual(
    snapshot.results.map((item: any) => item.id),
    ["c", "artboard-1", "ai-middle", "b"],
  );
  assert.equal(snapshot.results[1].position.x, 50);
});

test("incompatible concurrent collection reorders reject rather than silently choose one side", () => {
  const { base, local, remote } = scenario();
  for (const source of [base, local, remote])
    source.results.push(result("b"), result("c"));
  local.results.reverse();
  remote.results = [remote.results[1], remote.results[0], remote.results[2]];
  conflict(
    () => mergeAiBoardSnapshots(base, local, remote),
    "results.$order",
    "concurrent-change",
  );
});

test("a complete remote results collection is required and malformed collections reject", () => {
  const { base, local, remote } = scenario();
  conflict(
    () => mergeAiBoardSnapshots(base, local, {}),
    "remote.results",
    "invalid-collection",
  );
  conflict(
    () => mergeAiBoardSnapshots(base, local, { ...remote, notes: null }),
    "remote.notes",
    "invalid-collection",
  );
});
