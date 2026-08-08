/**
 * Warranty arithmetic — the promise window, and where a promise stands today.
 *
 * Pure on purpose: the question "when does a 12-month warranty sold on
 * 31 January end" has exactly one defensible answer and it should be decided
 * here once, under test, rather than in whichever query needed it.
 */

export interface WarrantyWindow {
  readonly soldOn: string;
  readonly expiresOn: string;
}

export type PromiseStatus = 'ACTIVE' | 'EXPIRING_SOON' | 'EXPIRED';

/** How close to the end a promise must be before the register raises it. */
export const EXPIRING_SOON_DAYS = 30;

/**
 * Sold on D for M months → expires at the END of the day M months on,
 * clamped to the month's last day: 31 January + 1 month is 28 February
 * (29 in a leap year), not the 3rd of March. The clamp matches how a
 * customer reads "one year warranty" off a receipt dated the 31st — the
 * generous reading loses the shop three days a year and an argument at
 * the counter every February.
 */
export function warrantyWindow(soldOn: string, months: number): WarrantyWindow {
  const [y, m, d] = soldOn.split('-').map(Number) as [number, number, number];
  const totalMonths = m - 1 + months;
  const year = y + Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return {
    soldOn,
    expiresOn: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/** ISO date comparison is string comparison; both sides are YYYY-MM-DD. */
export function promiseStatus(today: string, window: WarrantyWindow): PromiseStatus {
  if (today > window.expiresOn) return 'EXPIRED';
  return daysBetweenIso(today, window.expiresOn) <= EXPIRING_SOON_DAYS
    ? 'EXPIRING_SOON'
    : 'ACTIVE';
}

function daysBetweenIso(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
