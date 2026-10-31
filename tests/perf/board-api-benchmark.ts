import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
// Run: node --import tsx tests/perf/board-api-benchmark.ts [--optimized]
// Uses real PostgreSQL in a temporary database; existing app/worker data stays untouched.
const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(root + "/package.json");
require("dotenv").config({ path: root + "/.env", quiet: true });
const pg = require("pg");
const originalQuery = pg.Client.prototype.query;
let capture: string[] | null = null;
pg.Client.prototype.query = function (...args: any[]) {
  const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
  if (capture && typeof sql === "string" && !sql.includes("pgboss"))
    capture.push(sql);
  return originalQuery.apply(this, args);
};
const adminUrl =
  process.env.DATABASE_URL ||
  "postgres://designx:designx-local-only@127.0.0.1:55432/designx";
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const name = "designx_perf_" + randomUUID().replaceAll("-", "");
await admin.query(`CREATE DATABASE "${name}"`);
const url = new URL(adminUrl!);
url.pathname = "/" + name;
process.env.DATABASE_URL = url.toString();
const { migrate } = await import(root + "/db/migrate.ts");
const { pool, tenantTransaction } = await import(
  root + "/packages/server-infra/src/db.ts"
);
const { stopQueue } = await import(
  root + "/packages/server-infra/src/queue.ts"
);
const { buildApp } = await import(root + "/apps/api/src/server.ts");
let app: any;
try {
  await migrate();
  app = await buildApp({ logger: false });
  const auth = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `perf-${randomUUID()}@example.test`,
      password: "benchmark-safe-password",
      name: "Performance fixture",
    },
  });
  if (auth.statusCode !== 201) throw Error(auth.body);
  const cookie = String(auth.headers["set-cookie"]).split(";")[0],
    workspace = auth.json().workspace.id;
  const req = (method: string, path: string, payload?: any) =>
    app.inject({
      method,
      url: "/api" + path,
      payload,
      headers: { cookie, origin: "http://127.0.0.1:5173" },
    });
  const design = {
    width: 600,
    height: 800,
    background: "#ffffff",
    nodes: Array.from({ length: 50 }, (_, i) => ({
      id: `n-${i}`,
      type: "text",
      x: (i % 5) * 110,
      y: Math.floor(i / 5) * 75,
      w: 100,
      h: 60,
      text: `画板图层 ${i}：保留真实中文设计内容用于性能测量与交互。`,
      size: 16,
      color: "#23382d",
      weight: 500,
    })),
  };
  const project = (
    await req("POST", "/projects", { title: "200板性能基线", design })
  ).json();
  const ids = [
    project.documentId,
    ...Array.from({ length: 199 }, () => randomUUID()),
  ];
  const snapshot = {
    id: project.id,
    title: project.title,
    results: ids.map((id, i) => ({
      id,
      documentId: id,
      projectId: project.id,
      title: `画板 ${i + 1}`,
      type: "设计作品",
      persisted: true,
      position: { x: (i % 20) * 700, y: Math.floor(i / 20) * 900 },
    })),
    notes: [],
    sections: [],
    view: { x: 70, y: 100, zoom: 1 },
    messages: [],
    assets: [],
    attached: [],
    draft: "",
    selected: ids[0],
  };
  await tenantTransaction(workspace, async (tx: any) => {
    await tx.query(
      "INSERT INTO documents(id,workspace_id,project_id,kind,title,content) SELECT doc.id,$1,$2,'artboard',doc.title,$3::jsonb FROM jsonb_to_recordset($4::jsonb) AS doc(id text,title text)",
      [
        workspace,
        project.id,
        JSON.stringify(design),
        JSON.stringify(
          ids.slice(1).map((id, i) => ({ id, title: `画板 ${i + 2}` })),
        ),
      ],
    );
    await tx.query(
      "UPDATE documents SET content=$1 WHERE project_id=$2 AND kind='board'",
      [JSON.stringify(snapshot), project.id],
    );
  });
  const report: any = {
    environment: {
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      transport: "Fastify.inject → real PostgreSQL; no simulated services",
      warmup: 2,
      samples: 10,
    },
    fixture: {
      artboards: 200,
      nodes: 10000,
      designBytes: Buffer.byteLength(JSON.stringify(design)),
      boardBodyBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    },
    measurements: [],
  };
  async function measure(label: string, operation: () => Promise<any>) {
    const samples: any[] = [];
    for (let i = 0; i < 12; i++) {
      capture = [];
      const begin = performance.now();
      const response = await operation();
      const elapsed = performance.now() - begin;
      const queries = capture;
      capture = null;
      if (response.statusCode !== 200) throw Error(response.body);
      if (i >= 2)
        samples.push({
          ms: elapsed,
          queries: queries.length,
          bytes: response.rawPayload.length,
          selectDesign: queries.filter((s: string) =>
            s.includes("SELECT * FROM documents WHERE id="),
          ).length,
        });
    }
    const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
    report.measurements.push({
      label,
      p50Ms: Math.round(sorted[4] * 100) / 100,
      p95Ms: Math.round(sorted[9] * 100) / 100,
      queryCount: samples[0].queries,
      responseBytes: samples[0].bytes,
      perArtboardSelects: samples[0].selectDesign,
    });
  }
  await measure("GET studio full", () =>
    req("GET", `/projects/${project.id}/studio`),
  );
  let revision = 1,
    move = 0;
  await measure("PUT studio legacy", () =>
    req("PUT", `/projects/${project.id}/studio`, {
      snapshot: {
        ...snapshot,
        results: snapshot.results.map((r: any, i: number) =>
          i ? r : { ...r, position: { x: ++move, y: 0 } },
        ),
      },
      baseRevision: revision++,
    }),
  );
  if (process.argv.includes("--optimized"))
    await measure("PUT studio ack", () =>
      req("PUT", `/projects/${project.id}/studio?response=ack`, {
        snapshot: {
          ...snapshot,
          results: snapshot.results.map((r: any, i: number) =>
            i ? r : { ...r, position: { x: ++move, y: 0 } },
          ),
        },
        baseRevision: revision++,
      }),
    );
  await measure("GET single project full", () =>
    req("GET", `/projects/${project.id}`),
  );
  await measure("GET projects 1 project full", () => req("GET", "/projects"));
  const extra = Array.from({ length: 199 }, () => ({
    id: randomUUID(),
    document: randomUUID(),
  }));
  await tenantTransaction(workspace, async (tx: any) => {
    await tx.query(
      "INSERT INTO projects(id,workspace_id,title,primary_artboard_id) SELECT p.id,$1,'额外项目',p.document FROM jsonb_to_recordset($2::jsonb) AS p(id text,document text)",
      [workspace, JSON.stringify(extra)],
    );
    await tx.query(
      "INSERT INTO documents(id,workspace_id,project_id,kind,title,content) SELECT p.document,$1,p.id,'artboard','额外画板',$2::jsonb FROM jsonb_to_recordset($3::jsonb) AS p(id text,document text)",
      [workspace, JSON.stringify(design), JSON.stringify(extra)],
    );
  });
  await measure("GET projects 200 projects full", () =>
    req("GET", "/projects"),
  );
  if (process.argv.includes("--optimized")) {
    await measure("GET single project metadata", () =>
      req("GET", `/projects/${project.id}?view=metadata`),
    );
    await measure("GET projects 200 projects metadata", () =>
      req("GET", "/projects?view=metadata"),
    );
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  capture = null;
  if (app) await app.close();
  await stopQueue();
  await pool.end();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      Number(
        (
          await admin.query(
            "SELECT count(*) FROM pg_stat_activity WHERE datname=$1",
            [name],
          )
        ).rows[0].count,
      ) === 0
    )
      break;
    await delay(50);
  }
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
}
