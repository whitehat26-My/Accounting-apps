import { Money, type Currency } from './money.js';
import { daysBetween } from './ageing.js';

/**
 * Owner insights — the small pure pieces of "what should I do about my shop".
 *
 * The heavy lifting (which rows, which joins) is SQL in `packages/db`; what
 * lives here is the arithmetic and classification that must be testable
 * without a database, because a margin percentage that is quietly wrong is
 * worse than none.
 */

export type IdleBucket = 'FRESH' | 'SLOWING' | 'STALE' | 'DEAD';

/**
 * How worried to be about stock that has not sold.
 *
 * The thresholds are shopkeeping judgement, not statute: under a month is
 * normal rotation; a quarter is a shelf worth walking past; half a year of
 * silence on a computer part usually means the part outlived the machines it
 * fits. They are named rather than numeric so every screen colours them the
 * same way.
 */
export function idleBucket(daysIdle: number): IdleBucket {
  if (daysIdle <= 30) return 'FRESH';
  if (daysIdle <= 90) return 'SLOWING';
  if (daysIdle <= 180) return 'STALE';
  return 'DEAD';
}

/**
 * Whole days idle, floored at zero — ageing.js's `daysBetween` can go
 * negative for a future-dated receipt, and "idle for -3 days" is nonsense.
 */
export function daysIdleSince(sinceIso: string, todayIso: string): number {
  return Math.max(0, daysBetween(sinceIso, todayIso));
}

export interface MarginFigures {
  readonly revenue: string;
  readonly cost: string;
  readonly margin: string;
  /** Basis points of revenue, or null when revenue is zero (÷0 is not 0%). */
  readonly marginBp: number | null;
}

/**
 * Margin from revenue and cost, in Money end to end.
 *
 * Basis points rather than a float percentage: 3725 means 37.25%, exactly,
 * and no IEEE754 representation of 0.3725 is involved anywhere. Null when
 * revenue is zero — a margin on nothing is not 0%, it is a division that has
 * no answer, and printing "0.00%" there would hide a giveaway line.
 */
export function marginFigures(
  revenueDecimal: string,
  costDecimal: string,
  currency: Currency,
): MarginFigures {
  const revenue = Money.fromDecimal(revenueDecimal, currency);
  const cost = Money.fromDecimal(costDecimal, currency);
  const margin = revenue.subtract(cost);

  return {
    revenue: revenue.toDecimalString(),
    cost: cost.toDecimalString(),
    margin: margin.toDecimalString(),
    marginBp: revenue.isZero() ? null : Number((margin.units * 10_000n) / revenue.units),
  };
}
