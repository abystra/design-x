import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

// Fixed 200 × 50-node fixture in a real temporary database, independent of dev workers.
const adminUrl =
  process.env.DATABASE_URL ||
  "postgres://designx:designx-local-only@127.0.0.1:55432/designx";
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const databaseName = `designx_board_perf_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE DATABASE "${databaseName}"`);
const isolated = new URL(adminUrl);
isolated.pathname = "/" + databaseName;
process.env.DATABASE_URL = isolated.toString();
const { migrate } = await import("../../../db/migrate.js");
const { pool, tenantTransaction } =
  await import("../../../packages/server-infra/src/db.js");
const { stopQueue } =
  await import("../../../packages/server-infra/src/queue.js");
const { buildApp } = await import("../src/server.js");
await migrate();
const app = await buildApp({ logger: false });
const actors: any[] = [];
for (let index = 0; index < 2; index++) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `board-perf-${randomUUID()}@example.test`,
      password: "performance-test-password",
      name: "Performance test",
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  actors.push({
    ...response.json(),
    cookie: String(response.headers["set-cookie"]).split(";")[0],
  });
}
const request = (method: string, path: string, payload?: any, actor = 0) =>
  app.inject({
    method: method as any,
    url: "/api" + path,
    payload,
    headers: { origin: "http://127.0.0.1:5173", cookie: actors[actor].cookie },
  });
const design = {
  width: 600,
  height: 800,
  background: "#ffffff",
  nodes: Array.from({ length: 50 }, (_, index) => ({
    id: `node-${index}`,
    type: "text",
    x: (index % 5) * 110,
    y: Math.floor(index / 5) * 75,
    w: 100,
    h: 60,
    text: `第 ${index} 层，200 张真实画板的内容保持完整。`,
    size: 16,
    color: "#23382d",
  })),
};
const project = (
  await request("POST", "/projects", { title: "200 Artboards", design })
).json();
const artboardIds = [
  project.documentId,
  ...Array.from({ length: 199 }, () => randomUUID()),
];
const initialSnapshot = {
  id: project.id,
  title: project.title,
  results: artboardIds.map((id, index) => ({
    id,
    documentId: id,
    projectId: project.id,
    title: `画板 ${index + 1}`,
    position: { x: (index % 20) * 700, y: Math.floor(index / 20) * 900 },
  })),
  notes: [
    {
      id: "perf-note",
      text: "备注保留",
      position: { x: 20, y: 30 },
      width: 240,
      height: 180,
      color: "#fff0b3",
    },
  ],
  sections: [
    {
      id: "perf-section",
      title: "归属保留",
      position: { x: 0, y: 0 },
      width: 1600,
      height: 1200,
      color: "#eeeeee",
      itemIds: [artboardIds[0], "perf-note"],
    },
  ],
  view: { x: 70, y: 100, zoom: 1 },
  selected: artboardIds[0],
};
await tenantTransaction(actors[0].workspace.id, async (tx) => {
  await tx.query(
    "INSERT INTO documents(id,workspace_id,project_id,kind,title,content) SELECT d.id,$1,$2,'artboard',d.title,$3::jsonb FROM jsonb_to_recordset($4::jsonb) AS d(id text,title text)",
    [
      actors[0].workspace.id,
      project.id,
      JSON.stringify(design),
      JSON.stringify(
        artboardIds.slice(1).map((id) => ({ id, title: "额外画板" })),
      ),
    ],
  );
  await tx.query(
    "UPDATE documents SET content=$1 WHERE project_id=$2 AND kind='board'",
    [JSON.stringify(initialSnapshot), project.id],
  );
});
let revision = 1;
let captured: string[] | null = null;
const originalQuery = (pg.Client.prototype as any).query;
(pg.Client.prototype as any).query = function (
  this: pg.Client,
  ...args: any[]
) {
  const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
  if (captured && typeof sql === "string" && !sql.includes("pgboss"))
    captured.push(sql);
  return originalQuery.apply(this, args);
};
async function profile(operation: () => Promise<any>) {
  captured = [];
  const started = performance.now();
  try {
    const response = await operation();
    return { response, queries: captured, ms: performance.now() - started };
  } finally {
    captured = null;
  }
}
const boardRow = () =>
  tenantTransaction(
    actors[0].workspace.id,
    async (tx) =>
      (
        await tx.query(
          "SELECT * FROM documents WHERE project_id=$1 AND kind='board'",
          [project.id],
        )
      ).rows[0],
  );
test.after(async () => {
  (pg.Client.prototype as any).query = originalQuery;
  await app.close();
  await stopQueue();
  await pool.end();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      Number(
        (
          await admin.query(
            "SELECT count(*) FROM pg_stat_activity WHERE datname=$1",
            [databaseName],
          )
        ).rows[0].count,
      ) === 0
    )
      break;
    await delay(50);
  }
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
});

test("200-Artboard lean save has constant SQL count and a small authoritative revision acknowledgement", async (t) => {
  const snapshot = structuredClone(initialSnapshot);
  snapshot.results[0].position = { x: 321, y: 654 };
  const measured = await profile(() =>
    request("PUT", `/projects/${project.id}/studio?response=ack`, {
      snapshot,
      baseRevision: revision,
    }),
  );
  assert.equal(measured.response.statusCode, 200, measured.response.body);
  const ack = measured.response.json();
  assert.equal(ack.projectId, project.id);
  assert.equal(ack.revision, ++revision);
  assert.ok(ack.documentId);
  assert.ok(ack.updatedAt);
  assert.equal(ack.snapshot, undefined);
  assert.ok(
    measured.response.rawPayload.length < 512,
    `ack is ${measured.response.rawPayload.length} bytes`,
  );
  assert.ok(
    measured.queries.length <= 14,
    `expected constant queries, received ${measured.queries.length}`,
  );
  assert.equal(
    measured.queries.filter((sql) =>
      sql.includes("SELECT * FROM documents WHERE id="),
    ).length,
    0,
  );
  const current = await boardRow();
  assert.equal(current.id, ack.documentId);
  assert.deepEqual(current.content.results[0].position, { x: 321, y: 654 });
  const log = await tenantTransaction(
    actors[0].workspace.id,
    async (tx) =>
      (
        await tx.query(
          "SELECT * FROM document_ops WHERE document_id=$1 AND revision=$2",
          [current.id, revision],
        )
      ).rows[0],
  );
  assert.deepEqual(
    log.inverse_ops[0].content.results[0].position,
    initialSnapshot.results[0].position,
  );
  assert.deepEqual(log.ops[0].content.results[0].position, { x: 321, y: 654 });
  t.diagnostic(
    `200 Artboards / 10000 nodes: ${measured.queries.length} SQL, ${measured.response.rawPayload.length} response bytes, ${measured.ms.toFixed(2)} ms`,
  );
});

test("lean saves preserve revision conflicts, tenant isolation and batch membership validation", async () => {
  const before = await boardRow();
  assert.equal(
    (
      await request("PUT", `/projects/${project.id}/studio?response=ack`, {
        snapshot: initialSnapshot,
        baseRevision: revision - 1,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await request(
        "PUT",
        `/projects/${project.id}/studio?response=ack`,
        { snapshot: initialSnapshot, baseRevision: revision },
        1,
      )
    ).statusCode,
    404,
  );
  const foreign = (
    await request("POST", "/projects", { title: "Other project" })
  ).json();
  const bad = structuredClone(initialSnapshot);
  bad.results[1].id = foreign.documentId;
  assert.equal(
    (
      await request("PUT", `/projects/${project.id}/studio?response=ack`, {
        snapshot: bad,
        baseRevision: revision,
      })
    ).statusCode,
    404,
  );
  bad.results[1].id = "unknown-artboard";
  assert.equal(
    (
      await request("PUT", `/projects/${project.id}/studio?response=ack`, {
        snapshot: bad,
        baseRevision: revision,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await request("PUT", `/projects/${project.id}/studio?response=invalid`, {
        snapshot: initialSnapshot,
        baseRevision: revision,
      })
    ).statusCode,
    400,
  );
  assert.deepEqual(await boardRow(), before);
});

test("inverse Board state is undoable through acknowledgement mode without rewriting Artboard content", async () => {
  const current = await boardRow();
  const inverse = await tenantTransaction(
    actors[0].workspace.id,
    async (tx) =>
      (
        await tx.query(
          "SELECT inverse_ops FROM document_ops WHERE document_id=$1 AND revision=$2",
          [current.id, revision],
        )
      ).rows[0].inverse_ops[0].content,
  );
  inverse.results[0].design = { ...design, nodes: [] };
  const undone = await request(
    "PUT",
    `/projects/${project.id}/studio?response=ack`,
    { snapshot: inverse, baseRevision: revision },
  );
  assert.equal(undone.statusCode, 200, undone.body);
  assert.equal(undone.json().revision, ++revision);
  const opened = (
    await request("GET", `/projects/${project.id}/studio`)
  ).json();
  assert.equal(opened.revision, revision);
  assert.equal(opened.snapshot.results.length, 200);
  assert.deepEqual(
    opened.snapshot.results[0].position,
    initialSnapshot.results[0].position,
  );
  assert.deepEqual(opened.snapshot.results[0].design, design);
  assert.equal((await boardRow()).content.results[0].design, undefined);
  assert.deepEqual(
    opened.snapshot.sections[0].itemIds,
    initialSnapshot.sections[0].itemIds,
  );
});

test("legacy Board save still returns full Artboards after batch validation", async () => {
  const measured = await profile(() =>
    request("PUT", `/projects/${project.id}/studio`, {
      snapshot: initialSnapshot,
      baseRevision: revision,
    }),
  );
  assert.equal(measured.response.statusCode, 200, measured.response.body);
  const saved = measured.response.json();
  assert.equal(saved.revision, ++revision);
  assert.equal(saved.snapshot.results.length, 200);
  assert.deepEqual(saved.snapshot.results[199].design, design);
  assert.ok(measured.queries.length <= 17, `${measured.queries.length} SQL`);
});

test("project metadata reads omit document bodies while default clients retain them", async () => {
  const extra = Array.from({ length: 198 }, () => ({
    id: randomUUID(),
    document: randomUUID(),
  }));
  await tenantTransaction(actors[0].workspace.id, async (tx) => {
    await tx.query(
      "INSERT INTO projects(id,workspace_id,title,primary_artboard_id) SELECT p.id,$1,'Card fixture',p.document FROM jsonb_to_recordset($2::jsonb) AS p(id text,document text)",
      [actors[0].workspace.id, JSON.stringify(extra)],
    );
    await tx.query(
      "INSERT INTO documents(id,workspace_id,project_id,kind,title,content) SELECT p.document,$1,p.id,'artboard','Card fixture',$2::jsonb FROM jsonb_to_recordset($3::jsonb) AS p(id text,document text)",
      [actors[0].workspace.id, JSON.stringify(design), JSON.stringify(extra)],
    );
  });
  const full = await request("GET", "/projects");
  assert.equal(full.statusCode, 200);
  assert.equal(full.json().length, 200);
  assert.ok(full.json().every((row: any) => row.design));
  const lean = await profile(() => request("GET", "/projects?view=metadata"));
  assert.equal(lean.response.statusCode, 200);
  assert.equal(lean.response.json().length, 200);
  assert.ok(
    lean.response
      .json()
      .every(
        (row: any) =>
          row.design === undefined && row.documentId && row.revision,
      ),
  );
  assert.ok(lean.response.rawPayload.length < full.rawPayload.length / 10);
  assert.ok(!lean.queries.some((sql) => /d\.content/i.test(sql)));
  const detail = (
    await request("GET", `/projects/${project.id}?view=metadata`)
  ).json();
  assert.equal(detail.id, project.id);
  assert.equal(detail.design, undefined);
  assert.equal(detail.documentId, project.documentId);
  assert.deepEqual(
    (await request("GET", `/projects/${project.id}`)).json().design,
    design,
  );
  assert.equal(
    (
      await request(
        "GET",
        `/projects/${project.id}?view=metadata`,
        undefined,
        1,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await request("GET", "/projects?view=metadata", undefined, 1)).json()
      .length,
    0,
  );
  assert.equal(
    (await request("GET", "/projects?view=invalid")).statusCode,
    400,
  );
});

test("Artboard creation returns its exact committed Board revision and rejects invalid writes atomically", async () => {
  const before = await boardRow();
  const response = await request("POST", `/projects/${project.id}/artboards`, {
    title: "Board revision",
    design,
    position: { x: 123, y: 456 },
  });
  assert.equal(response.statusCode, 200, response.body);
  const created = response.json();
  assert.equal(created.boardRevision, before.revision + 1);
  assert.deepEqual(created.design, design);
  revision = created.boardRevision;
  const current = await boardRow();
  assert.equal(current.revision, created.boardRevision);
  assert.ok(current.content.results.some((row: any) => row.id === created.id));
  const stale = await request(
    "PUT",
    `/projects/${project.id}/studio?response=ack`,
    { snapshot: initialSnapshot, baseRevision: before.revision },
  );
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(await boardRow(), current);
  const bad = await request("POST", `/projects/${project.id}/artboards`, {
    title: "Invalid",
    design,
    position: { x: 100001, y: 0 },
  });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(await boardRow(), current);
  const denied = await request(
    "POST",
    `/projects/${project.id}/artboards`,
    { title: "Cross tenant", design },
    1,
  );
  assert.equal(denied.statusCode, 404);
  assert.deepEqual(await boardRow(), current);
});

test("job read APIs project status columns without loading large export document payloads", async () => {
  const jobId = randomUUID();
  await tenantTransaction(actors[0].workspace.id, (tx) =>
    tx.query(
      "INSERT INTO jobs(id,workspace_id,project_id,kind,payload,status) VALUES($1,$2,$3,'render.export',$4,'failed')",
      [
        jobId,
        actors[0].workspace.id,
        project.id,
        JSON.stringify({
          documents: Array.from({ length: 200 }, () => ({ content: design })),
        }),
      ],
    ),
  );
  for (const path of ["/jobs", `/jobs/${jobId}`]) {
    const measured = await profile(() => request("GET", path));
    assert.equal(measured.response.statusCode, 200, measured.response.body);
    const job = Array.isArray(measured.response.json())
      ? measured.response.json().find((row: any) => row.id === jobId)
      : measured.response.json();
    assert.equal(job.id, jobId);
    assert.equal(job.kind, "render.export");
    assert.equal(job.status, "failed");
    assert.equal(job.payload, undefined);
    assert.ok(
      measured.queries
        .filter((sql) => /FROM jobs/.test(sql))
        .every((sql) => !/^SELECT \*/.test(sql)),
      measured.queries.join("\n"),
    );
  }
  assert.equal(
    (await request("GET", `/jobs/${jobId}`, undefined, 1)).statusCode,
    404,
  );
  assert.equal((await request("GET", "/jobs", undefined, 1)).json().length, 0);
});
