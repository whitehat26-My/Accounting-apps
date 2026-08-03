import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildClosingEntry,
  checkClosingEntry,
  isErr,
  isOk,
  Money,
  type ClosableBalance,
} from '../src/index.js';

/**
 * The year-end close, tested for the property that actually matters: closing a
 * year must not change what the year earned.
 */

const MYR = 'MYR';
const RETAINED = 'acc-retained';

function balance(
  code: string,
  type: 'INCOME' | 'EXPENSE' | 'ASSET' | 'LIABILITY' | 'EQUITY',
  amount: string,
): ClosableBalance {
  return { accountId: `acc-${code}`, code, type, amount: Money.fromDecimal(amount, MYR) };
}

function build(balances: readonly ClosableBalance[]) {
  return buildClosingEntry({
    yearEndDate: '2026-12-31',
    yearLabel: 'FY2026',
    baseCurrency: MYR,
    retainedEarningsAccountId: RETAINED,
    retainedEarningsAccountType: 'EQUITY',
    balances,
  });
}

describe('buildClosingEntry', () => {
  it('zeroes every profit-and-loss account and carries the difference to retained earnings', () => {
    // Revenue 100,000 credit (debit-positive: negative); expenses 60,000 debit.
    // Profit 40,000.
    const result = build([
      balance('4000', 'INCOME', '-100000.0000'),
      balance('5000', 'EXPENSE', '35000.0000'),
      balance('6000', 'EXPENSE', '25000.0000'),
    ]);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.profitForYear.toDecimalString()).toBe('40000.0000');
    expect(result.value.accountsClosed).toBe(3);

    // Revenue carried a credit balance, so it is closed with a DEBIT.
    const revenue = result.value.draft.lines.find((l) => l.accountId === 'acc-4000');
    expect(revenue?.side).toBe('DEBIT');
    expect(revenue?.amount.toDecimalString()).toBe('100000.0000');

    // Expenses carried debit balances, so they are closed with CREDITs.
    expect(result.value.draft.lines.find((l) => l.accountId === 'acc-5000')?.side).toBe('CREDIT');

    // A profit CREDITS retained earnings.
    const retained = result.value.draft.lines.find((l) => l.accountId === RETAINED);
    expect(retained?.side).toBe('CREDIT');
    expect(retained?.amount.toDecimalString()).toBe('40000.0000');
  });

  it('debits retained earnings for a loss', () => {
    const result = build([
      balance('4000', 'INCOME', '-10000.0000'),
      balance('6000', 'EXPENSE', '25000.0000'),
    ]);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.profitForYear.toDecimalString()).toBe('-15000.0000');
    expect(result.value.draft.lines.find((l) => l.accountId === RETAINED)?.side).toBe('DEBIT');
  });

  it('is dated the last day of the year being closed, not the day it is run', () => {
    const result = build([balance('4000', 'INCOME', '-500.0000')]);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    // A closing entry dated in the FOLLOWING year would move the profit out of
    // the year that earned it: the income statement for the closed year would
    // still be right, and every comparative reading movement by date would not.
    expect(result.value.draft.entryDate).toBe('2026-12-31');
  });

  it('closes a contra-revenue account correctly, with no special case', () => {
    // A sales-discount account is INCOME carrying a DEBIT balance — the
    // opposite sign to its type. Closing by "post the negation" handles it;
    // branching on account type would not.
    const result = build([
      balance('4000', 'INCOME', '-100000.0000'),
      balance('4900', 'INCOME', '5000.0000'), // discounts given
    ]);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.draft.lines.find((l) => l.accountId === 'acc-4900')?.side).toBe('CREDIT');
    expect(result.value.profitForYear.toDecimalString()).toBe('95000.0000');
  });

  it('skips accounts that ended the year at zero', () => {
    const result = build([
      balance('4000', 'INCOME', '-1000.0000'),
      balance('6000', 'EXPENSE', '0.0000'),
    ]);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.accountsClosed).toBe(1);
    expect(result.value.draft.lines.some((l) => l.accountId === 'acc-6000')).toBe(false);
  });

  it('refuses when no account is mapped to RETAINED_EARNINGS', () => {
    // Refused rather than defaulted: posting a year's profit to a suspense
    // account produces a balanced ledger and a balance sheet nobody can explain.
    const result = buildClosingEntry({
      yearEndDate: '2026-12-31',
      yearLabel: 'FY2026',
      baseCurrency: MYR,
      retainedEarningsAccountId: undefined,
      retainedEarningsAccountType: undefined,
      balances: [balance('4000', 'INCOME', '-1000.0000')],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error[0]?.code).toBe('NO_RETAINED_EARNINGS_ACCOUNT');
  });

  it('refuses a retained earnings account that is not equity', () => {
    const result = buildClosingEntry({
      yearEndDate: '2026-12-31',
      yearLabel: 'FY2026',
      baseCurrency: MYR,
      retainedEarningsAccountId: RETAINED,
      retainedEarningsAccountType: 'LIABILITY',
      balances: [balance('4000', 'INCOME', '-1000.0000')],
    });

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error[0]?.code).toBe('RETAINED_EARNINGS_IS_NOT_EQUITY');
  });

  it('refuses a balance-sheet account in the closing set', () => {
    // Zeroing an asset into retained earnings is not a close; it is the
    // destruction of a balance.
    const result = build([
      balance('4000', 'INCOME', '-1000.0000'),
      balance('1000', 'ASSET', '5000.0000'),
    ]);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.some((v) => v.code === 'BALANCE_SHEET_ACCOUNT_IN_CLOSING_SET')).toBe(true);
  });

  it('reports a year with no trading rather than posting an empty entry', () => {
    const result = build([balance('4000', 'INCOME', '0.0000')]);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error[0]?.code).toBe('NOTHING_TO_CLOSE');
  });
});

describe('checkClosingEntry', () => {
  it('accepts an entry that balances and transfers exactly the profit', () => {
    const balances = [
      balance('4000', 'INCOME', '-100000.0000'),
      balance('5000', 'EXPENSE', '60000.0000'),
    ];
    const result = build(balances);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(checkClosingEntry(result.value, balances, MYR)).toEqual({
      consistent: true,
      violations: [],
    });
  });

  it('catches a P&L account left out of the closing entry', () => {
    // The failure this guards against is silent: the balance stays behind and
    // next year's income statement counts it as if it were earned then.
    const balances = [
      balance('4000', 'INCOME', '-100000.0000'),
      balance('5000', 'EXPENSE', '60000.0000'),
    ];
    const result = build(balances);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const missingOne = {
      ...result.value,
      draft: {
        ...result.value.draft,
        lines: result.value.draft.lines.filter((l) => l.accountId !== 'acc-5000'),
      },
    };

    const check = checkClosingEntry(missingOne, balances, MYR);
    expect(check.consistent).toBe(false);
    expect(check.violations.join(' ')).toContain('5000');
  });

  it('catches a transfer that is not the profit for the year', () => {
    const balances = [balance('4000', 'INCOME', '-100000.0000')];
    const result = build(balances);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    const overstated = {
      ...result.value,
      profitForYear: Money.fromDecimal('120000.0000', MYR),
    };

    expect(checkClosingEntry(overstated, balances, MYR).consistent).toBe(false);
  });
});

describe('the close does not change the year', () => {
  /**
   * The property the whole feature rests on.
   *
   * Whatever the mix of income and expense balances, the amount carried to
   * retained earnings is exactly the profit those balances already reported,
   * the entry balances, and every account with a balance is closed once. If
   * this ever fails, a close has restated a year — which is the kind of error
   * found by a client, a year later, in a comparative column.
   */
  it('carries exactly the profit the accounts already reported', () => {
    const amount = fc
      .integer({ min: -50_000_000, max: 50_000_000 })
      .map((units) => Money.fromUnits(BigInt(units), MYR));

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            code: fc.integer({ min: 4000, max: 6999 }).map(String),
            type: fc.constantFrom<'INCOME' | 'EXPENSE'>('INCOME', 'EXPENSE'),
            amount,
          }),
          { minLength: 1, maxLength: 25 },
        ),
        (rows) => {
          // Distinct accounts: two rows for one account is not a state the
          // caller can produce, and would make "closed exactly once" ambiguous.
          const seen = new Set<string>();
          const balances = rows
            .filter((r) => (seen.has(r.code) ? false : (seen.add(r.code), true)))
            .map((r) => ({
              accountId: `acc-${r.code}`,
              code: r.code,
              type: r.type,
              amount: r.amount,
            }));

          const result = build(balances);

          // Every account at zero is the NOTHING_TO_CLOSE case, which is
          // reported rather than closed. Not a counterexample.
          if (isErr(result)) {
            expect(result.error).toEqual([{ code: 'NOTHING_TO_CLOSE' }]);
            expect(balances.every((b) => b.amount.isZero())).toBe(true);
            return;
          }

          const check = checkClosingEntry(result.value, balances, MYR);
          expect(check.violations).toEqual([]);
        },
      ),
      { numRuns: 500 },
    );
  });
});
