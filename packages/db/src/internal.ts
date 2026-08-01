/**
 * Small conversions shared across the services.
 *
 * `toIsoDate` had six identical copies before this file existed. That is
 * benign right up until one of them is "fixed" to use `toLocaleDateString` or
 * a local-timezone constructor, at which point accounting dates start landing
 * on the wrong side of midnight for exactly one deployment region. Accounting
 * dates are DATEs — see CLAUDE.md rule 8 — and this is the one place that
 * belief is expressed.
 *
 * Not re-exported from `index.ts`: these are implementation details, not part
 * of the package's surface.
 */

/**
 * A `DATE` column as an ISO `YYYY-MM-DD` string.
 *
 * postgres.js hands back a `Date` for a DATE column, constructed at UTC
 * midnight. Slicing the ISO string preserves the calendar date; anything that
 * goes through local time does not.
 */
export function toIsoDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/** Calendar-date arithmetic in UTC, so no DST shift can move a due date. */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * `"2.5"` -> `25000n` at scale 4.
 *
 * Rejects excess precision rather than rounding it away: a caller that sends
 * five decimal places is either wrong or expecting a precision this system
 * does not have, and silently truncating hides both.
 */
export function decimalToScaled(value: string, scale: bigint): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`Not a valid decimal string: "${value}"`);
  }
  const negative = trimmed.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  if (BigInt(fraction.length) > scale) {
    throw new RangeError(`"${value}" exceeds ${scale} decimal places`);
  }
  const padded = fraction.padEnd(Number(scale), '0');
  const units = BigInt(whole) * 10n ** scale + BigInt(padded || '0');
  return negative ? -units : units;
}
