import type { PoolClient } from 'pg';
import { monthlyValue, type BillingUnit } from '../engine/index.ts';
import { one } from '../db/pool.ts';

export type MrrKind = 'new' | 'expansion' | 'contraction' | 'churn' | 'reactivation';

/** Classifies a change from the customer's point of view, following ChartMogul's convention. */
export function classifyMrr(params: { customerBefore: number; customerAfter: number; everPaid: boolean; delta: number }): MrrKind {
  const { customerBefore, customerAfter, everPaid, delta } = params;
  if (delta > 0) {
    if (customerBefore === 0) return everPaid ? 'reactivation' : 'new';
    return 'expansion';
  }
  return customerAfter === 0 ? 'churn' : 'contraction';
}

/** Moves a subscription to a new MRR and writes the movement row that explains why. */
export async function setSubscriptionMrr(client: PoolClient, subscriptionId: number, nextMrr: number, onDate: string) {
  const sub = await one(`SELECT id, customer_id, plan_id, mrr FROM subscriptions WHERE id = $1`, [subscriptionId], client);
  if (!sub || sub.mrr === nextMrr) return;
  const delta = nextMrr - sub.mrr;
  const totals = await one(
    `SELECT COALESCE(sum(mrr), 0)::bigint AS before,
            EXISTS (SELECT 1 FROM mrr_movements WHERE customer_id = $1) AS ever_paid
       FROM subscriptions WHERE customer_id = $1`,
    [sub.customer_id],
    client,
  );
  const kind = classifyMrr({
    customerBefore: totals.before,
    customerAfter: totals.before + delta,
    everPaid: totals.ever_paid,
    delta,
  });
  await client.query(`UPDATE subscriptions SET mrr = $2 WHERE id = $1`, [subscriptionId, nextMrr]);
  await client.query(
    `INSERT INTO mrr_movements (on_date, subscription_id, customer_id, plan_id, kind, delta) VALUES ($1,$2,$3,$4,$5,$6)`,
    [onDate, subscriptionId, sub.customer_id, sub.plan_id, kind, delta],
  );
}

/**
 * Recomputes the recurring amount from live lines. `linesAsOf` looks ahead, so an
 * add-on ending at period end drops out of MRR today, when the decision is made.
 */
export async function refreshRecurring(client: PoolClient, subscriptionId: number, onDate: string, opts: { countsAsLive: boolean; linesAsOf?: string }) {
  const row = await one(
    `SELECT COALESCE(sum(l.quantity * l.unit_price) FILTER (
              WHERE (l.active_until IS NULL OR l.active_until > $2)), 0)::bigint AS recurring,
            p.billing_unit, p.billing_interval
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       LEFT JOIN subscription_lines l ON l.subscription_id = s.id
      WHERE s.id = $1
      GROUP BY p.billing_unit, p.billing_interval`,
    [subscriptionId, opts.linesAsOf ?? onDate],
    client,
  );
  await client.query(`UPDATE subscriptions SET recurring_amount = $2 WHERE id = $1`, [subscriptionId, row.recurring]);
  const value = monthlyValue(row.recurring, { unit: row.billing_unit as BillingUnit, interval: row.billing_interval });
  if (opts.countsAsLive) await setSubscriptionMrr(client, subscriptionId, value, onDate);
  return { recurring: row.recurring as number, mrr: value };
}
