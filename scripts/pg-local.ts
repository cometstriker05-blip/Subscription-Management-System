// Boots a real PostgreSQL 17 for local development, with no Docker or system install.
// The data directory lives outside OneDrive: a synced data dir corrupts Postgres.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LOCAL_PG = {
  port: Number(process.env.KEEL_PG_PORT ?? 54329),
  user: 'keel',
  password: 'keel-local-only',
  database: 'keel',
  dataDir: process.env.KEEL_PG_DIR ?? join(homedir(), '.keel', 'pgdata'),
};

export const LOCAL_DATABASE_URL = `postgres://${LOCAL_PG.user}:${LOCAL_PG.password}@127.0.0.1:${LOCAL_PG.port}/${LOCAL_PG.database}`;

export async function startLocalPostgres(opts: { quiet?: boolean } = {}) {
  const fresh = !existsSync(join(LOCAL_PG.dataDir, 'PG_VERSION'));
  if (!fresh) {
    // A previous crash can leave a stale pid file behind, which blocks startup.
    const pid = join(LOCAL_PG.dataDir, 'postmaster.pid');
    if (existsSync(pid)) rmSync(pid, { force: true });
  }

  const pg = new EmbeddedPostgres({
    databaseDir: LOCAL_PG.dataDir,
    user: LOCAL_PG.user,
    password: LOCAL_PG.password,
    port: LOCAL_PG.port,
    persistent: true,
    // Windows defaults to WIN1252, which cannot store the rupee sign.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'max_connections=120', '-c', 'shared_buffers=512MB', '-c', 'work_mem=32MB', '-c', 'synchronous_commit=off'],
    onLog: opts.quiet ? () => {} : (message: unknown) => console.log(String(message).trim()),
    onError: (message: unknown) => console.error('[postgres]', message),
  });

  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase(LOCAL_PG.database);
  return pg;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/pg-local.ts')) {
  const pg = await startLocalPostgres();
  console.log(`\n  PostgreSQL ready at ${LOCAL_DATABASE_URL}\n  Data: ${LOCAL_PG.dataDir}\n`);
  const shutdown = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
