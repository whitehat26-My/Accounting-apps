/**
 * Ageing — how an open balance is bucketed by how overdue it is.
 *
 * This existed as a CASE expression inside the aged-receivables query. Pulling
 * it out matters for two reasons beyond tidiness:
 *
 *  1. AR and AP must bucket IDENTICALLY. Two copies of a boundary condition in
 *     two SQL statements drift, and then a debtors report and a creditors
 *     report disagree about what "31-60 days" means.
 *  2. The boundaries are a preference, not a law. 30/60/90 is conventional in
 *     Malaysia but a tenant on 14-day terms wants 14/28/42. Boundaries as data
 *     make that a row, not a migration.
 *
 * Pure, so the boundary arithmetic — the part that is actually easy to get
 * wrong by one day — is property-testable without a database.
 */

import { Money, sumMoney, type Currency } from './money.js';

export interface AgeingBucket {
  readonly key: string;
  readonly label: string;
  /**
   * Inclusive lower bound in days overdue. `0` means "due today or not yet
   * due"; the CURRENT bucket also absorbs anything not yet due, which is a
   * negative days-overdue.
   */
  readonly fromDaysOverdue: number;
  /** Inclusive upper bound, or null for the open-ended oldest bucket. */
  readonly toDaysOverdue: number | null;
}

/**
 * The conventional Malaysian SME layout. Note CURRENT is `0..0` and picks up
 * everything not yet due through the `<= 0` clamp in `bucketFor`, rather than
 * carrying a negative lower bound that reads as though it meant something.
 */
export const DEFAULT_AGEING_BUCKETS: readonly AgeingBucket[] = [
  { key: 'CURRENT', label: 'Current', fromDaysOverdue: 0, toDaysOverdue: 0 },
  { key: '1_30', label: '1–30 days', fromDaysOverdue: 1, toDaysOverdue: 30 },
  { key: '31_60', label: '31–60 days', fromDaysOverdue: 31, toDaysOverdue: 60 },
  { key: '61_90', label: '61–90 days', fromDaysOverdue: 61, toDaysOverdue: 90 },
  { key: '90_PLUS', label: 'Over 90 days', fromDaysOverdue: 91, toDaysOverdue: null },
];

const MS_PER_DAY = 86_400_000;

/**
 * Whole days between two YYYY-MM-DD dates.
 *
 * Both are parsed as UTC midnight so no timezone or DST shift can move a
 * document across a bucket boundary. Accounting dates are DATEs, not instants
 * — that is exactly why the schema stores them as DATE — and this preserves
 * the property.
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw new RangeError(`Invalid date in daysBetween(${from}, ${to})`);
  }
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * Which bucket a document falls in, given its due date and the as-at date.
 *
 * Negative days overdue — not yet due — clamps to 0 and lands in CURRENT.
 */
export function bucketFor(
  dueDate: string,
  asOfDate: string,
  buckets: readonly AgeingBucket[] = DEFAULT_AGEING_BUCKETS,
): AgeingBucket {
  const overdue = Math.max(0, daysBetween(dueDate, asOfDate));

  const match = buckets.find(
    (b) =>
      overdue >= b.fromDaysOverdue &&
      (b.toDaysOverdue === null || overdue <= b.toDaysOverdue),
  );

  if (match === undefined) {
    // Only reachable from a bucket set with a hole in it. Better to say so
    // than to silently drop the balance out of the report — an aged report
    // that does not tie to the control account is worse than no report.
    throw new RangeError(
      `No ageing bucket covers ${overdue} days overdue. Check the bucket boundaries for gaps.`,
    );
  }

  return match;
}

/** One open document as the ageing report sees it. */
export interface AgeingItem {
  readonly documentId: string;
  readonly documentNo: string;
  readonly contactId: string;
  readonly contactName?: string;
  readonly dueDate: string;
  /** Outstanding as at the report date, in base currency. */
  readonly outstanding: Money;
}

export interface AgeingBucketTotal {
  readonly key: string;
  readonly label: string;
  readonly total: Money;
  readonly count: number;
}

export interface AgeingReport {
  readonly asOfDate: string;
  readonly buckets: readonly AgeingBucketTotal[];
  readonly total: Money;
}

/**
 * Bucket a set of open documents.
 *
 * Every bucket appears in the output even when empty — a report whose columns
 * shift depending on the data is unreadable next to last month's — and the
 * grand total is summed from the items, not from the buckets, so a bucketing
 * bug shows up as a discrepancy instead of being hidden by construction.
 */
export function ageItems(
  items: readonly AgeingItem[],
  asOfDate: string,
  currency: Currency,
  buckets: readonly AgeingBucket[] = DEFAULT_AGEING_BUCKETS,
): AgeingReport {
  const totals = new Map<string, { total: Money; count: number }>(
    buckets.map((b) => [b.key, { total: Money.zero(currency), count: 0 }]),
  );

  for (const item of items) {
    if (item.outstanding.isZero()) continue;
    const bucket = bucketFor(item.dueDate, asOfDate, buckets);
    const current = totals.get(bucket.key)!;
    totals.set(bucket.key, {
      total: current.total.add(item.outstanding),
      count: current.count + 1,
    });
  }

  return {
    asOfDate,
    buckets: buckets.map((b) => ({
      key: b.key,
      label: b.label,
      total: totals.get(b.key)!.total,
      count: totals.get(b.key)!.count,
    })),
    total: sumMoney(
      items.map((i) => i.outstanding),
      currency,
    ),
  };
}
