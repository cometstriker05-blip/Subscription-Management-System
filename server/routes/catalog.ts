import { Hono } from 'hono';
import { z } from 'zod';
import { one, q, tx } from '../db/pool.ts';
import { appState, audit, conflict, Filters, listPage, notFound, paging } from '../services/core.ts';
import { actorOf, adminOnly, body, date, idParam, money, staffOnly, type Env } from './helpers.ts';

export const catalog = new Hono<Env>();

const productSchema = z.object({
  name: z.string().trim().min(2, 'Name the product'),
  type: z.enum(['software', 'service', 'addon', 'goods']),
  salesPrice: money,
  costPrice: money,
  notes: z.string().nullish(),
  taxCategory: z.string().default('software'),
  sac: z.string().nullish(),
  active: z.boolean().default(true),
  variants: z.array(z.object({ attribute: z.string().min(1), value: z.string().min(1), priceExtra: z.number().int() })).default([]),
});

catalog.get('/products', staffOnly, async (c) => {
  const rows = await q(
    `SELECT p.*, COALESCE((SELECT jsonb_agg(v ORDER BY v.id) FROM product_variants v WHERE v.product_id = p.id), '[]') AS variants,
            (SELECT count(*)::int FROM subscription_lines l JOIN subscriptions s ON s.id = l.subscription_id
              WHERE l.product_id = p.id AND s.status = 'active') AS in_use
       FROM products p ORDER BY p.type DESC, p.id`,
  );
  return c.json(rows);
});

async function saveVariants(client: any, productId: number, variants: z.infer<typeof productSchema>['variants']) {
  const existing = await q(`SELECT id, attribute, value FROM product_variants WHERE product_id = $1`, [productId], client);
  for (const v of variants) {
    await client.query(
      `INSERT INTO product_variants (product_id, attribute, value, price_extra) VALUES ($1,$2,$3,$4)
       ON CONFLICT (product_id, attribute, value) DO UPDATE SET price_extra = EXCLUDED.price_extra`,
      [productId, v.attribute, v.value, v.priceExtra],
    );
  }
  for (const old of existing) {
    if (!variants.some((v) => v.attribute === old.attribute && v.value === old.value)) {
      const used = await one(`SELECT 1 AS ok FROM subscription_lines WHERE variant_id = $1 LIMIT 1`, [old.id], client);
      if (used) throw conflict(`${old.attribute}: ${old.value} is on live subscriptions, so it cannot be removed`);
      await client.query(`DELETE FROM product_variants WHERE id = $1`, [old.id]);
    }
  }
}

catalog.post('/products', adminOnly, async (c) => {
  const p = await body(c, productSchema);
  const id = await tx(async (client) => {
    const row = await one(
      `INSERT INTO products (name, type, sales_price, cost_price, notes, tax_category, sac, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [p.name, p.type, p.salesPrice, p.costPrice, p.notes ?? null, p.taxCategory, p.sac ?? null, p.active],
      client,
    );
    await saveVariants(client, row!.id, p.variants);
    await audit(actorOf(c).name, 'product.create', 'product', row!.id, { name: p.name }, client);
    return row!.id;
  });
  return c.json({ id }, 201);
});

catalog.put('/products/:id', adminOnly, async (c) => {
  const id = idParam(c);
  const p = await body(c, productSchema);
  await tx(async (client) => {
    const hit = await client.query(
      `UPDATE products SET name=$2, type=$3, sales_price=$4, cost_price=$5, notes=$6, tax_category=$7, sac=$8, active=$9 WHERE id=$1`,
      [id, p.name, p.type, p.salesPrice, p.costPrice, p.notes ?? null, p.taxCategory, p.sac ?? null, p.active],
    );
    if (!hit.rowCount) throw notFound('Product');
    await saveVariants(client, id, p.variants);
    await audit(actorOf(c).name, 'product.update', 'product', id, { name: p.name }, client);
  });
  return c.json({ ok: true });
});

const planSchema = z.object({
  name: z.string().trim().min(2, 'Name the plan'),
  productId: z.number().int().nullish(),
  price: money,
  billingUnit: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  billingInterval: z.number().int().min(1).default(1),
  minQuantity: z.number().int().min(1),
  availableFrom: date.nullish(),
  availableUntil: date.nullish(),
  autoClose: z.boolean(),
  closable: z.boolean(),
  pausable: z.boolean(),
  renewable: z.boolean(),
  termMonths: z.number().int().min(1),
  notes: z.string().nullish(),
  active: z.boolean().default(true),
  addons: z.array(z.object({ productId: z.number().int(), price: money })).default([]),
}).refine((p) => !p.availableFrom || !p.availableUntil || p.availableUntil >= p.availableFrom, { message: 'The end date comes before the start date', path: ['availableUntil'] });

catalog.get('/plans', staffOnly, async (c) => {
  const rows = await q(
    `SELECT p.*, pr.name AS product_name,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', a.product_id, 'price', a.price, 'name', x.name))
               FROM plan_addons a JOIN products x ON x.id = a.product_id WHERE a.plan_id = p.id), '[]') AS addons,
            (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id AND s.status = 'active') AS active_subscriptions
       FROM plans p LEFT JOIN products pr ON pr.id = p.product_id ORDER BY p.id`,
  );
  return c.json(rows);
});

async function savePlanAddons(client: any, planId: number, addons: { productId: number; price: number }[]) {
  await client.query(`DELETE FROM plan_addons WHERE plan_id = $1`, [planId]);
  for (const a of addons) await client.query(`INSERT INTO plan_addons (plan_id, product_id, price) VALUES ($1,$2,$3)`, [planId, a.productId, a.price]);
}

catalog.post('/plans', adminOnly, async (c) => {
  const p = await body(c, planSchema);
  const id = await tx(async (client) => {
    const row = await one(
      `INSERT INTO plans (name, product_id, price, billing_unit, billing_interval, min_quantity, available_from, available_until,
          auto_close, closable, pausable, renewable, term_months, notes, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [p.name, p.productId ?? null, p.price, p.billingUnit, p.billingInterval, p.minQuantity, p.availableFrom ?? null, p.availableUntil ?? null,
        p.autoClose, p.closable, p.pausable, p.renewable, p.termMonths, p.notes ?? null, p.active],
      client,
    );
    await savePlanAddons(client, row!.id, p.addons);
    await audit(actorOf(c).name, 'plan.create', 'plan', row!.id, { name: p.name }, client);
    return row!.id;
  });
  return c.json({ id }, 201);
});

catalog.put('/plans/:id', adminOnly, async (c) => {
  const id = idParam(c);
  const p = await body(c, planSchema);
  await tx(async (client) => {
    const hit = await client.query(
      `UPDATE plans SET name=$2, product_id=$3, price=$4, billing_unit=$5, billing_interval=$6, min_quantity=$7, available_from=$8, available_until=$9,
          auto_close=$10, closable=$11, pausable=$12, renewable=$13, term_months=$14, notes=$15, active=$16 WHERE id=$1`,
      [id, p.name, p.productId ?? null, p.price, p.billingUnit, p.billingInterval, p.minQuantity, p.availableFrom ?? null, p.availableUntil ?? null,
        p.autoClose, p.closable, p.pausable, p.renewable, p.termMonths, p.notes ?? null, p.active],
    );
    if (!hit.rowCount) throw notFound('Plan');
    await savePlanAddons(client, id, p.addons);
    await audit(actorOf(c).name, 'plan.update', 'plan', id, { name: p.name }, client);
  });
  return c.json({ ok: true });
});

const taxSchema = z.object({
  name: z.string().trim().min(2, 'Name the rule'),
  taxCategory: z.string().nullish(),
  supply: z.enum(['intra', 'inter', 'export']).nullish(),
  components: z.array(z.object({ label: z.string().min(1), rate: z.number().int().min(0).max(10000) })).min(1, 'Add at least one tax component'),
  validFrom: date.nullish(),
  validUntil: date.nullish(),
  priority: z.number().int().default(0),
  active: z.boolean().default(true),
});

catalog.get('/tax-rules', staffOnly, async (c) => c.json(await q(`SELECT * FROM tax_rules ORDER BY priority DESC, id`)));

catalog.post('/tax-rules', adminOnly, async (c) => {
  const t = await body(c, taxSchema);
  const row = await one(
    `INSERT INTO tax_rules (name, tax_category, supply, components, valid_from, valid_until, priority, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [t.name, t.taxCategory || null, t.supply ?? null, JSON.stringify(t.components), t.validFrom ?? null, t.validUntil ?? null, t.priority, t.active],
  );
  await audit(actorOf(c).name, 'tax_rule.create', 'tax_rule', row!.id, { name: t.name });
  return c.json({ id: row!.id }, 201);
});

catalog.put('/tax-rules/:id', adminOnly, async (c) => {
  const id = idParam(c);
  const t = await body(c, taxSchema);
  await q(
    `UPDATE tax_rules SET name=$2, tax_category=$3, supply=$4, components=$5, valid_from=$6, valid_until=$7, priority=$8, active=$9 WHERE id=$1`,
    [id, t.name, t.taxCategory || null, t.supply ?? null, JSON.stringify(t.components), t.validFrom ?? null, t.validUntil ?? null, t.priority, t.active],
  );
  await audit(actorOf(c).name, 'tax_rule.update', 'tax_rule', id, { name: t.name });
  return c.json({ ok: true });
});

const discountSchema = z.object({
  code: z.string().trim().min(2, 'Give it a code').transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2, 'Name the discount'),
  kind: z.enum(['fixed', 'percent']),
  value: z.number().int().positive('Enter a value above zero'),
  minPurchase: money.default(0),
  minQuantity: z.number().int().min(0).default(0),
  validFrom: date.nullish(),
  validUntil: date.nullish(),
  usageLimit: z.number().int().positive().nullish(),
  scope: z.enum(['subscription', 'products']),
  productIds: z.array(z.number().int()).default([]),
  autoApply: z.boolean().default(false),
  active: z.boolean().default(true),
}).refine((d) => d.kind !== 'percent' || d.value <= 10000, { message: 'A percentage cannot exceed 100', path: ['value'] })
  .refine((d) => d.scope !== 'products' || d.productIds.length > 0, { message: 'Pick at least one product', path: ['productIds'] });

catalog.get('/discounts', staffOnly, async (c) => {
  const rows = await q(
    `SELECT d.*, COALESCE((SELECT array_agg(product_id) FROM discount_products x WHERE x.discount_id = d.id), '{}') AS product_ids,
            (SELECT count(*)::int FROM subscription_discounts sd WHERE sd.discount_id = d.id) AS attached,
            (SELECT COALESCE(sum(amount),0)::bigint FROM discount_redemptions r WHERE r.discount_id = d.id AND r.released_on IS NULL) AS total_given
       FROM discounts d ORDER BY d.id`,
  );
  return c.json(rows);
});

async function saveDiscountProducts(client: any, id: number, productIds: number[]) {
  await client.query(`DELETE FROM discount_products WHERE discount_id = $1`, [id]);
  for (const p of productIds) await client.query(`INSERT INTO discount_products (discount_id, product_id) VALUES ($1,$2)`, [id, p]);
}

// Discount rules are admin-only, enforced here on the server and not just hidden in the UI.
catalog.post('/discounts', adminOnly, async (c) => {
  const d = await body(c, discountSchema);
  const id = await tx(async (client) => {
    const dup = await one(`SELECT 1 AS ok FROM discounts WHERE code = $1`, [d.code], client);
    if (dup) throw conflict(`${d.code} already exists`);
    const row = await one(
      `INSERT INTO discounts (code, name, kind, value, min_purchase, min_quantity, valid_from, valid_until, usage_limit, scope, auto_apply, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [d.code, d.name, d.kind, d.value, d.minPurchase, d.minQuantity, d.validFrom ?? null, d.validUntil ?? null, d.usageLimit ?? null, d.scope, d.autoApply, d.active, actorOf(c).id],
      client,
    );
    await saveDiscountProducts(client, row!.id, d.scope === 'products' ? d.productIds : []);
    await audit(actorOf(c).name, 'discount.create', 'discount', row!.id, { code: d.code }, client);
    return row!.id;
  });
  return c.json({ id }, 201);
});

catalog.put('/discounts/:id', adminOnly, async (c) => {
  const id = idParam(c);
  const d = await body(c, discountSchema);
  await tx(async (client) => {
    const hit = await client.query(
      `UPDATE discounts SET code=$2, name=$3, kind=$4, value=$5, min_purchase=$6, min_quantity=$7, valid_from=$8, valid_until=$9,
          usage_limit=$10, scope=$11, auto_apply=$12, active=$13 WHERE id=$1`,
      [id, d.code, d.name, d.kind, d.value, d.minPurchase, d.minQuantity, d.validFrom ?? null, d.validUntil ?? null, d.usageLimit ?? null, d.scope, d.autoApply, d.active],
    );
    if (!hit.rowCount) throw notFound('Discount');
    await saveDiscountProducts(client, id, d.scope === 'products' ? d.productIds : []);
    await audit(actorOf(c).name, 'discount.update', 'discount', id, { code: d.code }, client);
  });
  return c.json({ ok: true });
});

catalog.get('/payment-terms', staffOnly, async (c) => c.json(await q(`SELECT * FROM payment_terms ORDER BY net_days`)));

catalog.get('/quote-templates', staffOnly, async (c) => {
  const rows = await q(
    `SELECT t.*, p.name AS plan_name,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', l.product_id, 'variant_id', l.variant_id, 'quantity', l.quantity,
                      'unit_price', l.unit_price, 'product_name', x.name) ORDER BY l.sort)
               FROM quotation_template_lines l JOIN products x ON x.id = l.product_id WHERE l.template_id = t.id), '[]') AS lines
       FROM quotation_templates t JOIN plans p ON p.id = t.plan_id WHERE t.active ORDER BY t.id`,
  );
  return c.json(rows);
});

const templateSchema = z.object({
  name: z.string().trim().min(2, 'Name the template'),
  planId: z.number().int(),
  validityDays: z.number().int().min(1, 'Valid for at least a day'),
  notes: z.string().nullish(),
  lines: z.array(z.object({ productId: z.number().int(), variantId: z.number().int().nullish(), quantity: z.number().int().min(1), unitPrice: z.number().int().nullish() })).min(1, 'Add at least one line'),
});

catalog.post('/quote-templates', adminOnly, async (c) => {
  const t = await body(c, templateSchema);
  const id = await tx(async (client) => {
    const row = await one(`INSERT INTO quotation_templates (name, plan_id, validity_days, notes) VALUES ($1,$2,$3,$4) RETURNING id`, [t.name, t.planId, t.validityDays, t.notes ?? null], client);
    for (const [i, l] of t.lines.entries()) {
      await client.query(`INSERT INTO quotation_template_lines (template_id, product_id, variant_id, quantity, unit_price, sort) VALUES ($1,$2,$3,$4,$5,$6)`, [row!.id, l.productId, l.variantId ?? null, l.quantity, l.unitPrice ?? null, i]);
    }
    await audit(actorOf(c).name, 'template.create', 'quotation_template', row!.id, { name: t.name }, client);
    return row!.id;
  });
  return c.json({ id }, 201);
});

const customerSchema = z.object({
  name: z.string().trim().min(2, 'Enter the company name'),
  email: z.string().trim().email('Use a valid email address'),
  phone: z.string().nullish(),
  gstin: z.string().trim().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][A-Z0-9]$/, 'That GSTIN does not look right').nullish().or(z.literal('').transform(() => null)),
  stateCode: z.string().nullish(),
  stateName: z.string().nullish(),
  city: z.string().nullish(),
  address: z.string().nullish(),
  country: z.string().length(2).default('IN'),
  segment: z.enum(['small', 'mid', 'enterprise']).default('small'),
  paymentTermId: z.number().int().nullish(),
});

catalog.get('/customers', staffOnly, async (c) => {
  const query = c.req.query();
  const filters = new Filters();
  filters.add((r) => `(c.name ILIKE ${r} OR c.email ILIKE ${r} OR c.code ILIKE ${r})`, query.q ? `%${query.q}%` : undefined);
  filters.add((r) => `c.segment = ${r}`, query.segment);
  filters.add((r) => `c.state_code = ${r}`, query.stateCode);
  return c.json(await listPage({
    select: `c.id, c.code, c.name, c.email, c.city, c.state_name, c.segment, c.gstin,
             (SELECT COALESCE(sum(s.mrr),0)::bigint FROM subscriptions s WHERE s.customer_id = c.id AND s.status = 'active') AS mrr,
             (SELECT count(*)::int FROM subscriptions s WHERE s.customer_id = c.id AND s.status = 'active') AS active_subscriptions,
             (SELECT COALESCE(sum(i.total - i.amount_paid),0)::bigint FROM invoices i WHERE i.customer_id = c.id AND i.status = 'confirmed') AS outstanding`,
    from: 'customers c',
    filters,
    orderBy: 'c.id',
    page: paging(query),
  }));
});

catalog.get('/customers/:id', staffOnly, async (c) => {
  const id = idParam(c);
  const { today } = await appState();
  const [customer, subscriptions, invoices, payments, totals] = await Promise.all([
    one(`SELECT c.*, t.name AS payment_term FROM customers c LEFT JOIN payment_terms t ON t.id = c.payment_term_id WHERE c.id = $1`, [id]),
    q(`SELECT s.id, s.number, s.status, s.start_date, s.expiry_date, s.next_billing_date, s.mrr, s.recurring_amount, p.name AS plan_name
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.customer_id = $1 ORDER BY s.id DESC`, [id]),
    q(`SELECT id, number, status, issue_date, due_date, total, amount_paid FROM invoices WHERE customer_id = $1 ORDER BY issue_date DESC, id DESC LIMIT 12`, [id]),
    q(`SELECT id, number, method, amount, paid_on, note FROM payments WHERE customer_id = $1 ORDER BY paid_on DESC, id DESC LIMIT 8`, [id]),
    one(`SELECT COALESCE(sum(total - amount_paid) FILTER (WHERE status = 'confirmed'),0)::bigint AS outstanding,
                COALESCE(sum(total - amount_paid) FILTER (WHERE status = 'confirmed' AND due_date < $2),0)::bigint AS overdue,
                COALESCE(sum(amount_paid),0)::bigint AS lifetime
           FROM invoices WHERE customer_id = $1`, [id, today]),
  ]);
  if (!customer) throw notFound('Customer');
  return c.json({ customer, subscriptions, invoices, payments, totals });
});

catalog.post('/customers', staffOnly, async (c) => {
  const v = await body(c, customerSchema);
  const { today } = await appState();
  const seq = await one(`SELECT nextval(pg_get_serial_sequence('customers','id')) AS n`);
  await q(
    `INSERT INTO customers (id, code, name, email, phone, gstin, state_code, state_name, city, address, country, segment, payment_term_id, created_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [seq!.n, `C${String(seq!.n).padStart(5, '0')}`, v.name, v.email, v.phone ?? null, v.gstin ?? null, v.stateCode ?? null, v.stateName ?? null, v.city ?? null, v.address ?? null, v.country, v.segment, v.paymentTermId ?? 2, today],
  );
  await audit(actorOf(c).name, 'customer.create', 'customer', seq!.n, { name: v.name });
  return c.json({ id: seq!.n }, 201);
});

catalog.put('/customers/:id', staffOnly, async (c) => {
  const id = idParam(c);
  const v = await body(c, customerSchema);
  await q(
    `UPDATE customers SET name=$2, email=$3, phone=$4, gstin=$5, state_code=$6, state_name=$7, city=$8, address=$9, country=$10, segment=$11, payment_term_id=$12 WHERE id=$1`,
    [id, v.name, v.email, v.phone ?? null, v.gstin ?? null, v.stateCode ?? null, v.stateName ?? null, v.city ?? null, v.address ?? null, v.country, v.segment, v.paymentTermId ?? 2],
  );
  await audit(actorOf(c).name, 'customer.update', 'customer', id, { name: v.name });
  return c.json({ ok: true });
});
