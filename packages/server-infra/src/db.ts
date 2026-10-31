import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from './config.js';
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 12 });
export const database = drizzle(pool);
export type Tx = pg.PoolClient;
export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally { tx.release(); }
}
export async function tenantTransaction<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async tx => {
    await tx.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    await tx.query('SET LOCAL ROLE designx_tenant');
    return fn(tx);
  });
}
