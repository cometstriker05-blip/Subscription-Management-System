import { addDays, addMonths, daysBetween, type ISODate, minDate } from './dates.ts';
import type { Minor } from './money.ts';
import { roundHalfUp } from './money.ts';

export type BillingUnit = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Recurrence {
  unit: BillingUnit;
  interval: number;
}

export interface BillingPeriod {
  index: number;
  start: ISODate;
  /** Exclusive. The period covers [start, end). */
  end: ISODate;
  /** Length of an uninterrupted period, used to prorate a shortened final period. */
  fullEnd: ISODate;
}

/** The start of period k, always computed from the anchor so month ends never drift. */
export function periodStart(anchor: ISODate, k: number, r: Recurrence): ISODate {
  switch (r.unit) {
    case 'daily':
      return addDays(anchor, k * r.interval);
    case 'weekly':
      return addDays(anchor, k * r.interval * 7);
    case 'monthly':
      return addMonths(anchor, k * r.interval);
    case 'yearly':
      return addMonths(anchor, k * r.interval * 12);
  }
}

export function periodAt(anchor: ISODate, k: number, r: Recurrence, expiry: ISODate | null): BillingPeriod {
  const start = periodStart(anchor, k, r);
  const fullEnd = periodStart(anchor, k + 1, r);
  return { index: k, start, fullEnd, end: expiry ? minDate(fullEnd, expiry) : fullEnd };
}

/** Finds which period a date falls in. Used to resume after a pause or a data import. */
export function periodIndexFor(anchor: ISODate, on: ISODate, r: Recurrence): number {
  let k = 0;
  while (periodStart(anchor, k + 1, r) <= on) k++;
  return k;
}

/**
 * Every period that should have been invoiced by `asOf` and has not been.
 * Returns several when the scheduler was down, so a missed day is caught up
 * in order instead of being skipped.
 */
export function duePeriods(params: {
  anchor: ISODate;
  nextIndex: number;
  recurrence: Recurrence;
  expiry: ISODate | null;
  asOf: ISODate;
}): BillingPeriod[] {
  const { anchor, nextIndex, recurrence, expiry, asOf } = params;
  const due: BillingPeriod[] = [];
  for (let k = nextIndex; ; k++) {
    const period = periodAt(anchor, k, recurrence, expiry);
    if (period.start > asOf) break;
    if (expiry && period.start >= expiry) break;
    due.push(period);
    if (due.length > 5000) throw new Error('duePeriods runaway: check the subscription anchor and recurrence');
  }
  return due;
}

/** Scales a full-period amount down to a shortened period by day count. */
export function prorate(amount: Minor, period: Pick<BillingPeriod, 'start' | 'end' | 'fullEnd'>): Minor {
  const used = daysBetween(period.start, period.end);
  const full = daysBetween(period.start, period.fullEnd);
  return used >= full ? amount : roundHalfUp((amount * used) / full);
}

/** Share of the current period left from `from`, for a mid-cycle add-on switch. */
export function prorateRemaining(amount: Minor, from: ISODate, periodEnd: ISODate, periodBegin: ISODate): Minor {
  const left = Math.max(0, daysBetween(from, periodEnd));
  const full = daysBetween(periodBegin, periodEnd);
  return full <= 0 ? 0 : roundHalfUp((amount * left) / full);
}

/**
 * Normalises a recurring amount to one month. This is the fix for "nobody can
 * say how much recurring revenue we have": a Rs 1,20,000 yearly plan is Rs 10,000
 * of MRR, not Rs 1,20,000.
 */
export function monthlyValue(amount: Minor, r: Recurrence): Minor {
  const perYear = { daily: 365, weekly: 52, monthly: 12, yearly: 1 }[r.unit] / r.interval;
  return roundHalfUp((amount * perYear) / 12);
}

export function describeRecurrence(r: Recurrence): string {
  const noun = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.unit];
  return r.interval === 1 ? `every ${noun}` : `every ${r.interval} ${noun}s`;
}
