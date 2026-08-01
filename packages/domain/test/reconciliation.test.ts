import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money, sumMoney } from '../src/money.js';
import {
  checkInvariantEight,
  firstMatchingRule,
  reconcile,
  type BankRule,
  type ReconciliationItem,
} from '../src/reconciliation.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);

const item = (id: string, amount: string, description = 'ITEM'): ReconciliationItem => ({
  id,
  date: '2026-08-20',
  amount: rm(amount),
  description,
});

const base = {
  asOfDate: '2026-08-31',
  baseCurrency: MYR,
  openingBalance: rm('10000.00'),
  statementClosingBalance: rm('10000.00'),
  bookBalance: rm('10000.00'),
  reconciled: [] as ReconciliationItem[],
  unreconciledStatementItems: [] as ReconciliationItem[],
  unpresentedBookItems: [] as ReconciliationItem[],
};

describe('reconcile', () => {
  it('reconciles when both sides already agree', () => {
    const result = reconcile(base);
    expect(result.reconciles).toBe(true);
    expect(result.variance.isZero()).toBe(true);
  });

  it('explains an unpresented cheque without reporting a variance', () => {
    // RM 100 paid out per the books; the payee has not banked it, so the bank
    // still holds the money. The ledger is RIGHT and no action is needed.
    const result = reconcile({
      ...base,
      bookBalance: rm('9900.00'),
      statementClosingBalance: rm('10000.00'),
      unpresentedBookItems: [item('chq-1', '-100.00', 'CHEQUE 123456')],
    });

    expect(result.reconciles).toBe(true);
    expect(result.unpresentedPayments.toDecimalString()).toBe('100.0000');
    expect(result.unrecordedBankMovement.isZero()).toBe(true);
  });

  it('explains a deposit in transit', () => {
    const result = reconcile({
      ...base,
      bookBalance: rm('10500.00'),
      statementClosingBalance: rm('10000.00'),
      unpresentedBookItems: [item('dep-1', '500.00', 'CASH DEPOSIT 31/08')],
    });

    expect(result.reconciles).toBe(true);
    expect(result.depositsInTransit.toDecimalString()).toBe('500.0000');
  });

  it('separates a bank charge from a timing difference', () => {
    // The distinction the whole module turns on. A bank charge is NOT a timing
    // difference: the bank is right and the ledger is missing an entry. Lumped
    // in with unpresented cheques it looks like something that will resolve
    // itself, and it never does.
    const result = reconcile({
      ...base,
      bookBalance: rm('10000.00'),
      statementClosingBalance: rm('9995.00'),
      unreconciledStatementItems: [item('chg-1', '-5.00', 'SERVICE CHARGE')],
    });

    expect(result.reconciles).toBe(true);
    expect(result.unrecordedBankMovement.toDecimalString()).toBe('-5.0000');
    // Emphatically not counted as an unpresented payment.
    expect(result.unpresentedPayments.isZero()).toBe(true);
  });

  it('reports a genuine variance rather than absorbing it', () => {
    const result = reconcile({ ...base, bookBalance: rm('9950.00') });
    expect(result.reconciles).toBe(false);
    expect(result.variance.toDecimalString()).toBe('50.0000');
  });

  it('handles both kinds of outstanding item at once', () => {
    const result = reconcile({
      ...base,
      // Books: 10,000 - 100 cheque + 500 deposit = 10,400
      bookBalance: rm('10400.00'),
      // Bank: 10,000 - 5 charge = 9,995
      statementClosingBalance: rm('9995.00'),
      unpresentedBookItems: [item('chq-1', '-100.00'), item('dep-1', '500.00')],
      unreconciledStatementItems: [item('chg-1', '-5.00', 'SERVICE CHARGE')],
    });

    expect(result.reconciles).toBe(true);
    expect(result.counts).toEqual({
      reconciled: 0,
      unreconciledStatementItems: 1,
      unpresentedBookItems: 2,
    });
  });

  it('a consistent set of books and statement always reconciles (property)', () => {
    // Constructed so the two sides genuinely agree: whatever the outstanding
    // items, the arithmetic must land on zero. A failure here means the
    // adjustment formula is wrong, not that the data is.
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: -1_000_0000n, max: 1_000_0000n }), { maxLength: 12 }),
        fc.array(fc.bigInt({ min: -1_000_0000n, max: 1_000_0000n }), { maxLength: 12 }),
        fc.bigInt({ min: 0n, max: 100_000_0000n }),
        (bookOnly, statementOnly, openingUnits) => {
          const opening = Money.fromUnits(openingUnits, MYR);
          const asItems = (units: readonly bigint[], prefix: string): ReconciliationItem[] =>
            units.map((u, i) => ({
              id: `${prefix}-${i}`,
              date: '2026-08-20',
              amount: Money.fromUnits(u, MYR),
              description: 'ITEM',
            }));

          const unpresented = asItems(bookOnly, 'b');
          const unrecorded = asItems(statementOnly, 's');

          const bookMovement = sumMoney(unpresented.map((i) => i.amount), MYR);
          const statementMovement = sumMoney(unrecorded.map((i) => i.amount), MYR);

          // Books see their own movements; the bank sees its own.
          const bookBalance = opening.add(bookMovement);
          const statementClosingBalance = opening.add(statementMovement);

          const result = reconcile({
            ...base,
            openingBalance: opening,
            bookBalance,
            statementClosingBalance,
            unpresentedBookItems: unpresented,
            unreconciledStatementItems: unrecorded,
          });

          expect(result.reconciles).toBe(true);
        },
      ),
    );
  });
});

describe('ledger invariant #8', () => {
  it('holds when the account is fully reconciled', () => {
    const opening = rm('10000.00');
    const reconciled = [rm('1080.00'), rm('-600.00'), rm('-5.00')];
    const book = rm('10475.00'); // 10,000 + 1,080 - 600 - 5

    const result = checkInvariantEight(opening, reconciled, book, MYR);
    expect(result.holds).toBe(true);
    expect(result.expected.toDecimalString()).toBe('10475.0000');
  });

  it('reports the difference when it does not hold', () => {
    const result = checkInvariantEight(rm('10000.00'), [rm('100.00')], rm('10150.00'), MYR);
    expect(result.holds).toBe(false);
    expect(result.difference.toDecimalString()).toBe('50.0000');
  });

  it('holds for any set of reconciled movements (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_0000n }),
        fc.array(fc.bigInt({ min: -10_000_0000n, max: 10_000_0000n }), { maxLength: 40 }),
        (openingUnits, movementUnits) => {
          const opening = Money.fromUnits(openingUnits, MYR);
          const movements = movementUnits.map((u) => Money.fromUnits(u, MYR));
          const book = opening.add(sumMoney(movements, MYR));

          expect(checkInvariantEight(opening, movements, book, MYR).holds).toBe(true);
        },
      ),
    );
  });
});

describe('bank rules', () => {
  const rule = (over: Partial<BankRule> = {}): BankRule => ({
    id: 'r1',
    priority: 10,
    contains: 'TNB',
    accountId: 'acc-utilities',
    autoApply: false,
    ...over,
  });

  it('matches on a narrative fragment', () => {
    const match = firstMatchingRule(
      { description: 'GIRO TNB TENAGA NASIONAL', amount: rm('-250.00') },
      [rule()],
    );
    expect(match?.rule.accountId).toBe('acc-utilities');
    expect(match?.reason).toMatch(/contains "TNB"/);
  });

  it('respects priority order, lowest first', () => {
    const match = firstMatchingRule({ description: 'TNB BILL', amount: rm('-250.00') }, [
      rule({ id: 'late', priority: 20, accountId: 'acc-wrong' }),
      rule({ id: 'early', priority: 1, accountId: 'acc-right' }),
    ]);
    expect(match?.rule.accountId).toBe('acc-right');
  });

  it('breaks a priority tie deterministically rather than by array order', () => {
    // Two rules at the same priority must not code a line differently
    // depending on the order the database happened to return them.
    const rules = [rule({ id: 'b', accountId: 'acc-b' }), rule({ id: 'a', accountId: 'acc-a' })];
    const forward = firstMatchingRule({ description: 'TNB', amount: rm('-1.00') }, rules);
    const reversed = firstMatchingRule({ description: 'TNB', amount: rm('-1.00') }, [...rules].reverse());
    expect(forward?.rule.id).toBe(reversed?.rule.id);
    expect(forward?.rule.id).toBe('a');
  });

  it('filters on direction', () => {
    const outflowOnly = rule({ matchesDirection: 'OUTFLOW' });
    expect(firstMatchingRule({ description: 'TNB', amount: rm('-250.00') }, [outflowOnly])).not.toBeNull();
    expect(firstMatchingRule({ description: 'TNB', amount: rm('250.00') }, [outflowOnly])).toBeNull();
  });

  it('filters on an amount range, by magnitude', () => {
    const banded = rule({ minAmount: rm('100.00'), maxAmount: rm('500.00') });
    expect(firstMatchingRule({ description: 'TNB', amount: rm('-250.00') }, [banded])).not.toBeNull();
    expect(firstMatchingRule({ description: 'TNB', amount: rm('-50.00') }, [banded])).toBeNull();
    expect(firstMatchingRule({ description: 'TNB', amount: rm('-600.00') }, [banded])).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(firstMatchingRule({ description: 'SOMETHING ELSE', amount: rm('-1.00') }, [rule()])).toBeNull();
  });

  it('defaults to suggest-only', () => {
    // autoApply is per rule and off unless a user turns it on. A rule that
    // silently posts to the wrong account is a rule nobody notices for months.
    expect(rule().autoApply).toBe(false);
  });
});
