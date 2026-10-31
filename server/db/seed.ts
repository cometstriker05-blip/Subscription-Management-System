// Builds Brightloop's world through the real engine, so every seeded invoice can be
// replayed and audited like a live one. Deterministic: same seed, same company.
import {
  addDays, addMonths, computeInvoice, financialYear, monthlyValue, periodAt, resolveTaxRule,
  type DiscountRule, type InvoiceInput, type TaxRule,
} from '../engine/index.ts';
import { supplyFor } from '../services/billing.ts';
import { classifyMrr } from '../services/mrr.ts';
import { hashPassword } from '../services/passwords.ts';
import { bulkInsert, pool } from './pool.ts';
import { migrate } from './migrate.ts';

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? process.env[`KEEL_SEED_${name.toUpperCase()}`] ?? fallback);

export const DEMO_LOGINS = {
  admin: { email: 'admin@keel.demo', password: 'Keel@Admin2026' },
  staff: { email: 'asha@keel.demo', password: 'Keel@Staff2026' },
  customer: { email: 'owner@malabarspices.demo', password: 'Keel@Portal2026' },
};

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPANY = {
  name: 'Brightloop Software',
  legalName: 'Brightloop Software Pvt Ltd',
  gstin: '32AAKCB1234F1Z5',
  stateCode: '32',
  stateName: 'Kerala',
  address: 'Infopark Phase 2, Kakkanad, Kochi 682042',
  email: 'billing@brightloop.example',
  invoicePrefix: 'BL',
};

const STATES: [string, string, string[]][] = [
  ['32', 'Kerala', ['Kochi', 'Thiruvananthapuram', 'Kozhikode', 'Thrissur']],
  ['29', 'Karnataka', ['Bengaluru', 'Mysuru', 'Mangaluru']],
  ['33', 'Tamil Nadu', ['Chennai', 'Coimbatore', 'Madurai']],
  ['27', 'Maharashtra', ['Mumbai', 'Pune', 'Nagpur']],
  ['36', 'Telangana', ['Hyderabad', 'Warangal']],
  ['07', 'Delhi', ['New Delhi']],
  ['24', 'Gujarat', ['Ahmedabad', 'Surat']],
  ['08', 'Rajasthan', ['Jaipur', 'Udaipur']],
];

const NAME_A = ['Malabar', 'Periyar', 'Deccan', 'Nilgiri', 'Konkan', 'Vembanad', 'Sahyadri', 'Coromandel', 'Thar', 'Narmada', 'Godavari', 'Kaveri', 'Aravalli', 'Ganga', 'Vindhya', 'Lakshadweep', 'Munnar', 'Wayanad', 'Hampi', 'Sundarban', 'Bharat', 'Saffron', 'Lotus', 'Peacock', 'Banyan', 'Teak', 'Monsoon', 'Harbour', 'Spice', 'Coastal'];
const NAME_B = ['Traders', 'Logistics', 'Textiles', 'Foods', 'Pharma', 'Exports', 'Motors', 'Retail', 'Interiors', 'Agro', 'Infotech', 'Studios', 'Clinics', 'Builders', 'Hospitality', 'Marine', 'Electronics', 'Finserv', 'Learning', 'Packaging'];
const NAME_C = ['Pvt Ltd', 'LLP', 'Ltd', '& Co', 'Enterprises', 'Industries', 'Group', 'Partners'];

export async function seed() {
  const started = Date.now();
  const CUSTOMERS = arg('customers', 9000);
  const TODAY = process.env.SEED_TODAY ?? '2026-10-31';
  const HISTORY_MONTHS = arg('months', 30);
  const rand = mulberry32(20260711);
  const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)];
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const chance = (p: number) => rand() < p;

  console.log(`Seeding ${CUSTOMERS} customers up to ${TODAY}`);
  await migrate();
  const db = await pool.connect();
  await db.query(`SET statement_timeout = 0`);

  await db.query(`TRUNCATE app_state, payment_terms, customers, users, sessions, password_resets, products, product_variants,
    plans, plan_addons, tax_rules, discounts, discount_products, quotation_templates, quotation_template_lines, subscriptions,
    subscription_lines, pending_charges, subscription_discounts, subscription_events, billing_runs, invoices, invoice_lines,
    billing_periods, invoice_sequences, discount_redemptions, bank_statements, bank_lines, payer_aliases, payments,
    payment_allocations, mrr_movements, dunning_events, outbox RESTART IDENTITY CASCADE`);
  await db.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_no_rewrite`);
  await db.query(`DELETE FROM audit_log`);
  await db.query(`ALTER TABLE audit_log ENABLE TRIGGER audit_no_rewrite`);
  await db.query(`UPDATE audit_head SET hash = 'genesis'`);

  await db.query(`INSERT INTO app_state (id, today, clock_mode, auto_confirm, company) VALUES (1, $1, 'simulated', true, $2)`, [TODAY, JSON.stringify(COMPANY)]);

  const terms = [
    { id: 1, name: 'Due on receipt', net_days: 0 },
    { id: 2, name: 'Net 15', net_days: 15 },
    { id: 3, name: 'Net 30', net_days: 30 },
    { id: 4, name: 'Net 45', net_days: 45 },
  ];
  await bulkInsert('payment_terms', terms, db);

  const P = (id: number, name: string, type: string, sales: number, cost: number, notes: string, tax = 'software', sac = '997331') =>
    ({ id, name, type, sales_price: sales * 100, cost_price: cost * 100, notes, tax_category: tax, sac, active: true });
  const products = [
    P(1, 'Brightloop CRM', 'software', 999, 180, 'Per seat. Pipeline, contacts and sales automation.'),
    P(2, 'Brightloop Books', 'software', 1499, 260, 'Per seat. Accounting, GST returns and ledgers.'),
    P(3, 'Brightloop Desk', 'software', 799, 140, 'Per seat. Customer support ticketing.'),
    P(4, 'Brightloop People', 'software', 599, 110, 'Per seat. HR, payroll and attendance.'),
    P(5, 'Brightloop Connect', 'software', 1200, 300, 'Connector to the ERP a customer already runs. Comes in brand variants.'),
    P(6, 'Extra Storage', 'addon', 299, 60, '100 GB of additional storage.'),
    P(7, 'Priority Support', 'addon', 1999, 700, 'Four-hour response, seven days a week.'),
    P(8, 'Advanced Analytics', 'addon', 999, 220, 'Dashboards and scheduled reports.'),
    P(9, 'API Access', 'addon', 1499, 240, 'Full REST API with higher rate limits.'),
    P(10, 'Single Sign-On', 'addon', 699, 90, 'SAML and OIDC sign-in.'),
    P(11, 'Onboarding & Training', 'service', 15000, 6000, 'Guided rollout for a new customer.', 'service', '999293'),
  ];
  await bulkInsert('products', products, db);

  const variants = [
    { id: 1, product_id: 5, attribute: 'Brand', value: 'Odoo', price_extra: 56000 },
    { id: 2, product_id: 5, attribute: 'Brand', value: 'Zoho', price_extra: 34000 },
    { id: 3, product_id: 5, attribute: 'Brand', value: 'Tally', price_extra: 28000 },
    { id: 4, product_id: 5, attribute: 'Brand', value: 'SAP', price_extra: 120000 },
  ];
  await bulkInsert('product_variants', variants, db);

  const plans = [
    { id: 1, name: 'Starter Monthly', product_id: 1, price: 99900, billing_unit: 'monthly', billing_interval: 1, min_quantity: 1, auto_close: false, closable: true, pausable: true, renewable: true, term_months: 12, notes: 'For small shops. Close or pause any time.' },
    { id: 2, name: 'Growth Monthly', product_id: 2, price: 149900, billing_unit: 'monthly', billing_interval: 1, min_quantity: 5, auto_close: false, closable: true, pausable: true, renewable: true, term_months: 12, notes: 'For growing teams.' },
    { id: 3, name: 'Growth Yearly', product_id: 2, price: 1499000, billing_unit: 'yearly', billing_interval: 1, min_quantity: 5, auto_close: false, closable: true, pausable: false, renewable: true, term_months: 12, notes: 'Two months free against monthly.' },
    { id: 4, name: 'Enterprise Yearly', product_id: 2, price: 2399000, billing_unit: 'yearly', billing_interval: 1, min_quantity: 25, auto_close: false, closable: false, pausable: false, renewable: true, term_months: 12, notes: 'Contracted. Cannot be closed early.' },
    { id: 5, name: 'Weekly Sprint', product_id: 3, price: 24900, billing_unit: 'weekly', billing_interval: 1, min_quantity: 1, auto_close: true, closable: true, pausable: false, renewable: false, term_months: 3, notes: 'Short campaigns. Closes on its own.' },
    { id: 6, name: 'Daily Pass', product_id: 3, price: 4900, billing_unit: 'daily', billing_interval: 1, min_quantity: 1, auto_close: true, closable: true, pausable: false, renewable: false, term_months: 1, notes: 'Pay by the day for peak season.' },
    { id: 7, name: 'Festive Launch', product_id: 4, price: 129900, billing_unit: 'monthly', billing_interval: 1, min_quantity: 3, available_from: '2026-09-01', available_until: '2026-11-30', auto_close: true, closable: true, pausable: false, renewable: false, term_months: 6, notes: 'Limited launch offer. Closes on its own.' },
  ];
  await bulkInsert('plans', plans.map((p) => ({ available_from: null, available_until: null, active: true, ...p })), db);

  const addonPrices: Record<number, number> = { 6: 29900, 7: 199900, 8: 99900, 9: 149900, 10: 69900 };
  const planAddons: any[] = [];
  for (const plan of plans) {
    for (const [productId, monthly] of Object.entries(addonPrices)) {
      if (plan.billing_unit === 'daily') continue;
      const price = plan.billing_unit === 'yearly' ? monthly * 10 : plan.billing_unit === 'weekly' ? Math.round(monthly / 4) : monthly;
      planAddons.push({ plan_id: plan.id, product_id: Number(productId), price });
    }
  }
  await bulkInsert('plan_addons', planAddons, db);

  const taxRows = [
    { id: 1, name: 'GST 18% within Kerala', tax_category: null, supply: 'intra', components: [{ label: 'CGST', rate: 900 }, { label: 'SGST', rate: 900 }], priority: 0 },
    { id: 2, name: 'GST 18% across states', tax_category: null, supply: 'inter', components: [{ label: 'IGST', rate: 1800 }], priority: 0 },
    { id: 3, name: 'Export of services (zero rated)', tax_category: null, supply: 'export', components: [{ label: 'IGST', rate: 0 }], priority: 0 },
  ];
  await bulkInsert('tax_rules', taxRows.map((t) => ({ ...t, active: true })), db);
  const taxRules: TaxRule[] = taxRows.map((t) => ({ id: t.id, name: t.name, taxCategory: t.tax_category, supply: t.supply as any, components: t.components, validFrom: null, validUntil: null, priority: 0, active: true }));

  const discountRows: any[] = [
    { id: 1, code: 'SEATS10', name: 'Volume: 10 seats or more', kind: 'percent', value: 1000, min_quantity: 10, min_purchase: 0, usage_limit: null, valid_from: '2024-01-01', valid_until: null, scope: 'subscription', auto_apply: false },
    { id: 2, code: 'FESTIVE15', name: 'Festive season offer', kind: 'percent', value: 1500, min_quantity: 0, min_purchase: 500000, usage_limit: null, valid_from: '2026-10-01', valid_until: '2026-11-15', scope: 'subscription', auto_apply: false },
    { id: 3, code: 'WELCOME500', name: 'Welcome credit', kind: 'fixed', value: 50000, min_quantity: 0, min_purchase: 0, usage_limit: 40, valid_from: '2026-01-01', valid_until: '2026-12-31', scope: 'subscription', auto_apply: false },
    { id: 4, code: 'ADDON25', name: 'Priority Support promotion', kind: 'percent', value: 2500, min_quantity: 0, min_purchase: 0, usage_limit: null, valid_from: '2026-06-01', valid_until: '2027-03-31', scope: 'products', auto_apply: false },
  ];
  await bulkInsert('discounts', discountRows.map((d) => ({ ...d, times_used: 0, active: true })), db);
  await bulkInsert('discount_products', [{ discount_id: 4, product_id: 7 }], db);
  const discountById = new Map<number, DiscountRule>(discountRows.map((d) => [d.id, {
    id: d.id, code: d.code, name: d.name, kind: d.kind, value: d.value, minPurchase: d.min_purchase, minQuantity: d.min_quantity,
    validFrom: d.valid_from, validUntil: d.valid_until, usageLimit: d.usage_limit, timesUsed: 0, scope: d.scope,
    productIds: d.id === 4 ? [7] : [], active: true,
  }]));

  const templates = [
    { id: 1, name: 'Enterprise rollout', plan_id: 4, validity_days: 30, notes: 'Standard offer for 25 seats and above.' },
    { id: 2, name: 'Growth bundle with Connect', plan_id: 3, validity_days: 21, notes: 'Books plus the Connect connector.' },
    { id: 3, name: 'Starter quick start', plan_id: 1, validity_days: 14, notes: 'A fast yes for small shops.' },
  ];
  await bulkInsert('quotation_templates', templates.map((t) => ({ ...t, active: true })), db);
  await bulkInsert('quotation_template_lines', [
    { template_id: 1, product_id: 2, variant_id: null, quantity: 50, unit_price: 2399000, sort: 0 },
    { template_id: 1, product_id: 7, variant_id: null, quantity: 1, unit_price: 1999000, sort: 1 },
    { template_id: 2, product_id: 2, variant_id: null, quantity: 10, unit_price: 1499000, sort: 0 },
    { template_id: 2, product_id: 5, variant_id: 1, quantity: 1, unit_price: 1256000, sort: 1 },
    { template_id: 3, product_id: 1, variant_id: null, quantity: 3, unit_price: 99900, sort: 0 },
  ], db);

  // Customers. The first few are hand-written heroes the demo and sample statement lean on.
  const heroes = [
    { name: 'Malabar Spices Pvt Ltd', city: 'Kochi', state: STATES[0], segment: 'mid', email: 'accounts@malabarspices.demo' },
    { name: 'Periyar Logistics LLP', city: 'Kochi', state: STATES[0], segment: 'mid', email: 'finance@periyarlogistics.demo' },
    { name: 'Kochi Port Traders', city: 'Kochi', state: STATES[0], segment: 'small', email: 'office@kochiport.demo' },
    { name: 'Deccan Fintech Ltd', city: 'Bengaluru', state: STATES[1], segment: 'enterprise', email: 'ap@deccanfintech.demo' },
    { name: 'Nilgiri Tea Estates', city: 'Coimbatore', state: STATES[2], segment: 'mid', email: 'accounts@nilgiritea.demo' },
    { name: 'Konkan Marine Exports', city: 'Mumbai', state: STATES[3], segment: 'enterprise', email: 'billing@konkanmarine.demo' },
    { name: 'Straits Robotics Pte Ltd', city: 'Singapore', state: null, segment: 'mid', email: 'finance@straitsrobotics.demo' },
    { name: 'Vembanad Resorts', city: 'Alappuzha', state: STATES[0], segment: 'small', email: 'stay@vembanadresorts.demo' },
  ];

  const customers: any[] = [];
  const behaviour: { lateness: 'prompt' | 'late' | 'poor'; deductsTds: boolean }[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < CUSTOMERS; i++) {
    const hero = heroes[i];
    const roll = rand();
    const segment = hero?.segment ?? (roll < 0.72 ? 'small' : roll < 0.95 ? 'mid' : 'enterprise');
    const state = hero ? hero.state : pick(STATES);
    let name = hero?.name ?? '';
    while (!name) {
      const base = `${pick(NAME_A)} ${pick(NAME_B)} ${pick(NAME_C)}`;
      const candidate = usedNames.has(base) ? `${base} ${between(2, 99)}` : base;
      if (!usedNames.has(candidate)) name = candidate;
    }
    usedNames.add(name);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
    const stateCode = state?.[0] ?? null;
    const gstin = stateCode && segment !== 'small'
      ? `${stateCode}${randomPan(rand)}${between(1, 9)}Z${between(0, 9)}`
      : stateCode && chance(0.45) ? `${stateCode}${randomPan(rand)}1Z${between(0, 9)}` : null;
    customers.push({
      id: i + 1,
      code: `C${String(i + 1).padStart(5, '0')}`,
      name,
      email: hero?.email ?? `accounts${i + 1}@${slug}.demo`,
      phone: `+91 9${between(100000000, 999999999)}`,
      gstin,
      state_code: stateCode,
      state_name: state?.[1] ?? null,
      city: hero?.city ?? (state ? pick(state[2]) : 'Singapore'),
      address: `${between(1, 240)}, ${pick(['MG Road', 'Marine Drive', 'Station Road', 'Industrial Estate', 'Tech Park', 'Market Road'])}`,
      country: state ? 'IN' : 'SG',
      segment,
      payment_term_id: segment === 'enterprise' ? 4 : segment === 'mid' ? 3 : pick([1, 2, 2, 3]),
      created_on: TODAY,
    });
    const l = rand();
    behaviour.push({
      lateness: l < 0.78 ? 'prompt' : l < 0.95 ? 'late' : 'poor',
      deductsTds: segment !== 'small' && chance(0.4),
    });
  }
  // Heroes get behaviour the demo script relies on.
  behaviour[0] = { lateness: 'prompt', deductsTds: false };
  behaviour[2] = { lateness: 'poor', deductsTds: false };
  behaviour[3] = { lateness: 'late', deductsTds: true };
  await bulkInsert('customers', customers, db);

  const pwd = hashPassword;
  await bulkInsert('users', [
    { id: 1, email: DEMO_LOGINS.admin.email, password_hash: pwd(DEMO_LOGINS.admin.password), name: 'Meera Nair', role: 'admin', customer_id: null, active: true },
    { id: 2, email: DEMO_LOGINS.staff.email, password_hash: pwd(DEMO_LOGINS.staff.password), name: 'Asha Thomas', role: 'staff', customer_id: null, active: true },
    { id: 3, email: DEMO_LOGINS.customer.email, password_hash: pwd(DEMO_LOGINS.customer.password), name: 'Rahul Menon', role: 'customer', customer_id: 1, active: true },
  ], db);

  const subs: any[] = [];
  const lines: any[] = [];
  const invoices: any[] = [];
  const invoiceLines: any[] = [];
  const periods: any[] = [];
  const payments: any[] = [];
  const allocations: any[] = [];
  const redemptions: any[] = [];
  const attached: any[] = [];
  const events: any[] = [];
  const mrrEvents: { date: string; customerId: number; subId: number; planId: number; delta: number; order: number }[] = [];
  const productById = new Map(products.map((p) => [p.id, p]));
  const companyForSupply = { ...COMPANY };
  let invoiceId = 0, lineId = 0, paymentId = 0, periodId = 0, order = 0;

  // Monthly anchors cluster on the 1st, which is what makes billing day a real event.
  const anchorFor = (start: string, unit: string) => {
    if (unit === 'monthly' && chance(0.38)) return addMonths(`${start.slice(0, 7)}-01`, 1);
    return start;
  };

  const planFor = (segment: string) => {
    const r = rand();
    if (segment === 'enterprise') return plans[r < 0.82 ? 3 : 2];
    if (segment === 'mid') return plans[r < 0.5 ? 1 : r < 0.84 ? 2 : r < 0.92 ? 0 : r < 0.96 ? 4 : 6];
    return plans[r < 0.72 ? 0 : r < 0.84 ? 1 : r < 0.92 ? 4 : r < 0.97 ? 5 : 6];
  };

  const seatsFor = (segment: string, min: number) => {
    if (segment === 'enterprise') return Math.max(min, between(25, 160));
    if (segment === 'mid') return Math.max(min, between(5, 40));
    return Math.max(min, between(1, 9));
  };

  const makeSubscription = (customer: any, b: (typeof behaviour)[0], spec: {
    plan: (typeof plans)[0]; start: string; anchor?: string; seats: number; addons?: number[]; connect?: number | null;
    discountIds?: number[]; live?: boolean; forceOpen?: boolean; expiryOffsetDays?: number;
  }) => {
    const { plan, start } = spec;
    const subId = subs.length + 1;
    const anchor = spec.anchor ?? anchorFor(start, plan.billing_unit);
    const recurrence = { unit: plan.billing_unit as any, interval: plan.billing_interval };
    const term = plan.term_months;
    const netDays = terms.find((t) => t.id === customer.payment_term_id)!.net_days;

    const subLines: any[] = [{ product_id: plan.product_id, variant_id: null, description: `${productById.get(plan.product_id!)!.name} (${plan.name})`, quantity: spec.seats, unit_price: plan.price, variant_extra: 0, is_addon: false }];
    if (spec.connect) {
      const v = variants.find((x) => x.id === spec.connect)!;
      const yearly = plan.billing_unit === 'yearly' ? 10 : 1;
      subLines.push({ product_id: 5, variant_id: v.id, description: `Brightloop Connect, ${v.attribute}: ${v.value}`, quantity: 1, unit_price: (120000 + v.price_extra) * yearly, variant_extra: v.price_extra * yearly, is_addon: false });
    }
    for (const addon of spec.addons ?? []) {
      const offer = planAddons.find((a) => a.plan_id === plan.id && a.product_id === addon);
      if (offer) subLines.push({ product_id: addon, variant_id: null, description: productById.get(addon)!.name, quantity: 1, unit_price: offer.price, variant_extra: 0, is_addon: true });
    }

    // Lifetime: most customers stay, and churn lands on a period boundary.
    const monthlyChurn = spec.live ? 0 : { small: 0.016, mid: 0.008, enterprise: 0.003 }[customer.segment as string]!;
    const liveDiscounts = (spec.discountIds ?? []).map((id) => discountById.get(id)!);

    let expiry: string | null = plan.auto_close || !plan.renewable ? addMonths(start, term) : null;
    let closedOn: string | null = null;
    let closeReason: string | null = null;
    let lastK = -1;
    const seatStep = chance(0.1) ? { at: between(2, 14), seats: spec.seats + between(1, Math.max(2, Math.ceil(spec.seats / 3))) } : null;
    let currentSeats = spec.seats;
    let currentMrr = 0;

    const supply = supplyFor(customer, companyForSupply);
    const applicableRules = taxRules.filter((r) => r.supply === supply);

    for (let k = 0; ; k++) {
      const period = periodAt(anchor, k, recurrence, expiry);
      if (period.start > TODAY) break;
      if (expiry && period.start >= expiry) break;

      if (!spec.live && k > 0) {
        const unitsPerMonth = { daily: 30, weekly: 4.3, monthly: 1, yearly: 1 / 12 }[plan.billing_unit]!;
        const hazard = plan.billing_unit === 'yearly' ? monthlyChurn * 12 : monthlyChurn / unitsPerMonth;
        if (chance(hazard)) {
          closedOn = period.start;
          closeReason = pick(['Moved to a competitor', 'Business closed', 'Budget cut', 'Went back to spreadsheets']);
          break;
        }
      }
      if (seatStep && k === seatStep.at) {
        currentSeats = seatStep.seats;
        subLines[0].quantity = currentSeats;
      }

      const recurring = subLines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0);
      const mrr = monthlyValue(recurring, recurrence);
      if (mrr !== currentMrr) {
        mrrEvents.push({ date: period.start, customerId: customer.id, subId, planId: plan.id, delta: mrr - currentMrr, order: order++ });
        currentMrr = mrr;
      }

      const input: InvoiceInput = {
        subscriptionNumber: `SUB-${String(subId).padStart(5, '0')}`,
        planName: plan.name,
        period: { start: period.start, end: period.end, fullEnd: period.fullEnd },
        issueDate: period.start,
        supply,
        lines: subLines.map((l, idx) => ({
          lineId: subId * 10 + idx, productId: l.product_id, variantId: l.variant_id, description: l.description,
          taxCategory: 'software', sac: productById.get(l.product_id)!.sac, quantity: l.quantity, unitPrice: l.unit_price,
          ...(l.variant_extra ? { variantExtra: l.variant_extra, basePrice: l.unit_price - l.variant_extra } : {}),
        })),
        discounts: liveDiscounts.map((d) => ({ ...d })),
        taxRules: applicableRules.filter((r) => resolveTaxRule(applicableRules, 'software', supply, period.start)?.id === r.id),
      };
      const result = computeInvoice(input);
      const id = ++invoiceId;
      const issue = period.start;
      const due = addDays(issue, netDays);

      invoices.push({
        id, number: null, fy: null, serial: null, subscription_id: subId, customer_id: customer.id, status: 'confirmed',
        issue_date: issue, due_date: due, period_start: period.start, period_end: period.end, supply,
        subtotal: result.subtotal, discount: result.discount, taxable: result.taxable, tax: result.tax, total: result.total,
        amount_paid: 0, tax_summary: result.taxSummary,
        customer_snapshot: { id: customer.id, name: customer.name, email: customer.email, gstin: customer.gstin, state_name: customer.state_name, state_code: customer.state_code, city: customer.city, address: customer.address, country: customer.country },
        engine_input: input, sent_at: `${issue}T09:00:00Z`, confirmed_at: `${issue}T09:00:00Z`, paid_on: null, created_at: `${issue}T09:00:00Z`,
      });
      for (const l of result.lines) {
        invoiceLines.push({
          id: ++lineId, invoice_id: id, product_id: l.productId, variant_id: l.variantId, description: l.description, sac: l.sac,
          quantity: l.quantity, unit_price: l.unitPrice, gross: l.gross, discount: l.discount, taxable: l.taxable, tax: l.tax, amount: l.amount, taxes: l.taxes,
        });
      }
      for (const d of result.discounts) {
        redemptions.push({ discount_id: d.discountId, invoice_id: id, subscription_id: subId, amount: d.amount });
        discountById.get(d.discountId)!.timesUsed++;
      }
      periods.push({ id: ++periodId, subscription_id: subId, period_index: k, period: `[${period.start},${period.end})`, state: 'billed', invoice_id: id });

      // Decide how this invoice gets paid.
      const inv = invoices[invoices.length - 1];
      const lateness = spec.forceOpen ? 400
        : b.lateness === 'prompt' ? between(-6, 3)
        : b.lateness === 'late' ? between(4, 34)
        : chance(0.22) ? 999 : between(18, 95);
      const payDate = addDays(due, lateness);
      const addPayment = (amount: number, on: string, method: string, note: string | null) => {
        const pid = ++paymentId;
        payments.push({
          id: pid, number: `PAY-${String(pid).padStart(6, '0')}`, customer_id: customer.id, method, amount, paid_on: on, note,
          reference: method === 'tds' ? `TDS/${on.slice(0, 7)}` : `${method.toUpperCase().slice(0, 4)}${between(100000, 999999)}`, source: 'import', created_by: 'Keel',
          created_at: `${on}T12:00:00Z`,
        });
        allocations.push({ payment_id: pid, invoice_id: id, amount });
        inv.amount_paid += amount;
      };
      const method = customer.segment === 'small' ? pick(['upi', 'upi', 'card', 'bank_transfer']) : pick(['bank_transfer', 'bank_transfer', 'bank_transfer', 'cheque']);

      if (payDate <= TODAY && lateness !== 999) {
        const tds = b.deductsTds && chance(0.85) ? Math.round(result.taxable * 0.1) : 0;
        if (chance(0.03) && result.total > 200000) {
          const firstPart = Math.round((result.total - tds) * 0.5);
          addPayment(firstPart, addDays(payDate, -between(4, 12)) < issue ? issue : addDays(payDate, -between(4, 12)), method, 'First instalment');
          addPayment(result.total - tds - firstPart, payDate, method, 'Balance');
        } else {
          addPayment(result.total - tds, payDate, method, null);
        }
        if (tds) addPayment(tds, payDate, 'tds', 'Tax deducted at source, 10%');
        inv.status = 'paid';
        inv.paid_on = payDate;
      } else if (lateness === 999 && chance(0.15) && result.total > 100000) {
        addPayment(Math.round(result.total * 0.4), addDays(due, between(1, 15)) > TODAY ? TODAY : addDays(due, between(1, 15)), method, 'Part payment');
      }
      lastK = k;
    }

    // Decide how the contract stands today.
    if (!closedOn && expiry && expiry <= TODAY) {
      closedOn = expiry;
      closeReason = 'Closed on its own at the end of the plan';
    }
    if (!expiry) {
      const renewals = Math.ceil((Math.max(0, monthsBetween(start, TODAY)) + 0.5) / term);
      expiry = addMonths(start, Math.max(1, renewals) * term);
      if (expiry <= TODAY) expiry = addMonths(expiry, term);
      if (spec.expiryOffsetDays !== undefined) expiry = addDays(TODAY, spec.expiryOffsetDays);
    }
    if (closedOn) {
      mrrEvents.push({ date: closedOn, customerId: customer.id, subId, planId: plan.id, delta: -currentMrr, order: order++ });
      currentMrr = 0;
    }

    const next = periodAt(anchor, lastK + 1, recurrence, expiry);
    const live = !closedOn;
    const recurring = subLines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0);

    subs.push({
      id: subId, number: `SUB-${String(subId).padStart(5, '0')}`, customer_id: customer.id, plan_id: plan.id,
      status: live ? 'active' : 'closed', start_date: start, expiry_date: expiry, billing_anchor: anchor,
      next_period_index: lastK + 1, next_billing_date: live && next.start < expiry ? next.start : null,
      payment_term_id: customer.payment_term_id, auto_renew: plan.renewable && !chance(0.12), owner_id: 2, recurring_amount: recurring,
      mrr: currentMrr, activated_on: start, closed_on: closedOn, close_reason: closeReason, created_on: addDays(start, -between(1, 14)),
      created_at: `${start}T08:00:00Z`,
    });
    subLines.forEach((l, idx) => lines.push({ subscription_id: subId, ...l, sort: idx }));
    for (const d of spec.discountIds ?? []) attached.push({ subscription_id: subId, discount_id: d, attached_on: start });
    events.push({ subscription_id: subId, kind: 'activated', from_status: 'confirmed', to_status: 'active', actor: 'Asha Thomas', on_date: start, created_at: `${start}T08:00:00Z` });
    if (closedOn) events.push({ subscription_id: subId, kind: 'closed', from_status: 'active', to_status: 'closed', actor: 'Keel', on_date: closedOn, detail: { reason: closeReason }, created_at: `${closedOn}T08:00:00Z` });
    return subId;
  };

  // Hero contracts, set up so the demo scenes land on real numbers.
  makeSubscription(customers[0], behaviour[0], { plan: plans[1], start: '2025-08-01', anchor: '2025-08-01', seats: 12, addons: [7], connect: 1, discountIds: [1, 2], live: true, expiryOffsetDays: 275 });
  makeSubscription(customers[1], behaviour[1], { plan: plans[2], start: '2025-11-01', anchor: '2025-11-01', seats: 18, addons: [8, 9], connect: 3, discountIds: [1], live: true, expiryOffsetDays: 1 });
  makeSubscription(customers[2], behaviour[2], { plan: plans[0], start: '2026-02-01', anchor: '2026-02-01', seats: 4, addons: [6], live: true, forceOpen: true, expiryOffsetDays: 120 });
  makeSubscription(customers[3], behaviour[3], { plan: plans[3], start: '2025-04-01', anchor: '2025-04-01', seats: 120, addons: [7, 9, 10], live: true });
  makeSubscription(customers[4], behaviour[4], { plan: plans[1], start: '2026-03-01', anchor: '2026-03-01', seats: 9, addons: [6], live: true, discountIds: [3] });
  makeSubscription(customers[5], behaviour[5], { plan: plans[3], start: '2025-11-15', anchor: '2025-11-15', seats: 60, live: true, expiryOffsetDays: 15 });
  makeSubscription(customers[6], behaviour[6], { plan: plans[2], start: '2026-01-10', anchor: '2026-01-10', seats: 14, live: true });
  makeSubscription(customers[7], behaviour[7], { plan: plans[0], start: '2026-05-01', anchor: '2026-05-01', seats: 3, live: true, forceOpen: true, expiryOffsetDays: 180 });

  for (let i = heroes.length; i < CUSTOMERS; i++) {
    const customer = customers[i];
    const count = customer.segment === 'enterprise' ? between(1, 3) : customer.segment === 'mid' ? (chance(0.3) ? 2 : 1) : 1;
    for (let n = 0; n < count; n++) {
      const plan = planFor(customer.segment);
      const skew = Math.pow(rand(), 1.4);
      let start = addDays(TODAY, -Math.floor(skew * HISTORY_MONTHS * 30) - 1);
      if (plan.available_from && start < plan.available_from) start = addDays(plan.available_from, between(0, 40));
      if (plan.billing_unit === 'daily' || plan.billing_unit === 'weekly') start = addDays(TODAY, -between(3, 70));
      if (start > TODAY) start = TODAY;
      const seats = seatsFor(customer.segment, plan.min_quantity);
      const addons = (Object.keys(addonPrices).map(Number)).filter(() => chance(customer.segment === 'small' ? 0.08 : 0.22));
      const connect = customer.segment !== 'small' && chance(0.25) ? pick([1, 2, 3, 4]) : null;
      const discountIds: number[] = [];
      if (seats >= 10 && chance(0.45)) discountIds.push(1);
      if (addons.includes(7) && chance(0.3)) discountIds.push(4);
      if (start >= '2026-09-15' && chance(0.3)) discountIds.push(2);
      if (n === 0 && i % 97 === 0) discountIds.push(3);
      const expiryOffsetDays = chance(0.06) ? between(1, 90) : undefined;
      makeSubscription(customer, behaviour[i], { plan, start, seats, addons, connect, discountIds, expiryOffsetDays });
    }
  }

  // Assign gapless invoice numbers in date order, per financial year.
  const ordered = [...invoices].sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.id - b.id);
  const counters = new Map<string, number>();
  for (const inv of ordered) {
    const fy = financialYear(inv.issue_date);
    const serial = (counters.get(fy) ?? 0) + 1;
    counters.set(fy, serial);
    inv.fy = fy;
    inv.serial = serial;
    inv.number = `${COMPANY.invoicePrefix}/${fy}/${String(serial).padStart(6, '0')}`;
  }

  // A sales pipeline, for the board.
  const pipelineStatuses = ['draft', 'quotation', 'quotation', 'quotation', 'confirmed'];
  const pipelineBase = subs.length;
  for (let n = 0; n < 150; n++) {
    const customer = customers[between(10, CUSTOMERS - 1)];
    const plan = pick([plans[1], plans[2], plans[3], plans[0]]);
    const id = pipelineBase + n + 1;
    const status = pipelineStatuses[n % pipelineStatuses.length];
    const seats = seatsFor(customer.segment, plan.min_quantity);
    const start = addDays(TODAY, between(2, 28));
    subs.push({
      id, number: `SUB-${String(id).padStart(5, '0')}`, customer_id: customer.id, plan_id: plan.id, status, start_date: start,
      expiry_date: addMonths(start, plan.term_months), billing_anchor: start, next_period_index: 0, next_billing_date: start,
      payment_term_id: customer.payment_term_id, auto_renew: plan.renewable, owner_id: 2,
      quotation_valid_until: status === 'quotation' ? addDays(TODAY, between(1, 20)) : null,
      recurring_amount: seats * plan.price, mrr: 0, created_on: addDays(TODAY, -between(0, 12)), created_at: `${TODAY}T08:00:00Z`,
    });
    lines.push({ subscription_id: id, product_id: plan.product_id, variant_id: null, description: `${productById.get(plan.product_id!)!.name} (${plan.name})`, quantity: seats, unit_price: plan.price, variant_extra: 0, is_addon: false, sort: 0 });
    events.push({ subscription_id: id, kind: 'created', from_status: null, to_status: status, actor: 'Asha Thomas', on_date: TODAY, created_at: `${TODAY}T08:00:00Z` });
  }

  // Classify MRR history in time order, so new, churn and expansion are honest.
  const running = new Map<number, number>();
  const seen = new Set<number>();
  const movements = mrrEvents
    .sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order)
    .map((e) => {
      const before = running.get(e.customerId) ?? 0;
      const after = before + e.delta;
      const kind = classifyMrr({ customerBefore: before, customerAfter: after, everPaid: seen.has(e.customerId), delta: e.delta });
      running.set(e.customerId, after);
      seen.add(e.customerId);
      return { on_date: e.date, subscription_id: e.subId, customer_id: e.customerId, plan_id: e.planId, kind, delta: e.delta };
    });

  console.log(`  ${subs.length} subscriptions, ${invoices.length} invoices, ${payments.length} payments. Writing...`);

  await db.query(`ALTER TABLE invoices DISABLE TRIGGER USER`);
  await db.query(`ALTER TABLE invoice_lines DISABLE TRIGGER USER`);
  await db.query(`ALTER TABLE payment_allocations DISABLE TRIGGER USER`);
  await db.query(`ALTER TABLE billing_periods DROP CONSTRAINT never_billed_twice`);

  await bulkInsert('subscriptions', subs, db);
  await bulkInsert('subscription_lines', lines, db);
  await bulkInsert('subscription_discounts', attached, db);
  await bulkInsert('subscription_events', events, db);
  await bulkInsert('invoices', invoices, db, 2000);
  await bulkInsert('invoice_lines', invoiceLines, db);
  await bulkInsert('billing_periods', periods, db);
  await bulkInsert('discount_redemptions', redemptions, db);
  await bulkInsert('payments', payments, db);
  await bulkInsert('payment_allocations', allocations, db);
  await bulkInsert('mrr_movements', movements, db);

  // Restoring the constraint re-validates every period in the seed.
  await db.query(`ALTER TABLE billing_periods ADD CONSTRAINT never_billed_twice EXCLUDE USING gist (subscription_id WITH =, period WITH &&) WHERE (state <> 'voided')`);
  await db.query(`ALTER TABLE invoices ENABLE TRIGGER USER`);
  await db.query(`ALTER TABLE invoice_lines ENABLE TRIGGER USER`);
  await db.query(`ALTER TABLE payment_allocations ENABLE TRIGGER USER`);

  for (const d of discountById.values()) await db.query(`UPDATE discounts SET times_used = $2 WHERE id = $1`, [d.id, d.timesUsed]);
  // Leave WELCOME500 two uses short of its limit so the demo run shows it running out.
  await db.query(`UPDATE discounts SET usage_limit = GREATEST(times_used + 2, 1) WHERE id = 3`);
  for (const [fy, serial] of counters) await db.query(`INSERT INTO invoice_sequences (fy, last_serial) VALUES ($1,$2)`, [fy, serial]);

  for (const [table, value] of Object.entries({
    subscriptions: subs.length, invoices: invoiceId, invoice_lines: lineId, billing_periods: periodId, payments: paymentId, customers: CUSTOMERS,
    users: 3, products: products.length, product_variants: variants.length, plans: plans.length, tax_rules: taxRows.length,
    discounts: discountRows.length, quotation_templates: templates.length, payment_terms: terms.length,
  })) {
    await db.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), $2)`, [table, value]);
  }
  await db.query(`SELECT setval('subscription_number_seq', $1)`, [subs.length]);
  await db.query(`SELECT setval('payment_number_seq', $1)`, [paymentId]);
  await db.query(`ANALYZE`);
  await db.query(`INSERT INTO audit_log (actor, action, entity, entity_id, detail, prev_hash, hash) VALUES ('Keel', 'system.seeded', 'system', NULL, $1, '', '')`, [JSON.stringify({ customers: CUSTOMERS, subscriptions: subs.length, invoices: invoices.length })]);

  db.release();
  console.log(`  Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { subscriptions: subs.length, invoices: invoices.length, payments: payments.length };
}

function randomPan(rand: () => number) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const L = () => letters[Math.floor(rand() * letters.length)];
  return `${L()}${L()}${L()}${L()}${L()}${1000 + Math.floor(rand() * 9000)}${L()}`;
}

function monthsBetween(a: string, b: string) {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('db/seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  await seed();
  await pool.end();
}
