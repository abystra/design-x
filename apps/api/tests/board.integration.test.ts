import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/server.js";
import { pool } from "../../../packages/server-infra/src/db.js";
import { stopQueue } from "../../../packages/server-infra/src/queue.js";
import { migrate } from "../../../db/migrate.js";
await migrate();
const app = await buildApp({ logger: false });
const cookies: string[] = [];
let project: any, board: any;
const req = (method: string, url: string, payload?: any, actor = 0) =>
  app.inject({
    method: method as any,
    url,
    payload,
    headers: { origin: "http://127.0.0.1:5173", cookie: cookies[actor] || "" },
  });
test.after(async () => {
  await app.close();
  await stopQueue();
  await pool.end();
});
test("notes and explicit section membership persist and retain authoritative Artboards", async () => {
  for (let i = 0; i < 2; i++) {
    const r = await req("POST", "/api/auth/register", {
      email: `board-${randomUUID()}@example.test`,
      password: "board-test-password",
      name: "Board tester",
    });
    assert.equal(r.statusCode, 201, r.body);
    cookies.push(String(r.headers["set-cookie"]).split(";")[0]);
  }
  project = (
    await req("POST", "/api/projects", { title: "Board annotations" })
  ).json();
  board = (await req("GET", `/api/projects/${project.id}/studio`)).json();
  board.snapshot.notes = [
    {
      id: "note-1",
      text: "中文想法\n第二行",
      position: { x: 700, y: 80 },
      width: 240,
      height: 180,
      color: "#FFF2C6",
    },
  ];
  board.snapshot.sections = [
    {
      id: "section-1",
      title: "第一套方案",
      position: { x: 40, y: 40 },
      width: 1000,
      height: 900,
      color: "#E9EFE8",
      itemIds: [project.documentId, "note-1"],
    },
  ];
  const saved = await req("PUT", `/api/projects/${project.id}/studio`, {
    snapshot: board.snapshot,
    baseRevision: board.revision,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  board = saved.json();
  const reopened = (
    await req("GET", `/api/projects/${project.id}/studio`)
  ).json();
  assert.deepEqual(reopened, board);
  assert.equal(board.snapshot.notes[0].text, "中文想法\n第二行");
  assert.deepEqual(board.snapshot.results[0].design, project.design);
});
test("invalid membership and stale Board writes roll back without losing any notes", async () => {
  for (const mutate of [
    (s: any) => s.sections[0].itemIds.push("missing"),
    (s: any) => s.notes.push(s.notes[0]),
    (s: any) => s.sections.push({ ...s.sections[0], id: "section-2" }),
    (s: any) => (s.notes[0].width = -20),
  ]) {
    const snapshot = structuredClone(board.snapshot);
    mutate(snapshot);
    const bad = await req("PUT", `/api/projects/${project.id}/studio`, {
      snapshot,
      baseRevision: board.revision,
    });
    assert.equal(bad.statusCode, 400, bad.body);
    assert.deepEqual(
      (await req("GET", `/api/projects/${project.id}/studio`)).json(),
      board,
    );
  }
  const stale = await req("PUT", `/api/projects/${project.id}/studio`, {
    snapshot: { ...board.snapshot, notes: [], sections: [] },
    baseRevision: board.revision - 1,
  });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(
    (await req("GET", `/api/projects/${project.id}/studio`)).json(),
    board,
  );
  assert.equal(
    (
      await req(
        "PUT",
        `/api/projects/${project.id}/studio`,
        { snapshot: board.snapshot, baseRevision: board.revision },
        1,
      )
    ).statusCode,
    404,
  );
});
test("removing a section retains its members and persists an inverse Board operation", async () => {
  const before = structuredClone(board.snapshot);
  const saved = await req("PUT", `/api/projects/${project.id}/studio`, {
    snapshot: { ...before, sections: [] },
    baseRevision: board.revision,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  board = saved.json();
  assert.equal(board.snapshot.notes.length, 1);
  assert.equal(board.snapshot.results.length, 1);
  const rows = (
    await pool.query(
      "SELECT o.* FROM document_ops o JOIN documents d ON d.id=o.document_id WHERE d.project_id=$1 AND d.kind='board' ORDER BY o.revision DESC",
      [project.id],
    )
  ).rows;
  assert.equal(rows[0].inverse_ops[0].content.sections[0].title, "第一套方案");
  const restored = await req("PUT", `/api/projects/${project.id}/studio`, {
    snapshot: before,
    baseRevision: board.revision,
  });
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json().snapshot.sections.length, 1);
});
test("new Artboard geometry is validated before the document or Board is changed", async () => {
  const before = (
    await req("GET", `/api/projects/${project.id}/studio`)
  ).json();
  const invalid = await req("POST", `/api/projects/${project.id}/artboards`, {
    position: { x: 100001, y: 0 },
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(
    (await req("GET", `/api/projects/${project.id}/studio`)).json(),
    before,
  );
});
