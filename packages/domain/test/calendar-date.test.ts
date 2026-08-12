import { describe, expect, it } from 'vitest';
import { isCalendarDate } from '../src/calendar-date.js';
import { validateJournalEntry } from '../src/journal-entry.js';
import { Money } from '../src/money.js';
import { isErr } from '../src/result.js';

/**
 * The day has to exist, not merely look like one.
 *
 * These cases are shared, by hand, with `packages/contracts/test/primitives.test.ts`:
 * the same predicate is written twice — once for the wire schema and once for
 * the domain — so that `@emil/contracts` need not depend on this package for
 * six lines. If the two ever disagree, one of the two test files fails.
 */

const REAL = ['2026-01-01', '2026-12-31', '2028-02-29', '2026-02-28', '2026-04-30'];

const NOT_REAL = [
  // The one that was actually posted: accepted by Date.parse, stored as 2 March.
  '2026-02-30',
  '2026-04-31',
  '2026-06-31',
  '2026-09-31',
  '2026-11-31',
  // 2027 is not a leap year. 2100 is not either — divisible by 100, not by 400.
  '2027-02-29',
  '2100-02-29',
  '2026-13-01',
  '2026-00-10',
  '2026-01-00',
  '2026-01-32',
];

describe('isCalendarDate', () => {
  for (const value of REAL) {
    it(`accepts ${value}`, () => expect(isCalendarDate(value)).toBe(true));
  }

  for (const value of NOT_REAL) {
    it(`rejects ${value}`, () => {
      expect(isCalendarDate(value)).toBe(false);
    });
  }

  /*
   * The point of the whole exercise, stated as its own assertion.
   *
   * Date.parse rejects a day of 00 or 32 — those were never the problem. What
   * it does NOT reject is a day that is in range for some month but not for
   * THIS one, and those are exactly the values that reached the database and
   * came back as a different month.
   */
  it('catches precisely the dates Date.parse silently rolls forward', () => {
    const rolled = ['2026-02-30', '2026-04-31', '2026-06-31', '2027-02-29', '2100-02-29'];
    for (const value of rolled) {
      expect(Number.isNaN(Date.parse(value)), `Date.parse should be fooled by ${value}`).toBe(
        false,
      );
      expect(isCalendarDate(value), `isCalendarDate must not be fooled by ${value}`).toBe(false);
    }
  });

  it('rejects anything not shaped like a date at all', () => {
    for (const value of ['', '2026-1-1', '26-01-01', 'yesterday', '2026-01-01T00:00:00Z']) {
      expect(isCalendarDate(value), value).toBe(false);
    }
  });
});

describe('a journal entry cannot be dated to a day that does not exist', () => {
  const rm = (v: string) => Money.fromDecimal(v, 'MYR');
  const draft = (entryDate: string) => ({
    entryDate,
    sourceModule: 'MANUAL' as const,
    lines: [
      { accountId: 'a', side: 'DEBIT' as const, amount: rm('100'), baseAmount: rm('100') },
      { accountId: 'b', side: 'CREDIT' as const, amount: rm('100'), baseAmount: rm('100') },
    ],
  });

  it('refuses 30 February with a violation rather than silently moving to March', () => {
    const result = validateJournalEntry(draft('2026-02-30'), 'MYR');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.map((v) => v.code)).toContain('INVALID_ENTRY_DATE');
    }
  });

  it('still accepts a leap day that exists', () => {
    expect(isErr(validateJournalEntry(draft('2028-02-29'), 'MYR'))).toBe(false);
  });
});
