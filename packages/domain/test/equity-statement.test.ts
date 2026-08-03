import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import type { AccountBalance } from '../src/report.js';
import {
  buildEquityStatement,
  checkEquityStatement,
  type EquityStatement,
} from '../src/equity-statement.js';

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

/** An equity account balance, debit-positive — so a credit reads negative. */
const equity = (accountId: string, code: string, name: string, creditBalance: string): AccountBalance => ({
  accountId,
  code,
  name,
  type: 'EQUITY',
  tags: [],
  amount: rm(creditBalance).negate(),
});

const build = (over: Partial<Parameters<typeof buildEquityStatement>[0]> = {}) =>
  buildEquityStatement({
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    baseCurrency: 'MYR',
    openingBalances: [],
    closingBalances: [],
    openingUnclosedProfit: rm('0.00'),
    profitForPeriod: rm('0.00'),
    ...over,
  });

const component = (s: EquityStatement, key: string) =>
  s.components.find((c) => c.key === key)!;

// ---------------------------------------------------------------------------
// The case this module exists for
// ---------------------------------------------------------------------------

describe('unclosed profit', () => {
  it('closes on the same equity as the balance sheet when the books are NOT closed', () => {
    /*
     * The normal case for a small business, and the one a SOCE built from
     * equity account balances alone gets wrong.
     *
     * Share capital RM 100,000, prior years' profit RM 40,000 still sitting
     * unclosed in income and expense, and RM 25,000 earned this year. The
     * retained earnings ACCOUNT holds nothing. A statement that read only the
     * equity accounts would close on RM 100,000 and disagree with a balance
     * sheet showing RM 165,000.
     */
    const capital = [equity('eq-1', '3000', 'Share capital', '100000.00')];

    const statement = build({
      openingBalances: capital,
      closingBalances: capital,
      // Debit-positive: a past profit is a credit, so negative.
      openingUnclosedProfit: rm('40000.00').negate(),
      profitForPeriod: rm('25000.00').negate(),
    });

    expect(statement.openingEquity.equals(rm('140000.00'))).toBe(true);
    expect(statement.profitForPeriod.equals(rm('25000.00'))).toBe(true);
    expect(statement.closingEquity.equals(rm('165000.00'))).toBe(true);

    const check = checkEquityStatement(statement, rm('165000.00'));
    expect(check.consistent, JSON.stringify(check.violations)).toBe(true);
  });

  it('presents a loss negative rather than hiding it in a movement', () => {
    const statement = build({
      openingBalances: [equity('eq-1', '3000', 'Share capital', '50000.00')],
      closingBalances: [equity('eq-1', '3000', 'Share capital', '50000.00')],
      profitForPeriod: rm('12000.00'),
    });

    expect(statement.profitForPeriod.equals(rm('-12000.00'))).toBe(true);
    expect(statement.closingEquity.equals(rm('38000.00'))).toBe(true);
    expect(checkEquityStatement(statement, rm('38000.00')).consistent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

describe('equity movements', () => {
  it('shows capital introduced during the period as a movement, not as profit', () => {
    const statement = build({
      openingBalances: [equity('eq-1', '3000', 'Share capital', '100000.00')],
      closingBalances: [equity('eq-1', '3000', 'Share capital', '150000.00')],
      profitForPeriod: rm('20000.00').negate(),
    });

    expect(component(statement, 'eq-1').movement.equals(rm('50000.00'))).toBe(true);
    expect(statement.otherMovements.equals(rm('50000.00'))).toBe(true);
    expect(statement.profitForPeriod.equals(rm('20000.00'))).toBe(true);
    expect(statement.closingEquity.equals(rm('170000.00'))).toBe(true);
  });

  it('shows drawings as a negative movement', () => {
    const statement = build({
      openingBalances: [equity('eq-2', '3200', 'Drawings', '0.00')],
      closingBalances: [equity('eq-2', '3200', 'Drawings', '-30000.00')],
    });

    expect(component(statement, 'eq-2').movement.equals(rm('-30000.00'))).toBe(true);
    expect(statement.closingEquity.equals(rm('-30000.00'))).toBe(true);
  });

  it('gives an equity account opened mid-period an opening of zero, not a gap', () => {
    const statement = build({
      openingBalances: [],
      closingBalances: [equity('eq-3', '3100', 'Revaluation reserve', '75000.00')],
    });

    const reserve = component(statement, 'eq-3');
    expect(reserve.opening.isZero()).toBe(true);
    expect(reserve.movement.equals(rm('75000.00'))).toBe(true);
    expect(reserve.closing.equals(rm('75000.00'))).toBe(true);
  });

  it('drops an equity account that is zero throughout', () => {
    const statement = build({
      openingBalances: [equity('eq-9', '3900', 'Unused reserve', '0.00')],
      closingBalances: [equity('eq-9', '3900', 'Unused reserve', '0.00')],
    });

    expect(statement.components.map((c) => c.key)).toEqual(['UNCLOSED_PROFIT']);
  });
});

// ---------------------------------------------------------------------------
// A year-end close, when one is eventually posted
// ---------------------------------------------------------------------------

describe('a posted year-end close', () => {
  it('leaves total equity untouched and shows the transfer on its own row', () => {
    /*
     * A close posted inside the window appears twice and nets to nothing:
     * profit for the period drops by the amount closed out, and the reserve it
     * went to rises by the same amount. Total equity is unchanged — which is
     * the correct answer, and the reason the statement is built from
     * `equity accounts + unclosed profit` rather than from either alone.
     *
     * Here: RM 25,000 earned and then immediately closed to retained earnings.
     * The P&L accounts net to zero over the period, and the reserve holds it.
     */
    const statement = build({
      openingBalances: [equity('eq-1', '3000', 'Share capital', '100000.00')],
      closingBalances: [
        equity('eq-1', '3000', 'Share capital', '100000.00'),
        equity('eq-4', '3500', 'Retained earnings', '25000.00'),
      ],
      profitForPeriod: rm('0.00'),
    });

    expect(statement.profitForPeriod.isZero()).toBe(true);
    expect(component(statement, 'eq-4').movement.equals(rm('25000.00'))).toBe(true);
    expect(statement.closingEquity.equals(rm('125000.00'))).toBe(true);
    expect(checkEquityStatement(statement, rm('125000.00')).consistent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

describe('checkEquityStatement', () => {
  it('catches a closing equity that disagrees with the balance sheet', () => {
    // The failure a SOCE that only checks itself will never notice: internally
    // consistent, and disagreeing with the ledger by exactly the current year.
    const statement = build({
      openingBalances: [equity('eq-1', '3000', 'Share capital', '100000.00')],
      closingBalances: [equity('eq-1', '3000', 'Share capital', '100000.00')],
      profitForPeriod: rm('25000.00').negate(),
    });

    const check = checkEquityStatement(statement, rm('100000.00'));

    expect(check.consistent).toBe(false);
    expect(check.violations).toContainEqual({
      code: 'DISAGREES_WITH_BALANCE_SHEET',
      statementEquity: '125000.0000',
      balanceSheetEquity: '100000.0000',
      difference: '25000.0000',
    });
  });

  it('catches a component that does not roll forward even when the total does', () => {
    // Two components wrong in opposite directions. The bottom line is right,
    // which is precisely why a total-only check is not enough.
    const broken: EquityStatement = {
      ...build(),
      components: [
        {
          kind: 'ACCOUNT', key: 'a', code: '3000', label: 'Share capital',
          opening: rm('100.00'), movement: rm('0.00'), closing: rm('110.00'),
        },
        {
          kind: 'ACCOUNT', key: 'b', code: '3100', label: 'Reserve',
          opening: rm('100.00'), movement: rm('0.00'), closing: rm('90.00'),
        },
      ],
      openingEquity: rm('200.00'),
      profitForPeriod: rm('0.00'),
      otherMovements: rm('0.00'),
      closingEquity: rm('200.00'),
    };

    const check = checkEquityStatement(broken);

    expect(check.consistent).toBe(false);
    expect(check.violations.map((v) => v.code)).toEqual([
      'COMPONENT_DOES_NOT_ROLL_FORWARD',
      'COMPONENT_DOES_NOT_ROLL_FORWARD',
    ]);
  });

  it('PROPERTY: whatever the inputs, the statement rolls forward at every level', () => {
    const amount = fc.integer({ min: -1_000_000, max: 1_000_000 })
      .map((c) => rm((c / 100).toFixed(2)));

    fc.assert(
      fc.property(
        fc.array(
          fc.record({ id: fc.string({ minLength: 1, maxLength: 4 }), open: amount, close: amount }),
          { maxLength: 12 },
        ),
        amount,
        amount,
        (rows, openingUnclosedProfit, profitForPeriod) => {
          const unique = [...new Map(rows.map((r) => [r.id, r])).values()];

          const statement = build({
            openingBalances: unique.map((r) => ({
              accountId: r.id, code: r.id, name: r.id, type: 'EQUITY' as const,
              tags: [], amount: r.open,
            })),
            closingBalances: unique.map((r) => ({
              accountId: r.id, code: r.id, name: r.id, type: 'EQUITY' as const,
              tags: [], amount: r.close,
            })),
            openingUnclosedProfit,
            profitForPeriod,
          });

          // No balance sheet figure: this asserts the module's own arithmetic,
          // which must hold for every input rather than for the fixtures.
          const check = checkEquityStatement(statement);
          expect(check.consistent, JSON.stringify(check.violations)).toBe(true);
        },
      ),
    );
  });
});
