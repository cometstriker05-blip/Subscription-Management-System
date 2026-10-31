import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { secureHeaders } from 'hono/secure-headers';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { auth, team } from './routes/auth.ts';
import { catalog } from './routes/catalog.ts';
import { loadActor, type Env } from './routes/helpers.ts';
import { insight } from './routes/insight.ts';
import { ops } from './routes/operations.ts';
import { portal } from './routes/portal.ts';
import { bumpDataVersion } from './services/cache.ts';
import { AppError } from './services/core.ts';

export const app = new Hono<Env>();

app.use('*', secureHeaders({ contentSecurityPolicy: undefined }));
app.use('*', compress());

// Every response reports its own latency, which is what the on-screen badge shows.
app.use('/api/*', async (c, next) => {
  const started = performance.now();
  await next();
  const ms = performance.now() - started;
  c.res.headers.set('Server-Timing', `app;dur=${ms.toFixed(1)}`);
  c.res.headers.set('X-Keel-Ms', ms.toFixed(1));
});

// JSON-only writes, combined with SameSite cookies, stop cross-site form attacks.
app.use('/api/*', async (c, next) => {
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  const type = c.req.header('content-type') ?? '';
  const upload = c.req.path.endsWith('/reconcile/upload');
  if (unsafe && !upload && !type.includes('application/json')) {
    throw new AppError(415, 'Send JSON', 'unsupported');
  }
  await next();
  if (unsafe) bumpDataVersion();
});

app.use('/api/*', loadActor);

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/api/auth', auth);
app.route('/api/team', team);
app.route('/api/portal', portal);
app.route('/api', catalog);
app.route('/api', ops);
app.route('/api', insight);

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: err.message, code: err.code, fields: err.fields }, err.status as any);
  }
  const code = (err as any).code as string | undefined;
  if (code?.startsWith('KE')) return c.json({ error: err.message, code }, 409);
  if (code === '23P01') return c.json({ error: 'That period is already billed', code }, 409);
  if (code === '23505') return c.json({ error: 'That already exists', code }, 409);
  console.error(err);
  return c.json({ error: 'Something went wrong on our side', code: 'server_error' }, 500);
});

app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found', code: 'not_found' }, 404);
  return c.text('Not found', 404);
});

const webRoot = process.env.WEB_ROOT ?? 'dist';
if (existsSync(join(webRoot, 'index.html'))) {
  const shell = readFileSync(join(webRoot, 'index.html'), 'utf8');
  app.use('/assets/*', serveStatic({ root: webRoot, onFound: (_, c) => void c.header('Cache-Control', 'public, immutable, max-age=31536000') }));
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', (c) => c.html(shell));
}
