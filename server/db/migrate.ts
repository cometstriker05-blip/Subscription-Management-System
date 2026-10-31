import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_LOCK = 4_2_4_2_0;

export async function migrate(dir = process.env.MIGRATIONS_DIR ?? join(here, 'migrations')) {
  const client = await pool.connect();
  try {
    // A server and a seed job can start together, so only one may migrate at a time.
    await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('  migrated', file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('db/migrate.ts') || process.argv[1]?.endsWith('db/migrate.js')) {
  await migrate();
  await pool.end();
}
