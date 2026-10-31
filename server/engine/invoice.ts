// The heart of Keel. A pure function from inputs to an invoice: no database, no
// clock, no randomness. The same call backs real billing, the billing-day
// rehearsal, the portal price preview and the replay audit, which is why a
// rehearsal cannot disagree with the real run.
import { isWithin, type ISODate } from './dates.ts';
import { allocate, applyRate, type BasisPoints, formatINR, type Minor, rateLabel } from './money.ts';
import { type BillingPeriod, prorate } from './periods.ts';

export type SupplyType = 'intra' | 'inter' | 'export';

export interface TaxComponent {
  label: string;
  rate: BasisPoints;
}

export interface TaxRule {
  id: number;
  name: string;
  taxCategory: string | null; // null matches any category
  supply: SupplyType | null; // null matches any supply type
  components: TaxComponent[];
  validFrom: ISODate | null;
  validUntil: ISODate | null;
  priority: number;
  active: boolean;
}

export interface DiscountRule {
  id: number;
  code: string;
  name: string;
  kind: 'fixed' | 'percent';
  /** Paise when fixed, basis points when percent. */
  value: number;
  minPurchase: Minor;
  minQuantity: number;
  validFrom: ISODate | null;
  validUntil: ISODate | null;
  usageLimit: number | null;
  timesUsed: number;
  scope: 'subscription' | 'products';
  productIds: number[];
  active: boolean;
}

export interface LineInput {
  lineId: number | null;
  productId: number;
  variantId: number | null;
  description: string;
  taxCategory: string;
  sac: string | null;
  quantity: number;
  unitPrice: Minor;
  basePrice?: Minor;
  variantExtra?: Minor;
  /** One-off charges (add-on proration) are never scaled by the period. */
  oneOff?: boolean;
}

export interface InvoiceInput {
  subscriptionNumber: string;
  planName: string;
  period: Pick<BillingPeriod, 'start' | 'end' | 'fullEnd'>;
  issueDate: ISODate;
  supply: SupplyType;
  lines: LineInput[];
  discounts: DiscountRule[];
  taxRules: TaxRule[];
}

export interface TaxLine {
  ruleId: number;
  label: string;
  rate: BasisPoints;
  amount: Minor;
}

export interface ComputedLine {
  lineId: number | null;
  productId: number;
  variantId: number | null;
  description: string;
  sac: string | null;
  quantity: number;
  unitPrice: Minor;
  gross: Minor;
  discount: Minor;
  taxable: Minor;
  taxes: TaxLine[];
  tax: Minor;
  amount: Minor;
}

export interface DiscountApplication {
  discountId: number;
  code: string;
  name: string;
  amount: Minor;
}

export type SkippedReason = 'inactive' | 'not_started' | 'expired' | 'used_up' | 'below_minimum' | 'no_matching_line';

export interface TraceStep {
  line: number | null;
  kind: 'base' | 'variant' | 'proration' | 'discount' | 'tax' | 'total' | 'skipped';
  label: string;
  detail: string;
  amount: Minor;
  source?: { type: 'plan' | 'product' | 'discount' | 'tax_rule' | 'subscription'; id?: number };
}

export interface ComputedInvoice {
  lines: ComputedLine[];
  subtotal: Minor;
  discount: Minor;
  taxable: Minor;
  tax: Minor;
  total: Minor;
  taxSummary: { label: string; rate: BasisPoints; amount: Minor }[];
  discounts: DiscountApplication[];
  skippedDiscounts: { discountId: number; code: string; reason: SkippedReason }[];
  trace: TraceStep[];
  problems: string[];
}

function eligibility(d: DiscountRule, on: ISODate): SkippedReason | null {
  if (!d.active) return 'inactive';
  if (d.validFrom && on < d.validFrom) return 'not_started';
  if (d.validUntil && on > d.validUntil) return 'expired';
  if (d.usageLimit !== null && d.timesUsed >= d.usageLimit) return 'used_up';
  return null;
}

const REASON_TEXT: Record<SkippedReason, string> = {
  inactive: 'is switched off',
  not_started: 'has not started yet',
  expired: 'has expired',
  used_up: 'has reached its usage limit',
  below_minimum: 'needs a larger purchase or quantity',
  no_matching_line: 'does not cover any product on this invoice',
};

/** Picks the single tax rule for a line. Most specific and highest priority wins. */
export function resolveTaxRule(rules: TaxRule[], category: string, supply: SupplyType, on: ISODate): TaxRule | null {
  const score = (r: TaxRule) => (r.taxCategory ? 2 : 0) + (r.supply ? 1 : 0);
  return (
    rules
      .filter(
        (r) =>
          r.active &&
          (r.taxCategory === null || r.taxCategory === category) &&
          (r.supply === null || r.supply === supply) &&
          isWithin(on, r.validFrom, r.validUntil),
      )
      .sort((a, b) => score(b) - score(a) || b.priority - a.priority || a.id - b.id)[0] ?? null
  );
}

export function computeInvoice(input: InvoiceInput): ComputedInvoice {
  const trace: TraceStep[] = [];
  const problems: string[] = [];
  const applied: DiscountApplication[] = [];
  const skipped: ComputedInvoice['skippedDiscounts'] = [];
  const on = input.issueDate;

  // Step 1: gross amounts, including variant extras and any shortened final period.
  const lines = input.lines.map((line, i) => {
    const full = line.quantity * line.unitPrice;
    const gross = line.oneOff ? line.unitPrice : prorate(full, input.period);
    const lineNo = i + 1;

    if (line.variantExtra) {
      trace.push({
        line: lineNo,
        kind: 'variant',
        label: 'Variant price',
        detail: `${formatINR(line.basePrice ?? line.unitPrice - line.variantExtra)} base + ${formatINR(line.variantExtra)} variant extra = ${formatINR(line.unitPrice)} each`,
        amount: line.variantExtra,
        source: { type: 'product', id: line.productId },
      });
    }
    trace.push({
      line: lineNo,
      kind: 'base',
      label: line.description,
      detail: line.oneOff ? 'One-off charge for this period' : `${line.quantity} × ${formatINR(line.unitPrice)}`,
      amount: line.oneOff ? gross : full,
      source: { type: 'plan' },
    });
    if (!line.oneOff && gross !== full) {
      trace.push({
        line: lineNo,
        kind: 'proration',
        label: 'Shortened final period',
        detail: `Contract ends ${input.period.end}, so only part of the period is charged`,
        amount: gross - full,
        source: { type: 'subscription' },
      });
    }
    return { input: line, gross, discount: 0 };
  });

  // Step 2: product discounts first, then whole-subscription discounts on what remains.
  const ordered = [...input.discounts].sort(
    (a, b) => (a.scope === b.scope ? a.id - b.id : a.scope === 'products' ? -1 : 1),
  );

  for (const d of ordered) {
    const blocked = eligibility(d, on);
    if (blocked) {
      skipped.push({ discountId: d.id, code: d.code, reason: blocked });
      trace.push({
        line: null,
        kind: 'skipped',
        label: `${d.code} not applied`,
        detail: `This discount ${REASON_TEXT[blocked]}`,
        amount: 0,
        source: { type: 'discount', id: d.id },
      });
      continue;
    }

    const targets = lines.filter((l) => d.scope === 'subscription' || d.productIds.includes(l.input.productId));
    if (targets.length === 0) {
      skipped.push({ discountId: d.id, code: d.code, reason: 'no_matching_line' });
      continue;
    }

    const base = targets.reduce((sum, l) => sum + l.gross - l.discount, 0);
    const quantity = targets.reduce((sum, l) => sum + (l.input.oneOff ? 0 : l.input.quantity), 0);
    if (base < d.minPurchase || quantity < d.minQuantity) {
      skipped.push({ discountId: d.id, code: d.code, reason: 'below_minimum' });
      trace.push({
        line: null,
        kind: 'skipped',
        label: `${d.code} not applied`,
        detail: `Needs ${d.minQuantity > 0 ? `at least ${d.minQuantity} units` : `at least ${formatINR(d.minPurchase)}`}. This invoice has ${quantity} units worth ${formatINR(base)}`,
        amount: 0,
        source: { type: 'discount', id: d.id },
      });
      continue;
    }

    // A discount can never push a line below zero.
    const amount = Math.min(base, d.kind === 'percent' ? applyRate(base, d.value) : d.value);
    if (amount <= 0) continue;

    const shares = allocate(amount, targets.map((l) => l.gross - l.discount));
    targets.forEach((l, i) => (l.discount += shares[i]));
    applied.push({ discountId: d.id, code: d.code, name: d.name, amount });
    trace.push({
      line: null,
      kind: 'discount',
      label: `${d.code}: ${d.name}`,
      detail:
        d.kind === 'percent'
          ? `${rateLabel(d.value)} off ${formatINR(base)}`
          : `${formatINR(d.value)} off, on ${d.scope === 'products' ? 'matching products' : 'the whole subscription'}`,
      amount: -amount,
      source: { type: 'discount', id: d.id },
    });
  }

  // Step 3: tax is charged on the discounted amount, line by line.
  const taxSummary = new Map<string, { label: string; rate: BasisPoints; amount: Minor }>();
  const computed: ComputedLine[] = lines.map((l, i) => {
    const taxable = l.gross - l.discount;
    const rule = resolveTaxRule(input.taxRules, l.input.taxCategory, input.supply, on);
    if (!rule) {
      problems.push(`No tax rule covers "${l.input.description}" (${l.input.taxCategory}, ${input.supply} supply)`);
    }
    const taxes: TaxLine[] = (rule?.components ?? []).map((c) => ({
      ruleId: rule!.id,
      label: c.label,
      rate: c.rate,
      amount: applyRate(taxable, c.rate),
    }));
    for (const t of taxes) {
      const key = `${t.label}|${t.rate}`;
      const row = taxSummary.get(key) ?? { label: t.label, rate: t.rate, amount: 0 };
      row.amount += t.amount;
      taxSummary.set(key, row);
      trace.push({
        line: i + 1,
        kind: 'tax',
        label: `${t.label} ${rateLabel(t.rate)}`,
        detail: `${rule!.name}, on ${formatINR(taxable)}`,
        amount: t.amount,
        source: { type: 'tax_rule', id: t.ruleId },
      });
    }
    const tax = taxes.reduce((sum, t) => sum + t.amount, 0);
    return {
      lineId: l.input.lineId,
      productId: l.input.productId,
      variantId: l.input.variantId,
      description: l.input.description,
      sac: l.input.sac,
      quantity: l.input.quantity,
      unitPrice: l.input.unitPrice,
      gross: l.gross,
      discount: l.discount,
      taxable,
      taxes,
      tax,
      amount: taxable + tax,
    };
  });

  const subtotal = computed.reduce((sum, l) => sum + l.gross, 0);
  const discount = computed.reduce((sum, l) => sum + l.discount, 0);
  const taxable = subtotal - discount;
  const tax = computed.reduce((sum, l) => sum + l.tax, 0);
  const total = taxable + tax;

  trace.push({
    line: null,
    kind: 'total',
    label: 'Invoice total',
    detail: `${formatINR(subtotal)} − ${formatINR(discount)} discount + ${formatINR(tax)} tax`,
    amount: total,
  });

  return {
    lines: computed,
    subtotal,
    discount,
    taxable,
    tax,
    total,
    taxSummary: [...taxSummary.values()],
    discounts: applied,
    skippedDiscounts: skipped,
    trace,
    problems,
  };
}
