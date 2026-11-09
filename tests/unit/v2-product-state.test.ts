import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAsset,
  capabilityFor,
  imageSize,
} from "../../src/lib/creative-capabilities.js";
import {
  generationPlacementKey,
  isGenerationPending,
  upsertGeneration,
} from "../../src/lib/useCreativeActivity.js";
import {
  mergeAiBoardSnapshots,
  rebaseAiBoardHistory,
} from "../../src/lib/ai-board-merge.js";
import { boardPersistenceSnapshot } from "../../src/components/board-state.js";
import { resolveAiCount } from "../../src/lib/ai-request.js";

test("project references retain immutable version URLs instead of mutable current asset URLs", () => {
  const asset = normalizeAsset({
    id: "asset-a",
    status: "ready",
    versionId: "version-1",
    image: "/api/assets/asset-a/file",
    title: "商品",
  });
  assert.equal(asset.url, "/api/assets/asset-a/versions/version-1/file");
  assert.equal(asset.assetId, "asset-a");
  assert.equal(
    normalizeAsset({ ...asset, image: "/new-image", title: "改名" }).url,
    asset.url,
  );
  assert.equal(
    normalizeAsset({ id: "coffee", name: "咖啡", url: "/assets/coffee.jpg" })
      .assetId,
    undefined,
  );
});

test("capabilities deny unknown modes and use the server reference/count contract", () => {
  const catalog = {
    modes: [
      { id: "design", enabled: true, maxReferences: 2, maxCount: 2 },
      { id: "image", enabled: false },
    ],
  };
  assert.equal(capabilityFor(catalog, "Agent")?.maxReferences, 2);
  assert.equal(capabilityFor(catalog, "图片生成")?.enabled, false);
  assert.equal(capabilityFor(null, "图片生成"), undefined);
  assert.equal(capabilityFor(catalog, "unsupported-mode"), undefined);
  assert.throws(() => resolveAiCount("3", "三个方案", 2));
  assert.equal(imageSize("9:16"), "1024x1536");
});

test("each newly placed output in a partially successful batch produces a distinct receipt", () => {
  const initial = {
    id: "g",
    outputs: [
      { id: "one", assetVersionId: "v1", placementStatus: "board" },
      { id: "two", placementStatus: "pending" },
    ],
  };
  const next = {
    ...initial,
    outputs: [
      initial.outputs[0],
      { id: "two", assetVersionId: "v2", placementStatus: "board" },
    ],
  };
  assert.notEqual(
    generationPlacementKey(initial),
    generationPlacementKey(next),
  );
  assert.equal(
    generationPlacementKey(next),
    generationPlacementKey({ ...next, outputs: [...next.outputs].reverse() }),
  );
  assert.equal(
    isGenerationPending({ status: "unknown", assetStatus: "none" }),
    false,
    "uncertain acceptance is not active polling or automatic retry",
  );
  assert.equal(
    isGenerationPending({ status: "running", assetStatus: "pending" }),
    true,
  );
});

test("received image additions survive local movement, deletion and prior undo checkpoints", () => {
  const image = {
    id: "image-new",
    kind: "image",
    assetId: "a",
    assetVersionId: "v",
    generationId: "g",
    position: { x: 320, y: 0 },
    design: { width: 1024, height: 1536, nodes: [] },
  };
  const original = {
    id: "doc",
    position: { x: 0, y: 0 },
    design: { width: 600, height: 800, nodes: [] },
  };
  const base = {
    results: [original],
    notes: [],
    sections: [],
    draft: "尚未提交的需求",
  };
  const local = {
    ...base,
    results: [{ ...original, position: { x: 120, y: 40 } }],
  };
  const remote = { ...base, results: [original, image] };
  const merged = mergeAiBoardSnapshots(base, local, remote).snapshot;
  assert.equal(merged.results[0].position.x, 120);
  assert.equal(merged.results[1].kind, "image");
  assert.equal(merged.draft, base.draft);
  const history = rebaseAiBoardHistory(
    {
      past: [
        {
          results: [{ id: "doc", position: { x: 0, y: 0 } }],
          notes: [],
          sections: [],
        },
      ],
      future: [],
    },
    base,
    remote,
  );
  assert.ok(history.past[0].results.some((item: any) => item.id === image.id));
  const deleted = mergeAiBoardSnapshots(
    base,
    { ...base, results: [] },
    remote,
  ).snapshot;
  assert.deepEqual(
    deleted.results.map((item: any) => item.id),
    [image.id],
  );
  const persisted = boardPersistenceSnapshot(merged);
  assert.equal(persisted.results[1].assetVersionId, "v");
  assert.equal("design" in persisted.results[1], false);
});

test("duplicate generation acknowledgements preserve metadata and never append a second record", () => {
  const first = { id: "g", prompt: "design", status: "queued" };
  const updated = upsertGeneration([first], { id: "g", status: "running" });
  assert.deepEqual(updated, [{ id: "g", prompt: "design", status: "running" }]);
  assert.equal(first.status, "queued");
});
