import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBoardIndex,
  visibleBoardEntries,
  worldViewport,
  intersects,
} from "../../src/components/board-spatial.js";

const result = (id: string, x: number, y: number) => ({
  id,
  position: { x, y },
  design: { width: 600, height: 800, nodes: [] },
});

test("viewport inversion uses CSS-pixel overscan at any zoom, including negative coordinates", () => {
  assert.deepEqual(
    worldViewport(
      { x: 100, y: -50, zoom: 0.5 },
      { width: 800, height: 600 },
      100,
    ),
    { x: -400, y: -100, width: 2000, height: 1600 },
  );
  assert.equal(
    intersects(
      { x: -10, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 2, height: 2 },
    ),
    true,
  );
});

test("200-board spatial query matches a geometry scan while leaving design nodes untouched", () => {
  const results = Array.from({ length: 200 }, (_, index) =>
    result(
      `board-${index}`,
      (index % 20) * 320 - 1000,
      Math.floor(index / 20) * 450 - 600,
    ),
  );
  for (const item of results)
    Object.defineProperty(item.design, "nodes", {
      get() {
        throw new Error("Spatial index traversed document nodes");
      },
    });
  const index = buildBoardIndex({ results });
  for (const zoom of [0.1, 0.2, 0.65, 1, 2])
    for (const x of [-2000, 0, 1000]) {
      const bounds = worldViewport(
        { x, y: -400, zoom },
        { width: 1100, height: 800 },
      );
      const expected = [...index.entries.values()]
        .filter((entry) => intersects(entry.bounds, bounds))
        .map((entry) => entry.id)
        .sort();
      assert.deepEqual(
        visibleBoardEntries(index, bounds)
          .map((entry) => entry.id)
          .sort(),
        expected,
      );
    }
  assert.ok(
    visibleBoardEntries(
      index,
      worldViewport({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 }, 0),
    ).length < 200,
  );
});

test("dragged group members enter a viewport using inverse queries and active pins remain mounted", () => {
  const index = buildBoardIndex({
    results: [
      result("stationary", 0, 0),
      result("moving", 1500, 0),
      result("focused", 9000, 0),
    ],
  });
  const bounds = { x: 0, y: 0, width: 800, height: 700 };
  assert.deepEqual(
    visibleBoardEntries(index, bounds).map((item) => item.id),
    ["stationary"],
  );
  assert.deepEqual(
    visibleBoardEntries(index, bounds, {
      movingIds: new Set(["moving"]),
      dx: -1300,
      pinnedIds: ["focused"],
    }).map((item) => item.id),
    ["stationary", "moving", "focused"],
  );
  assert.equal(
    index.entries.get("moving")?.item.position.x,
    1500,
    "Drag preview must not mutate persisted geometry",
  );
});

test("large sections avoid cell explosion and preserve section/note/artboard paint order", () => {
  const index = buildBoardIndex({
    sections: [
      {
        id: "section",
        position: { x: -10000, y: -10000 },
        width: 20000,
        height: 20000,
      },
    ],
    notes: [
      { id: "note", position: { x: 50, y: 50 }, width: 240, height: 180 },
    ],
    results: [result("board", 100, 100)],
  });
  assert.ok(index.cellCount < 20);
  assert.deepEqual(
    visibleBoardEntries(index, { x: 0, y: 0, width: 800, height: 700 }).map(
      (item) => item.id,
    ),
    ["section", "note", "board"],
  );
  assert.deepEqual(
    visibleBoardEntries(index, {
      x: 50000,
      y: 50000,
      width: 200,
      height: 200,
    }).map((item) => item.id),
    [],
  );
});
