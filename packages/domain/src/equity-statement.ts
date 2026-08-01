/**
 * The statement of changes in equity — the fourth primary statement.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING THAT MAKES THIS STATEMENT HARD FOR AN SME PRODUCT.
 *
 * A textbook SOCE opens with retained earnings brought forward, adds profit for
 * the year, deducts dividends, and closes on the retained earnings that appear
 * on the balance sheet. That works when a year-end close has been posted, so
 * profit has been transferred out of income and expense and into a reserve.
 *
 * For most small businesses most of the time, IT HAS NOT BEEN. Profit is still
 * sitting in the income and expense accounts, and the retained earnings account
 * holds only prior years. A SOCE built from equity account balances alone then
 * closes on a figure that does not agree with the balance sheet — by exactly
 * the current year's profit.
 *
 * So this module treats equity as EQUITY ACCOUNTS PLUS UNCLOSED PROFIT, the
 * same way `checkAccountingEquation` does. That is what makes the statement
 * agree with the balance sheet whether or not the books have been closed, which
 * for this product's users is the normal case rather than the exception.
 *
 * When a year-end close IS eventually posted, it appears in the period it was
 * posted in as two offsetting movements: profit for the period drops by the
 * amount closed out, and the reserve it was transferred to rises by the same
 * amount. Total equity is unaffected, which is correct, and the transfer is
 * visible on its own row rather than being netted into a figure that would then
 * look like the business earned nothing.
 * ---------------------------------------------------------------------------
 *
 * Sign convention: inputs are DEBIT-POSITIVE like everything else in the
 * reporting layer, and outputs are presented CREDIT-POSITIVE, because a reader
 * expects equity and profit to read positive.
 *
 * Pure: balances are fetched by the caller.
 */

import { Money, sumMoney, type Currency } from './money.js';
import type { AccountBalance } from './report.js';

export type EquityComponentKind = 'ACCOUNT' | 'UNCLOSED_PROFIT';

export interface EquityComponent {
  readonly kind: EquityComponentKind;
  /** The account id, or `UNCLOSED_PROFIT` for the synthetic component. */
  readonly key: string;
  readonly code: string;
  readonly label: string;
  /** All three credit-positive. */
  readonly opening: Money;
  readonly movement: Money;
  readonly closing: Money;
}

export interface EquityStatement {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: Currency;
  readonly components: readonly EquityComponent[];
  readonly openingEquity: Money;
  /** Profit or loss recognised in the period. Positive is a profit. */
  readonly profitForPeriod: Money;
  /** Everything else: capital introduced, drawings, dividends, transfers. */
  readonly otherMovements: Money;
  readonly closingEquity: Money;
}

export interface BuildEquityStatementOptions {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly baseCurrency: Currency;
  /** EQUITY accounts, cumulative to the day before `periodStart`. */
  readonly openingBalances: readonly AccountBalance[];
  /** EQUITY accounts, cumulative to `periodEnd`. */
  readonly closingBalances: readonly AccountBalance[];
  /**
   * Profit or loss never transferred to a reserve, cumulative to the day
   * before `periodStart`. Debit-positive, so a past profit is negative.
   */
  readonly openingUnclosedProfit: Money;
  /** Profit or loss arising in the period. Debit-positive. */
  readonly profitForPeriod: Money;
}

export function buildEquityStatement(
  options: BuildEquityStatementOptions,
): EquityStatement {
  const { baseCurrency } = options;
  const zero = Money.zero(baseCurrency);

  // Credit-positive presentation, applied once, here.
  const present = (m: Money) => m.negate();

  const byId = new Map<string, { code: string; name: string; opening: Money; closing: Money }>();

  for (const b of options.openingBalances) {
    byId.set(b.accountId, { code: b.code, name: b.name, opening: b.amount, closing: zero });
  }

  for (const b of options.closingBalances) {
    const existing = byId.get(b.accountId);
    if (existing) {
      byId.set(b.accountId, { ...existing, closing: b.amount });
    } else {
      // An equity account opened during the period. Its opening is genuinely
      // zero rather than missing.
      byId.set(b.accountId, { code: b.code, name: b.name, opening: zero, closing: b.amount });
    }
  }

  const accountComponents: EquityComponent[] = [...byId.entries()]
    .map(([accountId, v]) => ({
      kind: 'ACCOUNT' as const,
      key: accountId,
      code: v.code,
      label: v.name,
      opening: present(v.opening),
      movement: present(v.closing.subtract(v.opening)),
      closing: present(v.closing),
    }))
    // An equity account that is zero throughout says nothing. One that moved,
    // or that holds a balance, stays even if it nets to the same figure.
    .filter((c) => !(c.opening.isZero() && c.closing.isZero() && c.movement.isZero()))
    .sort((a, b) => a.code.localeCompare(b.code));

  const unclosedClosing = options.openingUnclosedProfit.add(options.profitForPeriod);

  const profitComponent: EquityComponent = {
    kind: 'UNCLOSED_PROFIT',
    key: 'UNCLOSED_PROFIT',
    // Sorts last among typical chart codes, and is not a real account code.
    code: 'ZZZZ',
    label: 'Profit or loss not yet transferred to reserves',
    opening: present(options.openingUnclosedProfit),
    movement: present(options.profitForPeriod),
    closing: present(unclosedClosing),
  };

  const components = [...accountComponents, profitComponent];

  const total = (pick: (c: EquityComponent) => Money) =>
    sumMoney(components.map(pick), baseCurrency);

  return {
    periodStart: options.periodStart,
    periodEnd: options.periodEnd,
    currency: baseCurrency,
    components,
    openingEquity: total((c) => c.opening),
    profitForPeriod: present(options.profitForPeriod),
    otherMovements: sumMoney(
      accountComponents.map((c) => c.movement),
      baseCurrency,
    ),
    closingEquity: total((c) => c.closing),
  };
}

export type EquityViolation =
  | {
      readonly code: 'DOES_NOT_ROLL_FORWARD';
      readonly opening: string;
      readonly profit: string;
      readonly otherMovements: string;
      readonly closing: string;
      readonly difference: string;
    }
  | {
      readonly code: 'COMPONENT_DOES_NOT_ROLL_FORWARD';
      readonly component: string;
      readonly difference: string;
    }
  | {
      readonly code: 'DISAGREES_WITH_BALANCE_SHEET';
      readonly statementEquity: string;
      readonly balanceSheetEquity: string;
      readonly difference: string;
    };

export interface EquityStatementCheck {
  readonly consistent: boolean;
  readonly violations: readonly EquityViolation[];
}

/**
 * Whether the statement rolls forward, at the total and at every component.
 *
 * The component-level check is the one that earns its keep. A total that
 * happens to be right while two components are wrong in opposite directions is
 * exactly the failure a reader cannot see and a reviewer cannot catch by
 * eyeballing the bottom line.
 *
 * `balanceSheetEquity` — assets less liabilities at `periodEnd`, credit-positive
 * — ties the statement to the ledger rather than only to itself. Pass it
 * whenever it is available; a SOCE that agrees with nothing outside its own
 * arithmetic proves very little.
 */
export function checkEquityStatement(
  statement: EquityStatement,
  balanceSheetEquity?: Money,
): EquityStatementCheck {
  const violations: EquityViolation[] = [];

  const expected = statement.openingEquity
    .add(statement.profitForPeriod)
    .add(statement.otherMovements);
  const difference = statement.closingEquity.subtract(expected);

  if (!difference.isZero()) {
    violations.push({
      code: 'DOES_NOT_ROLL_FORWARD',
      opening: statement.openingEquity.toDecimalString(),
      profit: statement.profitForPeriod.toDecimalString(),
      otherMovements: statement.otherMovements.toDecimalString(),
      closing: statement.closingEquity.toDecimalString(),
      difference: difference.toDecimalString(),
    });
  }

  for (const component of statement.components) {
    const componentDifference = component.closing.subtract(
      component.opening.add(component.movement),
    );
    if (!componentDifference.isZero()) {
      violations.push({
        code: 'COMPONENT_DOES_NOT_ROLL_FORWARD',
        component: `${component.code} ${component.label}`,
        difference: componentDifference.toDecimalString(),
      });
    }
  }

  if (balanceSheetEquity !== undefined) {
    const gap = statement.closingEquity.subtract(balanceSheetEquity);
    if (!gap.isZero()) {
      violations.push({
        code: 'DISAGREES_WITH_BALANCE_SHEET',
        statementEquity: statement.closingEquity.toDecimalString(),
        balanceSheetEquity: balanceSheetEquity.toDecimalString(),
        difference: gap.toDecimalString(),
      });
    }
  }

  return { consistent: violations.length === 0, violations };
}
