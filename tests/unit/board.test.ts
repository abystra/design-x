import test from "node:test";
import assert from "node:assert/strict";
import { BoardSchema } from "../../packages/doc-core/src/board.js";
const note = {
  id: "note-1",
  text: "中文便签\n保留换行",
  position: { x: 30, y: -15 },
  width: 240,
  height: 180,
  color: "#FFF2C6",
};
const section = {
  id: "section-1",
  title: "方案一",
  position: { x: 0, y: 0 },
  width: 700,
  height: 600,
  color: "#E9EFE8",
  itemIds: ["artboard-1", "note-1"],
};
const source = () => ({
  results: [
    { id: "artboard-1", position: { x: 320, y: 80 }, title: "Existing design" },
  ],
  notes: [structuredClone(note)],
  sections: [structuredClone(section)],
  draft: "保留旧草稿",
});
test("Board v1 defaults keep legacy data compatible and retain the existing envelope", () => {
  const parsed = BoardSchema.parse({
    results: [{ id: "legacy" }],
    draft: "既有草稿",
    messages: [],
  });
  assert.deepEqual(parsed.notes, []);
  assert.deepEqual(parsed.sections, []);
  assert.deepEqual(parsed.results[0].position, { x: 0, y: 0 });
  assert.equal(parsed.draft, "既有草稿");
  const input = source();
  assert.deepEqual(BoardSchema.parse(input), input);
});
test("Board object identity and non-nested section membership cannot be ambiguous", () => {
  for (const mutate of [
    (s: any) => s.notes.push({ ...note }),
    (s: any) => (s.notes[0].id = "artboard-1"),
    (s: any) => s.sections[0].itemIds.push("missing"),
    (s: any) => s.sections[0].itemIds.push("section-1"),
    (s: any) => s.sections[0].itemIds.push("note-1"),
    (s: any) => s.sections.push({ ...section, id: "section-2" }),
  ]) {
    const value = source();
    mutate(value);
    assert.equal(BoardSchema.safeParse(value).success, false);
  }
});
test("Board geometry, text and colors are bounded; empty sections and detached notes remain valid", () => {
  for (const patch of [
    { text: "x".repeat(10001) },
    { width: 0 },
    { height: Infinity },
    { color: "url(https://external.invalid)" },
    { position: { x: 100001, y: 0 } },
  ]) {
    const value = source();
    Object.assign(value.notes[0], patch);
    assert.equal(BoardSchema.safeParse(value).success, false);
  }
  const value = source();
  value.sections[0].itemIds = [];
  assert.ok(BoardSchema.safeParse(value).success);
  value.sections = [];
  assert.ok(BoardSchema.safeParse(value).success);
});
