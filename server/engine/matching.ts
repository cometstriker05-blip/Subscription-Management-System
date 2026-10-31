// Cash application: turns a bank line into a proposed payment against open invoices.
// Deterministic by design. AI may read a messy statement and explain a guess, but
// the rule that decides whether money gets posted is this code.
import type { ISODate } from './dates.ts';
import { applyRate, formatINR, type Minor } from './money.ts';

export interface BankLine {
  id: number;
  date: ISODate;
  description: string;
  amount: Minor;
}

export interface OpenInvoice {
  id: number;
  number: string;
  customerId: number;
  customerName: string;
  outstanding: Minor;
  taxable: Minor;
  dueDate: ISODate;
}

export interface PayerAlias {
  alias: string;
  customerId: number;
}

export interface Allocation {
  invoiceId: number;
  invoiceNumber: string;
  amount: Minor;
}

export type MatchKind =
  | 'invoice_exact'
  | 'invoice_partial'
  | 'invoice_tds'
  | 'customer_exact'
  | 'customer_multi'
  | 'customer_tds'
  | 'customer_oldest'
  | 'amount_only';

export interface MatchCandidate {
  kind: MatchKind;
  customerId: number;
  customerName: string;
  confidence: number;
  allocations: Allocation[];
  /** Tax deducted at source by the customer, recorded as a credit to close the invoice. */
  tdsAmount: Minor;
  reason: string;
}

export const AUTO_POST_THRESHOLD = 0.9;

/** TDS rates Indian business customers commonly withhold on service invoices. */
const TDS_RATES = [1000, 200];

const STOP_WORDS = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'co', 'company', 'corp', 'technologies', 'tech',
  'solutions', 'systems', 'services', 'software', 'india', 'the', 'and', 'neft', 'imps', 'rtgs', 'upi',
  'cr', 'dr', 'ref', 'inb', 'by', 'from', 'to', 'transfer', 'payment', 'trf', 'ach', 'chq', 'cheque',
]);

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const nameTokens = (text: string) =>
  normalize(text).split(' ').filter((t) => t.length > 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));

/** Share of the customer's distinctive name words found in the bank narration. */
export function nameScore(customerName: string, narration: string): number {
  const wanted = nameTokens(customerName);
  if (wanted.length === 0) return 0;
  const have = new Set(nameTokens(narration));
  // Typos rarely hit the first letter, so that check skips most of the expensive comparisons.
  const close = (a: string, b: string) => a[0] === b[0] && editDistance(a, b) <= (b.length > 6 ? 2 : 1);
  const hits = wanted.filter((t) => have.has(t) || [...have].some((h) => close(h, t))).length;
  return hits / wanted.length;
}

export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** Pulls invoice-number-looking tokens, tolerating spaces, dropped slashes and one typo. */
function findInvoiceRefs(narration: string, invoices: OpenInvoice[]): OpenInvoice[] {
  const squeezed = narration.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const found = new Map<number, OpenInvoice>();
  for (const inv of invoices) {
    const key = inv.number.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (key.length < 6) continue;
    if (squeezed.includes(key)) {
      found.set(inv.id, inv);
      continue;
    }
    // Banks often truncate the prefix, so match on the serial and financial year.
    const tail = key.slice(-9);
    if (squeezed.includes(tail)) found.set(inv.id, inv);
  }
  return [...found.values()];
}

/** Finds a set of a customer's invoices that adds up to the amount. Oldest first, small search. */
export function subsetSum(invoices: OpenInvoice[], target: Minor, maxItems = 6): OpenInvoice[] | null {
  const pool = [...invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 14);
  let best: OpenInvoice[] | null = null;
  const walk = (start: number, left: Minor, picked: OpenInvoice[]) => {
    if (best) return;
    if (left === 0) {
      best = [...picked];
      return;
    }
    if (picked.length >= maxItems) return;
    for (let i = start; i < pool.length; i++) {
      if (pool[i].outstanding <= left) {
        picked.push(pool[i]);
        walk(i + 1, left - pool[i].outstanding, picked);
        picked.pop();
      }
    }
  };
  walk(0, target, []);
  return best;
}

function tdsFit(amount: Minor, inv: OpenInvoice): { rate: number; tds: Minor } | null {
  for (const rate of TDS_RATES) {
    const tds = applyRate(inv.taxable, rate);
    if (Math.abs(inv.outstanding - tds - amount) <= 100) return { rate, tds: inv.outstanding - amount };
  }
  return null;
}

const one = (inv: OpenInvoice, amount: Minor): Allocation[] => [
  { invoiceId: inv.id, invoiceNumber: inv.number, amount },
];

/** Ranks every plausible explanation of a bank credit, best first. */
export function matchBankLine(line: BankLine, invoices: OpenInvoice[], aliases: PayerAlias[] = []): MatchCandidate[] {
  const out: MatchCandidate[] = [];
  const amount = line.amount;
  if (amount <= 0) return out;

  // Layer 1: the customer quoted an invoice number.
  for (const inv of findInvoiceRefs(line.description, invoices)) {
    const base = { customerId: inv.customerId, customerName: inv.customerName };
    if (inv.outstanding === amount) {
      out.push({ ...base, kind: 'invoice_exact', confidence: 0.99, allocations: one(inv, amount), tdsAmount: 0, reason: `Narration quotes ${inv.number} and the amount matches exactly` });
      continue;
    }
    const tds = tdsFit(amount, inv);
    if (tds) {
      out.push({ ...base, kind: 'invoice_tds', confidence: 0.95, allocations: one(inv, amount), tdsAmount: tds.tds, reason: `Narration quotes ${inv.number}. The ${formatINR(tds.tds)} shortfall equals ${tds.rate / 100}% TDS on the taxable value` });
      continue;
    }
    if (amount < inv.outstanding) {
      out.push({ ...base, kind: 'invoice_partial', confidence: 0.82, allocations: one(inv, amount), tdsAmount: 0, reason: `Narration quotes ${inv.number}, but this is a part payment of ${formatINR(amount)} against ${formatINR(inv.outstanding)} owed` });
    }
  }

  // Layer 2: identify the payer, from learned aliases first and then from the name.
  const scoped = new Map<number, { name: string; score: number; learned: boolean }>();
  const narration = normalize(line.description);
  for (const a of aliases) {
    if (narration.includes(normalize(a.alias))) {
      const inv = invoices.find((i) => i.customerId === a.customerId);
      if (inv) scoped.set(a.customerId, { name: inv.customerName, score: 1, learned: true });
    }
  }
  // A customer can have many open invoices, but their name only needs scoring once.
  const seen = new Set<number>(scoped.keys());
  for (const inv of invoices) {
    if (seen.has(inv.customerId)) continue;
    seen.add(inv.customerId);
    const score = nameScore(inv.customerName, line.description);
    if (score >= 0.6) scoped.set(inv.customerId, { name: inv.customerName, score, learned: false });
  }

  for (const [customerId, payer] of scoped) {
    const mine = invoices.filter((i) => i.customerId === customerId);
    const lift = payer.learned ? 0.04 : 0;
    const via = payer.learned ? 'a payer name your team confirmed before' : `the name "${payer.name}" in the narration`;
    const base = { customerId, customerName: payer.name };

    const exact = mine.filter((i) => i.outstanding === amount);
    if (exact.length === 1) {
      out.push({ ...base, kind: 'customer_exact', confidence: Math.min(0.97, 0.88 * payer.score + 0.08 + lift), allocations: one(exact[0], amount), tdsAmount: 0, reason: `Matched by ${via}. ${exact[0].number} is the only open invoice for exactly ${formatINR(amount)}` });
      continue;
    }

    const combo = subsetSum(mine, amount);
    if (combo && combo.length > 1) {
      out.push({ ...base, kind: 'customer_multi', confidence: Math.min(0.94, 0.84 * payer.score + 0.08 + lift), allocations: combo.map((i) => ({ invoiceId: i.id, invoiceNumber: i.number, amount: i.outstanding })), tdsAmount: 0, reason: `Matched by ${via}. One payment settles ${combo.length} invoices: ${combo.map((i) => i.number).join(', ')}` });
      continue;
    }

    const tdsInvoice = mine.map((inv) => ({ inv, fit: tdsFit(amount, inv) })).find((x) => x.fit);
    if (tdsInvoice) {
      out.push({ ...base, kind: 'customer_tds', confidence: Math.min(0.92, 0.82 * payer.score + 0.06 + lift), allocations: one(tdsInvoice.inv, amount), tdsAmount: tdsInvoice.fit!.tds, reason: `Matched by ${via}. Amount equals ${tdsInvoice.inv.number} less ${tdsInvoice.fit!.rate / 100}% TDS` });
      continue;
    }

    // Anything else from a known payer goes to their oldest invoices, for a human to check.
    const oldest = [...mine].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    if (oldest.length) {
      let left = amount;
      const allocations: Allocation[] = [];
      for (const inv of oldest) {
        if (left <= 0) break;
        const take = Math.min(left, inv.outstanding);
        allocations.push({ invoiceId: inv.id, invoiceNumber: inv.number, amount: take });
        left -= take;
      }
      if (left === 0) {
        out.push({ ...base, kind: 'customer_oldest', confidence: 0.55 * payer.score + lift, allocations, tdsAmount: 0, reason: `Matched by ${via}, but the amount fits no single invoice. Proposing oldest invoices first` });
      }
    }
  }

  // Layer 3: nothing but the amount. Only worth suggesting when it is unique.
  if (out.length === 0) {
    const same = invoices.filter((i) => i.outstanding === amount);
    if (same.length === 1) {
      out.push({ customerId: same[0].customerId, customerName: same[0].customerName, kind: 'amount_only', confidence: 0.6, allocations: one(same[0], amount), tdsAmount: 0, reason: `No name or reference, but ${same[0].number} is the only open invoice for exactly ${formatINR(amount)}` });
    }
  }

  return out.sort((a, b) => b.confidence - a.confidence);
}
