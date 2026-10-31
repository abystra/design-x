import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool, transaction } from '../packages/server-infra/src/db.js';
export async function migrate() {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
  for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
    await transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(774923)');
      if ((await tx.query('SELECT 1 FROM schema_migrations WHERE name=$1',[name])).rowCount) return;
      await tx.query(await readFile(`${directory}/${name}`,'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);
      console.log(`Applied ${name}`);
    });
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => pool.end()).catch(async error => { console.error(error); await pool.end(); process.exitCode=1; });
}
