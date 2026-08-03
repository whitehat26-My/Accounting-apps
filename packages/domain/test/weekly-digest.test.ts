import { describe, expect, it } from 'vitest';
import { Money } from '../src/money.js';
import {
  buildWeeklyDigest,
  lastCompletedWeek,
  type WeekFigures,
} from '../src/weekly-digest.js';

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

function week(overrides: Partial<WeekFigures> = {}): WeekFigures {
  return {
    weekStart: '2026-07-20',
    salesNet: rm('12000.00'),
    takings: rm('11500.00'),
    grossProfit: rm('3600.00'),
    expenses: rm('2000.00'),
    daysWithSales: 6,
    ...overrides,
  };
}

/** A steady trailing month: RM 12k sales, RM 3.6k GP, RM 2k expenses. */
const steadyHistory = [
  week({ weekStart: '2026-07-13' }),
  week({ weekStart: '2026-07-06' }),
  week({ weekStart: '2026-06-29' }),
  week({ weekStart: '2026-06-22' }),
];

const noOverdue = { total: Money.zero('MYR'), count: 0 };

describe('buildWeeklyDigest', () => {
  it('flags nothing on a normal week — a digest that cries weekly is deleted unread', () => {
    const digest = buildWeeklyDigest({
      week: week(),
      priorWeeks: steadyHistory,
      overdueReceivables: noOverdue,
      currency: 'MYR',
    });

    expect(digest.flags).toEqual([]);
    expect(digest.weekEnd).toBe('2026-07-26');
    expect(digest.comparedAgainstWeeks).toBe(4);
  });

  it('flags a revenue drop below 70% of the trailing average, with both figures in the message', () => {
    const digest = buildWeeklyDigest({
      // RM 7,000 against a RM 12,000 average — 58%.
      week: week({ salesNet: rm('7000.00'), grossProfit: rm('2100.00') }),
      priorWeeks: steadyHistory,
      overdueReceivables: noOverdue,
      currency: 'MYR',
    });

    const flag = digest.flags.find((f) => f.code === 'REVENUE_DOWN');
    expect(flag?.severity).toBe('WARN');
    expect(flag?.message).toContain('RM 7,000.00');
    expect(flag?.message).toContain('RM 12,000.00');
  });

  it('says so when a week is unusually GOOD — the cause is worth noting down', () => {
    const digest = buildWeeklyDigest({
      week: week({ salesNet: rm('20000.00'), grossProfit: rm('6000.00') }),
      priorWeeks: steadyHistory,
      overdueReceivables: noOverdue,
      currency: 'MYR',
    });

    expect(digest.flags.map((f) => f.code)).toContain('REVENUE_UP');
    expect(digest.flags.find((f) => f.code === 'REVENUE_UP')?.severity).toBe('INFO');
  });

  it('flags an expense spike above 150% of the trailing average', () => {
    const digest = buildWeeklyDigest({
      week: week({ expenses: rm('3500.00') }),
      priorWeeks: steadyHistory,
      overdueReceivables: noOverdue,
      currency: 'MYR',
    });

    expect(digest.flags.map((f) => f.code)).toEqual(['EXPENSE_SPIKE']);
  });

  it('flags a margin more than 10 points under the pooled trailing margin', () => {
    // History margin 30%. Same sales, GP down to RM 2,000 → 16.7%.
    const digest = buildWeeklyDigest({
      week: week({ grossProfit: rm('2000.00') }),
      priorWeeks: steadyHistory,
      overdueReceivables: noOverdue,
      currency: 'MYR',
    });

    expect(digest.flags.map((f) => f.code)).toEqual(['MARGIN_DIP']);
  });

  it('does NOT flag a margin 9 points under — blunt thresholds, or the digest is noise', () => {
    // 30% → 21%: within tolerance.
    const digest = buildWeeklyDigest({
      week: week({ grossProfit: rm('2520.00') }),
      priorWeeks: steadyHistory,
      overdueReceivables: noOverdue,
      currency: 'MYR',
    });

    expect(digest.flags).toEqual([]);
  });

  it('flags a week with fewer selling days than any recent week', () => {
    const digest = buildWeeklyDigest({
      // Proportionally quieter, not just shorter — avoids tripping REVENUE_DOWN.
      week: week({ daysWithSales: 3, salesNet: rm('9000.00'), grossProfit: rm('2700.00') }),
      priorWeeks: steadyHistory,
      overdueReceivables: noOverdue,
      currency: 'MYR',
    });

    expect(digest.flags.map((f) => f.code)).toEqual(['QUIET_WEEK']);
  });

  it('flags overdue receivables when they exceed the whole week of sales', () => {
    const digest = buildWeeklyDigest({
      week: week(),
      priorWeeks: steadyHistory,
      overdueReceivables: { total: rm('15000.00'), count: 3 },
      currency: 'MYR',
    });

    const flag = digest.flags.find((f) => f.code === 'OVERDUE_HEAVY');
    expect(flag?.message).toContain('RM 15,000.00');
    expect(flag?.message).toContain('3 overdue invoices');
  });

  it('makes no comparison against fewer than two prior weeks — one week is not a baseline', () => {
    const digest = buildWeeklyDigest({
      week: week({ salesNet: rm('100.00'), grossProfit: rm('10.00'), daysWithSales: 1 }),
      priorWeeks: [week({ weekStart: '2026-07-13' })],
      overdueReceivables: noOverdue,
      currency: 'MYR',
    });

    expect(digest.flags).toEqual([]);
    expect(digest.comparedAgainstWeeks).toBe(1);
  });
});

describe('lastCompletedWeek', () => {
  it('on a Monday, returns LAST week — never the zero-day week starting today', () => {
    // 2026-07-27 is a Monday.
    expect(lastCompletedWeek('2026-07-27')).toEqual({
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
    });
  });

  it('mid-week, still returns the last COMPLETED week', () => {
    // 2026-07-30 is a Thursday.
    expect(lastCompletedWeek('2026-07-30')).toEqual({
      weekStart: '2026-07-20',
      weekEnd: '2026-07-26',
    });
  });

  it('on a Sunday, the week ending today is not yet complete', () => {
    // 2026-07-26 is a Sunday: its own week (20–26) still has today to run.
    expect(lastCompletedWeek('2026-07-26')).toEqual({
      weekStart: '2026-07-13',
      weekEnd: '2026-07-19',
    });
  });
});
