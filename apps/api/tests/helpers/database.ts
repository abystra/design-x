import { setTimeout as delay } from 'node:timers/promises';
import type { Client } from 'pg';

/** Call after the test's workers, application, queue and pool have closed. */
export async function disposeTestDatabase(admin: Client, databaseName: string) {
  try {
    if (!/^designx_[a-z_]+_[a-f0-9]{32}$/.test(databaseName)) {
      throw new Error(`Refusing to drop a non-fixture database: ${databaseName}`);
    }
    // pg-pool can resolve end() before its clients' socket-close callbacks run.
    // Observe backend shutdown rather than using DROP ... FORCE, which can emit
    // asynchronous client errors after the test has ended and conceal leaks.
    const deadline = Date.now() + 5000;
    while (true) {
      const { rows } = await admin.query(
        'SELECT pid, application_name, state FROM pg_stat_activity WHERE datname=$1',
        [databaseName],
      );
      if (!rows.length) break;
      if (Date.now() >= deadline) {
        throw new Error(`Test database connections did not close (${databaseName}): ${JSON.stringify(rows)}`);
      }
      await delay(50);
    }
    await admin.query(`DROP DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
}
