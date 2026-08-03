import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import { isErr, isOk, unwrap } from '../src/result.js';
import { validateJournalEntry } from '../src/journal-entry.js';
import {
  buildOpeningJournal,
  type OpeningBalanceLine,
  type OpeningBalanceViolation,
} from '../src/opening-balance.js';

const EQUITY_ACCOUNT = 'opening-equity-id';

const line = (over: Partial<OpeningBalanceLine> = {}): OpeningBalanceLine => ({
  accountId: 'bank-id',
  accountCode: '1000',
  accountName: 'Cash and Bank',
  accountType: 'ASSET',
  amount: Money.fromDecimal('18540.00', 'MYR'),
  ...over,
});

const build = (lines: OpeningBalanceLine[]) =>
  buildOpeningJournal({
    asOfDate: '2026-08-01',
    baseCurrency: 'MYR',
    openingEquityAccountId: EQUITY_ACCOUNT,
    lines,
  });

const codes = (violations: OpeningBalanceViolation[]) => violations.map((v) => v.code);

describe('the opening journal balances by construction', () => {
  it('sends the whole of a single asset to equity', () => {
    const journal = unwrap(build([line()]));

    expect(journal.balancingFigure.toDecimalString()).toBe('18540.0000');
    expect(journal.balancingSide).toBe('CREDIT');
    expect(journal.lines).toHaveLength(2);
    // The shop has RM 18,540 and owes nothing, so it is worth RM 18,540.
    expect(journal.lines[1]).toMatchObject({ accountId: EQUITY_ACCOUNT, side: 'CREDIT' });
  });

  it('nets a loan against the assets it bought', () => {
    const journal = unwrap(
      build([
        line(),
        line({
          accountId: 'van-id',
          accountCode: '1500',
          accountName: 'Motor Vehicles',
          amount: Money.fromDecimal('40000.00', 'MYR'),
        }),
        line({
          accountId: 'loan-id',
          accountCode: '2500',
          accountName: 'Hire Purchase',
          accountType: 'LIABILITY',
          amount: Money.fromDecimal('30000.00', 'MYR'),
        }),
      ]),
    );

    // 18,540 + 40,000 - 30,000
    expect(journal.balancingFigure.toDecimalString()).toBe('28540.0000');
    expect(journal.balancingSide).toBe('CREDIT');
  });

  it('turns an overdrawn account into a credit rather than a negative debit', () => {
    const journal = unwrap(
      build([line({ amount: Money.fromDecimal('-2500.00', 'MYR') })]),
    );

    const bank = journal.lines[0]!;
    expect(bank.side).toBe('CREDIT');
    // Never a negative amount: `validateJournalEntry` refuses those outright,
    // so the sign has to move to the side instead.
    expect(bank.amount.isNegative()).toBe(false);
    expect(journal.balancingSide).toBe('DEBIT');
  });

  it('omits the equity line entirely when the position already balances', () => {
    const journal = unwrap(
      build([
        line(),
        line({
          accountId: 'loan-id',
          accountCode: '2500',
          accountName: 'Hire Purchase',
          accountType: 'LIABILITY',
          amount: Money.fromDecimal('18540.00', 'MYR'),
        }),
      ]),
    );

    expect(journal.balancingFigure.isZero()).toBe(true);
    expect(journal.lines.map((l) => l.accountId)).not.toContain(EQUITY_ACCOUNT);
  });

  it('ignores accounts stated as zero rather than posting empty lines', () => {
    const journal = unwrap(
      build([line(), line({ accountId: 'other', accountCode: '1010', amount: Money.zero('MYR') })]),
    );
    expect(journal.lines).toHaveLength(2);
  });
});

describe('the refusals — control accounts are not the ledger’s to state', () => {
  it('refuses receivables and says where unpaid invoices go instead', () => {
    const result = build([line({ accountCode: '1100', accountName: 'Accounts Receivable', controlledRole: 'AR' })]);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(codes(result.error)).toEqual(['CONTROLLED_ACCOUNT']);
    expect(result.error[0]!.message).toContain('Sales screen');
  });

  it('refuses payables and inventory for the same reason', () => {
    const result = build([
      line({ accountCode: '2000', accountName: 'Accounts Payable', accountType: 'LIABILITY', controlledRole: 'AP' }),
      line({ accountId: 'stock', accountCode: '1300', accountName: 'Inventory on Hand', controlledRole: 'INVENTORY' }),
    ]);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toHaveLength(2);
    expect(result.error[1]!.message).toContain('average cost');
  });

  it('refuses the balancing account being stated as a balance', () => {
    const result = build([line({ accountId: EQUITY_ACCOUNT, accountType: 'EQUITY' })]);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(codes(result.error)).toEqual(['EQUITY_ACCOUNT_LISTED']);
  });

  it('refuses income and expense — last year is carried as profit, not line by line', () => {
    const result = build([line({ accountCode: '4000', accountName: 'Sales Revenue', accountType: 'INCOME' })]);

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error[0]!.message).toContain('accumulated profit');
  });

  it('refuses an empty statement rather than posting nothing', () => {
    expect(codes((build([]) as { error: OpeningBalanceViolation[] }).error)).toEqual(['NO_BALANCES']);
  });
});

describe('whatever is stated, the entry the ledger receives is valid', () => {
  it('balances for any combination of assets and liabilities', () => {
    const amount = fc
      .integer({ min: -5_000_000, max: 5_000_000 })
      .map((sen) => Money.fromDecimal((sen / 100).toFixed(2), 'MYR'));

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            amount,
            accountType: fc.constantFrom<'ASSET' | 'LIABILITY' | 'EQUITY'>('ASSET', 'LIABILITY', 'EQUITY'),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (rows) => {
          const result = build(
            rows.map((row, i) =>
              line({
                accountId: `account-${i}`,
                accountCode: `${1000 + i}`,
                accountType: row.accountType,
                amount: row.amount,
              }),
            ),
          );

          // An all-zero draw is legitimately refused; anything else must
          // produce an entry the ledger accepts.
          if (isErr(result)) {
            expect(codes(result.error)).toEqual(['NO_BALANCES']);
            return;
          }
          expect(isOk(result)).toBe(true);

          const validated = validateJournalEntry(
            {
              entryDate: result.value.entryDate,
              description: result.value.description,
              sourceModule: 'MANUAL',
              lines: result.value.lines,
            },
            'MYR',
          );
          expect(isOk(validated), JSON.stringify(isErr(validated) ? validated.error : null)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
