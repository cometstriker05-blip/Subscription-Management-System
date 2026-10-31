// The demo-day command. Runs the production build on real local Postgres, with no
// internet needed. `npm run demo:reset` puts Brightloop back to 31 Oct 2026 first.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { LOCAL_DATABASE_URL, startLocalPostgres } from './pg-local.ts';

// Optional settings such as GEMINI_API_KEY. The server inherits them from here.
if (existsSync('.env')) process.loadEnvFile('.env');

const PORT = process.env.PORT ?? '8080';
process.env.DATABASE_URL = LOCAL_DATABASE_URL;

if (!existsSync('dist/index.html') || !existsSync('dist-server/index.js')) {
  console.error('  Build first: npm run build');
  process.exit(1);
}

const pg = await startLocalPostgres({ quiet: true });
console.log('  Postgres ready');

const { pool, one } = await import('../server/db/pool.ts');
const { seed } = await import('../server/db/seed.ts');
const { migrate } = await import('../server/db/migrate.ts');

await migrate();
const seeded = await one(`SELECT 1 AS ok FROM app_state LIMIT 1`).catch(() => null);
if (process.argv.includes('--reset') || !seeded) {
  console.log('  Building the Brightloop world, about a minute...');
  await seed();
}
await pool.end();

let stopping = false;
let server: ReturnType<typeof spawn>;

// A demo must not depend on one process staying up, so the server restarts by itself.
function startServer() {
  server = spawn(process.execPath, ['--trace-uncaught', 'dist-server/index.js'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      PORT,
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
      MIGRATIONS_DIR: 'server/db/migrations',
      APP_URL: `http://localhost:${PORT}`,
    },
  });
  server.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`  Server exited (code ${code}, signal ${signal}). Restarting...`);
    setTimeout(startServer, 500);
  });
}

startServer();
console.log(`\n  Keel is running at http://localhost:${PORT}\n`);

const shutdown = async () => {
  stopping = true;
  server.kill();
  await pg.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
