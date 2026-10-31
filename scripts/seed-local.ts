// Starts local Postgres, seeds it and stops again. Pass --customers=500 for a quick world.
import { startLocalPostgres } from './pg-local.ts';

const server = await startLocalPostgres({ quiet: true });
const { seed } = await import('../server/db/seed.ts');
const { pool } = await import('../server/db/pool.ts');
try {
  console.log(await seed());
} finally {
  await pool.end();
  await server.stop();
}
process.exit(0);
