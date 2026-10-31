// Billing dates are calendar dates, never instants. Everything here works on
// 'YYYY-MM-DD' strings so a server timezone can never shift a billing day.

export type ISODate = string;

const toUTC = (d: ISODate) => {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
};

const fromUTC = (ms: number): ISODate => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: ISODate, n: number): ISODate => fromUTC(toUTC(d) + n * 86400000);

export const daysBetween = (from: ISODate, to: ISODate): number => Math.round((toUTC(to) - toUTC(from)) / 86400000);

export const minDate = (a: ISODate, b: ISODate): ISODate => (a < b ? a : b);
export const maxDate = (a: ISODate, b: ISODate): ISODate => (a > b ? a : b);

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/**
 * Adds months from an anchor, clamping to month end.
 * Callers must always add from the ORIGINAL anchor. Stepping from the previous
 * date would turn 31 Jan -> 28 Feb -> 28 Mar and lose the 31st forever.
 */
export function addMonths(anchor: ISODate, months: number): ISODate {
  const [y, m, d] = anchor.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(d, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Indian financial year label for GST numbering: 2026-10-31 -> '26-27'. */
export function financialYear(d: ISODate): string {
  const [y, m] = d.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

export const monthStart = (d: ISODate): ISODate => `${d.slice(0, 7)}-01`;

export const monthEnd = (d: ISODate): ISODate => addDays(addMonths(monthStart(d), 1), -1);

export function isWithin(d: ISODate, from: ISODate | null, until: ISODate | null): boolean {
  if (from && d < from) return false;
  if (until && d > until) return false;
  return true;
}
