import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { one, pool, q, tx } from '../db/pool.ts';
import { computeInvoice, daysBetween, formatINR, SUBSCRIPTION_FLOW } from '../engine/index.ts';
import { cancelInvoice, confirmAllDrafts, confirmInvoices, previewNext, rehearse, runBilling } from '../services/billing.ts';
import { appState, audit, conflict, Filters, invalid, listPage, notFound, paging } from '../services/core.ts';
import { DUNNING_STEPS } from '../services/daily.ts';
import { sendMail } from '../services/mail.ts';
import * as subs from '../services/subscriptions.ts';
import { actorOf, body, date, idParam, staffOnly, type Env } from './helpers.ts';

export const ops = new Hono<Env>();
ops.use('*', staffOnly);

const lineSchema = z.object({
  productId: z.number().int(),
  variantId: z.number().int().nullish(),
  quantity: z.number().int().min(1, 'Quantity must be at least 1'),
  unitPrice: z.number().int().min(0).nullish(),
  description: z.string().optional(),
});

ops.get('/subscriptions', async (c) => {
  const query = c.req.query();
  const filters = new Filters();
  filters.add((r) => `s.status = ${r}`, query.status);
  filters.add((r) => `s.plan_id = ${r}`, query.planId);
  filters.add((r) => `s.customer_id = ${r}`, query.customerId);
  filters.add((r) => `(s.number ILIKE ${r} OR c.name ILIKE ${r})`, query.q ? `%${query.q}%` : undefined);
  const page = await listPage({
    select: `s.id, s.number, s.status, s.start_date, s.expiry_date, s.next_billing_date, s.mrr, s.recurring_amount,
             c.id AS customer_id, c.name AS customer_name, p.name AS plan_name, p.billing_unit`,
    from: 'subscriptions s JOIN customers c ON c.id = s.customer_id JOIN plans p ON p.id = s.plan_id',
    filters,
    orderBy: 's.id DESC',
    page: paging(query),
  });
  return c.json(page);
});

ops.get('/subscriptions/board', async (c) => {
  const [counts, cards] = await Promise.all([
    q(`SELECT status, count(*)::int AS n, COALESCE(sum(recurring_amount),0)::bigint AS value FROM subscriptions GROUP BY status`),
    q(`SELECT * FROM (
         SELECT s.id, s.number, s.status, s.recurring_amount, s.start_date, s.quotation_valid_until, c.name AS customer_name, p.name AS plan_name,
                row_number() OVER (PARTITION BY s.status ORDER BY s.id DESC) AS rn
           FROM subscriptions s JOIN customers c ON c.id = s.customer_id JOIN plans p ON p.id = s.plan_id) x
        WHERE rn <= 20`),
  ]);
  return c.json({ flow: SUBSCRIPTION_FLOW, counts, cards });
});

ops.post('/subscriptions', async (c) => {
  const input = await body(c, z.object({
    customerId: z.number().int(),
    planId: z.number().int(),
    templateId: z.number().int().nullish(),
    startDate: date,
    expiryDate: date.nullish(),
    paymentTermId: z.number().int().nullish(),
    notes: z.string().nullish(),
    lines: z.array(lineSchema).optional(),
  }));
  return c.json(await subs.createSubscription(input, actorOf(c)), 201);
});

ops.get('/subscriptions/:id', async (c) => {
  const id = idParam(c);
  const [sub, lines, events, invoices, discounts, addons, next] = await Promise.all([
    one(
      `SELECT s.*, c.name AS customer_name, c.email AS customer_email, c.gstin, c.segment, c.state_name,
              p.name AS plan_name, p.billing_unit, p.billing_interval, p.auto_close, p.closable, p.pausable, p.renewable, p.min_quantity,
              t.name AS payment_term, t.net_days, u.name AS owner_name, qt.name AS template_name
         FROM subscriptions s
         JOIN customers c ON c.id = s.customer_id JOIN plans p ON p.id = s.plan_id JOIN payment_terms t ON t.id = s.payment_term_id
         LEFT JOIN users u ON u.id = s.owner_id LEFT JOIN quotation_templates qt ON qt.id = s.template_id
        WHERE s.id = $1`,
      [id],
    ),
    q(`SELECT l.*, p.name AS product_name, p.type AS product_type FROM subscription_lines l JOIN products p ON p.id = l.product_id WHERE l.subscription_id = $1 ORDER BY l.sort, l.id`, [id]),
    q(`SELECT * FROM subscription_events WHERE subscription_id = $1 ORDER BY id DESC LIMIT 40`, [id]),
    q(`SELECT id, number, status, issue_date, due_date, period_start, period_end, total, amount_paid FROM invoices WHERE subscription_id = $1 ORDER BY period_start DESC, id DESC LIMIT 24`, [id]),
    q(`SELECT d.id, d.code, d.name, d.kind, d.value, d.valid_until, d.usage_limit, d.times_used FROM subscription_discounts sd JOIN discounts d ON d.id = sd.discount_id WHERE sd.subscription_id = $1`, [id]),
    subs.addonOffers(id, pool),
    previewNext(id),
  ]);
  if (!sub) throw notFound('Subscription');
  return c.json({ sub, lines, events, invoices, discounts, addons, next, flow: SUBSCRIPTION_FLOW });
});

ops.put('/subscriptions/:id/lines', async (c) => {
  const { lines } = await body(c, z.object({ lines: z.array(lineSchema).min(1, 'Keep at least one line') }));
  await subs.updateLines(idParam(c), lines, actorOf(c));
  return c.json({ ok: true });
});

ops.post('/subscriptions/:id/transition', async (c) => {
  const { to, reason } = await body(c, z.object({ to: z.enum(['draft', 'quotation', 'confirmed', 'active', 'closed']), reason: z.string().optional() }));
  await subs.transition(idParam(c), to, actorOf(c), { reason });
  return c.json({ ok: true });
});

ops.post('/subscriptions/:id/pause', async (c) => { await subs.pause(idParam(c), actorOf(c)); return c.json({ ok: true }); });
ops.post('/subscriptions/:id/resume', async (c) => { await subs.resume(idParam(c), actorOf(c)); return c.json({ ok: true }); });
ops.post('/subscriptions/:id/renew', async (c) => c.json(await subs.renew(idParam(c), actorOf(c))));

ops.post('/subscriptions/:id/discounts', async (c) => {
  const { code } = await body(c, z.object({ code: z.string().min(1, 'Enter a code') }));
  await subs.attachDiscount(idParam(c), code, actorOf(c));
  return c.json({ ok: true });
});

ops.delete('/subscriptions/:id/discounts/:discountId', async (c) => {
  await subs.detachDiscount(idParam(c), idParam(c, 'discountId'), actorOf(c));
  return c.json({ ok: true });
});

ops.post('/subscriptions/:id/addons', async (c) => {
  const { productId, enable } = await body(c, z.object({ productId: z.number().int(), enable: z.boolean() }));
  return c.json(await subs.setAddon(idParam(c), productId, enable, actorOf(c)));
});

ops.get('/invoices', async (c) => {
  const query = c.req.query();
  const { today } = await appState();
  const filters = new Filters();
  filters.add((r) => `i.status = ${r}`, query.status);
  filters.add((r) => `i.customer_id = ${r}`, query.customerId);
  filters.add((r) => `i.subscription_id = ${r}`, query.subscriptionId);
  filters.add((r) => `i.issue_date >= ${r}`, query.from);
  filters.add((r) => `i.issue_date <= ${r}`, query.to);
  filters.add((r) => `i.run_id = ${r}`, query.runId);
  filters.add((r) => `(i.number ILIKE ${r} OR c.name ILIKE ${r})`, query.q ? `%${query.q}%` : undefined);
  if (query.overdue) filters.add((r) => `i.status = 'confirmed' AND i.due_date < ${r}`, today);
  const page = await listPage({
    select: `i.id, i.number, i.status, i.issue_date, i.due_date, i.total, i.amount_paid, i.sent_at, c.id AS customer_id, c.name AS customer_name,
             s.number AS subscription_number, (i.status = 'confirmed' AND i.due_date < (SELECT today FROM app_state)) AS overdue`,
    from: 'invoices i JOIN customers c ON c.id = i.customer_id JOIN subscriptions s ON s.id = i.subscription_id',
    filters,
    orderBy: 'i.issue_date DESC, i.id DESC',
    page: paging(query),
  });
  return c.json(page);
});

export async function invoiceDetail(id: number) {
  const [invoice, lines, payments, period, redemptions, reminders] = await Promise.all([
    one(`SELECT i.*, c.name AS customer_name, c.email AS customer_email, s.number AS subscription_number, p.name AS plan_name
           FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN subscriptions s ON s.id = i.subscription_id JOIN plans p ON p.id = s.plan_id
          WHERE i.id = $1`, [id]),
    q(`SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY id`, [id]),
    q(`SELECT p.id, p.number, p.method, p.paid_on, p.note, p.reference, a.amount FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = $1 ORDER BY p.paid_on, p.id`, [id]),
    one(`SELECT id, state, period_index, run_id, lower(period) AS period_start, upper(period) AS period_end FROM billing_periods WHERE invoice_id = $1`, [id]),
    q(`SELECT r.amount, r.released_on, d.code, d.name FROM discount_redemptions r JOIN discounts d ON d.id = r.discount_id WHERE r.invoice_id = $1`, [id]),
    q(`SELECT step, on_date, actor FROM dunning_events WHERE invoice_id = $1 ORDER BY step`, [id]),
  ]);
  if (!invoice) throw notFound('Invoice');
  // The trace is recomputed from stored inputs, so what you see is what the engine really did.
  const replay = computeInvoice(invoice.engine_input);
  const verified = replay.total === invoice.total && replay.tax === invoice.tax;
  const { engine_input, ...safe } = invoice;
  return { invoice: safe, lines, payments, period, redemptions, reminders, trace: replay.trace, verified, skipped: replay.skippedDiscounts };
}

ops.get('/invoices/:id', async (c) => c.json(await invoiceDetail(idParam(c))));

ops.post('/invoices/confirm-all', async (c) => {
  const { runId } = await body(c, z.object({ runId: z.number().int().optional() }));
  return c.json({ confirmed: await confirmAllDrafts(actorOf(c).name, { runId }) });
});

ops.post('/invoices/:id/confirm', async (c) => {
  const id = idParam(c);
  await tx((client) => confirmInvoices(client, [id], actorOf(c).name));
  return c.json({ ok: true });
});

ops.post('/invoices/:id/cancel', async (c) => {
  const input = await body(c, z.object({ mode: z.enum(['rebill', 'waive']), reason: z.string().trim().min(3, 'Say why you are cancelling') }));
  await cancelInvoice(idParam(c), input.mode, input.reason, actorOf(c).name);
  return c.json({ ok: true });
});

ops.post('/invoices/:id/send', async (c) => {
  const id = idParam(c);
  const { today, company } = await appState();
  const inv = await one(`SELECT i.*, c.email, c.name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = $1`, [id]);
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'draft') throw conflict('Confirm this invoice before sending it');
  if (inv.status === 'cancelled') throw conflict('A cancelled invoice cannot be sent');
  await sendMail({
    to: inv.email,
    subject: `Invoice ${inv.number} from ${company.name}`,
    body: `Hello ${inv.name},\n\nInvoice ${inv.number} for ${formatINR(inv.total)} is ready, due on ${inv.due_date}.\nSign in to your portal to view or pay it.\n\n${company.name}`,
    kind: 'invoice',
    onDate: today,
  });
  await q(`UPDATE invoices SET sent_at = now() WHERE id = $1`, [id]);
  await audit(actorOf(c).name, 'invoice.send', 'invoice', id, { number: inv.number });
  return c.json({ ok: true });
});

ops.get('/payments', async (c) => {
  const query = c.req.query();
  const filters = new Filters();
  filters.add((r) => `p.paid_on >= ${r}`, query.from);
  filters.add((r) => `p.paid_on <= ${r}`, query.to);
  filters.add((r) => `p.method = ${r}`, query.method);
  filters.add((r) => `p.customer_id = ${r}`, query.customerId);
  filters.add((r) => `(p.number ILIKE ${r} OR c.name ILIKE ${r} OR p.reference ILIKE ${r})`, query.q ? `%${query.q}%` : undefined);
  return c.json(await listPage({
    select: `p.id, p.number, p.method, p.amount, p.paid_on, p.note, p.reference, p.source, p.created_by, c.id AS customer_id, c.name AS customer_name,
             (SELECT string_agg(i.number, ', ') FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id WHERE a.payment_id = p.id) AS invoices`,
    from: 'payments p JOIN customers c ON c.id = p.customer_id',
    filters,
    orderBy: 'p.paid_on DESC, p.id DESC',
    page: paging(query),
  }));
});

const METHODS = ['upi', 'bank_transfer', 'card', 'cash', 'cheque', 'tds', 'gateway'] as const;

export async function recordPayment(input: { invoiceId: number; amount: number; method: (typeof METHODS)[number]; paidOn: string; note?: string | null; reference?: string | null; source?: string }, actorName: string) {
  return tx(async (client) => {
    const inv = await one(`SELECT id, number, customer_id, status, total, amount_paid FROM invoices WHERE id = $1 FOR UPDATE`, [input.invoiceId], client);
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'draft') throw conflict('Confirm this invoice before taking a payment against it');
    if (inv.status === 'cancelled') throw conflict('This invoice is cancelled');
    if (inv.status === 'paid') throw conflict('This invoice is already paid in full');
    const owed = inv.total - inv.amount_paid;
    if (input.amount > owed) throw invalid(`Only ${formatINR(owed)} is owed on ${inv.number}`, { amount: `At most ${formatINR(owed)}` });
    const seq = await one(`SELECT nextval('payment_number_seq') AS n`, [], client);
    const number = `PAY-${String(seq!.n).padStart(6, '0')}`;
    const payment = await one(
      `INSERT INTO payments (number, customer_id, method, amount, paid_on, note, reference, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [number, inv.customer_id, input.method, input.amount, input.paidOn, input.note ?? null, input.reference ?? null, input.source ?? 'manual', actorName],
      client,
    );
    await client.query(`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,$3)`, [payment!.id, inv.id, input.amount]);
    await audit(actorName, 'payment.record', 'invoice', inv.id, { number, amount: input.amount, method: input.method }, client);
    return { id: payment!.id as number, number, remaining: owed - input.amount };
  });
}

ops.post('/payments', async (c) => {
  const input = await body(c, z.object({
    invoiceId: z.number().int(),
    amount: z.number().int().positive('Enter an amount above zero'),
    method: z.enum(METHODS),
    paidOn: date,
    note: z.string().nullish(),
    reference: z.string().nullish(),
  }));
  const { today } = await appState();
  if (input.paidOn > today) throw invalid('A payment cannot be dated in the future', { paidOn: `Today is ${today}` });
  return c.json(await recordPayment(input, actorOf(c).name), 201);
});

ops.get('/collections', async (c) => {
  const query = c.req.query();
  const { today } = await appState();
  const filters = new Filters();
  const todayRef = filters.next(today);
  filters.raw(`i.status = 'confirmed'`);
  filters.raw(`i.due_date < ${todayRef}::date`);
  filters.add((r) => `c.segment = ${r}`, query.segment);
  filters.add((r) => `(i.number ILIKE ${r} OR c.name ILIKE ${r})`, query.q ? `%${query.q}%` : undefined);
  if (query.bucket === 'd1_30') filters.raw(`i.due_date >= ${todayRef}::date - 30`);
  if (query.bucket === 'd31_60') filters.raw(`i.due_date BETWEEN ${todayRef}::date - 60 AND ${todayRef}::date - 31`);
  if (query.bucket === 'd61_90') filters.raw(`i.due_date BETWEEN ${todayRef}::date - 90 AND ${todayRef}::date - 61`);
  if (query.bucket === 'd90_plus') filters.raw(`i.due_date < ${todayRef}::date - 90`);
  const page = await listPage({
    select: `i.id, i.number, i.due_date, i.total, i.amount_paid, i.total - i.amount_paid AS owed, c.id AS customer_id, c.name AS customer_name,
             c.email AS customer_email, c.segment, ${todayRef}::date - i.due_date AS days_overdue,
             (SELECT max(step) FROM dunning_events d WHERE d.invoice_id = i.id) AS last_step,
             (SELECT max(on_date) FROM dunning_events d WHERE d.invoice_id = i.id) AS last_reminder`,
    from: 'invoices i JOIN customers c ON c.id = i.customer_id',
    filters,
    // Money at risk first: older debts are harder to recover, so age raises the priority.
    orderBy: `(i.total - i.amount_paid) * LEAST(${todayRef}::date - i.due_date + 10, 120) DESC`,
    page: paging(query),
  });
  return c.json({ ...page, steps: DUNNING_STEPS });
});

ops.post('/collections/:invoiceId/remind', async (c) => {
  const id = idParam(c, 'invoiceId');
  const { today, company } = await appState();
  const inv = await one(`SELECT i.*, c.email, c.name FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = $1 AND i.status = 'confirmed'`, [id]);
  if (!inv) throw notFound('Open invoice');
  const last = await one(`SELECT COALESCE(max(step),0)::int AS step FROM dunning_events WHERE invoice_id = $1`, [id]);
  const step = Math.min(last!.step + 1, DUNNING_STEPS.length);
  await q(`INSERT INTO dunning_events (invoice_id, step, on_date, actor) VALUES ($1,$2,$3,$4) ON CONFLICT (invoice_id, step) DO UPDATE SET on_date = EXCLUDED.on_date, actor = EXCLUDED.actor`, [id, step, today, actorOf(c).name]);
  const days = daysBetween(inv.due_date, today);
  await sendMail({
    to: inv.email,
    subject: `${DUNNING_STEPS[step - 1].tone}: invoice ${inv.number}`,
    body: `Hello ${inv.name},\n\nInvoice ${inv.number} for ${formatINR(inv.total - inv.amount_paid)} is ${days} days overdue. Please pay it from your portal, or reply if something is wrong.\n\n${actorOf(c).name}, ${company.name}`,
    kind: 'dunning',
    onDate: today,
  });
  await audit(actorOf(c).name, 'collections.remind', 'invoice', id, { step });
  return c.json({ ok: true, step });
});

ops.get('/renewals', async (c) => {
  const query = c.req.query();
  const { today } = await appState();
  const days = Math.min(Number(query.days) || 90, 365);
  const filters = new Filters();
  filters.raw(`s.status IN ('active','paused')`);
  const todayRef = filters.next(today);
  const daysRef = filters.next(days);
  filters.raw(`s.expiry_date <= ${todayRef}::date + ${daysRef}::int`);
  if (query.mode === 'manual') filters.raw(`NOT s.auto_renew`);
  if (query.mode === 'auto') filters.raw(`s.auto_renew`);
  filters.add((r) => `(s.number ILIKE ${r} OR c.name ILIKE ${r})`, query.q ? `%${query.q}%` : undefined);
  const page = await listPage({
    select: `s.id, s.number, s.expiry_date, s.mrr, s.recurring_amount, s.auto_renew, c.id AS customer_id, c.name AS customer_name, p.name AS plan_name,
             p.renewable, p.auto_close, s.expiry_date - ${todayRef}::date AS days_left`,
    from: 'subscriptions s JOIN customers c ON c.id = s.customer_id JOIN plans p ON p.id = s.plan_id',
    filters,
    orderBy: 's.expiry_date, s.id',
    page: paging(query),
  });
  const totals = await one(
    `SELECT count(*)::int AS n, COALESCE(sum(s.mrr),0)::bigint AS mrr,
            count(*) FILTER (WHERE NOT s.auto_renew)::int AS manual,
            COALESCE(sum(s.mrr) FILTER (WHERE NOT s.auto_renew),0)::bigint AS manual_mrr
       FROM subscriptions s WHERE s.status IN ('active','paused') AND s.expiry_date <= $1::date + $2::int`,
    [today, days],
  );
  return c.json({ ...page, totals });
});

ops.get('/billing/rehearse', async (c) => {
  const { today } = await appState();
  const asOf = c.req.query('date') ?? today;
  const result = await rehearse(asOf);
  // The full plan can run to thousands of rows; the screen needs only a sample.
  return c.json({ ...result, planned: result.planned.slice(0, 200) });
});

ops.post('/billing/run', async (c) => {
  const { today } = await appState();
  const actor = actorOf(c).name;
  return streamSSE(c, async (stream) => {
    const result = await runBilling({
      asOf: today,
      kind: 'manual',
      actor,
      onProgress: (p) => void stream.writeSSE({ event: 'progress', data: JSON.stringify(p) }),
    });
    await stream.writeSSE({ event: 'done', data: JSON.stringify(result) });
  });
});

ops.get('/billing/runs', async (c) => {
  return c.json(await q(`SELECT * FROM billing_runs ORDER BY id DESC LIMIT 20`));
});

ops.get('/search', async (c) => {
  const text = (c.req.query('q') ?? '').trim();
  if (text.length < 2) return c.json({ results: [] });
  const like = `%${text}%`;
  const [customers, subscriptions, invoices] = await Promise.all([
    q(`SELECT id, name AS label, email AS detail FROM customers WHERE name ILIKE $1 ORDER BY name LIMIT 5`, [like]),
    q(`SELECT s.id, s.number AS label, c.name AS detail FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE s.number ILIKE $1 LIMIT 4`, [like]),
    q(`SELECT i.id, i.number AS label, c.name AS detail FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.number ILIKE $1 ORDER BY i.id DESC LIMIT 4`, [like]),
  ]);
  return c.json({
    results: [
      ...customers.map((r) => ({ ...r, kind: 'Customer', href: `/customers/${r.id}` })),
      ...subscriptions.map((r) => ({ ...r, kind: 'Subscription', href: `/subscriptions/${r.id}` })),
      ...invoices.map((r) => ({ ...r, kind: 'Invoice', href: `/invoices/${r.id}` })),
    ],
  });
});

ops.get('/outbox', async (c) => {
  const query = c.req.query();
  const filters = new Filters();
  filters.add((r) => `kind = ${r}`, query.kind);
  return c.json(await listPage({ select: '*', from: 'outbox', filters, orderBy: 'id DESC', page: paging(query) }));
});
