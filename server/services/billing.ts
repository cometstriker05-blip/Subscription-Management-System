// Billing day. The rehearsal and the real run share computeInvoice and the same
// plan, so what you preview is what gets billed.
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one, PG_ERRORS, pool, q, tx, type Db } from '../db/pool.ts';
import {
  addDays, computeInvoice, duePeriods, financialYear, formatINR, periodAt, resolveTaxRule,
  type BillingPeriod, type BillingUnit, type ComputedInvoice, type DiscountRule, type InvoiceInput,
  type LineInput, type Recurrence, type SupplyType, type TaxRule,
} from '../engine/index.ts';
import { bumpDataVersion } from './cache.ts';
import { appState, audit, conflict, notFound, type Company } from './core.ts';

export interface BillingContext {
  taxRules: TaxRule[];
  discounts: Map<number, DiscountRule>;
  autoDiscountIds: number[];
  company: Company;
}

export function taxRuleFromRow(r: any): TaxRule {
  return {
    id: r.id, name: r.name, taxCategory: r.tax_category, supply: r.supply, components: r.components,
    validFrom: r.valid_from, validUntil: r.valid_until, priority: r.priority, active: r.active,
  };
}

export function discountFromRow(r: any, productIds: number[]): DiscountRule {
  return {
    id: r.id, code: r.code, name: r.name, kind: r.kind, value: r.value, minPurchase: r.min_purchase,
    minQuantity: r.min_quantity, validFrom: r.valid_from, validUntil: r.valid_until, usageLimit: r.usage_limit,
    timesUsed: r.times_used, scope: r.scope, productIds, active: r.active,
  };
}

export async function loadContext(db: Db = pool): Promise<BillingContext> {
  const [state, taxes, discounts, links] = await Promise.all([
    appState(db),
    q(`SELECT * FROM tax_rules ORDER BY id`, [], db),
    q(`SELECT * FROM discounts ORDER BY id`, [], db),
    q(`SELECT * FROM discount_products`, [], db),
  ]);
  const byDiscount = new Map<number, number[]>();
  for (const l of links) byDiscount.set(l.discount_id, [...(byDiscount.get(l.discount_id) ?? []), l.product_id]);
  return {
    taxRules: taxes.map(taxRuleFromRow),
    discounts: new Map(discounts.map((d) => [d.id, discountFromRow(d, byDiscount.get(d.id) ?? [])])),
    autoDiscountIds: discounts.filter((d) => d.auto_apply).map((d) => d.id),
    company: state.company,
  };
}

export interface SubscriptionBundle {
  id: number;
  number: string;
  status: string;
  customer_id: number;
  plan_id: number;
  billing_anchor: string;
  next_period_index: number;
  next_billing_date: string | null;
  expiry_date: string | null;
  auto_renew: boolean;
  renewable: boolean;
  net_days: number;
  plan_name: string;
  billing_unit: BillingUnit;
  billing_interval: number;
  customer: any;
  lines: any[];
  discount_ids: number[];
  charges: any[];
  voided: { id: number; period_index: number; lower: string; upper: string }[];
  last_total: number | null;
  overdue_total: number;
}

const BUNDLE_SQL = `
  SELECT s.id, s.number, s.status, s.customer_id, s.plan_id, s.billing_anchor, s.next_period_index,
         s.next_billing_date, s.expiry_date, s.auto_renew, t.net_days,
         p.name AS plan_name, p.billing_unit, p.billing_interval, p.renewable,
         to_jsonb(c) AS customer,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'id', l.id, 'product_id', l.product_id, 'variant_id', l.variant_id, 'description', l.description,
              'quantity', l.quantity, 'unit_price', l.unit_price, 'variant_extra', l.variant_extra,
              'active_from', l.active_from, 'active_until', l.active_until,
              'tax_category', pr.tax_category, 'sac', pr.sac) ORDER BY l.sort, l.id)
            FROM subscription_lines l JOIN products pr ON pr.id = l.product_id
           WHERE l.subscription_id = s.id), '[]') AS lines,
         COALESCE((SELECT array_agg(sd.discount_id) FROM subscription_discounts sd WHERE sd.subscription_id = s.id), '{}') AS discount_ids,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', pc.id, 'product_id', pc.product_id, 'description', pc.description,
              'amount', pc.amount, 'tax_category', pr.tax_category, 'sac', pr.sac))
            FROM pending_charges pc JOIN products pr ON pr.id = pc.product_id
           WHERE pc.subscription_id = s.id AND pc.invoice_id IS NULL), '[]') AS charges,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', bp.id, 'period_index', bp.period_index,
              'lower', lower(bp.period), 'upper', upper(bp.period)) ORDER BY bp.period_index)
            FROM billing_periods bp
           WHERE bp.subscription_id = s.id AND bp.state = 'voided' AND bp.replaced_by IS NULL), '[]') AS voided,
         (SELECT i.total FROM invoices i
           WHERE i.subscription_id = s.id AND i.status <> 'cancelled'
           ORDER BY i.period_start DESC LIMIT 1) AS last_total,
         COALESCE((SELECT sum(i.total - i.amount_paid) FROM invoices i
           WHERE i.customer_id = s.customer_id AND i.status = 'confirmed' AND i.due_date < $2), 0)::bigint AS overdue_total
    FROM subscriptions s
    JOIN customers c ON c.id = s.customer_id
    JOIN plans p ON p.id = s.plan_id
    JOIN payment_terms t ON t.id = s.payment_term_id
   WHERE s.id = ANY($1::bigint[])`;

export const loadBundles = (ids: number[], asOf: string, db: Db = pool) => q<any>(BUNDLE_SQL, [ids, asOf], db) as Promise<SubscriptionBundle[]>;

export function supplyFor(customer: { country: string; state_code: string | null }, company: Company): SupplyType {
  if (customer.country !== 'IN') return 'export';
  return customer.state_code === company.stateCode ? 'intra' : 'inter';
}

const recurrenceOf = (b: SubscriptionBundle): Recurrence => ({ unit: b.billing_unit, interval: b.billing_interval });

/** A contract that will renew has no real end, so its periods are never cut short. */
const billingEnd = (b: SubscriptionBundle) => (b.auto_renew && b.renewable ? null : b.expiry_date);

function periodsFor(b: SubscriptionBundle, asOf: string): (BillingPeriod & { replaces?: number })[] {
  const rebill = b.voided.map((v) => {
    const computed = periodAt(b.billing_anchor, v.period_index, recurrenceOf(b), billingEnd(b));
    // A pause can move the anchor, in which case the stored dates are the truth.
    const fullEnd = computed.start === v.lower ? computed.fullEnd : v.upper;
    return { index: v.period_index, start: v.lower, end: v.upper, fullEnd, replaces: v.id };
  });
  const due = b.status === 'active'
    ? duePeriods({ anchor: b.billing_anchor, nextIndex: b.next_period_index, recurrence: recurrenceOf(b), expiry: billingEnd(b), asOf })
    : [];
  return [...rebill, ...due];
}

/** Assembles the exact engine input. Stored on the invoice so it can be replayed forever. */
export function buildInput(b: SubscriptionBundle, period: BillingPeriod, ctx: BillingContext, allowedDiscounts?: Set<number>): InvoiceInput {
  const on = period.start;
  const lines: LineInput[] = b.lines
    .filter((l) => (!l.active_from || l.active_from <= on) && (!l.active_until || l.active_until > on))
    .map((l) => ({
      lineId: l.id,
      productId: l.product_id,
      variantId: l.variant_id,
      description: l.description,
      taxCategory: l.tax_category,
      sac: l.sac,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      ...(l.variant_extra ? { variantExtra: l.variant_extra, basePrice: l.unit_price - l.variant_extra } : {}),
    }));

  for (const c of b.charges) {
    lines.push({
      lineId: null, productId: c.product_id, variantId: null, description: c.description, taxCategory: c.tax_category,
      sac: c.sac, quantity: 1, unitPrice: c.amount, oneOff: true,
    });
  }

  const ids = new Set([...b.discount_ids.map(Number), ...ctx.autoDiscountIds]);
  const discounts = [...ids]
    .filter((id) => !allowedDiscounts || allowedDiscounts.has(id))
    .map((id) => ctx.discounts.get(id))
    .filter((d): d is DiscountRule => !!d);

  const supply = supplyFor(b.customer, ctx.company);
  const rules = new Map<number, TaxRule>();
  for (const line of lines) {
    const rule = resolveTaxRule(ctx.taxRules, line.taxCategory, supply, on);
    if (rule) rules.set(rule.id, rule);
  }

  return {
    subscriptionNumber: b.number,
    planName: b.plan_name,
    period: { start: period.start, end: period.end, fullEnd: period.fullEnd },
    issueDate: on,
    supply,
    lines,
    discounts,
    // Only the rules that matter are kept, which also makes a problem-free replay exact.
    taxRules: [...rules.values()],
  };
}

export type Severity = 'blocker' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  code: string;
  subscriptionId: number;
  subscription: string;
  customer: string;
  message: string;
}

export interface PlannedInvoice {
  subscriptionId: number;
  subscription: string;
  customer: string;
  plan: string;
  periodStart: string;
  periodEnd: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  discountIds: number[];
}

export interface Rehearsal {
  asOf: string;
  subscriptions: number;
  invoices: number;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  byPlan: { plan: string; invoices: number; total: number }[];
  findings: Finding[];
  counts: Record<Severity, number>;
  planned: PlannedInvoice[];
  fingerprint: string;
  ms: number;
}

export function fingerprintOf(rows: { subscriptionId: number; periodStart: string; total: number }[]): string {
  const hash = createHash('sha256');
  for (const r of [...rows].sort((a, b) => a.subscriptionId - b.subscriptionId || a.periodStart.localeCompare(b.periodStart))) {
    hash.update(`${r.subscriptionId}:${r.periodStart}:${r.total};`);
  }
  return hash.digest('hex').slice(0, 16);
}

export async function dueSubscriptionIds(asOf: string, db: Db = pool): Promise<number[]> {
  const rows = await q(
    `SELECT id FROM subscriptions WHERE status = 'active' AND next_billing_date <= $1
     UNION
     SELECT DISTINCT subscription_id FROM billing_periods WHERE state = 'voided' AND replaced_by IS NULL
     ORDER BY 1`,
    [asOf],
    db,
  );
  return rows.map((r) => r.id);
}

/**
 * Plans a billing run without writing anything. Usage-limited discounts are spent
 * in-memory in subscription order, so a limit that runs out mid-run is predicted
 * on exactly the invoice where it happens.
 */
export async function rehearse(asOf: string, db: Db = pool): Promise<Rehearsal> {
  const started = performance.now();
  const ctx = await loadContext(db);
  const ids = await dueSubscriptionIds(asOf, db);
  const bundles = (await loadBundles(ids, asOf, db)).sort((a, b) => a.id - b.id);

  const used = new Map<number, number>();
  const planned: PlannedInvoice[] = [];
  const findings: Finding[] = [];
  const plans = new Map<string, { plan: string; invoices: number; total: number }>();
  const exhausted = new Set<number>();
  const expiring = new Map<number, string>();

  for (const b of bundles) {
    const periods = periodsFor(b, asOf);
    const note = (severity: Severity, code: string, message: string) =>
      findings.push({ severity, code, subscriptionId: b.id, subscription: b.number, customer: b.customer.name, message });

    if (periods.length > 1) note('warning', 'catch_up', `${periods.length} periods are due at once, starting ${periods[0].start}. Keel will bill them in order`);
    if (b.overdue_total > 0 && b.overdue_total > (b.last_total ?? 0) * 2) note('info', 'billing_into_debt', `This customer already owes ${formatINR(b.overdue_total)} overdue`);

    for (const period of periods) {
      const input = buildInput(b, period, ctx);
      // Spend limited discounts from the running count, not the stored one.
      input.discounts = input.discounts.map((d) => ({ ...d, timesUsed: d.timesUsed + (used.get(d.id) ?? 0) }));
      const result = computeInvoice(input);

      for (const d of result.discounts) used.set(d.discountId, (used.get(d.discountId) ?? 0) + 1);
      for (const s of result.skippedDiscounts) {
        if (s.reason === 'used_up' && !exhausted.has(s.discountId) && b.discount_ids.map(Number).includes(s.discountId)) {
          exhausted.add(s.discountId);
          note('warning', 'discount_ran_out', `${s.code} reaches its usage limit in this run. ${b.number} and later invoices pay full price`);
        }
      }
      for (const d of input.discounts) {
        if (d.validUntil && d.validUntil >= period.start && d.validUntil <= addDays(period.start, 31) && !expiring.has(d.id)) {
          expiring.set(d.id, d.code);
          note('info', 'discount_ending', `${d.code} ends on ${d.validUntil}. This is among the last invoices it reaches`);
        }
      }

      for (const p of result.problems) note('blocker', 'no_tax_rule', p);
      if (!b.customer.gstin && result.total > 5_00_000_00 && b.customer.country === 'IN') note('warning', 'missing_gstin', `Large invoice of ${formatINR(result.total)} but the customer has no GSTIN on file`);
      if (!b.customer.state_code && b.customer.country === 'IN') note('blocker', 'missing_state', 'Customer has no state, so place of supply and GST split cannot be decided');
      if (result.total === 0) note('warning', 'zero_invoice', 'This invoice comes to zero. Check the discount');
      if (b.last_total && result.total > b.last_total * 1.5 && periods.length === 1) note('warning', 'jump', `${formatINR(result.total)} is ${Math.round((result.total / b.last_total - 1) * 100)}% above the last invoice of ${formatINR(b.last_total)}`);
      if (b.last_total && result.total < b.last_total * 0.5 && periods.length === 1 && result.total > 0) note('warning', 'drop', `${formatINR(result.total)} is ${Math.round((1 - result.total / b.last_total) * 100)}% below the last invoice of ${formatINR(b.last_total)}`);
      if (period.end !== period.fullEnd) note('info', 'final_period', `Contract ends ${period.end}, so this period is prorated`);

      planned.push({
        subscriptionId: b.id, subscription: b.number, customer: b.customer.name, plan: b.plan_name,
        periodStart: period.start, periodEnd: period.end, subtotal: result.subtotal, discount: result.discount,
        tax: result.tax, total: result.total, discountIds: result.discounts.map((d) => d.discountId),
      });
      const row = plans.get(b.plan_name) ?? { plan: b.plan_name, invoices: 0, total: 0 };
      row.invoices++;
      row.total += result.total;
      plans.set(b.plan_name, row);
    }
  }

  const sum = (f: (p: PlannedInvoice) => number) => planned.reduce((acc, p) => acc + f(p), 0);
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  return {
    asOf,
    subscriptions: bundles.length,
    invoices: planned.length,
    subtotal: sum((p) => p.subtotal),
    discount: sum((p) => p.discount),
    tax: sum((p) => p.tax),
    total: sum((p) => p.total),
    byPlan: [...plans.values()].sort((a, b) => b.total - a.total),
    findings: findings.sort((a, b) => ['blocker', 'warning', 'info'].indexOf(a.severity) - ['blocker', 'warning', 'info'].indexOf(b.severity)),
    counts: { blocker: count('blocker'), warning: count('warning'), info: count('info') },
    planned,
    fingerprint: fingerprintOf(planned),
    ms: Math.round(performance.now() - started),
  };
}

export class InjectedFault extends Error {}

interface BillOptions {
  asOf: string;
  runId: number;
  ctx: BillingContext;
  /** Which limited discounts each period may use, decided by the rehearsal. */
  plan: Map<string, Set<number>>;
  fault?: () => void;
}

/** Bills one locked subscription inside the caller's transaction. */
async function billLocked(client: PoolClient, subscriptionId: number, opts: BillOptions) {
  const { asOf, runId, ctx, plan } = opts;
  const [bundle] = await loadBundles([subscriptionId], asOf, client);
  const periods = periodsFor(bundle, asOf);
  const created: { id: number; total: number }[] = [];
  let chargesLeft = bundle;

  for (const period of periods) {
    const key = `${bundle.id}:${period.start}`;
    const allowed = plan.get(key);
    const input = buildInput(chargesLeft, period, ctx, allowed);
    const result = await claimDiscountsAndCompute(client, input);

    const dueDate = addDays(asOf, bundle.net_days);
    const invoice = await one(
      `INSERT INTO invoices (subscription_id, customer_id, status, issue_date, due_date, period_start, period_end, supply,
          subtotal, discount, taxable, tax, total, tax_summary, customer_snapshot, engine_input, run_id)
       VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [bundle.id, bundle.customer_id, asOf, dueDate, period.start, period.end, input.supply, result.subtotal, result.discount,
        result.taxable, result.tax, result.total, JSON.stringify(result.taxSummary), JSON.stringify(bundle.customer),
        JSON.stringify(input), runId],
      client,
    );

    await client.query(
      `INSERT INTO invoice_lines (invoice_id, product_id, variant_id, description, sac, quantity, unit_price, gross, discount, taxable, tax, amount, taxes)
       SELECT $1, x.product_id, x.variant_id, x.description, x.sac, x.quantity, x.unit_price, x.gross, x.discount, x.taxable, x.tax, x.amount, x.taxes
         FROM jsonb_to_recordset($2) AS x(product_id bigint, variant_id bigint, description text, sac text, quantity int,
              unit_price bigint, gross bigint, discount bigint, taxable bigint, tax bigint, amount bigint, taxes jsonb)`,
      [invoice!.id, JSON.stringify(result.lines.map((l) => ({
        product_id: l.productId, variant_id: l.variantId, description: l.description, sac: l.sac, quantity: l.quantity,
        unit_price: l.unitPrice, gross: l.gross, discount: l.discount, taxable: l.taxable, tax: l.tax, amount: l.amount, taxes: l.taxes,
      })))],
    );

    for (const d of result.discounts) {
      await client.query(`INSERT INTO discount_redemptions (discount_id, invoice_id, subscription_id, amount) VALUES ($1,$2,$3,$4)`, [d.discountId, invoice!.id, bundle.id, d.amount]);
    }

    // This insert is the wall. An overlapping period raises 23P01 and the whole transaction rolls back.
    const row = await one(
      `INSERT INTO billing_periods (subscription_id, period_index, period, state, invoice_id, run_id)
       VALUES ($1,$2,daterange($3::date,$4::date,'[)'),'billed',$5,$6) RETURNING id`,
      [bundle.id, period.index, period.start, period.end, invoice!.id, runId],
      client,
    );

    if (period.replaces) {
      await client.query(`UPDATE billing_periods SET replaced_by = $2 WHERE id = $1`, [period.replaces, row!.id]);
    } else {
      const nextIndex = period.index + 1;
      const end = billingEnd(bundle);
      const next = periodAt(bundle.billing_anchor, nextIndex, recurrenceOf(bundle), end);
      const nextDate = end && next.start >= end ? null : next.start;
      await client.query(`UPDATE subscriptions SET next_period_index = $2, next_billing_date = $3 WHERE id = $1`, [bundle.id, nextIndex, nextDate]);
    }

    if (chargesLeft.charges.length) {
      await client.query(`UPDATE pending_charges SET invoice_id = $2 WHERE id = ANY($1::bigint[])`, [chargesLeft.charges.map((c) => c.id), invoice!.id]);
      chargesLeft = { ...chargesLeft, charges: [] };
    }

    opts.fault?.();
    created.push({ id: invoice!.id, total: result.total });
  }
  return created;
}

/** Atomically spends each discount. If one ran out, recompute without it and try again. */
async function claimDiscountsAndCompute(client: PoolClient, input: InvoiceInput): Promise<ComputedInvoice> {
  for (;;) {
    const result = computeInvoice(input);
    const applied = [...result.discounts].sort((a, b) => a.discountId - b.discountId);
    let failed: number | null = null;
    const claimed: number[] = [];
    for (const d of applied) {
      const hit = await one(
        `UPDATE discounts SET times_used = times_used + 1
          WHERE id = $1 AND (usage_limit IS NULL OR times_used < usage_limit) RETURNING id`,
        [d.discountId],
        client,
      );
      if (hit) claimed.push(d.discountId);
      else {
        failed = d.discountId;
        break;
      }
    }
    if (failed === null) return result;
    if (claimed.length) await client.query(`UPDATE discounts SET times_used = times_used - 1 WHERE id = ANY($1::bigint[])`, [claimed]);
    input.discounts = input.discounts.filter((d) => d.id !== failed);
  }
}

export interface RunProgress {
  runId: number;
  done: number;
  expected: number;
  invoices: number;
  total: number;
  blockedDuplicates: number;
  faultsInjected: number;
}

export interface RunOptions {
  asOf: string;
  kind: 'manual' | 'scheduled' | 'chaos';
  actor: string;
  workers?: number;
  faultRate?: number;
  onProgress?: (p: RunProgress) => void;
}

/**
 * Runs billing with parallel workers. Each worker takes one due subscription with
 * FOR UPDATE SKIP LOCKED, bills it in its own transaction and commits. A crash loses
 * at most that one transaction, and the subscription is simply due again.
 */
export async function runBilling(opts: RunOptions) {
  const { asOf, kind, actor, workers = 6, faultRate = 0, onProgress } = opts;
  const plan = await rehearse(asOf);
  const ctx = await loadContext();
  const run = await one(
    `INSERT INTO billing_runs (run_date, kind, actor, fingerprint) VALUES ($1,$2,$3,$4) RETURNING id`,
    [asOf, kind, actor, plan.fingerprint],
  );
  const runId: number = run!.id;

  const allowed = new Map<string, Set<number>>();
  for (const p of plan.planned) allowed.set(`${p.subscriptionId}:${p.periodStart}`, new Set(p.discountIds));

  const state = { done: 0, invoices: 0, total: 0, blocked: 0, faults: 0 };
  const failed: { id: number; error: string }[] = [];
  const failedIds = new Set<number>();
  let lastEmit = 0;

  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 120) return;
    lastEmit = now;
    onProgress?.({ runId, done: state.done, expected: plan.subscriptions, invoices: state.invoices, total: state.total, blockedDuplicates: state.blocked, faultsInjected: state.faults });
  };

  const claim = async (client: PoolClient) => {
    const skip = [...failedIds];
    const due = await one(
      `SELECT id FROM subscriptions
        WHERE status = 'active' AND next_billing_date <= $1 AND NOT (id = ANY($2::bigint[]))
        ORDER BY next_billing_date, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [asOf, skip],
      client,
    );
    if (due) return due.id as number;
    const rebill = await one(
      `SELECT s.id FROM subscriptions s
        WHERE s.id IN (SELECT subscription_id FROM billing_periods WHERE state = 'voided' AND replaced_by IS NULL)
          AND NOT (s.id = ANY($1::bigint[]))
        ORDER BY s.id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`,
      [skip],
      client,
    );
    return (rebill?.id as number) ?? null;
  };

  const worker = async () => {
    for (;;) {
      const client = await pool.connect();
      let claimed: number | null = null;
      try {
        await client.query('BEGIN');
        claimed = await claim(client);
        if (claimed === null) {
          await client.query('ROLLBACK');
          return;
        }
        const fault = faultRate > 0 ? () => { if (Math.random() < faultRate) throw new InjectedFault('Injected crash'); } : undefined;
        const created = await billLocked(client, claimed, { asOf, runId, ctx, plan: allowed, fault });
        await client.query('COMMIT');
        state.done++;
        state.invoices += created.length;
        state.total += created.reduce((sum, c) => sum + c.total, 0);
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        if (err instanceof InjectedFault) {
          state.faults++;
        } else if (err.code === PG_ERRORS.exclusion) {
          state.blocked++;
          if (claimed !== null) failedIds.add(claimed);
        } else {
          console.error(`Billing failed for subscription ${claimed}:`, err);
          if (claimed !== null) {
            failedIds.add(claimed);
            failed.push({ id: claimed, error: err.message });
          }
        }
      } finally {
        client.release();
      }
      emit();
    }
  };

  await Promise.all(Array.from({ length: workers }, worker));
  emit(true);
  bumpDataVersion();

  const actual = await q(`SELECT subscription_id, period_start, total FROM invoices WHERE run_id = $1`, [runId]);
  const fingerprint = fingerprintOf(actual.map((a) => ({ subscriptionId: a.subscription_id, periodStart: a.period_start, total: a.total })));
  const matched = fingerprint === plan.fingerprint;
  const summary = { rehearsalFingerprint: plan.fingerprint, actualFingerprint: fingerprint, matchedRehearsal: matched, rehearsalTotal: plan.total, failed };

  await pool.query(
    `UPDATE billing_runs SET status = $2, finished_at = now(), subscriptions = $3, invoices = $4, total = $5,
        blocked_duplicates = $6, faults_injected = $7, summary = $8 WHERE id = $1`,
    [runId, failed.length ? 'failed' : 'completed', state.done, state.invoices, state.total, state.blocked, state.faults, JSON.stringify(summary)],
  );
  if (state.invoices > 0 || kind !== 'scheduled') {
    await audit(actor, 'billing.run', 'billing_run', runId, { kind, asOf, invoices: state.invoices, total: state.total, matchedRehearsal: matched });
  }
  return { runId, ...state, expected: plan.subscriptions, rehearsal: { total: plan.total, invoices: plan.invoices, fingerprint: plan.fingerprint }, fingerprint, matchedRehearsal: matched, failed };
}

/** Raises and confirms one subscription's invoice straight away, for self-serve signups. */
export async function billNow(subscriptionId: number, actor: string) {
  const { today } = await appState();
  const ctx = await loadContext();
  const run = await one(`INSERT INTO billing_runs (run_date, kind, actor, status) VALUES ($1,'manual',$2,'completed') RETURNING id`, [today, actor]);
  return tx(async (client) => {
    await client.query(`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, [subscriptionId]);
    const created = await billLocked(client, subscriptionId, { asOf: today, runId: run!.id, ctx, plan: new Map() });
    await confirmInvoices(client, created.map((c) => c.id), actor);
    return created;
  });
}

/** What the next invoice will be, computed by the engine and written nowhere. */
export async function previewNext(subscriptionId: number, db: Db = pool) {
  const { today } = await appState(db);
  const [bundle] = await loadBundles([subscriptionId], today, db);
  if (!bundle || bundle.status === 'closed') return null;
  const ctx = await loadContext(db);
  const end = billingEnd(bundle);
  const period = periodAt(bundle.billing_anchor, bundle.next_period_index, recurrenceOf(bundle), end);
  if (end && period.start >= end) return null;
  const result = computeInvoice(buildInput(bundle, period, ctx));
  return { period: { start: period.start, end: period.end }, ...result };
}

/** Assigns gapless numbers per financial year. GST requires consecutive serials. */
export async function confirmInvoices(client: PoolClient, ids: number[], actor: string) {
  const rows = await q(`SELECT id, issue_date FROM invoices WHERE id = ANY($1::bigint[]) AND status = 'draft' ORDER BY id FOR UPDATE`, [ids], client);
  if (!rows.length) return 0;
  const { company } = await appState(client);
  const byYear = new Map<string, number[]>();
  for (const r of rows) {
    const fy = financialYear(r.issue_date);
    byYear.set(fy, [...(byYear.get(fy) ?? []), r.id]);
  }
  for (const [fy, invoiceIds] of [...byYear].sort()) {
    await client.query(`INSERT INTO invoice_sequences (fy, last_serial) VALUES ($1, 0) ON CONFLICT DO NOTHING`, [fy]);
    const seq = await one(`SELECT last_serial FROM invoice_sequences WHERE fy = $1 FOR UPDATE`, [fy], client);
    await client.query(
      `UPDATE invoices i SET status = 'confirmed', confirmed_at = now(), fy = $2,
              serial = $3 + x.rn, number = $4 || '/' || $2 || '/' || lpad(($3 + x.rn)::text, 6, '0')
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM unnest($1::bigint[]) AS id) x
        WHERE i.id = x.id`,
      [invoiceIds, fy, seq!.last_serial, company.invoicePrefix],
    );
    await client.query(`UPDATE invoice_sequences SET last_serial = last_serial + $2 WHERE fy = $1`, [fy, invoiceIds.length]);
  }
  await audit(actor, 'invoice.confirm', 'invoice', ids.length === 1 ? ids[0] : null, { count: rows.length }, client);
  return rows.length;
}

export async function confirmAllDrafts(actor: string, filter?: { runId?: number }) {
  return tx(async (client) => {
    const rows = await q(
      `SELECT id FROM invoices WHERE status = 'draft' ${filter?.runId ? 'AND run_id = $1' : ''} ORDER BY id`,
      filter?.runId ? [filter.runId] : [],
      client,
    );
    return confirmInvoices(client, rows.map((r) => r.id), actor);
  });
}

/**
 * Cancels an invoice. `rebill` reopens the period so the next run replaces it, which
 * is how a wrong invoice gets corrected without a skipped period. `waive` writes it off.
 */
export async function cancelInvoice(id: number, mode: 'rebill' | 'waive', reason: string, actor: string) {
  return tx(async (client) => {
    const inv = await one(`SELECT id, status, amount_paid, number FROM invoices WHERE id = $1 FOR UPDATE`, [id], client);
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'paid') throw conflict('A paid invoice cannot be cancelled');
    if (inv.status === 'cancelled') throw conflict('This invoice is already cancelled');
    if (inv.amount_paid > 0) throw conflict('This invoice has payments against it. Move those first');
    const { today } = await appState(client);

    await client.query(`UPDATE invoices SET status = 'cancelled', cancelled_on = $2, cancel_reason = $3 WHERE id = $1`, [id, today, reason]);
    await client.query(`UPDATE billing_periods SET state = $2 WHERE invoice_id = $1 AND state = 'billed'`, [id, mode === 'rebill' ? 'voided' : 'waived']);
    await client.query(`UPDATE pending_charges SET invoice_id = NULL WHERE invoice_id = $1`, [id]);

    const released = await q(`UPDATE discount_redemptions SET released_on = $2 WHERE invoice_id = $1 AND released_on IS NULL RETURNING discount_id`, [id, today], client);
    if (released.length) {
      await client.query(`UPDATE discounts SET times_used = times_used - 1 WHERE id = ANY($1::bigint[])`, [released.map((r) => r.discount_id)]);
    }
    await audit(actor, 'invoice.cancel', 'invoice', id, { number: inv.number, mode, reason }, client);
  });
}

/**
 * Tries, on purpose, to bill a period that is already billed, skipping every check
 * in the application. Only the database constraint stands in the way.
 */
export async function attemptDoubleBill(actor: string) {
  const target = await one(
    `SELECT bp.id, bp.subscription_id, bp.period_index, lower(bp.period) AS period_start, upper(bp.period) AS period_end, s.number
       FROM billing_periods bp JOIN subscriptions s ON s.id = bp.subscription_id
      WHERE bp.state = 'billed' ORDER BY bp.id DESC LIMIT 1`,
  );
  if (!target) throw conflict('Nothing has been billed yet');
  try {
    await pool.query(
      `INSERT INTO billing_periods (subscription_id, period_index, period, state) VALUES ($1,$2,daterange($3::date,$4::date,'[)'),'billed')`,
      [target.subscription_id, target.period_index, target.period_start, target.period_end],
    );
    throw new Error('Constraint did not fire');
  } catch (err: any) {
    if (err.code !== PG_ERRORS.exclusion) throw err;
    await audit(actor, 'integrity.double_bill_blocked', 'subscription', target.subscription_id, { period: [target.period_start, target.period_end] });
    return {
      subscription: target.number,
      periodStart: target.period_start,
      periodEnd: target.period_end,
      blocked: true,
      sqlState: err.code,
      constraint: err.constraint,
      message: err.message,
    };
  }
}
