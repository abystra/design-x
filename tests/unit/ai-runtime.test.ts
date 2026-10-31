import test from "node:test";
import assert from "node:assert/strict";
import {
  validateManifest,
  type CreativeManifest,
} from "../../packages/ai-runtime/src/manifest.js";

// This test file runs in node:test's isolated process. Set synthetic credentials
// before importing config so dotenv never opens the developer's .env.ai.local.
const fakeE2BKey = "unit-fixture.e2b+[literal](key)/not-real";
const fakeModelKey = "unit-fixture.deepseek+$[literal](key)/not-real";
process.env.NODE_ENV = "production";
process.env.E2B_API_KEY = fakeE2BKey;
process.env.DEEPSEEK_API_KEY = fakeModelKey;
process.env.DEEPSEEK_MODEL = "deepseek-flash";
process.env.E2B_TEMPLATE_ID = "unit-test-template";
const { runtimeConfig, safeRuntimeError } =
  await import("../../packages/ai-runtime/src/config.js");

function manifest(count = 1): CreativeManifest {
  return {
    version: 1,
    summary: "已生成可编辑的秋日咖啡海报。",
    artboards: Array.from({ length: count }, (_, index) => ({
      title: `秋日咖啡 ${index + 1}`,
      design: {
        width: 1080,
        height: 1080,
        background: "#fff9ef",
        nodes: [
          {
            id: "background-card",
            type: "rect",
            x: 40,
            y: 40,
            w: 1000,
            h: 1000,
            color: "#eed9b4",
          },
          {
            id: "headline",
            type: "text",
            x: 100,
            y: 160,
            w: 880,
            h: 140,
            text: "慢一点，也很好",
            size: 64,
          },
        ],
      },
    })),
  };
}

test("AI manifest accepts editable one-to-three-artboard results without mutating input", () => {
  for (const count of [1, 2, 3]) {
    const input = manifest(count);
    const before = structuredClone(input);
    assert.deepEqual(validateManifest(input, count), before);
    assert.deepEqual(input, before);
  }
});

test("AI manifest rejects an empty generated artboard even when other artboards have layers", () => {
  const input = manifest(2);
  input.artboards[1].design.nodes = [];
  assert.throws(() => validateManifest(input, 2), /editable layers/);
});

test("AI manifest rejects duplicate layer identities within an artboard", () => {
  const input = manifest();
  input.artboards[0].design.nodes[1].id = input.artboards[0].design.nodes[0].id;
  assert.throws(() => validateManifest(input), /ID/);
});

test("AI manifest rejects unsupported layer types instead of accepting arbitrary model payloads", () => {
  for (const type of ["html", "script", "svg", "group", "TEXT"]) {
    const input = manifest();
    const badNode = { ...input.artboards[0].design.nodes[0], type };
    assert.throws(
      () =>
        validateManifest({
          ...input,
          artboards: [
            {
              ...input.artboards[0],
              design: { ...input.artboards[0].design, nodes: [badNode] },
            },
          ],
        }),
      Error,
      `unsupported node type: ${type}`,
    );
  }
});

test("AI manifest requires the requested number of generated artboards", () => {
  assert.throws(
    () => validateManifest(manifest(1), 2),
    /Expected 2 artboards, received 1/,
  );
  assert.throws(
    () => validateManifest(manifest(3), 1),
    /Expected 1 artboards, received 3/,
  );
  assert.throws(() => validateManifest(manifest(0)));
  assert.throws(() => validateManifest(manifest(4)));
});

test("AI manifest rejects extra root and artboard envelope fields", () => {
  const input = manifest();
  assert.throws(() =>
    validateManifest({ ...input, projectId: "untrusted-overwrite-target" }),
  );
  assert.throws(() => validateManifest({ ...input, commit: true }));
  assert.throws(() =>
    validateManifest({
      ...input,
      artboards: [
        { ...input.artboards[0], documentId: "untrusted-document-target" },
      ],
    }),
  );
});

test("AI manifest rejects unknown versions, missing summaries and invalid geometry", () => {
  assert.throws(() => validateManifest({ ...manifest(), version: 2 }));
  assert.throws(() => validateManifest({ ...manifest(), summary: "" }));
  for (const width of [0, 8193, Infinity, 1080.5]) {
    const input = manifest();
    input.artboards[0].design.width = width;
    assert.throws(
      () => validateManifest(input),
      Error,
      `invalid canvas width: ${width}`,
    );
  }
  const input = manifest();
  input.artboards[0].design.nodes[0].w = -1;
  assert.throws(() => validateManifest(input));
});

test("AI manifest rejects excessive editable layers before accepting an artifact", () => {
  const input = manifest();
  const seed = input.artboards[0].design.nodes[0];
  input.artboards[0].design.nodes = Array.from(
    { length: 1001 },
    (_, index) => ({ ...seed, id: `layer-${index}` }),
  );
  assert.throws(() => validateManifest(input));
});

test("runtime config uses only the synthetic test credentials", () => {
  assert.equal(process.env.NODE_ENV, "production");
  assert.deepEqual(runtimeConfig(), {
    apiKey: fakeE2BKey,
    modelKey: fakeModelKey,
    model: "deepseek-flash",
    templateId: "unit-test-template",
  });
});

test("safeRuntimeError redacts every exact known credential, including literal regex punctuation", () => {
  const result = safeRuntimeError(
    new Error(
      `model=${fakeModelKey}; e2b=${fakeE2BKey}; again=${fakeModelKey}`,
    ),
  );
  assert.equal(result, "model=[REDACTED]; e2b=[REDACTED]; again=[REDACTED]");
});

test("safeRuntimeError redacts multiline error messages and generic secret patterns", () => {
  const message = `Upstream rejected request\nAuthorization: Bearer ${fakeModelKey}\n{"apiKey":"${fakeE2BKey}"}\nunknown: sk-unit_generic-123_ABC; e2b_unit-generic_456\nRetry later.`;
  assert.equal(
    safeRuntimeError(new Error(message)),
    'Upstream rejected request\nAuthorization: Bearer [REDACTED]\n{"apiKey":"[REDACTED]"}\nunknown: [REDACTED]; [REDACTED]\nRetry later.',
  );
});

test("safeRuntimeError redacts before truncation and never returns a partial known secret", () => {
  const result = safeRuntimeError(
    new Error(`${"x".repeat(795)}${fakeModelKey}${"y".repeat(100)}`),
  );
  assert.equal(result.length, 800);
  assert.equal(result, `${"x".repeat(795)}[REDA`);
  assert.ok(!result.includes("unit-"));
  assert.equal(
    safeRuntimeError(new Error("普通错误：稍后重试")),
    "普通错误：稍后重试",
  );
});

test("safeRuntimeError does not serialize non-Error objects, access message getters, or invoke toString", () => {
  const opaque = {
    secret: fakeModelKey,
    get message(): never {
      throw new Error("message getter must not run");
    },
    toString(): never {
      throw new Error("toString must not run");
    },
    toJSON(): never {
      throw new Error("toJSON must not run");
    },
  };
  for (const value of [
    opaque,
    { message: fakeE2BKey },
    fakeModelKey,
    null,
    undefined,
    42,
  ]) {
    assert.equal(safeRuntimeError(value), "AI 运行失败");
  }
});
