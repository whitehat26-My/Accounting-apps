/**
 * Is this string a date that actually exists?
 *
 * ---------------------------------------------------------------------------
 * `Date.parse` IS NOT A CALENDAR CHECK, AND SEVEN CALL SITES BELIEVED IT WAS.
 *
 * The idiom copied through this package was:
 *
 *     if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) → invalid
 *
 * The regex proves the SHAPE and `Date.parse` was trusted to prove the DAY.
 * It does not. V8 rolls an out-of-range day forward instead of rejecting it,
 * so `2026-02-30` parses happily — as the 2nd of March.
 *
 * WHAT THAT COST, measured against the running system rather than reasoned
 * about: a manual journal posted with `entryDate: "2026-02-30"` was accepted,
 * the API echoed `"2026-02-30"` back, and the ledger stored **2026-03-02**.
 * A different month, therefore a different accounting period — the entry lands
 * outside the month the person believes they posted it in, and outside the one
 * a period lock was protecting. The response and the books disagree, and
 * nothing anywhere raises a hand.
 *
 * The fix is to compare the parsed date back against its own components. If
 * the day rolled, the round trip does not match and the date never existed.
 * ---------------------------------------------------------------------------
 */

const ISO_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `true` only for a real day on the proleptic Gregorian calendar, written as
 * `YYYY-MM-DD`.
 *
 * Rejects `2026-02-30`, `2026-04-31`, `2027-02-29` (not a leap year) and
 * `2026-13-01`. Accepts `2028-02-29`, which is one.
 */
export function isCalendarDate(value: string): boolean {
  const match = ISO_SHAPE.exec(value);
  if (!match) return false;

  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  /*
   * UTC, deliberately. `new Date(y, m, d)` is local-time and would shift under
   * a timezone whose offset crosses midnight — this repository runs in
   * Asia/Kuala_Lumpur but its CI does not, and a validator that answers
   * differently on two machines is worse than one that is merely strict.
   */
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  return (
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day
  );
}
