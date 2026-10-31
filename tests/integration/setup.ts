// Runs against a real Postgres, because the guarantees under test live in the database.
import { homedir } from 'node:os';
import { join } from 'node:path';

export default async function setup() {
  process.env.KEEL_PG_PORT = '54330';
  process.env.KEEL_PG_DIR = join(homedir(), '.keel', 'pgtest');
  process.env.DATABASE_URL = 'postgres://keel:keel-local-only@127.0.0.1:54330/keel';
  process.env.KEEL_SEED_CUSTOMERS = '400';

  const { startLocalPostgres } = await import('../../scripts/pg-local.ts');
  const server = await startLocalPostgres({ quiet: true });
  const { seed } = await import('../../server/db/seed.ts');
  const { pool } = await import('../../server/db/pool.ts');
  await seed();
  await pool.end();
  return async () => {
    await server.stop();
  };
}
