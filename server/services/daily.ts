// The day-by-day heartbeat. In production this runs once a day; the time machine
// runs exactly the same code for each day it crosses, so simulation is honest.
import { bulkInsert, one, pool, q, tx } from '../db/pool.ts';
import { addDays, daysBetween, formatINR } from '../engine/index.ts';
import { confirmAllDrafts, dueSubscriptionIds, runBilling, type RunProgress } from './billing.ts';
import { bumpDataVersion } from './cache.ts';
import { appState, audit, conflict } from './core.ts';
import { logMailBatch, type Mail } from './mail.ts';
import { logEvent, processExpiry, transition } from './subscriptions.ts';

const SYSTEM_ACTOR = { id: 1, name: 'Keel', role: 'admin', customerId: null, email: 'system' } as const;

export const DUNNING_STEPS = [
  { step: 1, afterDays: 1, tone: 'A friendly reminder' },
  { step: 2, afterDays: 7, tone: 'Payment is a week overdue' },
  { step: 3, afterDays: 15, tone: 'Final reminder' },
  { step: 4, afterDays: 30, tone: 'Your account needs attention' },
];

export interface FeedEvent {
  date: string;
  kind: 'billing' | 'renewal' | 'closed' | 'activated' | 'quote' | 'dunning' | 'payment' | 'signup' | 'churn' | 'day' | 'held';
  message: string;
  amount?: number;
  count?: number;
}

type Emit = (e: FeedEvent) => void;

async function activateDue(date: string, emit: Emit) {
  const rows = await q(`SELECT id FROM subscriptions WHERE status = 'confirmed' AND start_date <= $1`, [date]);
  for (const r of rows) await transition(r.id, 'active', SYSTEM_ACTOR);
  if (rows.length) emit({ date, kind: 'activated', message: `${rows.length} confirmed subscriptions went live`, count: rows.length });
}

async function expireQuotes(date: string, emit: Emit) {
  const rows = await q(
    `UPDATE subscriptions SET status = 'closed', closed_on = $1, close_reason = 'Quotation expired', next_billing_date = NULL
      WHERE status = 'quotation' AND quotation_valid_until < $1 RETURNING id`,
    [date],
  );
  for (const r of rows) await logEvent(pool, r.id, 'closed', { from: 'quotation', to: 'closed', actor: 'Keel', on: date, detail: { reason: 'Quotation expired' } });
  if (rows.length) emit({ date, kind: 'quote', message: `${rows.length} quotations expired unanswered`, count: rows.length });
}

async function handleExpiries(date: string, emit: Emit) {
  const rows = await q(`SELECT id, expiry_date FROM subscriptions WHERE status IN ('active', 'paused') AND expiry_date <= $1 ORDER BY id`, [date]);
  const tally = { renewed: 0, closed: 0, needs_decision: 0 };
  for (const r of rows) {
    await tx(async (client) => {
      const outcome = await processExpiry(client, r.id, date);
      // A contract waiting on a decision is reported once, on the day it expires.
      if (outcome !== 'needs_decision' || r.expiry_date === date) tally[outcome]++;
    });
  }
  if (tally.renewed) emit({ date, kind: 'renewal', message: `${tally.renewed} contracts renewed by themselves`, count: tally.renewed });
  if (tally.closed) emit({ date, kind: 'closed', message: `${tally.closed} plans reached their end and closed on their own`, count: tally.closed });
  if (tally.needs_decision) emit({ date, kind: 'renewal', message: `${tally.needs_decision} contracts reached expiry and need a decision`, count: tally.needs_decision });
}

async function renewalReminders(date: string) {
  const rows = await q(
    `SELECT s.id, s.number, s.expiry_date, c.email, c.name
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
      WHERE s.status = 'active' AND s.expiry_date = $1::date + 30`,
    [date],
  );
  await logMailBatch(rows.map((r): Mail => ({
    to: r.email, subject: `${r.number} renews on ${r.expiry_date}`, kind: 'renewal_reminder', onDate: date,
    body: `Hello ${r.name},\n\nYour subscription ${r.number} reaches the end of its term on ${r.expiry_date}. No action is needed if you want to continue. You can review it in your portal.`,
  })));
}

export async function runDunning(date: string, emit: Emit) {
  const mails: Mail[] = [];
  for (const s of DUNNING_STEPS) {
    const rows = await q(
      `WITH hit AS (
         INSERT INTO dunning_events (invoice_id, step, on_date)
         SELECT i.id, $1, $2::date FROM invoices i
          WHERE i.status = 'confirmed' AND i.due_date = $2::date - $3::int
         ON CONFLICT DO NOTHING RETURNING invoice_id)
       SELECT i.number, i.total - i.amount_paid AS owed, i.due_date, c.email, c.name
         FROM hit JOIN invoices i ON i.id = hit.invoice_id JOIN customers c ON c.id = i.customer_id`,
      [s.step, date, s.afterDays],
    );
    for (const r of rows) {
      mails.push({
        to: r.email, subject: `${s.tone}: invoice ${r.number}`, kind: 'dunning', onDate: date,
        body: `Hello ${r.name},\n\nInvoice ${r.number} for ${formatINR(r.owed)} was due on ${r.due_date}. Please pay it from your portal, or reply if you think this is wrong.`,
      });
    }
  }
  await logMailBatch(mails);
  if (mails.length) emit({ date, kind: 'dunning', message: `${mails.length} overdue reminders went out`, count: mails.length });
}

/** A stable pseudo-random number per invoice, so a replayed month plays out the same. */
const hash01 = (n: number) => {
  let t = Math.imul(n ^ (n >>> 15), 2147483647) ^ 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 13), 16777619);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
};

/** Plays customers paying, so a simulated month has money coming in. Simulation only. */
async function simulateCustomers(date: string, emit: Emit) {
  const open = await q(
    `SELECT i.id, i.customer_id, i.total, i.amount_paid, i.due_date, c.segment
       FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.status = 'confirmed' AND i.due_date BETWEEN $1::date - 60 AND $1::date + 6 AND i.number IS NOT NULL
      LIMIT 6000`,
    [date],
  );

  const paying = open.filter((inv) => {
    const roll = hash01(inv.id);
    const offset = roll < 0.74 ? Math.floor(hash01(inv.id + 7) * 10) - 6 : roll < 0.93 ? 4 + Math.floor(hash01(inv.id + 13) * 30) : 9999;
    return daysBetween(inv.due_date, date) === offset;
  });

  if (paying.length) {
    await tx(async (client) => {
      const numbers = await q(`SELECT nextval('payment_number_seq') AS n FROM generate_series(1, $1)`, [paying.length], client);
      const payments = paying.map((inv, i) => ({
        number: `PAY-${String(numbers[i].n).padStart(6, '0')}`, customer_id: inv.customer_id,
        method: inv.segment === 'small' ? 'upi' : 'bank_transfer', amount: inv.total - inv.amount_paid, paid_on: date, source: 'import', created_by: 'Simulation',
      }));
      await bulkInsert('payments', payments, client);
      const ids = await q(`SELECT id, number FROM payments WHERE number = ANY($1::text[])`, [payments.map((p) => p.number)], client);
      const byNumber = new Map(ids.map((r) => [r.number, r.id]));
      await bulkInsert('payment_allocations', paying.map((inv, i) => ({ payment_id: byNumber.get(payments[i].number), invoice_id: inv.id, amount: inv.total - inv.amount_paid })), client);
    });
    const total = paying.reduce((sum, p) => sum + p.total - p.amount_paid, 0);
    emit({ date, kind: 'payment', message: `${paying.length} payments came in, ${formatINR(total)}`, amount: total, count: paying.length });
  }
}

export interface DayOptions {
  simulate: boolean;
  holdBilling: boolean;
  emit: Emit;
  onBilling?: (p: RunProgress) => void;
}

export async function runDay(date: string, opts: DayOptions) {
  const { emit } = opts;
  const state = await appState();
  // Streams outlive their request, so a long clock jump invalidates reports itself.
  bumpDataVersion();
  await activateDue(date, emit);
  await expireQuotes(date, emit);
  await handleExpiries(date, emit);
  await renewalReminders(date);

  if (opts.holdBilling) {
    const due = await dueSubscriptionIds(date);
    emit({ date, kind: 'held', message: `${due.length} subscriptions are due. Billing is waiting for you`, count: due.length });
  } else {
    const due = await dueSubscriptionIds(date);
    if (due.length) {
      const run = await runBilling({ asOf: date, kind: 'scheduled', actor: 'Keel', onProgress: opts.onBilling });
      if (state.autoConfirm) await confirmAllDrafts('Keel', { runId: run.runId });
      emit({ date, kind: 'billing', message: `${run.invoices} invoices raised, ${formatINR(run.total)}`, amount: run.total, count: run.invoices });
    }
  }

  await runDunning(date, emit);
  if (opts.simulate) await simulateCustomers(date, emit);
  bumpDataVersion();
}

const CLOCK_LOCK = 4_2_4_2_1;

/** Moves the business clock forward one day at a time. No day is ever jumped over. */
export async function advanceClock(params: { to: string; holdBilling?: boolean; actor: string; emit: Emit; onBilling?: (p: RunProgress) => void }) {
  const client = await pool.connect();
  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock($1) AS ok`, [CLOCK_LOCK]);
    if (!lock.rows[0].ok) throw conflict('The clock is already moving');

    const state = await appState();
    if (state.clockMode !== 'simulated') throw conflict('The clock follows the real calendar in live mode');
    if (params.to <= state.today) throw conflict('The clock only moves forward');
    const days = daysBetween(state.today, params.to);
    if (days > 400) throw conflict('Jump at most 400 days at a time');

    for (let d = 1; d <= days; d++) {
      const date = addDays(state.today, d);
      await pool.query(`UPDATE app_state SET today = $1 WHERE id = 1`, [date]);
      params.emit({ date, kind: 'day', message: date });
      await runDay(date, {
        simulate: true,
        holdBilling: !!params.holdBilling && d === days,
        emit: params.emit,
        onBilling: params.onBilling,
      });
    }
    await audit(params.actor, 'clock.advance', 'system', null, { from: state.today, to: params.to });
    return { from: state.today, to: params.to, days };
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [CLOCK_LOCK]).catch(() => {});
    client.release();
  }
}

/** Next date on which a meaningful number of subscriptions bill. Powers "jump to billing day". */
export async function nextBillingDay(after: string) {
  const row = await one(
    `SELECT next_billing_date AS d, count(*)::int AS n FROM subscriptions
      WHERE status = 'active' AND next_billing_date > $1
      GROUP BY 1 ORDER BY n DESC, d ASC LIMIT 1`,
    [after],
  );
  return row ? { date: row.d as string, count: row.n as number } : null;
}
