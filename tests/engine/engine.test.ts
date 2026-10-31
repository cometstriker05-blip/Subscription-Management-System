import { describe, expect, it } from 'vitest';
import {
  addMonths, allocate, applyRate, canMoveInvoice, canMoveSubscription, computeInvoice, duePeriods, editDistance,
  financialYear, formatINR, matchBankLine, monthlyValue, nameScore, onExpiry, passwordProblems, periodStart,
  prorate, resolveTaxRule, subsetSum, type DiscountRule, type InvoiceInput, type OpenInvoice, type TaxRule,
} from '../../server/engine/index.ts';

const gstIntra: TaxRule = { id: 1, name: 'GST 18% intra-state', taxCategory: null, supply: 'intra', components: [{ label: 'CGST', rate: 900 }, { label: 'SGST', rate: 900 }], validFrom: null, validUntil: null, priority: 0, active: true };
const gstInter: TaxRule = { id: 2, name: 'GST 18% inter-state', taxCategory: null, supply: 'inter', components: [{ label: 'IGST', rate: 1800 }], validFrom: null, validUntil: null, priority: 0, active: true };
const gstExport: TaxRule = { id: 3, name: 'Export of services', taxCategory: null, supply: 'export', components: [{ label: 'IGST', rate: 0 }], validFrom: null, validUntil: null, priority: 0, active: true };
const rules = [gstIntra, gstInter, gstExport];

const line = (over: Partial<InvoiceInput['lines'][0]> = {}): InvoiceInput['lines'][0] => ({
  lineId: 1, productId: 10, variantId: null, description: 'Brightloop CRM', taxCategory: 'software', sac: '997331', quantity: 1, unitPrice: 100000, ...over,
});

const invoice = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  subscriptionNumber: 'SUB-00001', planName: 'Monthly', issueDate: '2026-11-01', supply: 'intra',
  period: { start: '2026-11-01', end: '2026-12-01', fullEnd: '2026-12-01' },
  lines: [line()], discounts: [], taxRules: rules, ...over,
});

const discount = (over: Partial<DiscountRule> = {}): DiscountRule => ({
  id: 1, code: 'SEATS10', name: 'Volume', kind: 'percent', value: 1000, minPurchase: 0, minQuantity: 0, validFrom: null, validUntil: null,
  usageLimit: null, timesUsed: 0, scope: 'subscription', productIds: [], active: true, ...over,
});

describe('money', () => {
  it('rounds half up and stays exact on large contracts', () => {
    expect(applyRate(100000, 1800)).toBe(18000);
    expect(applyRate(1, 5000)).toBe(1);
    expect(applyRate(99999999999, 1800)).toBe(18000000000);
  });

  it('allocates without losing a single paisa', () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
    expect(allocate(50, [0, 0])).toEqual([0, 0]);
  });

  it('formats rupees with Indian digit grouping', () => {
    expect(formatINR(12345678900)).toBe('₹12,34,56,789.00');
    expect(formatINR(56000)).toBe('₹560.00');
  });
});

describe('billing dates', () => {
  it('never drifts off month end', () => {
    const r = { unit: 'monthly' as const, interval: 1 };
    expect(periodStart('2026-01-31', 1, r)).toBe('2026-02-28');
    expect(periodStart('2026-01-31', 2, r)).toBe('2026-03-31');
    expect(periodStart('2028-01-31', 1, r)).toBe('2028-02-29');
  });

  it('keeps leap day yearly anchors valid', () => {
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28');
    expect(addMonths('2028-02-29', 48)).toBe('2032-02-29');
  });

  it('labels the Indian financial year', () => {
    expect(financialYear('2026-10-31')).toBe('26-27');
    expect(financialYear('2027-03-31')).toBe('26-27');
    expect(financialYear('2027-04-01')).toBe('27-28');
  });
});

describe('duePeriods: nothing skipped', () => {
  const r = { unit: 'monthly' as const, interval: 1 };

  it('catches up every period after three months of downtime, in order', () => {
    const due = duePeriods({ anchor: '2026-01-15', nextIndex: 2, recurrence: r, expiry: null, asOf: '2026-06-20' });
    expect(due.map((p) => p.start)).toEqual(['2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15']);
  });

  it('returns nothing before the next billing date', () => {
    expect(duePeriods({ anchor: '2026-01-15', nextIndex: 2, recurrence: r, expiry: null, asOf: '2026-03-14' })).toEqual([]);
  });

  it('leaves no gap between consecutive periods', () => {
    const due = duePeriods({ anchor: '2026-01-31', nextIndex: 0, recurrence: r, expiry: null, asOf: '2026-12-31' });
    for (let i = 1; i < due.length; i++) expect(due[i].start).toBe(due[i - 1].end);
  });

  it('stops at contract expiry and shortens the final period', () => {
    const due = duePeriods({ anchor: '2026-01-01', nextIndex: 0, recurrence: r, expiry: '2026-03-16', asOf: '2026-12-31' });
    expect(due).toHaveLength(3);
    expect(due[2].end).toBe('2026-03-16');
    expect(prorate(31000, due[2])).toBe(15000);
  });

  it('handles daily and weekly plans', () => {
    expect(duePeriods({ anchor: '2026-01-01', nextIndex: 0, recurrence: { unit: 'daily', interval: 1 }, expiry: null, asOf: '2026-01-03' })).toHaveLength(3);
    expect(duePeriods({ anchor: '2026-01-01', nextIndex: 0, recurrence: { unit: 'weekly', interval: 1 }, expiry: null, asOf: '2026-01-15' })).toHaveLength(3);
  });
});

describe('monthlyValue: what MRR really is', () => {
  it('normalises every billing frequency to one month', () => {
    expect(monthlyValue(1200000, { unit: 'yearly', interval: 1 })).toBe(100000);
    expect(monthlyValue(100000, { unit: 'monthly', interval: 1 })).toBe(100000);
    expect(monthlyValue(300000, { unit: 'monthly', interval: 3 })).toBe(100000);
    expect(monthlyValue(12000, { unit: 'weekly', interval: 1 })).toBe(52000);
    expect(monthlyValue(1000, { unit: 'daily', interval: 1 })).toBe(30417);
  });
});

describe('tax rules', () => {
  it('splits GST for a customer in the same state', () => {
    const result = computeInvoice(invoice());
    expect(result.tax).toBe(18000);
    expect(result.taxSummary.map((t) => t.label)).toEqual(['CGST', 'SGST']);
  });

  it('charges IGST across states and zero on exports', () => {
    expect(computeInvoice(invoice({ supply: 'inter' })).taxSummary[0]).toMatchObject({ label: 'IGST', amount: 18000 });
    expect(computeInvoice(invoice({ supply: 'export' })).tax).toBe(0);
  });

  it('picks the most specific rule, and respects validity dates', () => {
    const special: TaxRule = { ...gstIntra, id: 9, taxCategory: 'training', components: [{ label: 'CGST', rate: 250 }, { label: 'SGST', rate: 250 }] };
    expect(resolveTaxRule([gstIntra, special], 'training', 'intra', '2026-11-01')?.id).toBe(9);
    expect(resolveTaxRule([gstIntra, special], 'software', 'intra', '2026-11-01')?.id).toBe(1);
    expect(resolveTaxRule([{ ...special, validUntil: '2026-01-01' }, gstIntra], 'training', 'intra', '2026-11-01')?.id).toBe(1);
  });

  it('flags a missing rule instead of silently billing zero tax', () => {
    const result = computeInvoice(invoice({ taxRules: [gstInter] }));
    expect(result.problems).toHaveLength(1);
  });
});

describe('variants', () => {
  it('adds the Odoo brand extra of 560 to the unit price', () => {
    const result = computeInvoice(invoice({ lines: [line({ unitPrice: 156000, basePrice: 100000, variantExtra: 56000 })] }));
    expect(result.subtotal).toBe(156000);
    expect(result.trace.some((s) => s.kind === 'variant' && s.amount === 56000)).toBe(true);
  });
});

describe('discounts', () => {
  it('reduces the taxable value, so tax is charged after discount', () => {
    const result = computeInvoice(invoice({ discounts: [discount()] }));
    expect(result.discount).toBe(10000);
    expect(result.tax).toBe(16200);
    expect(result.total).toBe(106200);
  });

  it('applies by itself on the next invoice and stops at the end date', () => {
    const d = discount({ validUntil: '2026-11-30' });
    expect(computeInvoice(invoice({ discounts: [d] })).discount).toBe(10000);
    const later = computeInvoice(invoice({ issueDate: '2026-12-01', discounts: [d] }));
    expect(later.discount).toBe(0);
    expect(later.skippedDiscounts[0].reason).toBe('expired');
  });

  it('stops when the usage limit runs out', () => {
    const result = computeInvoice(invoice({ discounts: [discount({ usageLimit: 3, timesUsed: 3 })] }));
    expect(result.discount).toBe(0);
    expect(result.skippedDiscounts[0].reason).toBe('used_up');
  });

  it('enforces minimum quantity and minimum purchase', () => {
    expect(computeInvoice(invoice({ discounts: [discount({ minQuantity: 5 })] })).discount).toBe(0);
    expect(computeInvoice(invoice({ lines: [line({ quantity: 5 })], discounts: [discount({ minQuantity: 5 })] })).discount).toBe(50000);
    expect(computeInvoice(invoice({ discounts: [discount({ minPurchase: 200000 })] })).discount).toBe(0);
  });

  it('applies to specific products only when scoped', () => {
    const result = computeInvoice(invoice({
      lines: [line(), line({ lineId: 2, productId: 11, description: 'Support' })],
      discounts: [discount({ scope: 'products', productIds: [11] })],
    }));
    expect(result.lines[0].discount).toBe(0);
    expect(result.lines[1].discount).toBe(10000);
  });

  it('caps a fixed discount so a line never goes negative', () => {
    const result = computeInvoice(invoice({ discounts: [discount({ kind: 'fixed', value: 500000 })] }));
    expect(result.taxable).toBe(0);
    expect(result.total).toBe(0);
  });

  it('runs product discounts before subscription discounts, always', () => {
    const product = discount({ id: 2, code: 'P', scope: 'products', productIds: [10], value: 5000 });
    const whole = discount({ id: 1, code: 'W', value: 1000 });
    expect(computeInvoice(invoice({ discounts: [whole, product] })).discount).toBe(55000);
  });
});

describe('invoice arithmetic', () => {
  it('always reconciles from lines to totals', () => {
    const result = computeInvoice(invoice({
      supply: 'intra',
      lines: [line({ quantity: 7, unitPrice: 33333 }), line({ lineId: 2, productId: 11, quantity: 3, unitPrice: 12345 })],
      discounts: [discount({ value: 1250 })],
    }));
    expect(result.lines.reduce((s, l) => s + l.amount, 0)).toBe(result.total);
    expect(result.subtotal - result.discount + result.tax).toBe(result.total);
    expect(result.taxSummary.reduce((s, t) => s + t.amount, 0)).toBe(result.tax);
  });

  it('is deterministic, so a replay of stored inputs gives the same invoice', () => {
    const input = invoice({ discounts: [discount()] });
    expect(computeInvoice(JSON.parse(JSON.stringify(input)))).toEqual(computeInvoice(input));
  });
});

describe('lifecycle', () => {
  it('follows Draft to Quotation to Confirmed to Active to Closed', () => {
    expect(canMoveSubscription('draft', 'quotation')).toBe(true);
    expect(canMoveSubscription('quotation', 'confirmed')).toBe(true);
    expect(canMoveSubscription('confirmed', 'active')).toBe(true);
    expect(canMoveSubscription('active', 'closed')).toBe(true);
    expect(canMoveSubscription('draft', 'active')).toBe(false);
    expect(canMoveSubscription('closed', 'active')).toBe(false);
  });

  it('never lets a paid invoice be cancelled', () => {
    expect(canMoveInvoice('draft', 'confirmed')).toBe(true);
    expect(canMoveInvoice('confirmed', 'paid')).toBe(true);
    expect(canMoveInvoice('paid', 'cancelled')).toBe(false);
    expect(canMoveInvoice('draft', 'paid')).toBe(false);
  });

  it('follows each plan policy at expiry', () => {
    const base = { autoClose: false, closable: true, pausable: true, renewable: true };
    expect(onExpiry(base, true)).toBe('renew');
    expect(onExpiry({ ...base, renewable: false, autoClose: true }, true)).toBe('close');
    expect(onExpiry({ ...base, renewable: false }, false)).toBe('needs_decision');
  });
});

describe('password policy', () => {
  it('rejects exactly eight characters, because the brief says MORE than eight', () => {
    expect(passwordProblems('Abcdef1!')).toContain('Use more than 8 characters');
    expect(passwordProblems('Abcdefg1!')).toEqual([]);
  });

  it('needs upper, lower and special', () => {
    expect(passwordProblems('abcdefghi!')).toContain('Add an uppercase letter');
    expect(passwordProblems('ABCDEFGHI!')).toContain('Add a lowercase letter');
    expect(passwordProblems('Abcdefghij')).toContain('Add a special character');
  });
});

describe('bank matching', () => {
  const open: OpenInvoice[] = [
    { id: 1, number: 'BL/26-27/000101', customerId: 1, customerName: 'Malabar Spices Pvt Ltd', outstanding: 118000, taxable: 100000, dueDate: '2026-10-01' },
    { id: 2, number: 'BL/26-27/000102', customerId: 1, customerName: 'Malabar Spices Pvt Ltd', outstanding: 59000, taxable: 50000, dueDate: '2026-10-15' },
    { id: 3, number: 'BL/26-27/000103', customerId: 2, customerName: 'Periyar Logistics LLP', outstanding: 236000, taxable: 200000, dueDate: '2026-10-20' },
    { id: 4, number: 'BL/26-27/000104', customerId: 3, customerName: 'Kochi Port Traders', outstanding: 94400, taxable: 80000, dueDate: '2026-09-20' },
  ];
  const bank = (description: string, amount: number) => ({ id: 1, date: '2026-11-02', description, amount });

  it('matches a quoted invoice number with the exact amount', () => {
    const [top] = matchBankLine(bank('NEFT CR BL/26-27/000101 MALABAR', 118000), open);
    expect(top.kind).toBe('invoice_exact');
    expect(top.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('tolerates a mangled reference', () => {
    expect(matchBankLine(bank('INV BL 26 27 000103 PAYMENT', 236000), open)[0].allocations[0].invoiceId).toBe(3);
  });

  it('recognises Indian TDS instead of treating it as a short payment', () => {
    const [top] = matchBankLine(bank('RTGS BL/26-27/000103', 216000), open);
    expect(top.kind).toBe('invoice_tds');
    expect(top.tdsAmount).toBe(20000);
  });

  it('splits one payment across several invoices', () => {
    const [top] = matchBankLine(bank('NEFT MALABAR SPICES', 177000), open);
    expect(top.kind).toBe('customer_multi');
    expect(top.allocations.map((a) => a.invoiceId).sort()).toEqual([1, 2]);
  });

  it('flags a part payment for review rather than auto posting', () => {
    const [top] = matchBankLine(bank('BL/26-27/000103 PART', 100000), open);
    expect(top.kind).toBe('invoice_partial');
    expect(top.confidence).toBeLessThan(0.9);
  });

  it('survives a misspelt payer name', () => {
    expect(nameScore('Periyar Logistics LLP', 'NEFT PERIYAAR LOGISTIC')).toBe(1);
    expect(editDistance('periyar', 'periyaar')).toBe(1);
  });

  it('uses a payer alias the team confirmed earlier', () => {
    const [top] = matchBankLine(bank('IMPS KPT GLOBAL', 94400), open, [{ alias: 'KPT GLOBAL', customerId: 3 }]);
    expect(top.customerId).toBe(3);
    expect(top.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('suggests on amount alone only at low confidence', () => {
    const [top] = matchBankLine(bank('CASH DEPOSIT 8821', 94400), open);
    expect(top.kind).toBe('amount_only');
    expect(top.confidence).toBeLessThan(0.9);
  });

  it('refuses to guess when nothing fits', () => {
    expect(matchBankLine(bank('INTEREST CREDIT', 4321), open)).toEqual([]);
  });

  it('finds the invoice combination in subset sum', () => {
    expect(subsetSum(open.slice(0, 2), 177000)?.length).toBe(2);
    expect(subsetSum(open.slice(0, 2), 12345)).toBeNull();
  });
});
