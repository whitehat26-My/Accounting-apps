/**
 * Bank reconciliation arithmetic — M4.
 *
 * The question this answers is the one an auditor asks first: does the book
 * balance agree with the bank, and if not, exactly which items explain the
 * difference? A reconciliation that reports a variance without naming the
 * items causing it is not evidence of anything.
 *
 * ---------------------------------------------------------------------------
 * THE TWO SIDES ARE NOT SYMMETRIC, AND CONFLATING THEM IS THE CLASSIC ERROR.
 *
 * An unmatched item can be unmatched for two quite different reasons:
 *
 *  - **In the books, not on the statement.** A cheque written and posted that
 *    the payee has not banked; a deposit recorded on the 31st that clears on
 *    the 1st. The ledger is right and the bank will catch up. These are
 *    *timing differences*.
 *
 *  - **On the statement, not in the books.** A bank charge, interest, a direct
 *    debit nobody told accounts about. The BANK is right and the ledger is
 *    missing an entry. These require a journal, not patience.
 *
 * The first needs no action. The second is unposted expense sitting in a
 * reconciliation screen. Treating them as one pool of "unmatched items" hides
 * the second behind the first, which is how bank charges go unrecorded for a
 * year.
 * ---------------------------------------------------------------------------
 *
 * Pure: balances and item lists come in already fetched, so the arithmetic —
 * the part with a right answer — is property-testable without a database.
 */

import { Money, sumMoney, type Currency } from './money.js';

/** A statement line or a ledger movement, as the reconciliation sees it. */
export interface ReconciliationItem {
  readonly id: string;
  readonly date: string;
  /** Signed: positive money in, negative money out. */
  readonly amount: Money;
  readonly description: string;
}

export interface ReconciliationInput {
  readonly asOfDate: string;
  readonly baseCurrency: Currency;
  /** The bank account's opening balance, as configured when it was created. */
  readonly openingBalance: Money;
  /** Closing balance per the BANK's own statement. */
  readonly statementClosingBalance: Money;
  /** The GL bank account balance at `asOfDate`. */
  readonly bookBalance: Money;
  /** Statement lines matched to a ledger entry. */
  readonly reconciled: readonly ReconciliationItem[];
  /** On the statement, absent from the books — bank charges, interest, unknown debits. */
  readonly unreconciledStatementItems: readonly ReconciliationItem[];
  /** In the books, absent from the statement — unpresented cheques, deposits in transit. */
  readonly unpresentedBookItems: readonly ReconciliationItem[];
}

export interface ReconciliationResult {
  readonly asOfDate: string;
  /** Statement closing, adjusted for items the bank has not seen yet. */
  readonly adjustedBankBalance: Money;
  /** Book balance, adjusted for items the books have not recorded yet. */
  readonly adjustedBookBalance: Money;
  /** Zero when the account reconciles. Anything else is unexplained. */
  readonly variance: Money;
  readonly reconciles: boolean;
  /** Money out per the books that has not reached the bank. Reported positive. */
  readonly unpresentedPayments: Money;
  /** Money in per the books that has not reached the bank. Reported positive. */
  readonly depositsInTransit: Money;
  /**
   * Statement movement with no ledger entry behind it. This is the number that
   * needs someone to DO something — usually post a bank charge.
   */
  readonly unrecordedBankMovement: Money;
  readonly reconciledTotal: Money;
  readonly counts: {
    readonly reconciled: number;
    readonly unreconciledStatementItems: number;
    readonly unpresentedBookItems: number;
  };
}

/**
 * Reconcile a bank account at a date.
 *
 * Both sides are adjusted towards each other and the residue is the variance:
 *
 *   statement closing + (book items the bank has not seen)  = adjusted bank
 *   book balance      + (statement items the books have not) = adjusted book
 *
 * A non-zero variance is not a rounding artefact and must never be presented
 * as one — every legitimate timing difference is already accounted for by the
 * two adjustments, so what remains is a missing item, a duplicate, or a wrong
 * amount.
 */
export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const currency = input.baseCurrency;
  const zero = Money.zero(currency);

  const unpresentedTotal = sumMoney(
    input.unpresentedBookItems.map((i) => i.amount),
    currency,
  );
  const unrecordedTotal = sumMoney(
    input.unreconciledStatementItems.map((i) => i.amount),
    currency,
  );
  const reconciledTotal = sumMoney(
    input.reconciled.map((i) => i.amount),
    currency,
  );

  const adjustedBankBalance = input.statementClosingBalance.add(unpresentedTotal);
  const adjustedBookBalance = input.bookBalance.add(unrecordedTotal);
  const variance = adjustedBankBalance.subtract(adjustedBookBalance);

  const unpresentedPayments = sumMoney(
    input.unpresentedBookItems.filter((i) => i.amount.isNegative()).map((i) => i.amount),
    currency,
  ).abs();

  const depositsInTransit = sumMoney(
    input.unpresentedBookItems.filter((i) => i.amount.isPositive()).map((i) => i.amount),
    currency,
  );

  return {
    asOfDate: input.asOfDate,
    adjustedBankBalance,
    adjustedBookBalance,
    variance,
    reconciles: variance.isZero(),
    unpresentedPayments,
    depositsInTransit,
    unrecordedBankMovement: unrecordedTotal,
    reconciledTotal: reconciledTotal.add(zero),
    counts: {
      reconciled: input.reconciled.length,
      unreconciledStatementItems: input.unreconciledStatementItems.length,
      unpresentedBookItems: input.unpresentedBookItems.length,
    },
  };
}

export interface InvariantEightResult {
  readonly expected: Money;
  readonly actual: Money;
  readonly difference: Money;
  readonly holds: boolean;
}

/**
 * Ledger invariant #8: bank GL balance = opening + reconciled transactions.
 *
 * ---------------------------------------------------------------------------
 * This only holds when the account is FULLY reconciled — nothing outstanding
 * on either side. That precondition is the honest statement of the invariant,
 * and asserting it without the precondition is why a naive version of this
 * check fails on every real account: there is almost always a cheque in the
 * post.
 *
 * `fullyReconciled` therefore has to be established by the caller from the
 * counts in `ReconciliationResult`, not assumed here.
 * ---------------------------------------------------------------------------
 */
export function checkInvariantEight(
  openingBalance: Money,
  reconciledTransactions: readonly Money[],
  bookBalance: Money,
  currency: Currency,
): InvariantEightResult {
  const expected = openingBalance.add(sumMoney(reconciledTransactions, currency));
  const difference = bookBalance.subtract(expected);

  return {
    expected,
    actual: bookBalance,
    difference,
    holds: difference.isZero(),
  };
}

/**
 * What a bank rule does to a statement line it matches.
 *
 * Rules are the "if the narrative contains TNB, code it to Utilities" feature.
 * They are evaluated in priority order, first match wins, and — like the
 * matching engine — they SUGGEST by default. `autoApply` exists but is per
 * rule and off unless the user turns it on, because a rule that silently posts
 * to the wrong account is a rule nobody notices for months.
 */
export interface BankRule {
  readonly id: string;
  readonly priority: number;
  readonly contains?: string;
  readonly matchesDirection?: 'INFLOW' | 'OUTFLOW';
  readonly minAmount?: Money;
  readonly maxAmount?: Money;
  readonly accountId: string;
  readonly taxCodeId?: string;
  readonly contactId?: string;
  readonly autoApply: boolean;
}

export interface RuleMatch {
  readonly rule: BankRule;
  readonly reason: string;
}

/**
 * The first rule that matches a statement line, by priority.
 *
 * Ties on priority are broken by id so the outcome is deterministic — two
 * rules at priority 10 must not code a line differently depending on the order
 * the database happened to return them.
 */
export function firstMatchingRule(
  item: { description: string; amount: Money },
  rules: readonly BankRule[],
): RuleMatch | null {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const haystack = item.description.toUpperCase();
  const direction = item.amount.isNegative() ? 'OUTFLOW' : 'INFLOW';

  for (const rule of ordered) {
    if (rule.matchesDirection !== undefined && rule.matchesDirection !== direction) continue;

    const needle = rule.contains?.toUpperCase();
    if (needle !== undefined && needle.length > 0 && !haystack.includes(needle)) continue;

    const magnitude = item.amount.abs();
    if (rule.minAmount !== undefined && magnitude.compare(rule.minAmount) < 0) continue;
    if (rule.maxAmount !== undefined && magnitude.compare(rule.maxAmount) > 0) continue;

    const conditions: string[] = [];
    if (needle) conditions.push(`the narrative contains "${rule.contains}"`);
    if (rule.matchesDirection) {
      conditions.push(rule.matchesDirection === 'OUTFLOW' ? 'it is money out' : 'it is money in');
    }
    if (rule.minAmount || rule.maxAmount) conditions.push('the amount is in range');

    return {
      rule,
      reason:
        conditions.length > 0
          ? `Bank rule matched because ${conditions.join(' and ')}`
          : 'Bank rule matched (no conditions set — it applies to every line)',
    };
  }

  return null;
}
