import test from "node:test";
import assert from "node:assert/strict";
import { resolveAiCount } from "../../src/lib/ai-request.js";

test("automatic AI count follows full quantities, defaults to one, and leaves ratio alone", () => {
  assert.equal(resolveAiCount("自动", "做两张咖啡海报"), 2);
  assert.equal(resolveAiCount("自动", "设计3个不同方案"), 3);
  assert.equal(resolveAiCount("自动", "改成1:1比例"), 1);
  assert.equal(resolveAiCount("2", "参考12张照片做海报"), 2);
});
test("unsupported multi-digit and Chinese quantities fail before a paid submission", () => {
  for (const prompt of [
    "做10张海报",
    "做12张海报",
    "做20张海报",
    "做十二张海报",
    "做一百张海报",
    "做四张海报",
    "做0张海报",
    "做1.2张海报",
    "做-1张海报",
    "做一百零二张海报",
    "做一千零三张海报",
    "做零张海报",
    "做〇张海报",
    "做一亿零三张海报",
  ])
    assert.throws(() => resolveAiCount("自动", prompt), /1–3/);
  for (const selection of ["4", "6", "-1", "0", "NaN", "1.5"])
    assert.throws(() => resolveAiCount(selection, "咖啡海报"), /1–3/);
});
