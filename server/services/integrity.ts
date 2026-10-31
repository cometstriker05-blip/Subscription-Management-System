// Proof instead of promises. Each check is a question asked of the live data, and
// the answer must be zero. The SQL is shown in the app so anyone can verify it.
import { pool, q } from '../db/pool.ts';
import { computeInvoice, formatINR } from '../engine/index.ts';
import { audit, conflict, type Actor } from './core.ts';
import { attemptDoubleBill, fingerprintOf, rehearse, runBilling, type RunProgress } from './billing.ts';

export interface Check {
  id: string;
  title: string;
  promise: string;
  sql: string;
}

export const CHECKS: Check[] = [
  {
    id: 'no_double_billing',
    title: 'No period billed twice',
    promise: 'No subscription has two live invoices covering the same day',
    sql: `SELECT count(*) AS violations FROM billing_periods a
  JOIN billing_periods b ON a.subscription_id = b.subscription_id AND a.id < b.id
    AND a.period && b.period
 WHERE a.state <> 'voided' AND b.state <> 'voided'`,
  },
  {
    id: 'no_skipped_period',
    title: 'No period skipped',
    promise: 'Each billed period starts where the last one ended, except across a recorded pause',
    sql: `SELECT count(*) AS violations FROM (
  SELECT subscription_id, period,
         lag(upper(period)) OVER (PARTITION BY subscription_id ORDER BY lower(period)) AS prev_end
    FROM billing_periods WHERE state <> 'voided') x
 WHERE prev_end IS NOT NULL AND lower(period) <> prev_end
   AND NOT EXISTS (SELECT 1 FROM subscription_events e
                    WHERE e.subscription_id = x.subscription_id AND e.kind = 'resumed')`,
  },
  {
    id: 'nothing_overdue_to_bill',
    title: 'Nothing left unbilled',
    promise: 'No active subscription is more than one run behind the clock',
    sql: `SELECT count(*) AS violations FROM subscriptions s, app_state a
 WHERE s.status = 'active' AND s.next_billing_date < a.today - 1`,
  },
  {
    id: 'lines_equal_totals',
    title: 'Invoice lines add up',
    promise: 'Every invoice total equals the sum of its lines, to the paisa',
    sql: `SELECT count(*) AS violations FROM invoices i
  JOIN (SELECT invoice_id, sum(amount) AS lines_total, sum(tax) AS lines_tax
          FROM invoice_lines GROUP BY 1) l ON l.invoice_id = i.id
 WHERE i.total <> l.lines_total OR i.tax <> l.lines_tax`,
  },
  {
    id: 'paid_equals_allocated',
    title: 'Payments reconcile to invoices',
    promise: 'The paid amount on every invoice equals the money allocated to it',
    sql: `SELECT count(*) AS violations FROM invoices i
  LEFT JOIN (SELECT invoice_id, sum(amount) AS allocated
               FROM payment_allocations GROUP BY 1) a ON a.invoice_id = i.id
 WHERE i.amount_paid <> COALESCE(a.allocated, 0)`,
  },
  {
    id: 'paid_means_paid',
    title: 'Paid means paid in full',
    promise: 'No invoice is marked paid with money still owed, or the other way round',
    sql: `SELECT count(*) AS violations FROM invoices
 WHERE (status = 'paid' AND amount_paid <> total)
    OR (status = 'confirmed' AND amount_paid >= total AND total > 0)`,
  },
  {
    id: 'no_over_allocation',
    title: 'No payment spent twice',
    promise: 'No payment is allocated beyond its own amount',
    sql: `SELECT count(*) AS violations FROM payments p
  JOIN (SELECT payment_id, sum(amount) AS used
          FROM payment_allocations GROUP BY 1) a ON a.payment_id = p.id
 WHERE a.used > p.amount`,
  },
  {
    id: 'discount_usage',
    title: 'Discount limits hold',
    promise: 'Each discount’s counter matches its redemptions and stays within its limit',
    sql: `SELECT count(*) AS violations FROM discounts d
  LEFT JOIN (SELECT discount_id, count(*) AS live FROM discount_redemptions
              WHERE released_on IS NULL GROUP BY 1) r ON r.discount_id = d.id
 WHERE d.times_used <> COALESCE(r.live, 0)
    OR (d.usage_limit IS NOT NULL AND d.times_used > d.usage_limit)`,
  },
  {
    id: 'gapless_numbers',
    title: 'Invoice numbers are gapless',
    promise: 'Serials run 1, 2, 3 in each financial year with none missing, as GST requires',
    sql: `SELECT count(*) AS violations FROM (
  SELECT fy, max(serial) - count(*) AS gaps FROM invoices
   WHERE serial IS NOT NULL GROUP BY fy) x WHERE gaps <> 0`,
  },
  {
    id: 'mrr_ties_out',
    title: 'MRR bridge ties out',
    promise: 'All MRR movements ever recorded add up to today’s MRR exactly',
    sql: `SELECT abs((SELECT COALESCE(sum(delta), 0) FROM mrr_movements)
         - (SELECT COALESCE(sum(mrr), 0) FROM subscriptions)) AS violations`,
  },
  {
    id: 'audit_chain',
    title: 'Audit trail is untampered',
    promise: 'Every audit row’s hash covers the row before it, and the chain is unbroken',
    sql: `SELECT count(*) AS violations FROM (
  SELECT prev_hash, hash, actor, action, entity, entity_id, detail,
         lag(hash, 1, 'genesis') OVER (ORDER BY id) AS expected_prev
    FROM audit_log) a
 WHERE prev_hash <> expected_prev
    OR hash <> encode(sha256(convert_to(prev_hash || '|' || actor || '|' || action || '|'
         || entity || '|' || coalesce(entity_id, '') || '|' || detail::text, 'UTF8')), 'hex')`,
  },
];

export async function runChecks() {
  const started = performance.now();
  const results = await Promise.all(
    CHECKS.map(async (check) => {
      const t0 = performance.now();
      const [row] = await q(check.sql);
      return { ...check, violations: Number(row.violations), ms: Math.round(performance.now() - t0) };
    }),
  );
  return { checks: results, passed: results.every((r) => r.violations === 0), ms: Math.round(performance.now() - started) };
}

/** Recomputes stored invoices from their saved inputs. Any difference is a real finding. */
export async function replayInvoices(limit = 5000) {
  const started = performance.now();
  const rows = await q(
    `SELECT id, number, subtotal, discount, tax, total, engine_input FROM invoices
      WHERE status <> 'cancelled' ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  const mismatches: { id: number; number: string | null; stored: number; replayed: number }[] = [];
  for (const row of rows) {
    const replay = computeInvoice(row.engine_input);
    if (replay.total !== row.total || replay.tax !== row.tax || replay.discount !== row.discount) {
      mismatches.push({ id: row.id, number: row.number, stored: row.total, replayed: replay.total });
    }
  }
  return { replayed: rows.length, mismatches: mismatches.slice(0, 20), mismatchCount: mismatches.length, ms: Math.round(performance.now() - started) };
}

export async function chaosRun(asOf: string, actor: Actor, onProgress?: (p: { runs: RunProgress[] }) => void) {
  const before = await rehearse(asOf);
  if (before.invoices === 0) throw conflict('Nothing is due. Move the clock to a billing day first');

  const progress = new Map<number, RunProgress>();
  const track = (index: number) => (p: RunProgress) => {
    progress.set(index, p);
    onProgress?.({ runs: [...progress.values()] });
  };

  // Three billing runs race over the same subscriptions while workers crash at random.
  const runs = await Promise.all(
    [0, 1, 2].map((i) => runBilling({ asOf, kind: 'chaos', actor: actor.name, workers: 4, faultRate: 0.12, onProgress: track(i) })),
  );

  // Then rogue writers try to bill those same periods again, with no locks at all.
  const billed = await q(
    `SELECT subscription_id, period_index, lower(period) AS s, upper(period) AS e FROM billing_periods
      WHERE run_id = ANY($1::bigint[]) ORDER BY id LIMIT 400`,
    [runs.map((r) => r.runId)],
  );
  const rogue = await Promise.all(
    billed.map((p) =>
      pool
        .query(`INSERT INTO billing_periods (subscription_id, period_index, period, state) VALUES ($1,$2,daterange($3::date,$4::date,'[)'),'billed')`, [p.subscription_id, p.period_index, p.s, p.e])
        .then(() => 'escaped')
        .catch((err) => (err.code === '23P01' ? 'blocked' : 'other')),
    ),
  );

  const actual = await q(`SELECT subscription_id, period_start, total FROM invoices WHERE run_id = ANY($1::bigint[])`, [runs.map((r) => r.runId)]);
  const fingerprint = fingerprintOf(actual.map((a) => ({ subscriptionId: a.subscription_id, periodStart: a.period_start, total: a.total })));
  const total = actual.reduce((sum, a) => sum + a.total, 0);
  const checks = await runChecks();

  const report = {
    expected: before.invoices,
    created: actual.length,
    faultsInjected: runs.reduce((sum, r) => sum + r.faults, 0),
    runs: runs.length,
    rogueAttempts: rogue.length,
    rogueBlocked: rogue.filter((r) => r === 'blocked').length,
    rogueEscaped: rogue.filter((r) => r === 'escaped').length,
    rehearsedTotal: before.total,
    actualTotal: total,
    matchedRehearsal: fingerprint === before.fingerprint,
    integrityPassed: checks.passed,
    checks: checks.checks.map((c) => ({ id: c.id, title: c.title, violations: c.violations })),
    summary: `${actual.length} of ${before.invoices} invoices, ${formatINR(total)}`,
  };
  await audit(actor.name, 'integrity.chaos', 'system', null, report);
  return report;
}

export { attemptDoubleBill };
