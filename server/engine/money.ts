// All money in Keel is an integer count of paise. Floats never touch an amount.

export type Minor = number;

/** Rate in basis points: 1800 = 18.00%. */
export type BasisPoints = number;

/** Rounds half away from zero, which is what Indian tax rounding expects. */
export function roundHalfUp(value: number): Minor {
  return value >= 0 ? Math.floor(value + 0.5) : -Math.floor(-value + 0.5);
}

export function applyRate(amount: Minor, rate: BasisPoints): Minor {
  // BigInt keeps the intermediate exact for large contract values.
  const product = BigInt(amount) * BigInt(rate);
  const whole = product / 10000n;
  const rest = product % 10000n;
  const up = (rest < 0n ? -rest : rest) * 2n >= 10000n;
  return Number(up ? whole + (product < 0n ? -1n : 1n) : whole);
}

/**
 * Splits `total` across `weights` so the parts always sum to exactly `total`.
 * Uses largest-remainder, the only method where no paisa is ever lost or invented.
 */
export function allocate(total: Minor, weights: Minor[]): Minor[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let i = 0; left > 0 && i < order.length; i++, left--) parts[order[i].index] += 1;
  return parts;
}

export function formatINR(amount: Minor): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const rupees = Math.floor(abs / 100);
  const paise = String(abs % 100).padStart(2, '0');
  const digits = String(rupees);
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${negative ? '-' : ''}₹${grouped}.${paise}`;
}

export function rateLabel(rate: BasisPoints): string {
  return `${(rate / 100).toFixed(rate % 100 === 0 ? 0 : 2)}%`;
}
