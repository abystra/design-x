// Compare the actual editor DOM with PNG bytes produced by the separate renderer.
// Requires the running web/API/worker/renderer stack. No intercepted requests.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import sharp from "sharp";

const baseURL = process.env.DESIGNX_E2E_URL || "http://127.0.0.1:5173";
const runId = `render-${Date.now()}`;
const output = new URL(`./.artifacts/${runId}/`, import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const results = [];
async function api(method, path, data) {
  const response = await context.request.fetch(`/api${path}`, {
    method,
    data,
    headers: { Origin: baseURL, "X-Requested-With": "Design-X" },
  });
  assert.ok(
    response.ok(),
    `${method} ${path}: ${response.status()} ${await response.text()}`,
  );
  return response.json();
}
const fixtures = [
  {
    name: "chinese-latin-serif-and-wrapping",
    width: 600,
    height: 500,
    background: "#f3ede2",
    nodes: [
      {
        id: "image",
        type: "image",
        src: "/assets/coffee.jpg",
        x: 300,
        y: 0,
        w: 300,
        h: 500,
        fit: "cover",
        objectPosition: "67% 40%",
      },
      {
        id: "heading",
        type: "text",
        text: "慢一点，\n也很好。",
        x: 30,
        y: 35,
        w: 250,
        h: 140,
        size: 48,
        weight: 700,
        color: "#24362b",
      },
      {
        id: "english",
        type: "text",
        text: "The quiet\nmoments.",
        x: 32,
        y: 220,
        w: 240,
        h: 110,
        size: 36,
        weight: 500,
        font: "Georgia, serif",
        color: "#3d4132",
      },
      {
        id: "wrap",
        type: "text",
        text: "中英文混排 ABC 123 — 字体随项目固定，内容自动换行。",
        x: 32,
        y: 350,
        w: 230,
        h: 130,
        size: 21,
        color: "#52654a",
      },
    ],
  },
  {
    name: "rotation-opacity-contain-clipping",
    width: 480,
    height: 400,
    background: "#ffffff",
    nodes: [
      {
        id: "rect",
        type: "rect",
        x: -20,
        y: 40,
        w: 240,
        h: 290,
        color: "#f2634b",
        rotation: -11,
        opacity: 0.65,
      },
      {
        id: "circle",
        type: "circle",
        x: 110,
        y: 170,
        w: 270,
        h: 170,
        color: "#24362b",
        opacity: 0.8,
        rotation: 23,
      },
      {
        id: "image",
        type: "image",
        src: "/assets/skincare.jpg",
        x: 250,
        y: 20,
        w: 200,
        h: 270,
        fit: "contain",
        rotation: 8,
        opacity: 0.85,
      },
      {
        id: "hidden",
        type: "text",
        text: "THIS MUST STAY HIDDEN",
        x: 0,
        y: 0,
        w: 480,
        h: 80,
        size: 44,
        hidden: true,
      },
      {
        id: "caption",
        type: "text",
        text: "色彩 · 图形 · 图片",
        x: 25,
        y: 340,
        w: 420,
        h: 50,
        size: 30,
        align: "center",
        color: "#24362b",
      },
    ],
  },
];
try {
  await api("POST", "/auth/register", {
    email: `${runId}@example.test`,
    password: crypto.randomUUID(),
    name: "渲染一致性验收",
  });
  for (const fixture of fixtures) {
    const { name, ...design } = fixture;
    const project = await api("POST", "/projects", { title: name, design });
    await page.goto(`${baseURL}/#editor/${project.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "预览作品", exact: true }).click();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        [...document.querySelectorAll(".ed-board img")].map((i) => i.decode()),
      );
    });
    // Normalize only viewport placement and zoom, preserving every content style.
    await page.locator(".ed-board-holder").evaluate((holder, d) => {
      holder.style.cssText = `position:fixed;left:0;top:0;width:${d.width}px;height:${d.height}px;margin:0;box-shadow:none;z-index:10000`;
      holder.querySelector(".ed-board").style.transform = "none";
    }, design);
    await page.mouse.move(1400, 950);
    const editor = await page
      .locator(".ed-board")
      .screenshot({
        path: new URL(`${name}-editor.png`, output).pathname,
        animations: "disabled",
      });
    const job = await api("POST", `/projects/${project.id}/exports`, {
      format: "png",
      scale: 1,
    });
    let complete;
    for (let i = 0; i < 120; i++) {
      complete = await api("GET", `/jobs/${job.id}`);
      if (["succeeded", "failed", "cancelled"].includes(complete.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(complete.status, "succeeded", JSON.stringify(complete));
    const response = await context.request.get(complete.downloadUrl);
    assert.ok(response.ok());
    const exported = await response.body();
    await writeFile(new URL(`${name}-export.png`, output), exported);
    const [a, b] = await Promise.all(
      [editor, exported].map((bytes) =>
        sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
      ),
    );
    assert.deepEqual(a.info, b.info);
    let changed = 0,
      totalDelta = 0;
    for (let i = 0; i < a.data.length; i += 3) {
      const delta = Math.max(
        ...[0, 1, 2].map((c) => Math.abs(a.data[i + c] - b.data[i + c])),
      );
      if (delta > 12) changed++;
      totalDelta += delta;
    }
    const pixels = a.info.width * a.info.height;
    const result = {
      fixture: name,
      changedPixelRatio: changed / pixels,
      meanMaxChannelDelta: totalDelta / pixels,
      width: a.info.width,
      height: a.info.height,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    assert.ok(
      result.changedPixelRatio < 0.005,
      `Editor/export mismatch: ${JSON.stringify(result)}`,
    );
    await api("DELETE", `/projects/${project.id}`);
  }
  assert.deepEqual(pageErrors, []);
  console.log(`PASS ${results.length} real editor/export comparisons`);
} finally {
  await writeFile(
    new URL("report.json", output),
    JSON.stringify(
      { runId, baseURL, mocked: false, results, pageErrors },
      null,
      2,
    ),
  );
  await browser.close();
}
