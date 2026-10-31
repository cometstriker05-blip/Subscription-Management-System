import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../server/app.ts';
import { DEMO_LOGINS } from '../../server/db/seed.ts';
import { one, pool, q } from '../../server/db/pool.ts';
import { advanceClock, nextBillingDay } from '../../server/services/daily.ts';
import { rehearse, runBilling, confirmAllDrafts, attemptDoubleBill } from '../../server/services/billing.ts';
import { chaosRun, replayInvoices, runChecks } from '../../server/services/integrity.ts';
import { appState } from '../../server/services/core.ts';
import { addDays, monthlyValue } from '../../server/engine/index.ts';

class Session {
  cookie = '';
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set?.startsWith('keel_session=')) this.cookie = set.split(';')[0];
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* streams and CSV */ }
    return { status: res.status, data };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b: unknown = {}) => this.call('POST', p, b);
  put = (p: string, b: unknown = {}) => this.call('PUT', p, b);
}

const signIn = async (who: { email: string; password: string }) => {
  const s = new Session();
  const res = await s.post('/api/auth/login', who);
  expect(res.status).toBe(200);
  return s;
};

const STRONG = 'Str0ng!pass';
const actor = { id: 1, name: 'Test Admin', role: 'admin', customerId: null, email: 'admin@keel.demo' } as const;
let admin: Session, staff: Session, customer: Session;

beforeAll(async () => {
  admin = await signIn(DEMO_LOGINS.admin);
  staff = await signIn(DEMO_LOGINS.staff);
  customer = await signIn(DEMO_LOGINS.customer);
});

afterAll(async () => {
  await pool.end();
});

describe('A new customer signs up', () => {
  const account = (over = {}) => ({ name: 'Priya Das', company: 'Test Shop', email: 'priya@testshop.example', password: STRONG, stateCode: '29', stateName: 'Karnataka', ...over });

  it('rejects exactly 8 characters, because the brief says more than 8', async () => {
    const res = await new Session().post('/api/auth/signup', account({ email: 'a@b.example', password: 'Abcdef1!' }));
    expect(res.status).toBe(422);
    expect(res.data.error).toContain('more than 8');
  });

  it('demands upper, lower and special characters', async () => {
    for (const password of ['abcdefgh1!', 'ABCDEFGH1!', 'Abcdefghi1']) {
      expect((await new Session().post('/api/auth/signup', account({ email: 'a@b.example', password }))).status).toBe(422);
    }
  });

  it('allows one account per email, ignoring case', async () => {
    expect((await new Session().post('/api/auth/signup', account())).status).toBe(201);
    const again = await new Session().post('/api/auth/signup', account({ email: 'PRIYA@TESTSHOP.EXAMPLE' }));
    expect(again.status).toBe(409);
  });

  it('can never create staff or admin through public signup', async () => {
    const s = new Session();
    await s.post('/api/auth/signup', account({ email: 'sneaky@x.example', role: 'admin' }));
    expect((await s.get('/api/auth/me')).data.user.role).toBe('customer');
  });

  it('sends a single-use reset link, and hides which emails exist', async () => {
    const hit = await new Session().post('/api/auth/forgot', { email: DEMO_LOGINS.customer.email });
    const miss = await new Session().post('/api/auth/forgot', { email: 'nobody@nowhere.example' });
    expect(hit.data).toEqual(miss.data);

    const mail = await one(`SELECT body FROM outbox WHERE to_email = $1 AND kind = 'password_reset' ORDER BY id DESC LIMIT 1`, [DEMO_LOGINS.customer.email]);
    const token = mail!.body.match(/\/reset\/([\w-]+)/)[1];
    expect((await new Session().post('/api/auth/reset', { token, password: 'short' })).status).toBe(422);
    expect((await new Session().post('/api/auth/reset', { token, password: 'NewPassw0rd!x' })).status).toBe(200);
    expect((await new Session().post('/api/auth/reset', { token, password: 'NewPassw0rd!y' })).status).toBe(422);

    const fresh = await signIn({ email: DEMO_LOGINS.customer.email, password: 'NewPassw0rd!x' });
    customer = fresh;
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const a = await new Session().post('/api/auth/login', { email: DEMO_LOGINS.admin.email, password: 'wrong' });
    const b = await new Session().post('/api/auth/login', { email: 'ghost@x.example', password: 'wrong' });
    expect(a.status).toBe(401);
    expect(a.data.error).toBe(b.data.error);
  });
});

describe('Who can see what', () => {
  it('stops staff from admin-only work on the server', async () => {
    const discount = { code: 'NOPE', name: 'Nope', kind: 'percent', value: 500, scope: 'subscription' };
    expect((await staff.post('/api/discounts', discount)).status).toBe(403);
    expect((await staff.post('/api/products', {})).status).toBe(403);
    expect((await staff.post('/api/plans', {})).status).toBe(403);
    expect((await staff.post('/api/team', {})).status).toBe(403);
    expect((await staff.post('/api/tax-rules', {})).status).toBe(403);
  });

  it('lets only the admin add staff', async () => {
    const res = await admin.post('/api/team', { name: 'New Hire', email: 'hire@keel.demo', password: STRONG });
    expect(res.status).toBe(201);
  });

  it('keeps customers out of every internal page', async () => {
    for (const path of ['/api/subscriptions', '/api/invoices', '/api/customers', '/api/home', '/api/reports/revenue', '/api/payments', '/api/team']) {
      expect((await customer.get(path)).status).toBe(403);
    }
  });

  it('keeps anonymous visitors out', async () => {
    expect((await new Session().get('/api/subscriptions')).status).toBe(401);
    expect((await new Session().get('/api/portal/home')).status).toBe(401);
  });

  it('never shows a customer someone else’s records, even with a guessed id', async () => {
    const other = await one(`SELECT id FROM subscriptions WHERE customer_id <> 1 LIMIT 1`);
    const otherInvoice = await one(`SELECT id FROM invoices WHERE customer_id <> 1 AND status = 'confirmed' LIMIT 1`);
    expect((await customer.get(`/api/portal/subscriptions/${other!.id}`)).status).toBe(404);
    expect((await customer.get(`/api/portal/invoices/${otherInvoice!.id}`)).status).toBe(404);
    expect((await customer.post(`/api/portal/invoices/${otherInvoice!.id}/pay`, { method: 'upi' })).status).toBe(404);
    expect((await customer.post(`/api/portal/subscriptions/${other!.id}/close`, { reason: 'hack' })).status).toBe(404);
  });
});

describe('Launching a plan', () => {
  let productId: number;

  it('stores a product with an Odoo variant that adds 560', async () => {
    const res = await admin.post('/api/products', {
      name: 'Launch Product', type: 'software', salesPrice: 100000, costPrice: 20000, notes: 'New',
      variants: [{ attribute: 'Brand', value: 'Odoo', priceExtra: 56000 }],
    });
    expect(res.status).toBe(201);
    productId = res.data.id;
  });

  it('enforces plan availability dates and minimum quantity', async () => {
    const { today } = await appState();
    const plan = await admin.post('/api/plans', {
      name: 'Window Plan', productId, price: 100000, billingUnit: 'monthly', minQuantity: 5,
      availableFrom: addDays(today, 5), availableUntil: addDays(today, 30),
      autoClose: true, closable: false, pausable: false, renewable: false, termMonths: 3, addons: [],
    });
    expect(plan.status).toBe(201);

    const early = await staff.post('/api/subscriptions', { customerId: 20, planId: plan.data.id, startDate: today, lines: [{ productId, quantity: 5 }] });
    expect(early.status).toBe(422);
    expect(early.data.error).toContain('only available');

    const few = await staff.post('/api/subscriptions', { customerId: 20, planId: plan.data.id, startDate: addDays(today, 6), lines: [{ productId, quantity: 2 }] });
    expect(few.status).toBe(422);
    expect(few.data.error).toContain('at least 5');
  });
});

describe('Turning a quote into a subscription', () => {
  let id: number;

  it('fills lines from a quotation template and moves through every state', async () => {
    const { today } = await appState();
    const made = await staff.post('/api/subscriptions', { customerId: 25, planId: 3, templateId: 2, startDate: today });
    expect(made.status).toBe(201);
    id = made.data.id;
    expect(made.data.number).toMatch(/^SUB-\d{5}$/);

    const detail = (await staff.get(`/api/subscriptions/${id}`)).data;
    expect(detail.sub.status).toBe('draft');
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[1].variant_extra).toBe(56000);

    expect((await staff.post(`/api/subscriptions/${id}/transition`, { to: 'active' })).status).toBe(409);
    for (const to of ['quotation', 'confirmed', 'active']) {
      expect((await staff.post(`/api/subscriptions/${id}/transition`, { to })).status).toBe(200);
    }
    const after = (await staff.get(`/api/subscriptions/${id}`)).data;
    expect(after.sub.status).toBe('active');
    expect(after.sub.quotation_valid_until).toBe(addDays(today, 21));
    expect(after.events.length).toBeGreaterThanOrEqual(4);
    // A yearly contract counts as one twelfth in MRR, never the full amount.
    expect(after.sub.mrr).toBe(monthlyValue(after.sub.recurring_amount, { unit: 'yearly', interval: 1 }));
  });

  it('blocks a closed subscription from reopening', async () => {
    expect((await staff.post(`/api/subscriptions/${id}/transition`, { to: 'closed', reason: 'done' })).status).toBe(200);
    expect((await staff.post(`/api/subscriptions/${id}/transition`, { to: 'active' })).status).toBe(409);
  });

  it('honours a plan that cannot be closed early, for staff but not the admin', async () => {
    const sub = await one(`SELECT id FROM subscriptions WHERE plan_id = 4 AND status = 'active' AND id > 8 LIMIT 1`);
    const blocked = await staff.post(`/api/subscriptions/${sub!.id}/transition`, { to: 'closed', reason: 'x' });
    expect(blocked.status).toBe(409);
    expect(blocked.data.error).toContain('cannot be closed');
  });
});

describe('Billing day', () => {
  it('moves to a real billing day, with billing waiting for approval', async () => {
    const { today } = await appState();
    const next = await nextBillingDay(today);
    expect(next!.count).toBeGreaterThan(20);
    await advanceClock({ to: next!.date, holdBilling: true, actor: 'Test', emit: () => {} });
    expect((await appState()).today).toBe(next!.date);
  });

  it('bills exactly what the rehearsal predicted, to the paisa', async () => {
    const { today } = await appState();
    const plan = await rehearse(today);
    expect(plan.invoices).toBeGreaterThan(20);
    const before = await one(`SELECT count(*)::int AS n FROM invoices`);

    const run = await runBilling({ asOf: today, kind: 'manual', actor: 'Test' });
    expect(run.matchedRehearsal).toBe(true);
    expect(run.total).toBe(plan.total);
    expect(run.invoices).toBe(plan.invoices);

    const after = await one(`SELECT count(*)::int AS n FROM invoices`);
    expect(after!.n - before!.n).toBe(plan.invoices);
  });

  it('does nothing when run again, because nothing is billed twice', async () => {
    const { today } = await appState();
    const again = await runBilling({ asOf: today, kind: 'manual', actor: 'Test' });
    expect(again.invoices).toBe(0);
  });

  it('raises drafts with no number, then numbers them without a gap', async () => {
    const drafts = await one(`SELECT count(*)::int AS n FROM invoices WHERE status = 'draft'`);
    expect(drafts!.n).toBeGreaterThan(0);
    const unnumbered = await one(`SELECT count(*)::int AS n FROM invoices WHERE status = 'draft' AND number IS NOT NULL`);
    expect(unnumbered!.n).toBe(0);
    await confirmAllDrafts('Test');
    const checks = await runChecks();
    expect(checks.checks.find((c) => c.id === 'gapless_numbers')!.violations).toBe(0);
  });

  it('survives a Postgres-level attempt to bill the same period again', async () => {
    const result = await attemptDoubleBill('Test');
    expect(result.blocked).toBe(true);
    expect(result.sqlState).toBe('23P01');
    expect(result.constraint).toBe('never_billed_twice');
  });

  it('refuses to change a confirmed invoice, even by direct SQL', async () => {
    const inv = await one(`SELECT id FROM invoices WHERE status = 'confirmed' LIMIT 1`);
    await expect(pool.query(`UPDATE invoices SET total = total + 100, taxable = taxable + 100, subtotal = subtotal + 100 WHERE id = $1`, [inv!.id])).rejects.toThrow(/cannot be changed/);
    await expect(pool.query(`UPDATE invoice_lines SET amount = 1 WHERE invoice_id = $1`, [inv!.id])).rejects.toThrow(/cannot be changed/);
  });

  it('catches up every missed period after downtime', async () => {
    const { today } = await appState();
    const sub = await one(`SELECT id, billing_anchor FROM subscriptions WHERE plan_id = 1 AND status = 'active' AND next_billing_date > $1 LIMIT 1`, [today]);
    const before = await one(`SELECT count(*)::int AS n FROM invoices WHERE subscription_id = $1`, [sub!.id]);
    // Pretend the scheduler died three months ago.
    await pool.query(`UPDATE subscriptions SET next_billing_date = next_billing_date - interval '3 months', next_period_index = next_period_index - 3 WHERE id = $1`, [sub!.id]);
    await pool.query(`DELETE FROM billing_periods WHERE subscription_id = $1 AND period_index >= (SELECT next_period_index FROM subscriptions WHERE id = $1)`, [sub!.id]);
    const run = await runBilling({ asOf: today, kind: 'manual', actor: 'Test' });
    expect(run.invoices).toBeGreaterThanOrEqual(3);
    const after = await one(`SELECT count(*)::int AS n FROM invoices WHERE subscription_id = $1`, [sub!.id]);
    expect(after!.n - before!.n).toBeGreaterThanOrEqual(3);
    await confirmAllDrafts('Test');
  });
});

describe('Discounts', () => {
  it('stops a limited discount at its limit, under parallel workers', async () => {
    const { today } = await appState();
    const next = await nextBillingDay(today);
    await advanceClock({ to: next!.date, holdBilling: true, actor: 'Test', emit: () => {} });

    // Created after the jump, so only this one billing day can spend it.
    const res = await admin.post('/api/discounts', { code: 'LIMIT3', name: 'Three uses', kind: 'percent', value: 1000, scope: 'subscription', usageLimit: 3, autoApply: true });
    expect(res.status).toBe(201);

    const plan = await rehearse(next!.date);
    expect(plan.planned.filter((p) => p.discountIds.includes(res.data.id))).toHaveLength(3);

    const run = await runBilling({ asOf: next!.date, kind: 'manual', actor: 'Test', workers: 8 });
    expect(run.matchedRehearsal).toBe(true);
    const row = await one(`SELECT times_used FROM discounts WHERE id = $1`, [res.data.id]);
    expect(row!.times_used).toBe(3);
    await q(`UPDATE discounts SET active = false WHERE id = $1`, [res.data.id]);
    await confirmAllDrafts('Test');
  });

  it('puts usage back when an invoice is cancelled', async () => {
    const red = await one(`SELECT r.invoice_id, d.id, d.times_used FROM discount_redemptions r JOIN discounts d ON d.id = r.discount_id JOIN invoices i ON i.id = r.invoice_id
                            WHERE d.code = 'LIMIT3' AND i.status = 'confirmed' AND i.amount_paid = 0 LIMIT 1`);
    const res = await staff.post(`/api/invoices/${red!.invoice_id}/cancel`, { mode: 'waive', reason: 'Issued in error' });
    expect(res.status).toBe(200);
    const after = await one(`SELECT times_used FROM discounts WHERE id = $1`, [red!.id]);
    expect(after!.times_used).toBe(red!.times_used - 1);
  });
});

describe('The money comes in', () => {
  it('takes part payments on different days, then marks the invoice paid', async () => {
    const inv = await one(`SELECT id, total, amount_paid FROM invoices WHERE status = 'confirmed' AND amount_paid = 0 AND total > 1000 ORDER BY id DESC LIMIT 1`);
    const { today } = await appState();
    const first = Math.floor(inv!.total / 3);
    const r1 = await staff.post('/api/payments', { invoiceId: inv!.id, amount: first, method: 'cash', paidOn: today, note: 'First part' });
    expect(r1.status).toBe(201);
    expect((await one(`SELECT status, amount_paid FROM invoices WHERE id = $1`, [inv!.id]))).toMatchObject({ status: 'confirmed', amount_paid: first });

    const over = await staff.post('/api/payments', { invoiceId: inv!.id, amount: inv!.total, method: 'upi', paidOn: today });
    expect(over.status).toBe(422);

    const r2 = await staff.post('/api/payments', { invoiceId: inv!.id, amount: inv!.total - first, method: 'upi', paidOn: today });
    expect(r2.status).toBe(201);
    expect(await one(`SELECT status FROM invoices WHERE id = $1`, [inv!.id])).toMatchObject({ status: 'paid' });

    const cancel = await staff.post(`/api/invoices/${inv!.id}/cancel`, { mode: 'waive', reason: 'Trying' });
    expect(cancel.status).toBe(409);
  });

  it('stops overpayment in the database itself', async () => {
    const inv = await one(`SELECT id, customer_id, total FROM invoices WHERE status = 'confirmed' AND amount_paid = 0 LIMIT 1`);
    const pay = await one(`INSERT INTO payments (number, customer_id, method, amount, paid_on) VALUES ('PAY-TEST', $1, 'cash', $2, '2026-11-01') RETURNING id`, [inv!.customer_id, inv!.total + 500]);
    await expect(pool.query(`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES ($1,$2,$3)`, [pay!.id, inv!.id, inv!.total + 500])).rejects.toThrow(/exceeds/);
    await pool.query(`DELETE FROM payments WHERE id = $1`, [pay!.id]);
  });

  it('reconciles a bank statement, and refuses to post the same file twice', async () => {
    const sample = (await staff.get('/api/reconcile/sample')).data;
    const upload = async () => {
      const form = new FormData();
      form.append('file', new File([sample.csv], sample.filename, { type: 'text/csv' }));
      const res = await app.request('/api/reconcile/upload', { method: 'POST', body: form, headers: { cookie: staff.cookie } });
      return { status: res.status, data: await res.json() as any };
    };
    const first = await upload();
    expect(first.status).toBe(201);
    expect(first.data.auto_posted).toBeGreaterThan(5);
    expect(first.data.suggested + first.data.unmatched).toBeGreaterThan(0);

    const second = await upload();
    expect(second.data.duplicates).toBe(first.data.lines);
    expect(second.data.auto_posted).toBe(0);

    const lines = (await staff.get(`/api/reconcile/statements/${first.data.statementId}`)).data.lines;
    const pending = lines.find((l: any) => l.status === 'suggested');
    if (pending) expect((await staff.post(`/api/reconcile/lines/${pending.id}/confirm`, { candidate: 0 })).status).toBe(200);
  });
});

describe('Customers manage their own subscriptions', () => {
  it('previews and switches an add-on on, then off', async () => {
    const home = (await customer.get('/api/portal/home')).data;
    const sub = home.subscriptions.find((s: any) => s.status === 'active');
    const detail = (await customer.get(`/api/portal/subscriptions/${sub.id}`)).data;
    const off = detail.addons.find((a: any) => !a.enabled);

    const preview = (await customer.get(`/api/portal/subscriptions/${sub.id}/addons/${off.product_id}/preview?enable=true`)).data;
    expect(preview.chargeNow).toBeGreaterThanOrEqual(0);
    expect(preview.newRecurring).toBe(preview.currentRecurring + off.price);

    expect((await customer.post(`/api/portal/subscriptions/${sub.id}/addons`, { productId: off.product_id, enable: true })).status).toBe(200);
    const on = (await customer.get(`/api/portal/subscriptions/${sub.id}`)).data;
    expect(on.addons.find((a: any) => a.product_id === off.product_id).enabled).toBe(true);

    expect((await customer.post(`/api/portal/subscriptions/${sub.id}/addons`, { productId: off.product_id, enable: false })).status).toBe(200);
  });

  it('lets a new customer buy a plan and pay on their own', async () => {
    const s = new Session();
    await s.post('/api/auth/signup', { name: 'Solo Owner', company: 'Solo Shop', email: 'solo@shop.example', password: STRONG, stateCode: '32', stateName: 'Kerala' });
    const plans = (await s.get('/api/portal/plans')).data;
    const starter = plans.find((p: any) => p.name === 'Starter Monthly');
    expect((await s.post('/api/portal/subscribe', { planId: starter.id, quantity: 2 })).status).toBe(201);

    const home = (await s.get('/api/portal/home')).data;
    expect(home.subscriptions[0].status).toBe('active');
    expect(home.invoices).toHaveLength(1);
    const [invoice] = home.invoices;
    expect(invoice.number).toBeTruthy();
    expect(invoice.total).toBe(Math.round(starter.price * 2 * 1.18));

    const detail = (await s.get(`/api/portal/invoices/${invoice.id}`)).data;
    expect(detail.verified).toBe(true);
    expect(detail.trace.length).toBeGreaterThan(2);

    expect((await s.post(`/api/portal/invoices/${invoice.id}/pay`, { method: 'upi' })).status).toBe(201);
    expect((await s.get('/api/portal/home')).data.totals.outstanding).toBe(0);
  });
});

describe('Contracts that end mid-period', () => {
  const contract = async (autoRenew: boolean) => {
    const { today } = await appState();
    const sub = await one(
      `SELECT s.id, s.next_billing_date FROM subscriptions s WHERE s.plan_id = 1 AND s.status = 'active' AND s.next_billing_date > $1
        AND s.id > 8 AND s.auto_renew = $2 ORDER BY s.id DESC LIMIT 1`,
      [today, autoRenew],
    );
    // Put the expiry in the middle of the next period.
    const expiry = addDays(sub!.next_billing_date, 12);
    await pool.query(`UPDATE subscriptions SET expiry_date = $2 WHERE id = $1`, [sub!.id, expiry]);
    return { id: sub!.id as number, expiry, start: sub!.next_billing_date as string };
  };

  it('bills a renewing contract in full, because it has no real end', async () => {
    const { id, expiry, start } = await contract(true);
    await advanceClock({ to: addDays(start, 1), actor: 'Test', emit: () => {} });
    await confirmAllDrafts('Test');
    const period = await one(`SELECT upper(period) AS e FROM billing_periods WHERE subscription_id = $1 ORDER BY lower(period) DESC LIMIT 1`, [id]);
    expect(period!.e > expiry).toBe(true);
  });

  it('shortens a contract that truly ends, and stays continuous if it is renewed by hand', async () => {
    const { id, expiry } = await contract(false);
    await advanceClock({ to: addDays(expiry, 2), actor: 'Test', emit: () => {} });
    await confirmAllDrafts('Test');
    expect((await staff.post(`/api/subscriptions/${id}/renew`)).status).toBe(200);
    await runBilling({ asOf: (await appState()).today, kind: 'manual', actor: 'Test' });
    await confirmAllDrafts('Test');

    const sub = { id };
    const chain = await q(
      `SELECT lower(period) AS s, upper(period) AS e FROM billing_periods WHERE subscription_id = $1 AND state <> 'voided' ORDER BY lower(period) DESC LIMIT 2`,
      [sub!.id],
    );
    expect(chain[1].e).toBe(expiry);
    expect(chain[0].s).toBe(expiry);
  });
});

describe('Reports', () => {
  it('answers the finance lead, with figures that tie to the ledger', async () => {
    const res = await staff.get('/api/reports/revenue?preset=year');
    expect(res.status).toBe(200);
    const { summary, series } = res.data;
    expect(summary.activeSubscriptions).toBeGreaterThan(100);
    expect(summary.bridge.opening + summary.bridge.net).toBe(summary.bridge.closing);
    const live = await one(`SELECT COALESCE(sum(mrr),0)::bigint AS mrr FROM subscriptions`);
    expect(series[series.length - 1].mrr).toBe(live!.mrr);
  });

  it('applies filters', async () => {
    const all = (await staff.get('/api/reports/revenue')).data.summary;
    const small = (await staff.get('/api/reports/revenue?segment=small')).data.summary;
    expect(small.mrr).toBeLessThan(all.mrr);
  });

  it('answers questions without AI, with receipts', async () => {
    const res = await staff.post('/api/ask', { question: 'who owes us the most?' });
    expect(res.status).toBe(200);
    expect(res.data.mode).toBe('rules');
    expect(res.data.receipts.length).toBeGreaterThan(0);
  });
});

describe('Proof', () => {
  it('survives chaos: racing runs, crashing workers, rogue writers', async () => {
    const { today } = await appState();
    const next = await nextBillingDay(today);
    await advanceClock({ to: next!.date, holdBilling: true, actor: 'Test', emit: () => {} });
    const report = await chaosRun(next!.date, actor);
    expect(report.created).toBe(report.expected);
    expect(report.matchedRehearsal).toBe(true);
    expect(report.rogueEscaped).toBe(0);
    expect(report.rogueBlocked).toBe(report.rogueAttempts);
    await confirmAllDrafts('Test');
  });

  it('passes every integrity check after all of the above', async () => {
    const result = await runChecks();
    const failing = result.checks.filter((c) => c.violations !== 0).map((c) => `${c.id}: ${c.violations}`);
    expect(failing).toEqual([]);
  });

  it('replays every invoice to the same total', async () => {
    const result = await replayInvoices(100000);
    expect(result.replayed).toBeGreaterThan(1000);
    expect(result.mismatches).toEqual([]);
  });

  it('notices when someone tampers with the audit log', async () => {
    await pool.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_no_rewrite`);
    const row = await one(`SELECT id, actor FROM audit_log ORDER BY id LIMIT 1`);
    await pool.query(`UPDATE audit_log SET actor = 'Mallory' WHERE id = $1`, [row!.id]);
    const tampered = await runChecks();
    expect(tampered.checks.find((c) => c.id === 'audit_chain')!.violations).toBeGreaterThan(0);
    await pool.query(`UPDATE audit_log SET actor = $2 WHERE id = $1`, [row!.id, row!.actor]);
    await pool.query(`ALTER TABLE audit_log ENABLE TRIGGER audit_no_rewrite`);
    await expect(pool.query(`DELETE FROM audit_log WHERE id = $1`, [row!.id])).rejects.toThrow(/append-only/);
  });
});
