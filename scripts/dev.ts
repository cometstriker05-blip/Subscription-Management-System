// One command for local work: Postgres, API with reload, and the Vite dev server.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_DATABASE_URL, startLocalPostgres } from './pg-local.ts';

// Optional settings such as GEMINI_API_KEY. Both servers inherit them from here.
if (existsSync('.env')) process.loadEnvFile('.env');

const API_PORT = process.env.KEEL_API_PORT ?? '8787';
const pg = await startLocalPostgres({ quiet: true });
console.log('  Postgres ready');

const bin = (...path: string[]) => join(process.cwd(), 'node_modules', ...path);

// Node is started directly, with stdin closed, so nothing can sit waiting on a prompt.
const run = (args: string[], env: Record<string, string>) =>
  spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } });

const children = [
  run([bin('tsx', 'dist', 'cli.mjs'), 'watch', 'server/index.ts'], { DATABASE_URL: LOCAL_DATABASE_URL, PORT: API_PORT }),
  run([bin('vite', 'bin', 'vite.js')], { KEEL_API_PORT: API_PORT }),
];

const shutdown = async () => {
  children.forEach((child) => child.kill());
  await pg.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
