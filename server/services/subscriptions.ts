import type { PoolClient } from 'pg';
import { one, q, tx, type Db } from '../db/pool.ts';
import {
  addDays, addMonths, canMoveSubscription, duePeriods, formatINR, isWithin, monthlyValue, onExpiry, periodAt,
  planAllows, prorateRemaining, type LifecycleAction, type Recurrence, type SubscriptionStatus,
} from '../engine/index.ts';
import { appState, audit, conflict, invalid, notFound, type Actor } from './core.ts';
import { sendMail } from './mail.ts';
import { refreshRecurring, setSubscriptionMrr } from './mrr.ts';

export interface LineDraft {
  productId: number;
  variantId?: number | null;
  quantity: number;
  unitPrice?: number | null;
  description?: string;
}

export interface SubscriptionDraft {
  customerId: number;
  planId: number;
  templateId?: number | null;
  startDate: string;
  expiryDate?: string | null;
  paymentTermId?: number | null;
  notes?: string | null;
  lines?: LineDraft[];
}

export async function logEvent(client: Db, subscriptionId: number, kind: string, params: { from?: string | null; to?: string | null; actor: string; on: string; detail?: object }) {
  await client.query(
    `INSERT INTO subscription_events (subscription_id, kind, from_status, to_status, actor, on_date, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [subscriptionId, kind, params.from ?? null, params.to ?? null, params.actor, params.on, JSON.stringify(params.detail ?? {})],
  );
}

const lockSubscription = async (client: PoolClient, id: number) => {
  const sub = await one(
    `SELECT s.*, p.name AS plan_name, p.billing_unit, p.billing_interval, p.auto_close, p.closable, p.pausable, p.renewable,
            p.term_months, c.email AS customer_email, c.name AS customer_name
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN customers c ON c.id = s.customer_id
      WHERE s.id = $1 FOR UPDATE OF s`,
    [id],
    client,
  );
  if (!sub) throw notFound('Subscription');
  return sub;
};

const recurrenceOf = (sub: any): Recurrence => ({ unit: sub.billing_unit, interval: sub.billing_interval });

const policyOf = (sub: any) => ({ autoClose: sub.auto_close, closable: sub.closable, pausable: sub.pausable, renewable: sub.renewable });

function assertPlanAllows(sub: any, action: LifecycleAction, actor: Actor) {
  if (planAllows(policyOf(sub), action)) return;
  // The admin may still close a contract early; a customer or staff member may not.
  if (action === 'close' && actor.role === 'admin') return;
  const verb = { close: 'closed early', pause: 'paused', renew: 'renewed' }[action];
  throw conflict(`${sub.plan_name} subscriptions cannot be ${verb}`);
}

async function resolveLines(client: PoolClient, plan: any, drafts: LineDraft[]) {
  const ids = drafts.map((d) => d.productId);
  const products = await q(`SELECT * FROM products WHERE id = ANY($1::bigint[])`, [ids], client);
  const variants = await q(`SELECT * FROM product_variants WHERE product_id = ANY($1::bigint[])`, [ids], client);
  const addons = await q(`SELECT product_id, price FROM plan_addons WHERE plan_id = $1`, [plan.id], client);

  return drafts.map((d, sort) => {
    const product = products.find((p) => p.id === d.productId);
    if (!product) throw invalid(`Product ${d.productId} does not exist`);
    if (d.quantity < 1) throw invalid('Quantity must be at least 1');
    const variant = d.variantId ? variants.find((v) => v.id === d.variantId) : null;
    if (d.variantId && !variant) throw invalid(`That variant does not belong to ${product.name}`);
    const addon = addons.find((a) => a.product_id === d.productId);
    const base = d.productId === plan.product_id ? plan.price : addon?.price ?? product.sales_price;
    const extra = variant?.price_extra ?? 0;
    return {
      product_id: d.productId,
      variant_id: variant?.id ?? null,
      description: d.description ?? `${product.name}${variant ? `, ${variant.attribute}: ${variant.value}` : d.productId === plan.product_id ? ` (${plan.name})` : ''}`,
      quantity: d.quantity,
      unit_price: d.unitPrice ?? base + extra,
      variant_extra: extra,
      is_addon: product.type === 'addon',
      sort,
    };
  });
}

function assertPlanOffer(plan: any, start: string, lines: { product_id: number; quantity: number }[]) {
  if (!plan.active) throw invalid(`${plan.name} is no longer offered`);
  if (!isWithin(start, plan.available_from, plan.available_until)) {
    throw invalid(`${plan.name} is only available from ${plan.available_from ?? 'launch'} to ${plan.available_until ?? 'further notice'}`, { startDate: 'Outside the plan availability window' });
  }
  const main = lines.find((l) => l.product_id === plan.product_id) ?? lines[0];
  if (main && main.quantity < plan.min_quantity) {
    throw invalid(`${plan.name} needs at least ${plan.min_quantity} seats`, { quantity: `Minimum ${plan.min_quantity}` });
  }
}

export async function createSubscription(draft: SubscriptionDraft, actor: Actor) {
  return tx(async (client) => {
    const { today } = await appState(client);
    const plan = await one(`SELECT * FROM plans WHERE id = $1`, [draft.planId], client);
    if (!plan) throw notFound('Plan');
    const customer = await one(`SELECT id, payment_term_id FROM customers WHERE id = $1`, [draft.customerId], client);
    if (!customer) throw notFound('Customer');

    let lineDrafts = draft.lines ?? [];
    let template: any = null;
    if (draft.templateId) {
      template = await one(`SELECT * FROM quotation_templates WHERE id = $1`, [draft.templateId], client);
      if (!template) throw notFound('Quotation template');
      if (!lineDrafts.length) {
        const rows = await q(`SELECT * FROM quotation_template_lines WHERE template_id = $1 ORDER BY sort`, [template.id], client);
        lineDrafts = rows.map((r) => ({ productId: r.product_id, variantId: r.variant_id, quantity: r.quantity, unitPrice: r.unit_price }));
      }
    }
    if (!lineDrafts.length) lineDrafts = [{ productId: plan.product_id, quantity: plan.min_quantity }];

    const lines = await resolveLines(client, plan, lineDrafts);
    assertPlanOffer(plan, draft.startDate, lines);

    const seq = await one(`SELECT nextval('subscription_number_seq') AS n`, [], client);
    const number = `SUB-${String(seq!.n).padStart(5, '0')}`;
    const expiry = draft.expiryDate ?? addMonths(draft.startDate, plan.term_months);
    const term = draft.paymentTermId ?? customer.payment_term_id ?? 1;

    const sub = await one(
      `INSERT INTO subscriptions (number, customer_id, plan_id, status, start_date, expiry_date, billing_anchor, next_billing_date,
          payment_term_id, auto_renew, template_id, owner_id, notes, created_on)
       VALUES ($1,$2,$3,'draft',$4,$5,$4,$4,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [number, draft.customerId, draft.planId, draft.startDate, expiry, term, plan.renewable, draft.templateId ?? null, actor.id, draft.notes ?? null, today],
      client,
    );
    for (const l of lines) {
      await client.query(
        `INSERT INTO subscription_lines (subscription_id, product_id, variant_id, description, quantity, unit_price, variant_extra, is_addon, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [sub!.id, l.product_id, l.variant_id, l.description, l.quantity, l.unit_price, l.variant_extra, l.is_addon, l.sort],
      );
    }
    await refreshRecurring(client, sub!.id, today, { countsAsLive: false });
    await logEvent(client, sub!.id, 'created', { to: 'draft', actor: actor.name, on: today, detail: template ? { template: template.name } : {} });
    await audit(actor.name, 'subscription.create', 'subscription', sub!.id, { number });
    return { id: sub!.id as number, number };
  });
}

export async function updateLines(id: number, drafts: LineDraft[], actor: Actor) {
  return tx(async (client) => {
    const sub = await lockSubscription(client, id);
    if (!['draft', 'quotation'].includes(sub.status)) throw conflict('Lines can only change before the subscription is confirmed');
    const { today } = await appState(client);
    const plan = await one(`SELECT * FROM plans WHERE id = $1`, [sub.plan_id], client);
    const lines = await resolveLines(client, plan, drafts);
    assertPlanOffer(plan, sub.start_date, lines);
    await client.query(`DELETE FROM subscription_lines WHERE subscription_id = $1`, [id]);
    for (const l of lines) {
      await client.query(
        `INSERT INTO subscription_lines (subscription_id, product_id, variant_id, description, quantity, unit_price, variant_extra, is_addon, sort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, l.product_id, l.variant_id, l.description, l.quantity, l.unit_price, l.variant_extra, l.is_addon, l.sort],
      );
    }
    await refreshRecurring(client, id, today, { countsAsLive: false });
    await logEvent(client, id, 'lines_updated', { actor: actor.name, on: today });
  });
}

async function activate(client: PoolClient, sub: any, today: string, actor: string) {
  const start = sub.start_date > today ? sub.start_date : today;
  await client.query(
    `UPDATE subscriptions SET status = 'active', activated_on = $2, billing_anchor = $2, next_period_index = 0, next_billing_date = $2,
            expiry_date = CASE WHEN expiry_date <= $2 THEN $3 ELSE expiry_date END WHERE id = $1`,
    [sub.id, start, addMonths(start, sub.term_months)],
  );
  await refreshRecurring(client, sub.id, today, { countsAsLive: true });
  await logEvent(client, sub.id, 'activated', { from: sub.status, to: 'active', actor, on: today });
}

export async function transition(id: number, to: SubscriptionStatus, actor: Actor, opts: { reason?: string } = {}) {
  return tx(async (client) => {
    const sub = await lockSubscription(client, id);
    const from = sub.status as SubscriptionStatus;
    if (from === to) return;
    if (!canMoveSubscription(from, to)) throw conflict(`A ${from} subscription cannot move to ${to}`);
    const { today, company } = await appState(client);

    if (to === 'quotation') {
      const template = sub.template_id ? await one(`SELECT validity_days FROM quotation_templates WHERE id = $1`, [sub.template_id], client) : null;
      const validUntil = addDays(today, template?.validity_days ?? 30);
      await client.query(`UPDATE subscriptions SET status = 'quotation', quotation_valid_until = $2 WHERE id = $1`, [id, validUntil]);
      await sendMail({
        to: sub.customer_email,
        subject: `Your quotation ${sub.number} from ${company.name}`,
        body: `Hello ${sub.customer_name},\n\nYour quotation ${sub.number} for ${sub.plan_name} comes to ${formatINR(sub.recurring_amount)} before tax, ${recurrenceWord(sub)}. It stays valid until ${validUntil}.\n\nSign in to your portal to accept it.\n\n${company.name}`,
        kind: 'quotation',
        onDate: today,
      }, client);
      await logEvent(client, id, 'status', { from, to, actor: actor.name, on: today, detail: { validUntil } });
    } else if (to === 'confirmed') {
      if (sub.quotation_valid_until && sub.quotation_valid_until < today) throw conflict(`This quotation expired on ${sub.quotation_valid_until}. Send a new one`);
      await client.query(`UPDATE subscriptions SET status = 'confirmed' WHERE id = $1`, [id]);
      await logEvent(client, id, 'status', { from, to, actor: actor.name, on: today });
    } else if (to === 'active') {
      if (from === 'paused') throw conflict('Use resume to restart a paused subscription');
      await activate(client, sub, today, actor.name);
    } else if (to === 'closed') {
      if (['active', 'paused'].includes(from)) assertPlanAllows(sub, 'close', actor);
      await closeLocked(client, sub, today, actor.name, opts.reason ?? 'Closed by request');
    } else if (to === 'draft') {
      await client.query(`UPDATE subscriptions SET status = 'draft', quotation_valid_until = NULL WHERE id = $1`, [id]);
      await logEvent(client, id, 'status', { from, to, actor: actor.name, on: today });
    }
    await audit(actor.name, `subscription.${to}`, 'subscription', id, { number: sub.number, from, reason: opts.reason });
  });
}

const recurrenceWord = (sub: any) => ({ daily: 'per day', weekly: 'per week', monthly: 'per month', yearly: 'per year' })[sub.billing_unit as string];

export async function closeLocked(client: PoolClient, sub: any, today: string, actor: string, reason: string) {
  await setSubscriptionMrr(client, sub.id, 0, today);
  await client.query(`UPDATE subscriptions SET status = 'closed', closed_on = $2, close_reason = $3, next_billing_date = NULL WHERE id = $1`, [sub.id, today, reason]);
  await logEvent(client, sub.id, 'closed', { from: sub.status, to: 'closed', actor, on: today, detail: { reason } });
}

export async function pause(id: number, actor: Actor) {
  return tx(async (client) => {
    const sub = await lockSubscription(client, id);
    if (sub.status !== 'active') throw conflict('Only an active subscription can be paused');
    assertPlanAllows(sub, 'pause', actor);
    const { today } = await appState(client);
    await client.query(`UPDATE subscriptions SET status = 'paused', paused_on = $2 WHERE id = $1`, [id, today]);
    await setSubscriptionMrr(client, id, 0, today);
    await logEvent(client, id, 'paused', { from: 'active', to: 'paused', actor: actor.name, on: today });
    await audit(actor.name, 'subscription.pause', 'subscription', id, { number: sub.number });
  });
}

/**
 * Restarts billing. A customer has paid through their next billing date, so if they
 * come back before it nothing changes. After it, billing restarts from today and the
 * paused stretch is never charged.
 */
export async function resume(id: number, actor: Actor) {
  return tx(async (client) => {
    const sub = await lockSubscription(client, id);
    if (sub.status !== 'paused') throw conflict('This subscription is not paused');
    const { today } = await appState(client);
    if (sub.next_billing_date && sub.next_billing_date < today) {
      await client.query(`UPDATE subscriptions SET billing_anchor = $2, next_period_index = 0, next_billing_date = $2 WHERE id = $1`, [id, today]);
    }
    await client.query(`UPDATE subscriptions SET status = 'active', paused_on = NULL WHERE id = $1`, [id]);
    await refreshRecurring(client, id, today, { countsAsLive: true });
    await logEvent(client, id, 'resumed', { from: 'paused', to: 'active', actor: actor.name, on: today, detail: { pausedOn: sub.paused_on } });
    await audit(actor.name, 'subscription.resume', 'subscription', id, { number: sub.number });
  });
}

export async function renewLocked(client: PoolClient, sub: any, today: string, actor: string) {
  const from = sub.expiry_date ?? today;
  const nextExpiry = addMonths(from > today ? from : today, sub.term_months);
  await client.query(`UPDATE subscriptions SET expiry_date = $2 WHERE id = $1`, [sub.id, nextExpiry]);
  if (!sub.next_billing_date) {
    const next = periodAt(sub.billing_anchor, sub.next_period_index, recurrenceOf(sub), nextExpiry);
    const billed = await one(
      `SELECT max(upper(period)) AS through FROM billing_periods WHERE subscription_id = $1 AND state <> 'voided'`,
      [sub.id],
      client,
    );
    if (billed?.through && billed.through < next.start) {
      // The last period was cut short at expiry. Restart billing where it stopped,
      // otherwise the days up to the old anchor would never be billed.
      await client.query(
        `UPDATE subscriptions SET billing_anchor = $2, next_period_index = 0, next_billing_date = $2 WHERE id = $1`,
        [sub.id, billed.through],
      );
    } else {
      await client.query(`UPDATE subscriptions SET next_billing_date = $2 WHERE id = $1`, [sub.id, next.start]);
    }
  }
  await logEvent(client, sub.id, 'renewed', { actor, on: today, detail: { until: nextExpiry } });
  return nextExpiry;
}

export async function renew(id: number, actor: Actor) {
  return tx(async (client) => {
    const sub = await lockSubscription(client, id);
    if (!['active', 'paused'].includes(sub.status)) throw conflict('Only a live subscription can be renewed');
    assertPlanAllows(sub, 'renew', actor);
    const { today } = await appState(client);
    const until = await renewLocked(client, sub, today, actor.name);
    await audit(actor.name, 'subscription.renew', 'subscription', id, { number: sub.number, until });
    return { until };
  });
}

export async function attachDiscount(subscriptionId: number, code: string, actor: Actor) {
  return tx(async (client) => {
    await lockSubscription(client, subscriptionId);
    const { today } = await appState(client);
    const discount = await one(`SELECT * FROM discounts WHERE code = $1`, [code], client);
    if (!discount) throw notFound(`Discount ${code}`);
    if (!discount.active) throw conflict(`${discount.code} is switched off`);
    if (discount.valid_until && discount.valid_until < today) throw conflict(`${discount.code} expired on ${discount.valid_until}`);
    if (discount.usage_limit !== null && discount.times_used >= discount.usage_limit) throw conflict(`${discount.code} has reached its usage limit`);
    await client.query(`INSERT INTO subscription_discounts (subscription_id, discount_id, attached_on) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [subscriptionId, discount.id, today]);
    await logEvent(client, subscriptionId, 'discount_added', { actor: actor.name, on: today, detail: { code: discount.code } });
    await audit(actor.name, 'subscription.discount', 'subscription', subscriptionId, { code: discount.code });
  });
}

export async function detachDiscount(subscriptionId: number, discountId: number, actor: Actor) {
  const { today } = await appState();
  await tx(async (client) => {
    await client.query(`DELETE FROM subscription_discounts WHERE subscription_id = $1 AND discount_id = $2`, [subscriptionId, discountId]);
    await logEvent(client, subscriptionId, 'discount_removed', { actor: actor.name, on: today, detail: { discountId } });
  });
}

export async function addonOffers(subscriptionId: number, db: Db) {
  return q(
    `SELECT pa.product_id, pa.price, p.name, p.notes,
            l.id AS line_id, l.active_until,
            (l.id IS NOT NULL AND l.active_until IS NULL) AS enabled
       FROM subscriptions s
       JOIN plan_addons pa ON pa.plan_id = s.plan_id
       JOIN products p ON p.id = pa.product_id AND p.active
       LEFT JOIN subscription_lines l ON l.subscription_id = s.id AND l.product_id = pa.product_id
      WHERE s.id = $1
      ORDER BY p.name`,
    [subscriptionId],
    db,
  );
}

/** What switching an add-on on or off will cost, before anything changes. */
export async function previewAddon(subscriptionId: number, productId: number, enable: boolean, db: Db) {
  const sub = await one(
    `SELECT s.*, p.billing_unit, p.billing_interval FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = $1`,
    [subscriptionId],
    db,
  );
  if (!sub) throw notFound('Subscription');
  if (sub.status !== 'active') throw conflict('Add-ons can only change on an active subscription');
  const offer = await one(`SELECT pa.price, pr.name FROM plan_addons pa JOIN products pr ON pr.id = pa.product_id WHERE pa.plan_id = $1 AND pa.product_id = $2`, [sub.plan_id, productId], db);
  if (!offer) throw invalid('This add-on is not offered on your plan');
  const { today } = await appState(db);
  const recurrence = recurrenceOf(sub);
  const periodEnd = sub.next_billing_date ?? sub.expiry_date;
  const periodBegin = periodAt(sub.billing_anchor, Math.max(0, sub.next_period_index - 1), recurrence, sub.expiry_date).start;
  const charge = enable && periodEnd ? prorateRemaining(offer.price, today, periodEnd, periodBegin) : 0;
  const recurring = sub.recurring_amount + (enable ? offer.price : -offer.price);
  return {
    name: offer.name as string,
    price: offer.price as number,
    enable,
    chargeNow: charge,
    effectiveFrom: enable ? today : periodEnd,
    nextBillingDate: periodEnd,
    currentRecurring: sub.recurring_amount as number,
    newRecurring: recurring as number,
    message: enable
      ? `${offer.name} starts today. Your next invoice adds ${formatINR(charge)} for the rest of this period, then ${formatINR(offer.price)} each period.`
      : `${offer.name} stays on until ${periodEnd}, the end of the period you have paid for. Nothing is charged after that.`,
  };
}

export async function setAddon(subscriptionId: number, productId: number, enable: boolean, actor: Actor) {
  return tx(async (client) => {
    const preview = await previewAddon(subscriptionId, productId, enable, client);
    const sub = await lockSubscription(client, subscriptionId);
    const { today } = await appState(client);
    const line = await one(`SELECT * FROM subscription_lines WHERE subscription_id = $1 AND product_id = $2`, [subscriptionId, productId], client);

    if (enable) {
      if (line && line.active_until === null) throw conflict(`${preview.name} is already on`);
      if (line) {
        await client.query(`UPDATE subscription_lines SET active_until = NULL WHERE id = $1`, [line.id]);
      } else {
        await client.query(
          `INSERT INTO subscription_lines (subscription_id, product_id, description, quantity, unit_price, is_addon, active_from, sort)
           VALUES ($1,$2,$3,1,$4,true,$5,99)`,
          [subscriptionId, productId, preview.name, preview.price, sub.next_billing_date],
        );
        if (preview.chargeNow > 0) {
          await client.query(
            `INSERT INTO pending_charges (subscription_id, product_id, description, amount, created_on) VALUES ($1,$2,$3,$4,$5)`,
            [subscriptionId, productId, `${preview.name}, from ${today} to ${preview.nextBillingDate}`, preview.chargeNow, today],
          );
        }
      }
      await refreshRecurring(client, subscriptionId, today, { countsAsLive: true });
    } else {
      if (!line || line.active_until !== null) throw conflict(`${preview.name} is not on`);
      await client.query(`UPDATE subscription_lines SET active_until = $2 WHERE id = $1`, [line.id, sub.next_billing_date ?? today]);
      await refreshRecurring(client, subscriptionId, today, { countsAsLive: true, linesAsOf: sub.next_billing_date ?? today });
    }
    await logEvent(client, subscriptionId, enable ? 'addon_on' : 'addon_off', { actor: actor.name, on: today, detail: { addon: preview.name, charge: preview.chargeNow } });
    await audit(actor.name, enable ? 'addon.on' : 'addon.off', 'subscription', subscriptionId, { addon: preview.name });
    return preview;
  });
}

/** Handles a contract reaching its expiry date, following that plan's policy. */
export async function processExpiry(client: PoolClient, id: number, today: string) {
  const sub = await lockSubscription(client, id);
  const outcome = onExpiry(policyOf(sub), sub.auto_renew);
  if (outcome === 'renew') {
    await renewLocked(client, sub, today, 'Keel');
    return 'renewed' as const;
  }
  if (outcome === 'close') {
    await closeLocked(client, sub, today, 'Keel', 'Closed on its own at the end of the plan');
    return 'closed' as const;
  }
  return 'needs_decision' as const;
}

/** Every period a contract would still bill between two dates. Used for forecasts. */
export function futurePeriods(sub: { billing_anchor: string; next_period_index: number; billing_unit: any; billing_interval: number; expiry_date: string | null }, until: string) {
  return duePeriods({
    anchor: sub.billing_anchor,
    nextIndex: sub.next_period_index,
    recurrence: { unit: sub.billing_unit, interval: sub.billing_interval },
    expiry: sub.expiry_date,
    asOf: until,
  });
}

export { monthlyValue };
