import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money, sumMoney } from '../src/money.js';
import {
  DEFAULT_AGEING_BUCKETS,
  ageItems,
  bucketFor,
  daysBetween,
  type AgeingItem,
} from '../src/ageing.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);

const item = (over: Partial<AgeingItem> = {}): AgeingItem => ({
  documentId: 'inv-1',
  documentNo: 'INV-00001',
  contactId: 'cust-1',
  dueDate: '2026-08-31',
  outstanding: rm('1000.00'),
  ...over,
});

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween('2026-08-01', '2026-08-31')).toBe(30);
    expect(daysBetween('2026-08-31', '2026-08-01')).toBe(-30);
    expect(daysBetween('2026-08-01', '2026-08-01')).toBe(0);
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    // 2028 is a leap year.
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('is unaffected by local timezone — both ends are parsed at UTC midnight', () => {
    // Asia/Kuala_Lumpur is UTC+8 with no DST, but a machine running the tests
    // may be anywhere. If either end were parsed locally this would drift.
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });

  it('rejects a malformed date rather than returning NaN days', () => {
    expect(() => daysBetween('31/08/2026', '2026-08-31')).toThrow(RangeError);
  });
});

describe('bucketFor', () => {
  it('puts a document not yet due in CURRENT', () => {
    expect(bucketFor('2026-09-30', '2026-08-01').key).toBe('CURRENT');
  });

  it('puts a document due today in CURRENT', () => {
    expect(bucketFor('2026-08-01', '2026-08-01').key).toBe('CURRENT');
  });

  it('lands exactly on every boundary', () => {
    const due = '2026-01-01';
    const after = (days: number) => {
      const d = new Date(Date.parse(`${due}T00:00:00Z`) + days * 86_400_000);
      return d.toISOString().slice(0, 10);
    };
    expect(bucketFor(due, after(1)).key).toBe('1_30');
    expect(bucketFor(due, after(30)).key).toBe('1_30');
    expect(bucketFor(due, after(31)).key).toBe('31_60');
    expect(bucketFor(due, after(60)).key).toBe('31_60');
    expect(bucketFor(due, after(61)).key).toBe('61_90');
    expect(bucketFor(due, after(90)).key).toBe('61_90');
    expect(bucketFor(due, after(91)).key).toBe('90_PLUS');
    expect(bucketFor(due, after(3650)).key).toBe('90_PLUS');
  });

  it('accepts a tenant on shorter terms', () => {
    const fortnightly = [
      { key: 'CURRENT', label: 'Current', fromDaysOverdue: 0, toDaysOverdue: 0 },
      { key: '1_14', label: '1–14', fromDaysOverdue: 1, toDaysOverdue: 14 },
      { key: '15_PLUS', label: 'Over 14', fromDaysOverdue: 15, toDaysOverdue: null },
    ];
    expect(bucketFor('2026-01-01', '2026-01-15', fortnightly).key).toBe('1_14');
    expect(bucketFor('2026-01-01', '2026-01-16', fortnightly).key).toBe('15_PLUS');
  });

  it('fails loudly on a bucket set with a hole rather than dropping the balance', () => {
    const holed = [
      { key: 'CURRENT', label: 'Current', fromDaysOverdue: 0, toDaysOverdue: 0 },
      { key: 'LATE', label: 'Late', fromDaysOverdue: 10, toDaysOverdue: null },
    ];
    expect(() => bucketFor('2026-01-01', '2026-01-05', holed)).toThrow(/No ageing bucket/);
  });

  it('every non-negative days-overdue lands in exactly one default bucket (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -400, max: 4000 }), (offset) => {
        const asOf = new Date(Date.parse('2026-01-01T00:00:00Z') + offset * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const overdue = Math.max(0, offset);
        const matches = DEFAULT_AGEING_BUCKETS.filter(
          (b) =>
            overdue >= b.fromDaysOverdue &&
            (b.toDaysOverdue === null || overdue <= b.toDaysOverdue),
        );
        expect(matches).toHaveLength(1);
        expect(bucketFor('2026-01-01', asOf).key).toBe(matches[0]!.key);
      }),
    );
  });
});

describe('ageItems', () => {
  it('reports every bucket even when empty, so columns do not shift month to month', () => {
    const report = ageItems([item()], '2026-08-01', MYR);
    expect(report.buckets.map((b) => b.key)).toEqual([
      'CURRENT',
      '1_30',
      '31_60',
      '61_90',
      '90_PLUS',
    ]);
    expect(report.buckets.find((b) => b.key === '1_30')!.total.isZero()).toBe(true);
  });

  it('sums into the right buckets', () => {
    const report = ageItems(
      [
        item({ documentId: 'a', dueDate: '2026-09-30', outstanding: rm('100.00') }),
        item({ documentId: 'b', dueDate: '2026-07-15', outstanding: rm('200.00') }),
        item({ documentId: 'c', dueDate: '2026-07-01', outstanding: rm('300.00') }),
        item({ documentId: 'd', dueDate: '2026-01-01', outstanding: rm('400.00') }),
      ],
      '2026-08-01',
      MYR,
    );
    const by = new Map(report.buckets.map((b) => [b.key, b.total.toDecimalString()]));
    expect(by.get('CURRENT')).toBe('100.0000'); // not yet due
    expect(by.get('1_30')).toBe('200.0000'); // 17 days overdue
    expect(by.get('31_60')).toBe('300.0000'); // 31 days — July has 31 days
    expect(by.get('61_90')).toBe('0.0000');
    expect(by.get('90_PLUS')).toBe('400.0000'); // 212 days
    expect(report.total.toDecimalString()).toBe('1000.0000');
  });

  it('skips zero balances without counting them', () => {
    const report = ageItems(
      [item({ outstanding: rm('0') }), item({ documentId: 'b', outstanding: rm('50.00') })],
      '2026-08-01',
      MYR,
    );
    expect(report.buckets.find((b) => b.key === 'CURRENT')!.count).toBe(1);
  });

  it('bucket totals always sum to the grand total (property)', () => {
    // The grand total is summed from the items, not from the buckets, so a
    // bucketing bug shows up here rather than being hidden by construction.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            units: fc.bigInt({ min: 1n, max: 10_000_000n }),
            offset: fc.integer({ min: -60, max: 500 }),
          }),
          { minLength: 0, maxLength: 30 },
        ),
        (rows) => {
          const items = rows.map((r, i) =>
            item({
              documentId: `d-${i}`,
              dueDate: new Date(Date.parse('2026-08-01T00:00:00Z') - r.offset * 86_400_000)
                .toISOString()
                .slice(0, 10),
              outstanding: Money.fromUnits(r.units, MYR),
            }),
          );
          const report = ageItems(items, '2026-08-01', MYR);
          const bucketed = sumMoney(
            report.buckets.map((b) => b.total),
            MYR,
          );
          expect(bucketed.equals(report.total)).toBe(true);
        },
      ),
    );
  });
});
