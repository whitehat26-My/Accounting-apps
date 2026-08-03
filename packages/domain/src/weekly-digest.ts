/**
 * The weekly digest: "anything off?" as a computation.
 *
 * ---------------------------------------------------------------------------
 * THE OWNER'S MONDAY QUESTION, ANSWERED WITHOUT AN ACCOUNTANT.
 *
 * A shop owner does not read a trial balance; they ask whether last week was
 * normal. This module answers exactly that: last week's figures next to the
 * recent weeks' figures, and a short list of flags where something moved
 * enough to deserve a look. It never diagnoses — "sales were 40% below your
 * recent average" is a fact; WHY is the owner's job, because the system
 * cannot know about the flood, the holiday, or the competitor's opening.
 *
 * The thresholds are product judgement, not statute — deliberately blunt
 * (30% down, 50% expense jump, 10-point margin slide) so a flag means
 * "genuinely unusual", not "Tuesday was slow". A digest that cries weekly is
 * deleted unread by week three.
 *
 * All comparisons are exact bigint cross-multiplication on Money minor units.
 * No percentages are computed as floats; no float ever touches a figure.
 * ---------------------------------------------------------------------------
 *
 * Pure: one week's figures plus recent history in, flags out.
 */

import { Money, type Currency } from './money.js';

export interface WeekFigures {
  /** Monday, ISO. */
  readonly weekStart: string;
  /** Invoiced net of tax — what was sold. */
  readonly salesNet: Money;
  /** Receipts landed — what was collected. */
  readonly takings: Money;
  /** Sales net of tax minus weighted-average COGS. */
  readonly grossProfit: Money;
  /** Bills dated in the week — what it cost to run. */
  readonly expenses: Money;
  /** Days with at least one sale, 0–7. */
  readonly daysWithSales: number;
}

export type DigestFlagCode =
  | 'REVENUE_DOWN'
  | 'REVENUE_UP'
  | 'EXPENSE_SPIKE'
  | 'MARGIN_DIP'
  | 'QUIET_WEEK'
  | 'OVERDUE_HEAVY';

export interface DigestFlag {
  readonly code: DigestFlagCode;
  readonly severity: 'INFO' | 'WARN';
  /** Ready to read — figures formatted, no placeholders. */
  readonly message: string;
}

export interface WeeklyDigest {
  readonly weekStart: string;
  /** Sunday, ISO. */
  readonly weekEnd: string;
  readonly week: WeekFigures;
  /** How many prior weeks the comparisons actually used. */
  readonly comparedAgainstWeeks: number;
  readonly flags: readonly DigestFlag[];
}

/**
 * Thresholds, in ratio form so the arithmetic stays in bigints.
 * A week is flagged when it crosses these against the trailing average.
 */
export const DIGEST_THRESHOLDS = {
  /** Sales below 70% of the trailing average. */
  revenueDown: { num: 7n, den: 10n },
  /** Sales above 130% of the trailing average — worth hearing too. */
  revenueUp: { num: 13n, den: 10n },
  /** Expenses above 150% of the trailing average. */
  expenseSpike: { num: 15n, den: 10n },
  /** Gross margin more than 10 percentage points below the trailing margin. */
  marginDipPoints: 10n,
  /** Comparisons need at least this many prior weeks to mean anything. */
  minimumHistory: 2,
} as const;

export function buildWeeklyDigest(input: {
  readonly week: WeekFigures;
  /** Up to four prior weeks, any order. Fewer means fewer comparisons. */
  readonly priorWeeks: readonly WeekFigures[];
  readonly overdueReceivables: { readonly total: Money; readonly count: number };
  readonly currency: Currency;
}): WeeklyDigest {
  const { week, priorWeeks, overdueReceivables } = input;
  const flags: DigestFlag[] = [];
  const k = BigInt(priorWeeks.length);
  const enoughHistory = priorWeeks.length >= DIGEST_THRESHOLDS.minimumHistory;

  const priorSales = priorWeeks.reduce((s, w) => s + w.salesNet.units, 0n);
  const priorExpenses = priorWeeks.reduce((s, w) => s + w.expenses.units, 0n);
  const priorGp = priorWeeks.reduce((s, w) => s + w.grossProfit.units, 0n);

  if (enoughHistory && priorSales > 0n) {
    // week < avg × 7/10  ⇔  week × k × 10 < priorSum × 7
    if (week.salesNet.units * k * DIGEST_THRESHOLDS.revenueDown.den <
        priorSales * DIGEST_THRESHOLDS.revenueDown.num) {
      flags.push({
        code: 'REVENUE_DOWN',
        severity: 'WARN',
        message:
          `Sales were ${rm(week.salesNet)}, well below your recent weekly average of ` +
          `${rm(average(priorSales, k, input.currency))}. Worth asking why.`,
      });
    } else if (week.salesNet.units * k * DIGEST_THRESHOLDS.revenueUp.den >
               priorSales * DIGEST_THRESHOLDS.revenueUp.num) {
      flags.push({
        code: 'REVENUE_UP',
        severity: 'INFO',
        message:
          `Good week: sales of ${rm(week.salesNet)} against a recent average of ` +
          `${rm(average(priorSales, k, input.currency))}. Whatever caused it, note it down.`,
      });
    }
  }

  if (enoughHistory && priorExpenses > 0n &&
      week.expenses.units * k * DIGEST_THRESHOLDS.expenseSpike.den >
      priorExpenses * DIGEST_THRESHOLDS.expenseSpike.num) {
    flags.push({
      code: 'EXPENSE_SPIKE',
      severity: 'WARN',
      message:
        `Expenses hit ${rm(week.expenses)} against a recent average of ` +
        `${rm(average(priorExpenses, k, input.currency))}. Check the bills — a one-off ` +
        `purchase is fine, a new normal is not.`,
    });
  }

  /*
   * Margin dip: this week's GP/sales more than 10 points under the pooled
   * trailing margin. Pooled (sum GP over sum sales) rather than an average of
   * weekly ratios, so one tiny week cannot swing the baseline.
   *
   *   gpW/salesW < gpSum/salesSum − 1/10
   * ⇔ 10·gpW·salesSum < 10·gpSum·salesW − salesW·salesSum
   * (both sales sums positive, so the cross-multiplication keeps direction)
   */
  if (enoughHistory && priorSales > 0n && week.salesNet.units > 0n) {
    const lhs = 10n * week.grossProfit.units * priorSales;
    const rhs = 10n * priorGp * week.salesNet.units - week.salesNet.units * priorSales;
    if (lhs < rhs) {
      flags.push({
        code: 'MARGIN_DIP',
        severity: 'WARN',
        message:
          `Gross profit was ${rm(week.grossProfit)} on ${rm(week.salesNet)} of sales — ` +
          `a noticeably thinner margin than your recent weeks. Discounting, a pricey ` +
          `stock batch, or a mispriced item are the usual suspects.`,
      });
    }
  }

  if (enoughHistory && priorWeeks.every((w) => week.daysWithSales < w.daysWithSales)) {
    flags.push({
      code: 'QUIET_WEEK',
      severity: 'WARN',
      message:
        `Only ${week.daysWithSales} day${week.daysWithSales === 1 ? '' : 's'} saw a sale — ` +
        `fewer than any recent week. If the shop was open, the till was quiet.`,
    });
  }

  if (overdueReceivables.count > 0 &&
      overdueReceivables.total.units > week.salesNet.units) {
    flags.push({
      code: 'OVERDUE_HEAVY',
      severity: 'WARN',
      message:
        `${rm(overdueReceivables.total)} across ${overdueReceivables.count} overdue ` +
        `invoice${overdueReceivables.count === 1 ? '' : 's'} — more than the whole week's ` +
        `sales. Collections is where this week's money actually is.`,
    });
  }

  return {
    weekStart: week.weekStart,
    weekEnd: addDaysUtc(week.weekStart, 6),
    week,
    comparedAgainstWeeks: priorWeeks.length,
    flags,
  };
}

/**
 * The most recent COMPLETED Monday–Sunday week strictly before `todayIso`.
 * On a Monday this is last week, never the zero-day week starting today.
 */
export function lastCompletedWeek(todayIso: string): { weekStart: string; weekEnd: string } {
  const today = new Date(`${todayIso}T00:00:00Z`);
  // getUTCDay: Sunday 0 … Saturday 6. Days back to the most recent Monday.
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  const thisMonday = addDaysUtc(todayIso, -sinceMonday);
  const weekStart = addDaysUtc(thisMonday, -7);
  return { weekStart, weekEnd: addDaysUtc(weekStart, 6) };
}

// ------------------------------------------------------------------ helpers

function average(sumUnits: bigint, k: bigint, currency: Currency): Money {
  return Money.fromUnits(sumUnits, currency).multiplyRatio(1n, k);
}

/** `RM 1,234.56` via Money's own locale-independent formatter. */
function rm(value: Money): string {
  return value.toDisplayString();
}

/** Calendar arithmetic in UTC — accounting dates carry no timezone (rule 8). */
function addDaysUtc(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
