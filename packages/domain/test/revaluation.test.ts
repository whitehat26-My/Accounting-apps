import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import { isErr, unwrap } from '../src/result.js';
import { netMovementByAccount, reverseEntry, validateJournalEntry } from '../src/journal-entry.js';
import { Rate } from '../src/fx.js';
import {
  buildCombinedRevaluationJournal,
  buildRevaluationJournal,
  revalue,
  reversalDate,
  type RevaluationItem,
} from '../src/revaluation.js';

const MYR = 'MYR';
const USD = 'USD';
const SGD = 'SGD';
const rm = (v: string) => Money.fromDecimal(v, MYR);
const usd = (v: string) => Money.fromDecimal(v, USD);
const sgd = (v: string) => Money.fromDecimal(v, SGD);

const ACCOUNTS = {
  revaluationAccountId: 'acc-ar-reval',
  unrealisedFxAccountId: 'acc-unrealised-fx',
};

const CTX = {
  entryDate: '2026-08-31',
  documentType: 'REVALUATION',
  documentId: 'rev-1',
};

const item = (over: Partial<RevaluationItem> = {}): RevaluationItem => ({
  reference: 'INV-00001',
  outstanding: usd('1000.00'),
  bookedRate: Rate.fromDecimal('4.70'),
  ...over,
});

describe('revalue', () => {
  it('restates an open foreign receivable at the closing rate', () => {
    const result = unwrap(
      revalue([item()], new Map([[USD, Rate.fromDecimal('4.80')]]), MYR, '2026-08-31'),
    );

    expect(result.byCurrency).toHaveLength(1);
    const line = result.byCurrency[0]!;
    expect(line.carryingBase.toDecimalString()).toBe('4700.0000');
    expect(line.closingBase.toDecimalString()).toBe('4800.0000');
    expect(line.difference.toDecimalString()).toBe('100.0000');
    expect(result.totalDifference.toDecimalString()).toBe('100.0000');
  });

  it('produces a negative adjustment when the currency weakens', () => {
    const result = unwrap(
      revalue([item()], new Map([[USD, Rate.fromDecimal('4.50')]]), MYR, '2026-08-31'),
    );
    expect(result.totalDifference.toDecimalString()).toBe('-200.0000');
  });

  it('is zero when the rate has not moved', () => {
    const result = unwrap(
      revalue([item()], new Map([[USD, Rate.fromDecimal('4.70')]]), MYR, '2026-08-31'),
    );
    expect(result.totalDifference.isZero()).toBe(true);
  });

  it('carries each item at its OWN booked rate, not an aggregate rate', () => {
    // Two invoices raised on different days. Converting the USD 2,000 total at
    // any single historical rate would give a different carrying value.
    const result = unwrap(
      revalue(
        [
          item({ reference: 'A', bookedRate: Rate.fromDecimal('4.50') }),
          item({ reference: 'B', bookedRate: Rate.fromDecimal('4.70') }),
        ],
        new Map([[USD, Rate.fromDecimal('4.80')]]),
        MYR,
        '2026-08-31',
      ),
    );

    const line = result.byCurrency[0]!;
    expect(line.carryingBase.toDecimalString()).toBe('9200.0000'); // 4500 + 4700
    expect(line.closingBase.toDecimalString()).toBe('9600.0000');  // 2000 @ 4.80
    expect(line.difference.toDecimalString()).toBe('400.0000');
  });

  it('groups by currency and reports each separately', () => {
    const result = unwrap(
      revalue(
        [
          item({ reference: 'A', outstanding: usd('1000.00'), bookedRate: Rate.fromDecimal('4.70') }),
          item({ reference: 'B', outstanding: sgd('1000.00'), bookedRate: Rate.fromDecimal('3.50') }),
        ],
        new Map([
          [USD, Rate.fromDecimal('4.80')],
          [SGD, Rate.fromDecimal('3.40')],
        ]),
        MYR,
        '2026-08-31',
      ),
    );

    expect(result.byCurrency.map((c) => c.currency)).toEqual([SGD, USD]);
    expect(result.byCurrency.find((c) => c.currency === USD)!.difference.toDecimalString())
      .toBe('100.0000');
    expect(result.byCurrency.find((c) => c.currency === SGD)!.difference.toDecimalString())
      .toBe('-100.0000');
    // They offset exactly here, which is a useful reminder that the net can be
    // zero while individual currencies moved a long way.
    expect(result.totalDifference.isZero()).toBe(true);
  });

  it('ignores base-currency items entirely', () => {
    const result = unwrap(
      revalue(
        [
          item(),
          { reference: 'LOCAL', outstanding: rm('99999.00'), bookedRate: Rate.one() },
        ],
        new Map([[USD, Rate.fromDecimal('4.80')]]),
        MYR,
        '2026-08-31',
      ),
    );

    expect(result.byCurrency).toHaveLength(1);
    expect(result.byCurrency[0]!.itemCount).toBe(1);
  });

  it('errors on a missing closing rate rather than skipping the currency', () => {
    const result = revalue(
      [item({ outstanding: sgd('500.00') })],
      new Map([[USD, Rate.fromDecimal('4.80')]]),
      MYR,
      '2026-08-31',
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error[0]).toMatchObject({ code: 'MISSING_CLOSING_RATE', currency: SGD });
    }
  });

  it('handles an empty item list', () => {
    const result = unwrap(revalue([], new Map(), MYR, '2026-08-31'));
    expect(result.byCurrency).toHaveLength(0);
    expect(result.totalDifference.isZero()).toBe(true);
  });

  it('rejects a malformed reporting date', () => {
    expect(isErr(revalue([], new Map(), MYR, '31/08/2026'))).toBe(true);
  });
});

describe('the revaluation journal', () => {
  it('debits the revaluation account on a gain', () => {
    const result = unwrap(
      revalue([item()], new Map([[USD, Rate.fromDecimal('4.80')]]), MYR, '2026-08-31'),
    );
    const entry = buildRevaluationJournal(result, ACCOUNTS, CTX)!;

    const reval = entry.lines.find((l) => l.accountId === 'acc-ar-reval')!;
    const fx = entry.lines.find((l) => l.accountId === 'acc-unrealised-fx')!;

    expect(reval.side).toBe('DEBIT');
    expect(reval.amount.toDecimalString()).toBe('100.0000');
    expect(fx.side).toBe('CREDIT');
    expect(validateJournalEntry(entry, MYR).ok).toBe(true);
  });

  it('credits the revaluation account on a loss', () => {
    const result = unwrap(
      revalue([item()], new Map([[USD, Rate.fromDecimal('4.50')]]), MYR, '2026-08-31'),
    );
    const entry = buildRevaluationJournal(result, ACCOUNTS, CTX)!;

    expect(entry.lines.find((l) => l.accountId === 'acc-ar-reval')!.side).toBe('CREDIT');
    expect(entry.lines.find((l) => l.accountId === 'acc-unrealised-fx')!.side).toBe('DEBIT');
    expect(validateJournalEntry(entry, MYR).ok).toBe(true);
  });

  it('builds nothing when no rate moved', () => {
    const result = unwrap(
      revalue([item()], new Map([[USD, Rate.fromDecimal('4.70')]]), MYR, '2026-08-31'),
    );
    expect(buildRevaluationJournal(result, ACCOUNTS, CTX)).toBeNull();
  });

  it('builds nothing when currencies offset to zero', () => {
    // A period where USD gained exactly what SGD lost leaves no adjustment to
    // post, even though both currencies moved.
    const result = unwrap(
      revalue(
        [
          item({ outstanding: usd('1000.00'), bookedRate: Rate.fromDecimal('4.70') }),
          item({ outstanding: sgd('1000.00'), bookedRate: Rate.fromDecimal('3.50') }),
        ],
        new Map([
          [USD, Rate.fromDecimal('4.80')],
          [SGD, Rate.fromDecimal('3.40')],
        ]),
        MYR,
        '2026-08-31',
      ),
    );
    expect(buildRevaluationJournal(result, ACCOUNTS, CTX)).toBeNull();
  });

  it('is always balanced (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100_000_0000n }),
        fc.bigInt({ min: 1_00000000n, max: 10_00000000n }),
        fc.bigInt({ min: 1_00000000n, max: 10_00000000n }),
        (amountUnits, bookedUnits, closingUnits) => {
          const result = unwrap(
            revalue(
              [{
                reference: 'X',
                outstanding: Money.fromUnits(amountUnits, USD),
                bookedRate: Rate.fromUnits(bookedUnits),
              }],
              new Map([[USD, Rate.fromUnits(closingUnits)]]),
              MYR,
              '2026-08-31',
            ),
          );

          const entry = buildRevaluationJournal(result, ACCOUNTS, CTX);
          if (entry === null) {
            expect(result.totalDifference.isZero()).toBe(true);
            return;
          }
          const validated = validateJournalEntry(entry, MYR);
          expect(validated.ok, JSON.stringify(validated.ok ? {} : validated.error)).toBe(true);
        },
      ),
    );
  });
});

describe('the revaluation reverses', () => {
  it('reverses on the day after the reporting date', () => {
    expect(reversalDate('2026-08-31')).toBe('2026-09-01');
    expect(reversalDate('2026-12-31')).toBe('2027-01-01');
    // Leap year, because month arithmetic is exactly where this goes wrong.
    expect(reversalDate('2028-02-28')).toBe('2028-02-29');
  });

  it('the entry and its reversal net every account to zero', () => {
    // This is what makes settlement safe: by the time the invoice is paid,
    // the carrying amount is back at the historical rate, so the realised
    // gain computed in fx.ts does not double-count the unrealised one.
    const result = unwrap(
      revalue([item()], new Map([[USD, Rate.fromDecimal('4.80')]]), MYR, '2026-08-31'),
    );

    const entry = buildRevaluationJournal(result, ACCOUNTS, CTX)!;
    const reversal = reverseEntry(entry, { entryDate: reversalDate('2026-08-31') });

    const movements = netMovementByAccount([entry, reversal], MYR);
    for (const [accountId, movement] of movements) {
      expect(movement.isZero(), `${accountId} did not net to zero`).toBe(true);
    }
    expect(reversal.entryDate).toBe('2026-09-01');
  });

  it('the reversal is itself a valid entry (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100_000_0000n }),
        fc.bigInt({ min: 1_00000000n, max: 10_00000000n }),
        (amountUnits, closingUnits) => {
          const result = unwrap(
            revalue(
              [{
                reference: 'X',
                outstanding: Money.fromUnits(amountUnits, USD),
                bookedRate: Rate.fromDecimal('4.70'),
              }],
              new Map([[USD, Rate.fromUnits(closingUnits)]]),
              MYR,
              '2026-08-31',
            ),
          );

          const entry = buildRevaluationJournal(result, ACCOUNTS, CTX);
          if (entry === null) return;

          const reversal = reverseEntry(entry, { entryDate: '2026-09-01' });
          expect(validateJournalEntry(reversal, MYR).ok).toBe(true);
        },
      ),
    );
  });
});

describe('two-sided revaluation', () => {
  const AP_REVAL = 'acc-ap-reval';

  const receivables = (closing: string) =>
    unwrap(revalue([item()], new Map([[USD, Rate.fromDecimal(closing)]]), MYR, '2026-08-31'));

  /**
   * A payable, fed as a NEGATIVE outstanding.
   *
   * The system is debit-positive throughout, so a credit-natured balance
   * carries a negative sign and `revalue()` needs no notion of which side of
   * the balance sheet it is looking at. Flipping this sign is the single
   * easiest way to turn a period-end loss into a reported gain, so the
   * arithmetic is asserted directly below rather than inferred from a journal
   * that happens to balance.
   */
  const payables = (closing: string) =>
    unwrap(
      revalue(
        [item({ reference: 'BILL-00001', outstanding: usd('-1000.00') })],
        new Map([[USD, Rate.fromDecimal(closing)]]),
        MYR,
        '2026-08-31',
      ),
    );

  it('a strengthening USD is a gain on receivables and a loss on payables', () => {
    expect(receivables('4.90').totalDifference.toDecimalString()).toBe('200.0000');
    expect(payables('4.90').totalDifference.toDecimalString()).toBe('-200.0000');
  });

  it('gives each side its own balance-sheet line and nets only the P&L', () => {
    const entry = buildCombinedRevaluationJournal(
      [
        { revaluation: receivables('4.90'), revaluationAccountId: ACCOUNTS.revaluationAccountId },
        { revaluation: payables('4.80'), revaluationAccountId: AP_REVAL },
      ],
      ACCOUNTS.unrealisedFxAccountId,
      CTX,
      MYR,
    );

    const net = netMovementByAccount([entry!], MYR);
    // +200 on receivables, -100 on payables, +100 net gain -> credit the P&L.
    expect(net.get(ACCOUNTS.revaluationAccountId)!.toDecimalString()).toBe('200.0000');
    expect(net.get(AP_REVAL)!.toDecimalString()).toBe('-100.0000');
    expect(net.get(ACCOUNTS.unrealisedFxAccountId)!.toDecimalString()).toBe('-100.0000');
    expect(validateJournalEntry(entry!, MYR).ok).toBe(true);
  });

  it('a matched receivable and payable move the balance sheet but not the P&L', () => {
    // The natural-hedge case. Netting the two sides into one balance-sheet
    // account would produce the same (correct) P&L and the WRONG balance
    // sheet, which is why this asserts the two lines separately.
    const entry = buildCombinedRevaluationJournal(
      [
        { revaluation: receivables('4.90'), revaluationAccountId: ACCOUNTS.revaluationAccountId },
        { revaluation: payables('4.90'), revaluationAccountId: AP_REVAL },
      ],
      ACCOUNTS.unrealisedFxAccountId,
      CTX,
      MYR,
    )!;

    const net = netMovementByAccount([entry], MYR);
    expect(net.get(ACCOUNTS.revaluationAccountId)!.toDecimalString()).toBe('200.0000');
    expect(net.get(AP_REVAL)!.toDecimalString()).toBe('-200.0000');
    expect(net.has(ACCOUNTS.unrealisedFxAccountId)).toBe(false);
    expect(validateJournalEntry(entry, MYR).ok).toBe(true);
  });

  it('posts nothing when no rate moved on either side', () => {
    expect(
      buildCombinedRevaluationJournal(
        [
          { revaluation: receivables('4.70'), revaluationAccountId: ACCOUNTS.revaluationAccountId },
          { revaluation: payables('4.70'), revaluationAccountId: AP_REVAL },
        ],
        ACCOUNTS.unrealisedFxAccountId,
        CTX,
        MYR,
      ),
    ).toBeNull();
  });

  it('always balances, whatever the two sides do (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 20_00000000n }),
        fc.bigInt({ min: 1n, max: 20_00000000n }),
        (arClosing, apClosing) => {
          const toRate = (units: bigint) => Rate.fromUnits(units);
          const ar = unwrap(
            revalue([item()], new Map([[USD, toRate(arClosing)]]), MYR, '2026-08-31'),
          );
          const ap = unwrap(
            revalue(
              [item({ reference: 'BILL-1', outstanding: usd('-1000.00') })],
              new Map([[USD, toRate(apClosing)]]),
              MYR,
              '2026-08-31',
            ),
          );

          const entry = buildCombinedRevaluationJournal(
            [
              { revaluation: ar, revaluationAccountId: ACCOUNTS.revaluationAccountId },
              { revaluation: ap, revaluationAccountId: AP_REVAL },
            ],
            ACCOUNTS.unrealisedFxAccountId,
            CTX,
            MYR,
          );
          if (entry === null) return;
          expect(validateJournalEntry(entry, MYR).ok).toBe(true);
        },
      ),
    );
  });

  it('reverses cleanly, leaving nothing behind', () => {
    const entry = buildCombinedRevaluationJournal(
      [
        { revaluation: receivables('4.90'), revaluationAccountId: ACCOUNTS.revaluationAccountId },
        { revaluation: payables('4.80'), revaluationAccountId: AP_REVAL },
      ],
      ACCOUNTS.unrealisedFxAccountId,
      CTX,
      MYR,
    )!;

    const reversal = reverseEntry(entry, {
      entryDate: reversalDate('2026-08-31'),
      description: 'Reversal',
    });

    for (const movement of netMovementByAccount([entry, reversal], MYR).values()) {
      expect(movement.isZero()).toBe(true);
    }
  });
});
