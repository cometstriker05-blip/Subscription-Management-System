// Everything the finance lead asks for. All figures are computed live from the same
// tables that invoicing writes, so a report can never disagree with the ledger.
import { pool, q, one, type Db } from '../db/pool.ts';
import { addDays, addMonths, monthEnd, monthStart } from '../engine/index.ts';
import { Filters } from './core.ts';
import { futurePeriods } from './subscriptions.ts';

export interface ReportFilter {
  from: string;
  to: string;
  planId?: number;
  segment?: string;
  stateCode?: string;
}

function invoiceScope(f: ReportFilter, alias = 'i', needsJoins = false) {
  const filters = new Filters();
  filters.add((r) => `s.plan_id = ${r}`, f.planId);
  filters.add((r) => `c.segment = ${r}`, f.segment);
  filters.add((r) => `c.state_code = ${r}`, f.stateCode);
  // Unfiltered company totals never touch these tables, so they are not joined at all.
  const joins = needsJoins || filters.clauses.length
    ? `JOIN subscriptions s ON s.id = ${alias}.subscription_id JOIN customers c ON c.id = ${alias}.customer_id`
    : '';
  return { filters, joins };
}

export async function revenueSummary(f: ReportFilter, today: string, db: Db = pool) {
  const invoiced = invoiceScope(f);
  const invoiceFilter = invoiced.filters;
  const fromRef = invoiceFilter.next(f.from);
  const toRef = invoiceFilter.next(f.to);

  const paid = invoiceScope(f);
  const payFilter = paid.filters;
  const payFrom = payFilter.next(f.from);
  const payTo = payFilter.next(f.to);

  const open = invoiceScope(f);
  const openFilter = open.filters;
  const todayRef = openFilter.next(today);

  const subs = new Filters();
  subs.add((r) => `s.plan_id = ${r}`, f.planId);
  subs.add((r) => `c.segment = ${r}`, f.segment);
  subs.add((r) => `c.state_code = ${r}`, f.stateCode);

  const bridge = new Filters();
  bridge.add((r) => `m.plan_id = ${r}`, f.planId);
  bridge.add((r) => `c.segment = ${r}`, f.segment);
  bridge.add((r) => `c.state_code = ${r}`, f.stateCode);
  const bFrom = bridge.next(f.from);
  const bTo = bridge.next(f.to);

  const [totals, collected, aging, book, movements, opening] = await Promise.all([
    one(
      `SELECT count(*)::int AS invoices, COALESCE(sum(i.total),0)::bigint AS invoiced, COALESCE(sum(i.taxable),0)::bigint AS revenue,
              COALESCE(sum(i.tax),0)::bigint AS tax, COALESCE(sum(i.discount),0)::bigint AS discounts
         FROM invoices i ${invoiced.joins}
        WHERE i.status IN ('confirmed','paid') AND i.issue_date BETWEEN ${fromRef} AND ${toRef}
          ${invoiceFilter.clauses.length ? `AND ${invoiceFilter.clauses.join(' AND ')}` : ''}`,
      invoiceFilter.params,
      db,
    ),
    one(
      `SELECT COALESCE(sum(a.amount),0)::bigint AS collected, count(DISTINCT a.payment_id)::int AS payments
         FROM payment_allocations a JOIN payments p ON p.id = a.payment_id JOIN invoices i ON i.id = a.invoice_id ${paid.joins}
        WHERE p.paid_on BETWEEN ${payFrom} AND ${payTo}
          ${payFilter.clauses.length ? `AND ${payFilter.clauses.join(' AND ')}` : ''}`,
      payFilter.params,
      db,
    ),
    q(
      `SELECT CASE WHEN i.due_date >= ${todayRef} THEN 'current'
                   WHEN ${todayRef}::date - i.due_date <= 30 THEN 'd1_30'
                   WHEN ${todayRef}::date - i.due_date <= 60 THEN 'd31_60'
                   WHEN ${todayRef}::date - i.due_date <= 90 THEN 'd61_90'
                   ELSE 'd90_plus' END AS bucket,
              count(*)::int AS invoices, sum(i.total - i.amount_paid)::bigint AS amount
         FROM invoices i ${open.joins}
        WHERE i.status = 'confirmed' ${openFilter.clauses.length > 0 ? `AND ${openFilter.clauses.join(' AND ')}` : ''}
        GROUP BY 1`,
      openFilter.params,
      db,
    ),
    one(
      `SELECT count(*) FILTER (WHERE s.status = 'active')::int AS active,
              count(*) FILTER (WHERE s.status = 'paused')::int AS paused,
              COALESCE(sum(s.mrr) FILTER (WHERE s.status = 'active'),0)::bigint AS mrr,
              count(DISTINCT s.customer_id) FILTER (WHERE s.status = 'active')::int AS customers
         FROM subscriptions s JOIN customers c ON c.id = s.customer_id ${subs.where}`,
      subs.params,
      db,
    ),
    q(
      `SELECT m.kind, COALESCE(sum(m.delta),0)::bigint AS amount, count(*)::int AS events
         FROM mrr_movements m JOIN customers c ON c.id = m.customer_id
        WHERE m.on_date BETWEEN ${bFrom} AND ${bTo}
          ${bridge.clauses.length ? `AND ${bridge.clauses.join(' AND ')}` : ''}
        GROUP BY m.kind`,
      bridge.params,
      db,
    ),
    one(
      `SELECT COALESCE(sum(m.delta),0)::bigint AS opening
         FROM mrr_movements m JOIN customers c ON c.id = m.customer_id
        WHERE m.on_date < ${bFrom}
          ${bridge.clauses.length ? `AND ${bridge.clauses.join(' AND ')}` : ''}`,
      bridge.params.slice(0, bridge.params.length - 1),
      db,
    ),
  ]);

  const buckets = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'].map((key) => {
    const row = aging.find((a) => a.bucket === key);
    return { bucket: key, invoices: row?.invoices ?? 0, amount: row?.amount ?? 0 };
  });
  const overdue = buckets.slice(1).reduce((acc, b) => ({ amount: acc.amount + b.amount, invoices: acc.invoices + b.invoices }), { amount: 0, invoices: 0 });
  const outstanding = buckets.reduce((sum, b) => sum + b.amount, 0);

  const moves = ['new', 'expansion', 'reactivation', 'contraction', 'churn'].map((kind) => ({
    kind,
    amount: movements.find((m) => m.kind === kind)?.amount ?? 0,
    events: movements.find((m) => m.kind === kind)?.events ?? 0,
  }));
  const net = moves.reduce((sum, m) => sum + m.amount, 0);

  return {
    period: { from: f.from, to: f.to },
    activeSubscriptions: book!.active,
    pausedSubscriptions: book!.paused,
    activeCustomers: book!.customers,
    mrr: book!.mrr,
    arr: book!.mrr * 12,
    arpa: book!.customers ? Math.round(book!.mrr / book!.customers) : 0,
    invoiced: totals!.invoiced,
    revenue: totals!.revenue,
    invoiceCount: totals!.invoices,
    tax: totals!.tax,
    discounts: totals!.discounts,
    collected: collected!.collected,
    paymentCount: collected!.payments,
    collectionRate: totals!.invoiced ? collected!.collected / totals!.invoiced : 0,
    outstanding,
    overdue: overdue.amount,
    overdueCount: overdue.invoices,
    aging: buckets,
    bridge: { opening: opening!.opening, moves, net, closing: opening!.opening + net },
  };
}

export async function monthlySeries(f: Omit<ReportFilter, 'from' | 'to'>, today: string, months = 12, db: Db = pool) {
  const start = monthStart(addMonths(today, -(months - 1)));
  const scoped = invoiceScope({ ...f, from: start, to: today });
  const startRef = scoped.filters.next(start);
  const extra = scoped.filters.clauses.length ? `AND ${scoped.filters.clauses.join(' AND ')}` : '';

  const pay = invoiceScope({ ...f, from: start, to: today });
  const payStart = pay.filters.next(start);
  const payExtra = pay.filters.clauses.length ? `AND ${pay.filters.clauses.join(' AND ')}` : '';

  const moveFilter = new Filters();
  moveFilter.add((r) => `m.plan_id = ${r}`, f.planId);
  moveFilter.add((r) => `c.segment = ${r}`, f.segment);
  moveFilter.add((r) => `c.state_code = ${r}`, f.stateCode);

  const [invoiced, collected, mrr] = await Promise.all([
    q(
      `SELECT to_char(i.issue_date,'YYYY-MM') AS month, sum(i.total)::bigint AS amount
         FROM invoices i ${scoped.joins}
        WHERE i.status IN ('confirmed','paid') AND i.issue_date >= ${startRef} ${extra}
        GROUP BY 1`,
      scoped.filters.params,
      db,
    ),
    q(
      `SELECT to_char(p.paid_on,'YYYY-MM') AS month, sum(a.amount)::bigint AS amount
         FROM payment_allocations a JOIN payments p ON p.id = a.payment_id JOIN invoices i ON i.id = a.invoice_id ${pay.joins}
        WHERE p.paid_on >= ${payStart} ${payExtra}
        GROUP BY 1`,
      pay.filters.params,
      db,
    ),
    q(
      `SELECT to_char(m.on_date,'YYYY-MM') AS month, sum(m.delta)::bigint AS delta
         FROM mrr_movements m ${f.segment || f.stateCode ? 'JOIN customers c ON c.id = m.customer_id' : ''} ${moveFilter.where}
        GROUP BY 1 ORDER BY 1`,
      moveFilter.params,
      db,
    ),
  ]);

  const months_: { month: string; invoiced: number; collected: number; mrr: number }[] = [];
  let running = 0;
  const firstLabel = start.slice(0, 7);
  for (const m of mrr) if (m.month < firstLabel) running += m.delta;
  for (let i = 0; i < months; i++) {
    const label = addMonths(start, i).slice(0, 7);
    running += mrr.find((m) => m.month === label)?.delta ?? 0;
    months_.push({
      month: label,
      invoiced: invoiced.find((r) => r.month === label)?.amount ?? 0,
      collected: collected.find((r) => r.month === label)?.amount ?? 0,
      mrr: running,
    });
  }
  return months_;
}

export async function planBreakdown(f: ReportFilter, db: Db = pool) {
  const filters = new Filters();
  filters.add((r) => `c.segment = ${r}`, f.segment);
  filters.add((r) => `c.state_code = ${r}`, f.stateCode);
  filters.add((r) => `s.plan_id = ${r}`, f.planId);
  filters.raw(`s.status = 'active'`);
  return q(
    `SELECT p.id, p.name, p.billing_unit, count(*)::int AS subscriptions, COALESCE(sum(s.mrr),0)::bigint AS mrr
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN customers c ON c.id = s.customer_id
       ${filters.where}
      GROUP BY p.id ORDER BY mrr DESC`,
    filters.params,
    db,
  );
}

export async function topOverdue(f: Pick<ReportFilter, 'planId' | 'segment' | 'stateCode'>, today: string, limit = 8, db: Db = pool) {
  const scoped = invoiceScope({ ...f, from: today, to: today }, 'i', true);
  const todayRef = scoped.filters.next(today);
  const extra = scoped.filters.clauses.length ? `AND ${scoped.filters.clauses.join(' AND ')}` : '';
  return q(
    `SELECT c.id, c.name, c.segment, sum(i.total - i.amount_paid)::bigint AS overdue, count(*)::int AS invoices,
            max(${todayRef}::date - i.due_date)::int AS oldest_days
       FROM invoices i ${scoped.joins}
      WHERE i.status = 'confirmed' AND i.due_date < ${todayRef} ${extra}
      GROUP BY c.id ORDER BY overdue DESC LIMIT ${limit}`,
    scoped.filters.params,
    db,
  );
}

/**
 * The tide chart: what happened and what is coming, day by day. The forecast walks
 * every active contract through the same period logic that billing uses.
 */
export async function tideChart(today: string, back = 30, ahead = 45, db: Db = pool) {
  const from = addDays(today, -back);
  const until = addDays(today, ahead);
  const [billed, paid, contracts, receivable] = await Promise.all([
    q(`SELECT issue_date AS d, sum(total)::bigint AS amount, count(*)::int AS n FROM invoices
        WHERE status IN ('confirmed','paid') AND issue_date BETWEEN $1 AND $2 GROUP BY 1`, [from, today], db),
    q(`SELECT paid_on AS d, sum(amount)::bigint AS amount FROM payments WHERE paid_on BETWEEN $1 AND $2 GROUP BY 1`, [from, today], db),
    q(`SELECT s.billing_anchor, s.next_period_index, s.recurring_amount, p.billing_unit, p.billing_interval,
              CASE WHEN s.auto_renew AND p.renewable THEN NULL ELSE s.expiry_date END AS expiry_date,
              t.net_days, s.next_billing_date
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN payment_terms t ON t.id = s.payment_term_id
        WHERE s.status = 'active' AND s.next_billing_date <= $1`, [until], db),
    q(`SELECT due_date AS d, sum(total - amount_paid)::bigint AS amount FROM invoices
        WHERE status = 'confirmed' AND due_date > $1 AND due_date <= $2 GROUP BY 1`, [today, until], db),
  ]);

  const days = new Map<string, { date: string; billed: number; collected: number; forecastBilled: number; forecastCash: number; count: number }>();
  const at = (d: string) => {
    if (!days.has(d)) days.set(d, { date: d, billed: 0, collected: 0, forecastBilled: 0, forecastCash: 0, count: 0 });
    return days.get(d)!;
  };
  for (let i = -back; i <= ahead; i++) at(addDays(today, i));
  for (const r of billed) { at(r.d).billed = r.amount; at(r.d).count = r.n; }
  for (const r of paid) at(r.d).collected = r.amount;

  // Tax is estimated at the standard rate here; the rehearsal computes it exactly.
  for (const c of contracts) {
    for (const p of futurePeriods(c, until)) {
      if (p.start <= today) continue;
      const gross = Math.round(c.recurring_amount * 1.18);
      const day = at(p.start);
      day.forecastBilled += gross;
      day.count += 1;
      const cashDay = addDays(p.start, c.net_days);
      if (cashDay <= until) at(cashDay).forecastCash += gross;
    }
  }
  for (const r of receivable) at(r.d).forecastCash += r.amount;

  return { today, days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

/** Headline counts for the home screen. */
export async function overview(today: string, db: Db = pool) {
  const [counts, overdueRow, renewals, drafts, quotes, recent] = await Promise.all([
    one(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
                COALESCE(sum(mrr) FILTER (WHERE status = 'active'),0)::bigint AS mrr,
                count(*) FILTER (WHERE status = 'active' AND next_billing_date <= $1)::int AS due_now,
                count(*) FILTER (WHERE status IN ('draft','quotation','confirmed'))::int AS pipeline
           FROM subscriptions`, [today], db),
    one(`SELECT count(*)::int AS invoices, COALESCE(sum(total - amount_paid),0)::bigint AS amount
           FROM invoices WHERE status = 'confirmed' AND due_date < $1`, [today], db),
    one(`SELECT count(*) FILTER (WHERE expiry_date <= $1::date + 30)::int AS soon,
                count(*) FILTER (WHERE expiry_date <= $1::date AND NOT auto_renew)::int AS expired
           FROM subscriptions WHERE status IN ('active','paused') AND expiry_date <= $1::date + 30`, [today], db),
    one(`SELECT count(*)::int AS n, COALESCE(sum(total),0)::bigint AS amount FROM invoices WHERE status = 'draft'`, [], db),
    one(`SELECT count(*)::int AS n FROM subscriptions WHERE status = 'quotation' AND quotation_valid_until <= $1::date + 3`, [today], db),
    one(`SELECT COALESCE(sum(amount) FILTER (WHERE paid_on >= $1::date - 30),0)::bigint AS last30,
                COALESCE(sum(amount) FILTER (WHERE paid_on >= $2::date),0)::bigint AS this_month
           FROM payments WHERE paid_on >= LEAST($1::date - 30, $2::date)`, [today, monthStart(today)], db),
  ]);
  return {
    active: counts!.active,
    mrr: counts!.mrr,
    arr: counts!.mrr * 12,
    dueNow: counts!.due_now,
    pipeline: counts!.pipeline,
    overdue: overdueRow,
    renewals,
    drafts,
    expiringQuotes: quotes!.n,
    collected30: recent!.last30,
    collectedThisMonth: recent!.this_month,
  };
}

export const monthRange = (today: string) => ({ from: monthStart(today), to: monthEnd(today) });
