import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import { isErr, isOk, unwrap } from '../src/result.js';
import {
  netMovementByAccount,
  reverseEntry,
  trialBalanceIsBalanced,
  validateJournalEntry,
  type JournalEntryDraft,
  type JournalLineDraft,
} from '../src/journal-entry.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);

function line(
  accountId: string,
  side: 'DEBIT' | 'CREDIT',
  amount: string,
  base = amount,
): JournalLineDraft {
  return { accountId, side, amount: rm(amount), baseAmount: rm(base) };
}

function draft(lines: JournalLineDraft[], entryDate = '2026-08-01'): JournalEntryDraft {
  return { entryDate, description: 'test entry', sourceModule: 'MANUAL', lines };
}

describe('validateJournalEntry', () => {
  it('accepts a balanced two-line entry', () => {
    // Issuing an invoice: Dr AR / Cr Revenue
    const result = validateJournalEntry(
      draft([line('ar', 'DEBIT', '1080.00'), line('revenue', 'CREDIT', '1080.00')]),
      MYR,
    );

    expect(isOk(result)).toBe(true);
    const entry = unwrap(result);
    expect(entry.totalDebit.toDecimalString()).toBe('1080.0000');
    expect(entry.totalCredit.toDecimalString()).toBe('1080.0000');
  });

  it('accepts a multi-line entry with SST split out', () => {
    const result = validateJournalEntry(
      draft([
        line('ar', 'DEBIT', '1080.00'),
        line('revenue', 'CREDIT', '1000.00'),
        line('sst-payable', 'CREDIT', '80.00'),
      ]),
      MYR,
    );
    expect(isOk(result)).toBe(true);
  });

  it('rejects an unbalanced entry and reports the difference', () => {
    const result = validateJournalEntry(
      draft([line('ar', 'DEBIT', '1000.00'), line('revenue', 'CREDIT', '999.99')]),
      MYR,
    );

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    const unbalanced = result.error.find((v) => v.code === 'UNBALANCED');
    expect(unbalanced).toMatchObject({ code: 'UNBALANCED', difference: '0.0100' });
  });

  it('rejects an entry with no lines', () => {
    const result = validateJournalEntry(draft([]), MYR);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]).toEqual({ code: 'NO_LINES' });
  });

  it('rejects a single-line entry — double entry needs two sides', () => {
    const result = validateJournalEntry(draft([line('ar', 'DEBIT', '100.00')]), MYR);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'SINGLE_LINE')).toBe(true);
    }
  });

  it('rejects non-positive amounts (a negative debit is a credit, spelled wrong)', () => {
    const result = validateJournalEntry(
      draft([line('ar', 'DEBIT', '-100.00'), line('revenue', 'CREDIT', '-100.00')]),
      MYR,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.filter((v) => v.code === 'NON_POSITIVE_AMOUNT')).toHaveLength(2);
    }
  });

  it('rejects a line whose base amount is not in the base currency', () => {
    const result = validateJournalEntry(
      draft([
        { accountId: 'ar', side: 'DEBIT', amount: rm('100'), baseAmount: Money.fromDecimal('100', 'USD') },
        line('revenue', 'CREDIT', '100.00'),
      ]),
      MYR,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'MIXED_BASE_CURRENCY')).toBe(true);
    }
  });

  it('rejects a malformed entry date', () => {
    const result = validateJournalEntry(
      draft([line('ar', 'DEBIT', '100'), line('revenue', 'CREDIT', '100')], '01/08/2026'),
      MYR,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'INVALID_ENTRY_DATE')).toBe(true);
    }
  });

  it('reports every violation at once, not just the first', () => {
    const result = validateJournalEntry(
      draft([line('', 'DEBIT', '-5.00'), line('revenue', 'CREDIT', '10.00')], 'not-a-date'),
      MYR,
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    const codes = new Set(result.error.map((v) => v.code));
    expect(codes.has('INVALID_ENTRY_DATE')).toBe(true);
    expect(codes.has('MISSING_ACCOUNT')).toBe(true);
    expect(codes.has('NON_POSITIVE_AMOUNT')).toBe(true);
    expect(codes.has('UNBALANCED')).toBe(true);
  });
});

describe('multi-currency', () => {
  it('balances in base currency even when transaction currencies differ', () => {
    // USD 1,000 invoice at 4.70, settled at 4.75: RM 50 realised FX gain.
    const result = validateJournalEntry(
      draft([
        { accountId: 'bank-usd', side: 'DEBIT', amount: Money.fromDecimal('1000', 'USD'), baseAmount: rm('4750.00') },
        { accountId: 'ar', side: 'CREDIT', amount: Money.fromDecimal('1000', 'USD'), baseAmount: rm('4700.00') },
        { accountId: 'fx-gain', side: 'CREDIT', amount: rm('50.00'), baseAmount: rm('50.00') },
      ]),
      MYR,
    );

    expect(isOk(result)).toBe(true);
  });
});

describe('reverseEntry', () => {
  it('swaps every side and leaves amounts untouched', () => {
    const original = draft([
      line('ar', 'DEBIT', '1080.00'),
      line('revenue', 'CREDIT', '1000.00'),
      line('sst-payable', 'CREDIT', '80.00'),
    ]);

    const reversal = reverseEntry(original, { entryDate: '2026-08-15' });

    expect(reversal.lines.map((l) => l.side)).toEqual(['CREDIT', 'DEBIT', 'DEBIT']);
    expect(reversal.lines.map((l) => l.baseAmount.toDecimalString())).toEqual(
      original.lines.map((l) => l.baseAmount.toDecimalString()),
    );
    expect(reversal.entryDate).toBe('2026-08-15');
    expect(reversal.description).toContain('Reversal of');
  });

  it('produces a reversal that is itself valid', () => {
    const original = draft([line('ar', 'DEBIT', '500'), line('revenue', 'CREDIT', '500')]);
    const reversal = reverseEntry(original, { entryDate: '2026-08-15' });
    expect(isOk(validateJournalEntry(reversal, MYR))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ledger invariants — docs/architecture/06-data-model.md §6.9
// ---------------------------------------------------------------------------

/** Generate a balanced entry: N random debits, offset by one balancing credit. */
const arbBalancedEntry = fc
  .array(
    fc.record({
      accountId: fc.constantFrom('a1', 'a2', 'a3', 'a4', 'a5'),
      units: fc.bigInt({ min: 1n, max: 10_000_0000n }),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .map((debits): JournalEntryDraft => {
    const total = debits.reduce((sum, d) => sum + d.units, 0n);
    return draft([
      ...debits.map((d): JournalLineDraft => ({
        accountId: d.accountId,
        side: 'DEBIT',
        amount: Money.fromUnits(d.units, MYR),
        baseAmount: Money.fromUnits(d.units, MYR),
      })),
      {
        accountId: 'balancing',
        side: 'CREDIT',
        amount: Money.fromUnits(total, MYR),
        baseAmount: Money.fromUnits(total, MYR),
      },
    ]);
  });

describe('ledger invariants', () => {
  it('#1 every generated entry validates and has equal debits and credits', () => {
    fc.assert(
      fc.property(arbBalancedEntry, (entry) => {
        const result = validateJournalEntry(entry, MYR);
        expect(isOk(result)).toBe(true);
        if (isOk(result)) {
          expect(result.value.totalDebit.equals(result.value.totalCredit)).toBe(true);
        }
      }),
    );
  });

  it('#2 the trial balance balances across any set of posted entries', () => {
    fc.assert(
      fc.property(fc.array(arbBalancedEntry, { maxLength: 25 }), (entries) => {
        expect(trialBalanceIsBalanced(entries, MYR)).toBe(true);
      }),
    );
  });

  it('#4 reversing every entry returns all account balances to zero', () => {
    fc.assert(
      fc.property(fc.array(arbBalancedEntry, { minLength: 1, maxLength: 20 }), (entries) => {
        const reversals = entries.map((e) => reverseEntry(e, { entryDate: '2026-12-31' }));
        const movements = netMovementByAccount([...entries, ...reversals], MYR);

        for (const [accountId, movement] of movements) {
          expect(
            movement.isZero(),
            `account ${accountId} did not return to zero: ${movement.toDecimalString()}`,
          ).toBe(true);
        }
      }),
    );
  });

  it('#2 an unbalanced entry is never accepted, however it is constructed', () => {
    fc.assert(
      fc.property(
        arbBalancedEntry,
        fc.bigInt({ min: 1n, max: 100_0000n }),
        (entry, drift) => {
          const firstLine = entry.lines[0]!;
          const tampered = draft([
            {
              ...firstLine,
              amount: Money.fromUnits(firstLine.amount.units + drift, MYR),
              baseAmount: Money.fromUnits(firstLine.baseAmount.units + drift, MYR),
            },
            ...entry.lines.slice(1),
          ]);

          const result = validateJournalEntry(tampered, MYR);
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.some((v) => v.code === 'UNBALANCED')).toBe(true);
          }
        },
      ),
    );
  });
});

describe('netMovementByAccount', () => {
  it('nets debits against credits per account', () => {
    const movements = netMovementByAccount(
      [
        draft([line('bank', 'DEBIT', '1000'), line('revenue', 'CREDIT', '1000')]),
        draft([line('bank', 'CREDIT', '250'), line('expense', 'DEBIT', '250')]),
      ],
      MYR,
    );

    expect(movements.get('bank')!.toDecimalString()).toBe('750.0000');
    expect(movements.get('revenue')!.toDecimalString()).toBe('-1000.0000');
    expect(movements.get('expense')!.toDecimalString()).toBe('250.0000');
  });
});
