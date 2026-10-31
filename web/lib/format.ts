const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inrWhole = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const count = new Intl.NumberFormat('en-IN');

export const money = (paise: number | null | undefined) => inr.format((paise ?? 0) / 100);
export const moneyWhole = (paise: number | null | undefined) => inrWhole.format((paise ?? 0) / 100);
export const number = (n: number | null | undefined) => count.format(n ?? 0);

/** Short lakh and crore form for charts and headline tiles. */
export function compact(paise: number) {
  const rupees = Math.abs(paise) / 100;
  const sign = paise < 0 ? '−' : '';
  if (rupees >= 1_00_00_000) return `${sign}₹${(rupees / 1_00_00_000).toFixed(2)} Cr`;
  if (rupees >= 1_00_000) return `${sign}₹${(rupees / 1_00_000).toFixed(2)} L`;
  if (rupees >= 1_000) return `${sign}₹${(rupees / 1_000).toFixed(1)}K`;
  return `${sign}₹${rupees.toFixed(0)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function date(iso: string | null | undefined) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function shortDate(iso: string) {
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
};

export function weekday(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' });
}

export function addDays(iso: string, n: number) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export const rupeesToPaise = (value: string | number) => Math.round(Number(value) * 100);
export const paiseToRupees = (paise: number | null | undefined) => (paise == null ? '' : String(paise / 100));

export const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;
export const bp = (rate: number) => `${(rate / 100).toFixed(rate % 100 === 0 ? 0 : 2)}%`;

export const periodWord: Record<string, string> = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };

export const METHOD_LABEL: Record<string, string> = {
  upi: 'UPI', bank_transfer: 'Bank transfer', card: 'Card', cash: 'Cash', cheque: 'Cheque', tds: 'TDS', gateway: 'Gateway',
};

export const INDIAN_STATES: [string, string][] = [
  ['32', 'Kerala'], ['29', 'Karnataka'], ['33', 'Tamil Nadu'], ['27', 'Maharashtra'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'],
  ['07', 'Delhi'], ['24', 'Gujarat'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['19', 'West Bengal'], ['06', 'Haryana'],
];
