/** Read-only verification against the private snapshot taken before cutover. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, transaction } from '../packages/server-infra/src/db.js';

const directory = 'artifacts/v2/cutover';
const before = JSON.parse(await readFile(`${directory}/data-before.json`, 'utf8'));
const exclusions: string[] = JSON.parse(await readFile(`${directory}/preexisting-missing-asset-ids.json`, 'utf8'));
const sourceAudit = JSON.parse(await readFile(`${directory}/source-reference-audit.json`, 'utf8'));
const activeMissingIds = [...new Set<string>(sourceAudit.missing.filter((row: { kind: string; deleted: boolean }) => row.kind === 'asset' && !row.deleted).map((row: { id: string }) => row.id))].sort();
const protectedTables = ['projects', 'documents', 'document_versions', 'asset_versions', 'ai_turns'];
try {
  const report = await transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables: Record<string, { preserved: number; current: number }> = {};
    for (const table of protectedTables) {
      const rows = (await tx.query(`SELECT id,md5(to_jsonb(t)::text) AS hash FROM ${table} t ORDER BY id`)).rows;
      const current = new Map(rows.map(row => [row.id, row.hash]));
      assert.ok(Array.isArray(before.hashes[table]), `Missing baseline for ${table}`);
      for (const row of before.hashes[table]) {
        assert.equal(current.get(row.id), row.hash, `Original ${table} row changed or disappeared: ${row.id}`);
      }
      tables[table] = { preserved: before.hashes[table].length, current: rows.length };
    }
    const unversioned = (await tx.query("SELECT id FROM assets WHERE status='ready' AND deleted_at IS NULL AND current_version_id IS NULL ORDER BY id")).rows.map(row => row.id);
    assert.deepEqual(unversioned, activeMissingIds, 'Only explicitly audited pre-existing missing test assets may remain unversioned');
    const preservedMissing = (await tx.query('SELECT id FROM assets WHERE id=ANY($1::text[]) ORDER BY id', [exclusions])).rows.map(row => row.id);
    assert.deepEqual(preservedMissing, [...exclusions].sort(), 'Preserve active and soft-deleted pre-existing missing asset records');
    const migrations = (await tx.query("SELECT status,count(*)::int AS count FROM storage_migrations GROUP BY status ORDER BY status")).rows;
    return { status: 'passed', at: new Date().toISOString(), tables, preservedMissingTestAssets: preservedMissing.length, activeMissingTestAssets: unversioned.length, migrations };
  });
  await writeFile(`${directory}/data-preservation.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally {
  await pool.end();
}
