// Measures the brief's speed rule over HTTP against a running server: every page's data
// must arrive in under two seconds. Usage: npm run bench -- http://localhost:8787 [users]
export {};

const BASE = process.argv[2] ?? 'http://localhost:8787';
const USERS = Number(process.argv[3] ?? 10);
const ROUNDS = 5;

const PAGES = [
  '/api/home', '/api/subscriptions', '/api/subscriptions?status=active', '/api/subscriptions?q=spice', '/api/subscriptions/board', '/api/subscriptions/1',
  '/api/invoices', '/api/invoices?status=confirmed', '/api/invoices?q=malabar', '/api/invoices/1', '/api/payments', '/api/collections', '/api/renewals',
  '/api/customers', '/api/customers?q=traders', '/api/customers/1', '/api/products', '/api/plans', '/api/discounts', '/api/reports/revenue',
  '/api/reports/revenue?preset=year', '/api/reports/revenue?segment=small', '/api/search?q=malabar', '/api/integrity/audit', '/api/outbox',
];

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@keel.demo', password: 'Keel@Admin2026' }),
});
const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
if (!cookie) throw new Error(`Could not sign in: ${login.status}`);

const samples = new Map<string, number[]>();

async function user() {
  for (let round = 0; round < ROUNDS; round++) {
    for (const page of PAGES) {
      const started = performance.now();
      const res = await fetch(`${BASE}${page}`, { headers: { cookie } });
      await res.text();
      if (!res.ok) throw new Error(`${page} returned ${res.status}`);
      samples.set(page, [...(samples.get(page) ?? []), performance.now() - started]);
    }
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: USERS }, user));
const seconds = (performance.now() - started) / 1000;

const pick = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const rows = [...samples].map(([page, values]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { page: page.replace('/api', ''), p50: Math.round(pick(sorted, 0.5)), p95: Math.round(pick(sorted, 0.95)), max: Math.round(sorted[sorted.length - 1]) };
}).sort((a, b) => b.p95 - a.p95);

console.table(rows);
const total = [...samples.values()].reduce((sum, v) => sum + v.length, 0);
const worst = rows[0];
console.log(`${total} requests from ${USERS} simultaneous users in ${seconds.toFixed(1)}s (${Math.round(total / seconds)} req/s)`);
console.log(`Slowest p95: ${worst.page} at ${worst.p95} ms. ${worst.p95 < 2000 ? 'PASS' : 'FAIL'}: under 2000 ms`);
process.exit(worst.p95 < 2000 ? 0 : 1);
