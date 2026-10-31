import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { q } from '../db/pool.ts';
import { addMonths, monthStart } from '../engine/index.ts';
import { askKeel, monthBrief } from '../services/ai.ts';
import { cached } from '../services/cache.ts';
import { appState, audit, conflict, Filters, listPage, paging } from '../services/core.ts';
import { advanceClock, nextBillingDay, type FeedEvent } from '../services/daily.ts';
import { attemptDoubleBill, chaosRun, replayInvoices, runChecks } from '../services/integrity.ts';
import { assignLine, confirmLine, explainLine, ignoreLine, ingestStatement, loadStatement, sampleStatement } from '../services/reconcile.ts';
import { monthlySeries, monthRange, overview, planBreakdown, revenueSummary, tideChart, topOverdue } from '../services/reports.ts';
import { actorOf, adminOnly, body, date, idParam, staffOnly, type Env } from './helpers.ts';

export const insight = new Hono<Env>();
insight.use('*', staffOnly);

insight.get('/home', async (c) => {
  const { today } = await appState();
  return c.json(await cached(`home:${today}`, 30_000, async () => {
    const [summary, tide, next] = await Promise.all([overview(today), tideChart(today), nextBillingDay(today)]);
    return { today, summary, tide, nextBillingDay: next };
  }));
});

const reportFilter = (query: Record<string, string>, today: string) => {
  const preset = query.preset ?? 'month';
  const range = preset === 'quarter' ? { from: monthStart(addMonths(today, -2)), to: today }
    : preset === 'year' ? { from: monthStart(addMonths(today, -11)), to: today }
    : monthRange(today);
  return {
    from: query.from || range.from,
    to: query.to || range.to,
    planId: query.planId ? Number(query.planId) : undefined,
    segment: query.segment || undefined,
    stateCode: query.stateCode || undefined,
  };
};

insight.get('/reports/revenue', async (c) => {
  const { today } = await appState();
  const f = reportFilter(c.req.query(), today);
  return c.json(await cached(`revenue:${today}:${JSON.stringify(f)}`, 30_000, async () => {
    const [summary, series, plans, overdue] = await Promise.all([
      revenueSummary(f, today),
      monthlySeries(f, today),
      planBreakdown(f),
      topOverdue(f, today),
    ]);
    return { summary, series, plans, overdue };
  }));
});

insight.get('/reports/export', async (c) => {
  const { today } = await appState();
  const f = reportFilter(c.req.query(), today);
  const rows = await q(
    `SELECT i.number, i.issue_date, i.due_date, c.name, c.gstin, c.state_name, p.name AS plan, i.status, i.subtotal, i.discount, i.tax, i.total, i.amount_paid
       FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id
      WHERE i.issue_date BETWEEN $1 AND $2 AND i.status <> 'cancelled' AND i.number IS NOT NULL
      ORDER BY i.issue_date, i.id LIMIT 50000`,
    [f.from, f.to],
  );
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rupees = (n: number) => (n / 100).toFixed(2);
  const lines = rows.map((r) => [r.number, r.issue_date, r.due_date, r.name, r.gstin, r.state_name, r.plan, r.status, rupees(r.subtotal), rupees(r.discount), rupees(r.tax), rupees(r.total), rupees(r.amount_paid)].map(cell).join(','));
  c.header('Content-Type', 'text/csv');
  c.header('Content-Disposition', `attachment; filename="brightloop-invoices-${f.from}-to-${f.to}.csv"`);
  return c.body(['Invoice,Issued,Due,Customer,GSTIN,State,Plan,Status,Subtotal,Discount,Tax,Total,Paid', ...lines].join('\n'));
});

insight.post('/ask', async (c) => {
  const { question } = await body(c, z.object({ question: z.string().trim().min(2, 'Ask a question').max(400) }));
  return c.json(await askKeel(question));
});

// The rule-based note is instant. The Gemini one is slower and costs credit, so it runs
// only when asked for, and repeat requests reuse it until the books change.
insight.get('/brief', async (c) => {
  if (c.req.query('ai') !== '1') return c.json(await monthBrief({ useAi: false }));
  const { today } = await appState();
  return c.json(await cached(`brief:${today}`, 600_000, () => monthBrief({ useAi: true })));
});

insight.get('/clock', async (c) => {
  const { today, clockMode } = await appState();
  return c.json({ today, clockMode, nextBillingDay: await nextBillingDay(today) });
});

insight.post('/clock/advance', adminOnly, async (c) => {
  const input = await body(c, z.object({ to: date, holdBilling: z.boolean().default(false) }));
  const actor = actorOf(c).name;
  return streamSSE(c, async (stream) => {
    const send = (e: FeedEvent) => void stream.writeSSE({ event: 'feed', data: JSON.stringify(e) });
    try {
      const result = await advanceClock({ to: input.to, holdBilling: input.holdBilling, actor, emit: send });
      await stream.writeSSE({ event: 'done', data: JSON.stringify(result) });
    } catch (err: any) {
      await stream.writeSSE({ event: 'failed', data: JSON.stringify({ message: err.message }) });
    }
  });
});

insight.put('/settings', adminOnly, async (c) => {
  const { autoConfirm } = await body(c, z.object({ autoConfirm: z.boolean() }));
  await q(`UPDATE app_state SET auto_confirm = $1 WHERE id = 1`, [autoConfirm]);
  await audit(actorOf(c).name, 'settings.auto_confirm', 'system', null, { autoConfirm });
  return c.json({ ok: true });
});

insight.get('/integrity/checks', async (c) => c.json(await runChecks()));
insight.get('/integrity/replay', async (c) => c.json(await replayInvoices(Math.min(Number(c.req.query('limit')) || 5000, 500000))));

insight.post('/integrity/double-bill', adminOnly, async (c) => c.json(await attemptDoubleBill(actorOf(c).name)));

insight.post('/integrity/chaos', adminOnly, async (c) => {
  const { today } = await appState();
  const actor = actorOf(c);
  return streamSSE(c, async (stream) => {
    try {
      const report = await chaosRun(today, actor, (p) => void stream.writeSSE({ event: 'progress', data: JSON.stringify(p) }));
      await stream.writeSSE({ event: 'done', data: JSON.stringify(report) });
    } catch (err: any) {
      await stream.writeSSE({ event: 'failed', data: JSON.stringify({ message: err.message }) });
    }
  });
});

insight.get('/integrity/audit', async (c) => {
  const query = c.req.query();
  const filters = new Filters();
  filters.add((r) => `action ILIKE ${r}`, query.q ? `%${query.q}%` : undefined);
  return c.json(await listPage({ select: 'id, at, actor, action, entity, entity_id, detail, hash', from: 'audit_log', filters, orderBy: 'id DESC', page: paging(query) }));
});

/** Live latency probe of every main page's data, for the performance panel. */
insight.get('/integrity/performance', async (c) => {
  const { today } = await appState();
  const range = monthRange(today);
  const probes: [string, () => Promise<unknown>][] = [
    ['Home overview', () => overview(today)],
    ['Tide chart', () => tideChart(today)],
    ['Revenue report', () => revenueSummary(range, today)],
    ['Monthly series', () => monthlySeries({}, today)],
    ['Subscription list', () => q(`SELECT s.id FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE s.status = 'active' ORDER BY s.id DESC LIMIT 25`)],
    ['Invoice list', () => q(`SELECT i.id FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.issue_date DESC, i.id DESC LIMIT 25`)],
    ['Overdue list', () => q(`SELECT i.id FROM invoices i WHERE i.status = 'confirmed' AND i.due_date < $1 ORDER BY i.total DESC LIMIT 25`, [today])],
    ['Search', () => q(`SELECT id FROM customers WHERE name ILIKE $1 LIMIT 5`, ['%malabar%'])],
  ];
  const results = [];
  for (const [name, run] of probes) {
    const t0 = performance.now();
    await run();
    results.push({ name, ms: Math.round((performance.now() - t0) * 10) / 10 });
  }
  const [volume] = await q(
    `SELECT (SELECT count(*)::int FROM subscriptions) AS subscriptions, (SELECT count(*)::int FROM invoices) AS invoices,
            (SELECT count(*)::int FROM payments) AS payments, (SELECT count(*)::int FROM customers) AS customers`,
  );
  return c.json({ results, volume });
});

insight.get('/reconcile/sample', async (c) => c.json(await sampleStatement()));

insight.get('/reconcile/statements', async (c) => {
  return c.json(await q(
    `SELECT s.*, count(l.*) FILTER (WHERE l.status IN ('auto_posted','confirmed'))::int AS posted,
            count(l.*) FILTER (WHERE l.status = 'suggested')::int AS suggested,
            count(l.*) FILTER (WHERE l.status = 'unmatched')::int AS unmatched
       FROM bank_statements s LEFT JOIN bank_lines l ON l.statement_id = s.id GROUP BY s.id ORDER BY s.id DESC LIMIT 20`,
  ));
});

insight.get('/reconcile/statements/:id', async (c) => c.json(await loadStatement(idParam(c))));

insight.post('/reconcile/upload', async (c) => {
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) throw conflict('Attach a statement file');
  if (file.size > 10 * 1024 * 1024) throw conflict('Statements up to 10 MB, please');
  const content = Buffer.from(await file.arrayBuffer());
  return c.json(await ingestStatement({ filename: file.name, mimeType: file.type || 'text/csv', content, actor: actorOf(c) }), 201);
});

insight.post('/reconcile/lines/:id/confirm', async (c) => {
  const { candidate } = await body(c, z.object({ candidate: z.number().int().min(0).default(0) }));
  return c.json(await confirmLine(idParam(c), candidate, actorOf(c)));
});

insight.post('/reconcile/lines/:id/assign', async (c) => {
  const { invoiceId } = await body(c, z.object({ invoiceId: z.number().int() }));
  return c.json(await assignLine(idParam(c), invoiceId, actorOf(c)));
});

insight.post('/reconcile/lines/:id/ignore', async (c) => {
  await ignoreLine(idParam(c), actorOf(c));
  return c.json({ ok: true });
});

insight.post('/reconcile/lines/:id/explain', async (c) => c.json(await explainLine(idParam(c))));

