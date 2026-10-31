// The customer's side. Every query is scoped to the signed-in customer, so changing
// an id in the URL can never reach someone else's records.
import { Hono } from 'hono';
import { z } from 'zod';
import { one, pool, q } from '../db/pool.ts';
import { billNow, previewNext } from '../services/billing.ts';
import { appState, audit, conflict, notFound } from '../services/core.ts';
import * as subs from '../services/subscriptions.ts';
import { invoiceDetail, recordPayment } from './operations.ts';
import { actorOf, body, customerOnly, idParam, type Env } from './helpers.ts';

export const portal = new Hono<Env>();
portal.use('*', customerOnly);

const customerIdOf = (c: any) => actorOf(c).customerId!;

async function ownedSubscription(c: any) {
  const id = idParam(c);
  const row = await one(`SELECT id FROM subscriptions WHERE id = $1 AND customer_id = $2`, [id, customerIdOf(c)]);
  if (!row) throw notFound('Subscription');
  return id;
}

async function ownedInvoice(c: any) {
  const id = idParam(c);
  const row = await one(`SELECT id FROM invoices WHERE id = $1 AND customer_id = $2 AND status <> 'draft'`, [id, customerIdOf(c)]);
  if (!row) throw notFound('Invoice');
  return id;
}

portal.get('/home', async (c) => {
  const customerId = customerIdOf(c);
  const { today } = await appState();
  const [customer, subscriptions, invoices, totals] = await Promise.all([
    one(`SELECT id, code, name, email, phone, gstin, state_code, state_name, city, address FROM customers WHERE id = $1`, [customerId]),
    q(`SELECT s.id, s.number, s.status, s.start_date, s.expiry_date, s.next_billing_date, s.recurring_amount, s.quotation_valid_until,
              p.name AS plan_name, p.billing_unit
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.customer_id = $1 AND s.status <> 'draft' ORDER BY s.status = 'closed', s.id DESC`, [customerId]),
    q(`SELECT i.id, i.number, i.status, i.issue_date, i.due_date, i.total, i.amount_paid, s.number AS subscription_number,
              (i.status = 'confirmed' AND i.due_date < $2) AS overdue
         FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
        WHERE i.customer_id = $1 AND i.status <> 'draft' ORDER BY i.issue_date DESC, i.id DESC LIMIT 24`, [customerId, today]),
    one(`SELECT COALESCE(sum(total - amount_paid) FILTER (WHERE status = 'confirmed'),0)::bigint AS outstanding,
                COALESCE(sum(total - amount_paid) FILTER (WHERE status = 'confirmed' AND due_date < $2),0)::bigint AS overdue
           FROM invoices WHERE customer_id = $1`, [customerId, today]),
  ]);
  return c.json({ today, customer, subscriptions, invoices, totals });
});

portal.get('/plans', async (c) => {
  const { today } = await appState();
  return c.json(await q(
    `SELECT p.id, p.name, p.price, p.billing_unit, p.min_quantity, p.notes, p.closable, p.pausable, pr.name AS product_name
       FROM plans p LEFT JOIN products pr ON pr.id = p.product_id
      WHERE p.active AND (p.available_from IS NULL OR p.available_from <= $1) AND (p.available_until IS NULL OR p.available_until >= $1)
        AND p.billing_unit IN ('monthly','yearly') ORDER BY p.price`,
    [today],
  ));
});

portal.post('/subscribe', async (c) => {
  const input = await body(c, z.object({ planId: z.number().int(), quantity: z.number().int().min(1) }));
  const actor = actorOf(c);
  const { today } = await appState();
  const plan = await one(`SELECT product_id FROM plans WHERE id = $1`, [input.planId]);
  if (!plan) throw notFound('Plan');
  const created = await subs.createSubscription({
    customerId: actor.customerId!, planId: input.planId, startDate: today,
    lines: [{ productId: plan.product_id, quantity: input.quantity }],
  }, actor);
  await subs.transition(created.id, 'quotation', actor);
  await subs.transition(created.id, 'confirmed', actor);
  await subs.transition(created.id, 'active', actor);
  await billNow(created.id, 'Self-serve signup');
  return c.json(created, 201);
});

portal.get('/subscriptions/:id', async (c) => {
  const id = await ownedSubscription(c);
  const [sub, lines, addons, events, next] = await Promise.all([
    one(`SELECT s.id, s.number, s.status, s.start_date, s.expiry_date, s.next_billing_date, s.recurring_amount, s.auto_renew, s.quotation_valid_until,
                p.name AS plan_name, p.billing_unit, p.closable, p.pausable, p.renewable, p.auto_close, t.name AS payment_term
           FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN payment_terms t ON t.id = s.payment_term_id WHERE s.id = $1`, [id]),
    q(`SELECT description, quantity, unit_price, is_addon, active_until FROM subscription_lines WHERE subscription_id = $1 ORDER BY sort, id`, [id]),
    subs.addonOffers(id, pool),
    q(`SELECT kind, from_status, to_status, on_date, actor, detail FROM subscription_events WHERE subscription_id = $1 ORDER BY id DESC LIMIT 12`, [id]),
    previewNext(id),
  ]);
  return c.json({ sub, lines, addons, events, next });
});

portal.get('/subscriptions/:id/addons/:productId/preview', async (c) => {
  const id = await ownedSubscription(c);
  const enable = c.req.query('enable') === 'true';
  return c.json(await subs.previewAddon(id, idParam(c, 'productId'), enable, pool));
});

portal.post('/subscriptions/:id/addons', async (c) => {
  const id = await ownedSubscription(c);
  const { productId, enable } = await body(c, z.object({ productId: z.number().int(), enable: z.boolean() }));
  return c.json(await subs.setAddon(id, productId, enable, actorOf(c)));
});

portal.post('/subscriptions/:id/pause', async (c) => { await subs.pause(await ownedSubscription(c), actorOf(c)); return c.json({ ok: true }); });
portal.post('/subscriptions/:id/resume', async (c) => { await subs.resume(await ownedSubscription(c), actorOf(c)); return c.json({ ok: true }); });
portal.post('/subscriptions/:id/renew', async (c) => c.json(await subs.renew(await ownedSubscription(c), actorOf(c))));

portal.post('/subscriptions/:id/close', async (c) => {
  const id = await ownedSubscription(c);
  const { reason } = await body(c, z.object({ reason: z.string().trim().min(2, 'Tell us why').default('Closed from the portal') }));
  await subs.transition(id, 'closed', actorOf(c), { reason });
  return c.json({ ok: true });
});

portal.post('/subscriptions/:id/accept', async (c) => {
  const id = await ownedSubscription(c);
  const sub = await one(`SELECT status FROM subscriptions WHERE id = $1`, [id]);
  if (sub?.status !== 'quotation') throw conflict('This quotation is not open for acceptance');
  await subs.transition(id, 'confirmed', actorOf(c));
  return c.json({ ok: true });
});

portal.post('/subscriptions/:id/decline', async (c) => {
  const id = await ownedSubscription(c);
  const sub = await one(`SELECT status FROM subscriptions WHERE id = $1`, [id]);
  if (sub?.status !== 'quotation') throw conflict('This quotation is not open');
  await subs.transition(id, 'closed', actorOf(c), { reason: 'Declined by the customer' });
  return c.json({ ok: true });
});

portal.get('/invoices/:id', async (c) => {
  const detail = await invoiceDetail(await ownedInvoice(c));
  return c.json(detail);
});

// Simulated checkout. A real gateway would plug in here and call the same recordPayment.
portal.post('/invoices/:id/pay', async (c) => {
  const id = await ownedInvoice(c);
  const { method } = await body(c, z.object({ method: z.enum(['upi', 'card']) }));
  const inv = await one(`SELECT total - amount_paid AS owed FROM invoices WHERE id = $1`, [id]);
  const { today } = await appState();
  const paid = await recordPayment({
    invoiceId: id, amount: inv!.owed, method, paidOn: today, note: 'Paid from the customer portal',
    reference: `PORTAL-${Date.now().toString(36).toUpperCase()}`, source: 'portal',
  }, actorOf(c).name);
  return c.json(paid, 201);
});

portal.put('/profile', async (c) => {
  const v = await body(c, z.object({
    name: z.string().trim().min(2, 'Enter the company name'),
    phone: z.string().nullish(),
    gstin: z.string().trim().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z0-9]$/, 'That GSTIN does not look right').nullish().or(z.literal('').transform(() => null)),
    stateCode: z.string().nullish(),
    stateName: z.string().nullish(),
    city: z.string().nullish(),
    address: z.string().nullish(),
  }));
  await q(`UPDATE customers SET name=$2, phone=$3, gstin=$4, state_code=$5, state_name=$6, city=$7, address=$8 WHERE id=$1`,
    [customerIdOf(c), v.name, v.phone ?? null, v.gstin ?? null, v.stateCode ?? null, v.stateName ?? null, v.city ?? null, v.address ?? null]);
  await audit(actorOf(c).name, 'customer.profile', 'customer', customerIdOf(c), {});
  return c.json({ ok: true });
});
