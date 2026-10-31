import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import { setTimeout as delay } from "node:timers/promises";
import type { AiRuntime } from "../../worker/src/ai-turn.js";

// Real isolated PG/S3, with an explicitly injected local sandbox adapter: no paid calls.
const adminUrl =
  process.env.DATABASE_URL ||
  "postgres://designx:designx-local-only@127.0.0.1:55432/designx";
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const databaseName = `designx_ai_test_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE DATABASE "${databaseName}"`);
const isolated = new URL(adminUrl);
isolated.pathname = `/${databaseName}`;
process.env.DATABASE_URL = isolated.toString();
const { migrate } = await import("../../../db/migrate.js");
const { pool, tenantTransaction } =
  await import("../../../packages/server-infra/src/db.js");
const { stopQueue, queuePolicy } =
  await import("../../../packages/server-infra/src/queue.js");
const { buildApp } = await import("../src/server.js");
const { runBusinessJob } = await import("../../worker/src/process.js");
const { runAiTurn, reconcileAiAttempts } =
  await import("../../worker/src/ai-turn.js");
const { putObject, deleteObject } =
  await import("../../../packages/server-infra/src/storage.js");
await migrate();
const app = await buildApp({ logger: false, aiEnabled: true });
const actors: any[] = [];
const keys: string[] = [];
for (let index = 0; index < 2; index++) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      email: `ai-${randomUUID()}@example.test`,
      password: "ai-integration-password",
      name: "AI Tester",
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  actors.push({
    ...response.json(),
    cookie: String(response.headers["set-cookie"]).split(";")[0],
  });
}
let fixtureClient = 0;
test.beforeEach(() => {
  fixtureClient++;
});
const req = (
  method: string,
  url: string,
  payload?: any,
  actor = 0,
  headers: any = {},
) =>
  app.inject({
    method: method as any,
    url: `/api${url}`,
    payload,
    remoteAddress: `192.0.2.${fixtureClient}`,
    headers: {
      origin: "http://127.0.0.1:5173",
      cookie: actors[actor].cookie,
      ...headers,
    },
  });
const design = {
  width: 600,
  height: 800,
  background: "#ffffff",
  nodes: [
    {
      id: "title",
      type: "text",
      x: 40,
      y: 40,
      w: 500,
      h: 100,
      text: "AI 可编辑文字",
      size: 32,
      color: "#222222",
    },
  ],
};
const project = async () => {
  const response = await req("POST", "/projects", {
    title: "AI fixture",
    design,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
};
const start = (
  projectId: string,
  body: any = {},
  actor = 0,
  key = randomUUID(),
) =>
  req(
    "POST",
    `/projects/${projectId}/ai-turns`,
    { prompt: "制作清晰中文海报", ...body },
    actor,
    { "idempotency-key": key },
  );
const turn = (id: string) =>
  req("GET", `/ai-turns/${id}`).then((response) => response.json());
const job = (id: string) =>
  req("GET", `/jobs/${id}`).then((response) => response.json());
const board = (id: string) =>
  req("GET", `/projects/${id}/studio`).then((response) => response.json());
function fixtureRuntime(
  transform?: (manifest: any, input: any) => Promise<any> | any,
  onInput?: (input: any) => Promise<void>,
): AiRuntime {
  return {
    killSandbox: async () => {},
    findSandboxesForExecution: async () => [],
    runSandboxTurn: async (input) => {
      await input.onSandbox?.(`fixture-${randomUUID()}`);
      await input.onProgress?.({ stage: "running" });
      await onInput?.(input);
      const manifest = {
        version: 1,
        summary: "已完成真实领域提交测试",
        artboards: Array.from(
          { length: (input.context as any).count },
          (_, index) => ({
            title: `提案 ${index + 1}`,
            design: {
              ...structuredClone(design),
              nodes: [{ ...design.nodes[0], text: `方案 ${index + 1}` }],
            },
          }),
        ),
      };
      await input.onProgress?.({
        stage: "validating",
        threadId: "thread-local-fixture",
      });
      return {
        manifest: transform ? await transform(manifest, input) : manifest,
        runtime: {
          sandboxId: "fixture-sandbox",
          threadId: "thread-local-fixture",
          model: "local-test-adapter",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      };
    },
  };
}
async function execute(id: string, runtime = fixtureRuntime()) {
  const current = (await pool.query("SELECT * FROM jobs WHERE id=$1", [id]))
    .rows[0];
  return runBusinessJob(
    {
      id: current.queue_id,
      data: { jobId: id, workspaceId: current.workspace_id },
    },
    (active) => runAiTurn(active, runtime),
  );
}
test.after(async () => {
  await app.close();
  await stopQueue();
  for (const key of keys) await deleteObject(key).catch(() => {});
  await pool.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

test("turn submission is durable, idempotent, tenant isolated and uses a bounded non-repeating AI queue", async () => {
  const p = await project(),
    key = randomUUID();
  const response = await start(p.id, { count: 3 }, 0, key);
  assert.equal(response.statusCode, 202, response.body);
  const created = response.json();
  assert.equal((await start(p.id, { count: 3 }, 0, key)).json().id, created.id);
  assert.equal(
    (await start(p.id, { prompt: "different" }, 0, key)).statusCode,
    409,
  );
  assert.equal((await start(p.id, {}, 1)).statusCode, 404);
  assert.equal(
    (await req("GET", `/ai-turns/${created.id}`, undefined, 1)).statusCode,
    404,
  );
  assert.equal(
    (await req("GET", `/projects/${p.id}/ai-turns`, undefined, 1)).statusCode,
    404,
  );
  assert.equal(
    (await req("POST", `/jobs/${created.id}/cancel`, {}, 1)).statusCode,
    404,
  );
  assert.equal(
    (await req("POST", `/projects/${p.id}/ai-turns`, { prompt: "missing key" }))
      .statusCode,
    400,
  );
  assert.equal((await start(p.id, { count: 4 })).statusCode, 400);
  assert.equal(
    (
      await start(p.id, {
        mode: "revise",
        targetDocumentId: p.id,
        baseRevision: 1,
      })
    ).statusCode,
    404,
  );
  const queue = (
    await pool.query(
      "SELECT name,retry_limit,expire_seconds FROM pgboss.job WHERE id=(SELECT queue_id::uuid FROM jobs WHERE id=$1)",
      [created.id],
    )
  ).rows[0];
  assert.equal(queue.name, "ai.turn");
  assert.equal(queue.retry_limit, 0);
  assert.ok(queue.expire_seconds >= 600);
  assert.equal(queuePolicy("ai.turn").retryLimit, 0);
  assert.equal((await turn(created.id)).status, "queued");
});

test("ratio reaches the immutable context and idempotent responses do not bypass project deletion", async () => {
  const p = await project(),
    key = randomUUID();
  const created = await start(p.id, { ratio: "3:4" }, 0, key);
  assert.equal(created.statusCode, 202, created.body);
  const stored = (
    await pool.query("SELECT context FROM ai_turns WHERE id=$1", [
      created.json().id,
    ])
  ).rows[0];
  assert.equal(stored.context.ratio, "3:4");
  assert.equal((await start(p.id, { ratio: "invalid" })).statusCode, 400);
  await req("DELETE", `/projects/${p.id}`);
  assert.equal((await start(p.id, { ratio: "3:4" }, 0, key)).statusCode, 404);
  assert.equal(
    (await req("GET", `/ai-turns/${created.json().id}`)).statusCode,
    404,
  );
});

test("create commits all Artboards, versions, Board ops and successful job together; replay adds nothing", async () => {
  const p = await project(),
    before = await board(p.id),
    response = await start(p.id, { count: 3 });
  const id = response.json().id;
  await execute(id);
  const completed = await turn(id),
    after = await board(p.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.artboardIds.length, 3);
  assert.equal(after.snapshot.results.length, 4);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(completed.boardRevision, after.revision);
  assert.equal(completed.proposals.length, 3);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM document_versions WHERE document_id=ANY($1::text[])",
        [completed.artboardIds],
      )
    ).rows[0].n,
    3,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM document_ops o JOIN documents d ON d.id=o.document_id WHERE d.project_id=$1 AND d.kind='board'",
        [p.id],
      )
    ).rows[0].n,
    1,
  );
  await execute(id);
  assert.deepEqual(await board(p.id), after);
  const listed = (await req("GET", `/projects/${p.id}/ai-turns`)).json();
  assert.equal(listed[0].proposals[0].design, undefined);
  assert.equal((await job(id)).result.turnId, id);
  assert.equal((await job(id)).downloadUrl, null);
});

test("create appends to current Board without replacing notes or newer organization", async () => {
  const p = await project(),
    id = (await start(p.id)).json().id;
  await execute(
    id,
    fixtureRuntime(undefined, async () => {
      const current = await board(p.id);
      current.snapshot.results[0].position = { x: 987, y: 654 };
      current.snapshot.notes = [
        {
          id: "note-during-ai",
          text: "创作时的本地保存",
          position: { x: 20, y: 40 },
          width: 240,
          height: 180,
          color: "#fff2c6",
        },
      ];
      assert.equal(
        (
          await req("PUT", `/projects/${p.id}/studio`, {
            snapshot: current.snapshot,
            baseRevision: current.revision,
          })
        ).statusCode,
        200,
      );
    }),
  );
  const after = await board(p.id);
  assert.deepEqual(after.snapshot.results[0].position, { x: 987, y: 654 });
  assert.equal(after.snapshot.notes[0].id, "note-during-ai");
  assert.equal(after.snapshot.results.length, 2);
});

test("Board saving waits for the project lock before locking its document", async () => {
  const p = await project(),
    current = await board(p.id),
    client = new pg.Client({ connectionString: isolated.toString() });
  await client.connect();
  let saving: Promise<any> | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
      p.id,
    ]);
    saving = req("PUT", `/projects/${p.id}/studio?response=ack`, {
      snapshot: current.snapshot,
      baseRevision: current.revision,
    }).then((value) => value);
    let waiting = false;
    for (let index = 0; index < 100; index++) {
      waiting =
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
          )
        ).rowCount! > 0;
      if (waiting) break;
      await delay(10);
    }
    assert.equal(
      waiting,
      true,
      "the concurrent save reached its database lock",
    );
    await client.query("SET LOCAL lock_timeout='500ms'");
    await client.query(
      "SELECT id FROM documents WHERE project_id=$1 AND kind='board' FOR UPDATE",
      [p.id],
    );
    await client.query("COMMIT");
    assert.equal((await saving).statusCode, 200);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
    await saving;
  }
});

test("concurrent manual editing and proposal apply have one winner without a deadlock", async () => {
  const p = await project(),
    id = (
      await start(p.id, {
        mode: "revise",
        targetDocumentId: p.documentId,
        baseRevision: 1,
      })
    ).json().id;
  await execute(id);
  const proposal = (await turn(id)).proposals[0];
  const responses = await Promise.all([
    req(
      "POST",
      `/ai-turns/${id}/apply`,
      { proposalId: proposal.id, baseRevision: 1 },
      0,
      { "idempotency-key": randomUUID() },
    ),
    req("PATCH", `/projects/${p.id}/artboards/${p.documentId}`, {
      design: { ...design, background: "#abcdef" },
      baseRevision: 1,
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(
    (await req("GET", `/documents/${p.documentId}`)).json().revision,
    2,
  );
});

test("revise proposals preserve original until apply; selection/replay work and external edits conflict", async () => {
  const p = await project(),
    id = (
      await start(p.id, {
        mode: "revise",
        targetDocumentId: p.documentId,
        baseRevision: 1,
        count: 2,
      })
    ).json().id;
  await execute(id);
  const proposal = await turn(id);
  assert.equal(
    (await req("GET", `/documents/${p.documentId}`)).json().revision,
    1,
  );
  const apply = (
    proposalId: string,
    baseRevision: number,
    key = randomUUID(),
    actor = 0,
  ) =>
    req("POST", `/ai-turns/${id}/apply`, { proposalId, baseRevision }, actor, {
      "idempotency-key": key,
    });
  assert.equal(
    (await apply(proposal.proposals[0].id, 1, randomUUID(), 1)).statusCode,
    404,
  );
  const key = randomUUID(),
    first = await apply(proposal.proposals[0].id, 1, key);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().artboard.revision, 2);
  assert.equal(
    (await apply(proposal.proposals[0].id, 1, key)).json().artboard.revision,
    2,
  );
  const second = await apply(proposal.proposals[1].id, 2);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().artboard.revision, 3);
  assert.equal(
    (
      await req("PATCH", `/projects/${p.id}/artboards/${p.documentId}`, {
        design: { ...design, background: "#abcdef" },
        baseRevision: 3,
      })
    ).statusCode,
    200,
  );
  assert.equal((await apply(proposal.proposals[0].id, 4)).statusCode, 409);
  assert.equal(
    (await req("GET", `/documents/${p.documentId}`)).json().content.background,
    "#abcdef",
  );
  assert.equal((await turn(id)).proposals.length, 2);
});

test("late cancellation and deleted projects reject artifacts without partial rows", async () => {
  for (const remove of [false, true]) {
    const p = await project(),
      id = (await start(p.id)).json().id;
    await assert.rejects(
      execute(
        id,
        fixtureRuntime(async (manifest) => {
          if (remove) await req("DELETE", `/projects/${p.id}`);
          else await req("POST", `/jobs/${id}/cancel`, {});
          return manifest;
        }),
      ),
    );
    assert.equal(
      (await pool.query("SELECT status FROM jobs WHERE id=$1", [id])).rows[0]
        .status,
      "cancelled",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM documents WHERE project_id=$1 AND kind='artboard'",
          [p.id],
        )
      ).rows[0].n,
      1,
    );
  }
});

test("old execution is fenced after a newer delivery commits", async () => {
  const p = await project(),
    id = (await start(p.id)).json().id;
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (ready = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const stale = execute(
    id,
    fixtureRuntime(async (manifest) => {
      ready();
      await gate;
      return manifest;
    }),
  );
  await entered;
  await execute(id);
  release();
  await assert.rejects(stale);
  assert.equal((await turn(id)).status, "succeeded");
  assert.equal((await board(p.id)).snapshot.results.length, 2);
});

test("running cancellation aborts the long sandbox call and queued cancellation never starts one", async () => {
  const p = await project(),
    id = (await start(p.id)).json().id;
  let ready!: () => void,
    killed = false;
  const entered = new Promise<void>((resolve) => (ready = resolve));
  const runtime: AiRuntime = {
    findSandboxesForExecution: async () => [],
    killSandbox: async () => {
      killed = true;
    },
    runSandboxTurn: async (input) => {
      await input.onSandbox?.("fixture-abort-sandbox");
      ready();
      await new Promise<void>((_, reject) =>
        input.signal!.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
      throw new Error("unreachable");
    },
  };
  const running = execute(id, runtime);
  await entered;
  await req("POST", `/jobs/${id}/cancel`, {});
  await assert.rejects(running);
  assert.equal(killed, true);
  assert.equal((await job(id)).status, "cancelled");
  assert.equal((await board(p.id)).snapshot.results.length, 1);
  const queued = (await start(p.id)).json().id;
  await req("POST", `/jobs/${queued}/cancel`, {});
  let called = false;
  await execute(queued, {
    ...fixtureRuntime(),
    runSandboxTurn: async () => {
      called = true;
      throw new Error("must not run");
    },
  });
  assert.equal(called, false);
});

test("an expired execution cannot commit even if the local abort timer has not fired", async () => {
  const p = await project(),
    id = (await start(p.id)).json().id;
  await assert.rejects(
    execute(
      id,
      fixtureRuntime(async (manifest) => {
        await pool.query(
          "UPDATE ai_attempts SET deadline_at=now()-interval '1 second' WHERE turn_id=$1",
          [id],
        );
        return manifest;
      }),
    ),
  );
  assert.equal((await job(id)).status, "failed");
  assert.equal((await board(p.id)).snapshot.results.length, 1);
});

test("invalid external resources and malformed manifests fail without creating a half-result", async () => {
  const mutations = [
    (m: any) => ({ ...m, version: 2 }),
    (m: any) => ({
      ...m,
      artboards: [
        {
          ...m.artboards[0],
          design: {
            ...design,
            nodes: [
              {
                id: "bad",
                type: "image",
                x: 0,
                y: 0,
                w: 10,
                h: 10,
                src: "https://example.invalid/pixel.png",
              },
            ],
          },
        },
      ],
    }),
    (m: any) => ({
      ...m,
      artboards: [
        {
          ...m.artboards[0],
          design: {
            ...design,
            background: "url(https://example.invalid/pixel.png)",
          },
        },
      ],
    }),
  ];
  for (const mutate of mutations) {
    const p = await project(),
      id = (await start(p.id)).json().id;
    await assert.rejects(execute(id, fixtureRuntime(mutate)));
    assert.equal((await turn(id)).status, "failed");
    assert.equal((await board(p.id)).snapshot.results.length, 1);
  }
});

test("SQL failure rolls back artifacts, Board revision, events and successful status", async () => {
  const p = await project(),
    id = (await start(p.id, { count: 2 })).json().id,
    before = await board(p.id);
  await pool.query(
    "ALTER TABLE documents ADD CONSTRAINT ai_fixture_reject CHECK(title <> 'reject-fixture')",
  );
  try {
    await assert.rejects(
      execute(
        id,
        fixtureRuntime((manifest) => {
          manifest.artboards[1].title = "reject-fixture";
          return manifest;
        }),
      ),
    );
  } finally {
    await pool.query("ALTER TABLE documents DROP CONSTRAINT ai_fixture_reject");
  }
  assert.deepEqual(await board(p.id), before);
  assert.equal((await turn(id)).status, "failed");
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM events WHERE type='artboard.created' AND payload->>'turnId'=$1",
        [id],
      )
    ).rows[0].n,
    0,
  );
});

test("authorized private image bytes reach the adapter and unrelated tenant resources are rejected", async () => {
  const p = await project(),
    own = randomUUID(),
    foreign = randomUUID();
  const bytes = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "#447766" },
  })
    .png()
    .toBuffer();
  for (const [assetId, actor] of [
    [own, 0],
    [foreign, 1],
  ] as const) {
    const key = `${actors[actor].workspace.id}/ai-fixture/${assetId}.png`;
    keys.push(key);
    await putObject(key, bytes, "image/png");
    await tenantTransaction(actors[actor].workspace.id, (tx) =>
      tx.query(
        "INSERT INTO assets(id,workspace_id,title,mime,bytes,width,height,object_key,status) VALUES($1,$2,'reference','image/png',$3,64,48,$4,'ready')",
        [assetId, actors[actor].workspace.id, bytes.length, key],
      ),
    );
  }
  assert.equal((await start(p.id, { assetIds: [foreign] })).statusCode, 400);
  const id = (await start(p.id, { assetIds: [own] })).json().id;
  let seen = false;
  await execute(
    id,
    fixtureRuntime((manifest, input) => {
      seen = true;
      assert.equal(input.images.length, 1);
      assert.ok(input.images[0].bytes.byteLength > 0);
      manifest.artboards[0].design.nodes.push({
        id: "image",
        type: "image",
        x: 0,
        y: 120,
        w: 300,
        h: 200,
        src: `/api/assets/${own}/file`,
      });
      return manifest;
    }),
  );
  assert.equal(seen, true);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM asset_refs WHERE asset_id=$1",
        [own],
      )
    ).rows[0].n,
    1,
  );
});

test("manual retry receives a fresh queue identity and retains non-repeating AI policy", async () => {
  const p = await project(),
    id = (await start(p.id)).json().id;
  await assert.rejects(
    execute(id, {
      ...fixtureRuntime(),
      runSandboxTurn: async () => {
        throw new Error("provider-private-diagnostic");
      },
    }),
  );
  assert.doesNotMatch((await turn(id)).error, /provider-private/);
  const prior = (
    await pool.query("SELECT queue_id FROM jobs WHERE id=$1", [id])
  ).rows[0].queue_id;
  const retry = await req("POST", `/jobs/${id}/retry`, {});
  assert.equal(retry.statusCode, 200, retry.body);
  const next = (await pool.query("SELECT queue_id FROM jobs WHERE id=$1", [id]))
    .rows[0].queue_id;
  assert.notEqual(next, prior);
  assert.equal(
    (await pool.query("SELECT retry_limit FROM pgboss.job WHERE id=$1", [next]))
      .rows[0].retry_limit,
    0,
  );
  await execute(id);
  assert.equal((await turn(id)).status, "succeeded");
});

test("expired sandbox attempts are reconciled and failed cleanup remains durable for retry", async () => {
  const p = await project(),
    id = (await start(p.id)).json().id,
    token = randomUUID();
  await pool.query(
    "UPDATE jobs SET status='running',execution_token=$1 WHERE id=$2",
    [token, id],
  );
  await pool.query(
    "INSERT INTO ai_attempts(id,workspace_id,turn_id,queue_id,sandbox_id,deadline_at) SELECT $1,workspace_id,id,queue_id,'sandbox-orphan',now()-interval '1 minute' FROM jobs WHERE id=$2",
    [token, id],
  );
  await reconcileAiAttempts({
    ...fixtureRuntime(),
    killSandbox: async () => {
      throw new Error("temporary");
    },
  });
  assert.equal((await job(id)).status, "failed");
  assert.equal(
    (await pool.query("SELECT status FROM ai_attempts WHERE id=$1", [token]))
      .rows[0].status,
    "cleanup_failed",
  );
  await reconcileAiAttempts(fixtureRuntime());
  assert.equal(
    (await pool.query("SELECT status FROM ai_attempts WHERE id=$1", [token]))
      .rows[0].status,
    "closed",
  );
});

test("lost sandbox create responses remain discoverable and cleanup is retried until conclusive", async () => {
  const p = await project(),
    id = (await start(p.id)).json().id,
    token = randomUUID();
  await pool.query(
    "UPDATE jobs SET status='failed',execution_token=$1 WHERE id=$2",
    [token, id],
  );
  await pool.query(
    "INSERT INTO ai_attempts(id,workspace_id,turn_id,queue_id,deadline_at) SELECT $1,workspace_id,id,queue_id,now()+interval '5 minutes' FROM jobs WHERE id=$2",
    [token, id],
  );
  const read = async () =>
    (
      await pool.query(
        "SELECT status,sandbox_id FROM ai_attempts WHERE id=$1",
        [token],
      )
    ).rows[0];
  let lookupToken = "";
  const emptyLookup = {
    ...fixtureRuntime(),
    findSandboxesForExecution: async (executionKey: string) => {
      lookupToken = executionKey;
      return [];
    },
  };
  await reconcileAiAttempts(emptyLookup);
  assert.equal(lookupToken, token);
  assert.equal(
    (await read()).status,
    "active",
    "an in-flight create may still appear",
  );
  await reconcileAiAttempts({
    ...fixtureRuntime(),
    findSandboxesForExecution: async () => {
      throw new Error("temporary lookup failure");
    },
  });
  assert.equal((await read()).status, "cleanup_failed");
  const killed: string[] = [];
  await reconcileAiAttempts({
    ...fixtureRuntime(),
    findSandboxesForExecution: async (key) =>
      key === token ? ["discovered-orphan", "discovered-orphan"] : [],
    killSandbox: async (sandboxId) => {
      killed.push(sandboxId);
    },
  });
  assert.deepEqual(killed, ["discovered-orphan"]);
  assert.equal((await read()).status, "closed");
  assert.equal((await read()).sandbox_id, "discovered-orphan");
  const expired = (await start(p.id)).json().id,
    expiredToken = randomUUID();
  await pool.query(
    "UPDATE jobs SET status='failed',execution_token=$1 WHERE id=$2",
    [expiredToken, expired],
  );
  await pool.query(
    "INSERT INTO ai_attempts(id,workspace_id,turn_id,queue_id,deadline_at) SELECT $1,workspace_id,id,queue_id,now()-interval '1 second' FROM jobs WHERE id=$2",
    [expiredToken, expired],
  );
  await reconcileAiAttempts(fixtureRuntime());
  assert.equal(
    (
      await pool.query("SELECT status FROM ai_attempts WHERE id=$1", [
        expiredToken,
      ])
    ).rows[0].status,
    "closed",
  );
});

test("a sandbox identified after empty deadline reconciliation is reopened for cleanup", async () => {
  const p = await project(),
    id = (await start(p.id)).json().id;
  let ready!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (ready = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const killed: string[] = [];
  const runtime: AiRuntime = {
    ...fixtureRuntime(),
    killSandbox: async (sandboxId) => {
      killed.push(sandboxId);
    },
    runSandboxTurn: async (input) => {
      ready();
      await gate;
      await input.onSandbox?.("late-after-deadline");
      throw new Error("late call cannot succeed");
    },
  };
  const running = execute(id, runtime);
  await entered;
  await pool.query(
    "UPDATE ai_attempts SET deadline_at=now()-interval '1 second' WHERE turn_id=$1",
    [id],
  );
  await reconcileAiAttempts(fixtureRuntime());
  assert.equal(
    (await pool.query("SELECT status FROM ai_attempts WHERE turn_id=$1", [id]))
      .rows[0].status,
    "closed",
  );
  release();
  await assert.rejects(running);
  assert.deepEqual(killed, ["late-after-deadline"]);
  assert.equal(
    (await pool.query("SELECT status FROM ai_attempts WHERE turn_id=$1", [id]))
      .rows[0].status,
    "closed",
  );
  assert.equal((await board(p.id)).snapshot.results.length, 1);
});

test("committed AI events replay through the actual authenticated SSE endpoint", async () => {
  const p = await project(),
    cursor = (await pool.query("SELECT COALESCE(max(id),0) AS id FROM events"))
      .rows[0].id,
    id = (await start(p.id)).json().id;
  await execute(id);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${address}/api/events?since=${cursor}`, {
      headers: { cookie: actors[0].cookie },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes('"status":"succeeded"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    assert.match(text, /event: artboard.created/);
    assert.match(text, /event: board.committed/);
    assert.ok(text.includes(id));
    controller.abort();
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
});
