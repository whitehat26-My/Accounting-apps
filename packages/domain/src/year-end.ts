/**
 * The year-end close — M1's last missing piece.
 *
 * ---------------------------------------------------------------------------
 * `RETAINED_EARNINGS` AND `YEAR_END_CLOSED` HAVE BEEN RESERVED SINCE M1 AND
 * USED BY NOTHING.
 *
 * The posting role is in the `posting_account_map` CHECK from 0002. The event
 * type is in the `financial_event_log` CHECK from 0012. `fiscal_year.status`
 * has accepted CLOSED since 0001. Not one line of code ever wrote any of them,
 * so an accounting product that has been able to post for nine milestones has
 * never been able to finish a year.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * WHAT CLOSING ACTUALLY DOES, AND THE ONE THING IT MUST NOT DO.
 *
 * Income and expense accounts measure a PERIOD. At the year end their balances
 * are transferred to retained earnings so the next year starts from zero, and
 * the transfer is an ordinary journal entry — every income account debited by
 * its credit balance, every expense account credited by its debit balance, and
 * the difference to retained earnings.
 *
 * What it must not do is CHANGE ANY REPORTED FIGURE. The profit for the year
 * just closed is the same before and after; all that moves is where it is
 * carried. `checkAccountingEquation` treats equity as equity accounts plus
 * unclosed profit precisely so the balance sheet is identical either side of
 * the close — and `closingCheck` below asserts that rather than trusting it.
 * ---------------------------------------------------------------------------
 *
 * Pure: balances are fetched by the caller and passed in.
 */

import { Money, sumMoney, type Currency } from './money.js';
import { err, ok, type Result } from './result.js';
import { isProfitOrLossAccount, type AccountType } from './account.js';
import type { JournalEntryDraft, JournalLineDraft } from './journal-entry.js';

/** One account's balance for the year being closed, DEBIT-POSITIVE. */
export interface ClosableBalance {
  readonly accountId: string;
  readonly code: string;
  readonly type: AccountType;
  readonly amount: Money;
}

export type YearEndViolation =
  | { readonly code: 'NO_RETAINED_EARNINGS_ACCOUNT' }
  | { readonly code: 'NOTHING_TO_CLOSE' }
  | {
      readonly code: 'RETAINED_EARNINGS_IS_NOT_EQUITY';
      readonly accountId: string;
    }
  | {
      readonly code: 'BALANCE_SHEET_ACCOUNT_IN_CLOSING_SET';
      readonly code_: string;
      readonly type: AccountType;
    };

export interface ClosingEntry {
  readonly draft: JournalEntryDraft;
  /** Profit for the year, CREDIT-POSITIVE. A loss is negative. */
  readonly profitForYear: Money;
  /** How many income and expense accounts were zeroed. */
  readonly accountsClosed: number;
}

export interface BuildClosingEntryOptions {
  /** The last day of the fiscal year. The entry is dated here, deliberately. */
  readonly yearEndDate: string;
  readonly yearLabel: string;
  readonly baseCurrency: Currency;
  readonly retainedEarningsAccountId: string | undefined;
  readonly retainedEarningsAccountType: AccountType | undefined;
  /** Every account with movement in the year, debit-positive. */
  readonly balances: readonly ClosableBalance[];
}

/**
 * Build the closing entry.
 *
 * Dated the LAST DAY of the year being closed, not the day the close is run.
 * A closing entry dated in the following year would move the profit out of the
 * year that earned it — the income statement for the closed year would still
 * be right, and every comparative that reads movement by date would not.
 */
export function buildClosingEntry(
  options: BuildClosingEntryOptions,
): Result<ClosingEntry, YearEndViolation[]> {
  const violations: YearEndViolation[] = [];
  const { baseCurrency } = options;

  if (!options.retainedEarningsAccountId) {
    // Refused rather than defaulted. There is no sensible fallback: posting a
    // year's profit to a suspense account produces a balanced ledger and a
    // balance sheet nobody can explain.
    violations.push({ code: 'NO_RETAINED_EARNINGS_ACCOUNT' });
  } else if (options.retainedEarningsAccountType !== 'EQUITY') {
    // Retained earnings is where a year's profit lives permanently. An account
    // of any other type would put it on the wrong statement forever.
    violations.push({
      code: 'RETAINED_EARNINGS_IS_NOT_EQUITY',
      accountId: options.retainedEarningsAccountId,
    });
  }

  const closing = options.balances.filter((b) => isProfitOrLossAccount(b.type));

  // The caller is expected to pass profit-and-loss accounts. A balance-sheet
  // account reaching here would be zeroed into retained earnings, which is not
  // a close — it is the destruction of an asset balance.
  for (const balance of options.balances) {
    if (!isProfitOrLossAccount(balance.type)) {
      violations.push({
        code: 'BALANCE_SHEET_ACCOUNT_IN_CLOSING_SET',
        code_: balance.code,
        type: balance.type,
      });
    }
  }

  if (violations.length > 0) return err(violations);

  const withBalance = closing.filter((b) => !b.amount.isZero());

  if (withBalance.length === 0) {
    // A year with no trading. Reported rather than closed with a zero-value
    // entry: an entry that moves nothing still consumes a document number an
    // auditor will later ask about, and the year can be marked closed without
    // one.
    return err([{ code: 'NOTHING_TO_CLOSE' }]);
  }

  /*
   * Each account is zeroed by posting its OPPOSITE.
   *
   * Balances arrive debit-positive, so an income account carrying a credit
   * balance is negative and is closed with a DEBIT; an expense account is
   * positive and is closed with a CREDIT. Expressing it as "post the negation"
   * rather than branching on account type means a P&L account that is
   * unusually signed — a contra-revenue account, a credited expense — closes
   * correctly with no special case.
   */
  const lines: JournalLineDraft[] = withBalance.map((balance) => {
    const closingAmount = balance.amount.negate();
    const side = closingAmount.isPositive() ? 'DEBIT' : 'CREDIT';
    const amount = closingAmount.abs();

    return {
      accountId: balance.accountId,
      side,
      amount,
      baseAmount: amount,
      description: `Year-end close ${options.yearLabel}`,
    };
  });

  // Debit-positive sum of the P&L accounts. A profit is a net credit, so this
  // is negative for a profitable year.
  const netProfitOrLoss = sumMoney(withBalance.map((b) => b.amount), baseCurrency);
  const retained = netProfitOrLoss.negate();

  // The balancing line. A profit CREDITS retained earnings.
  if (!retained.isZero()) {
    lines.push({
      accountId: options.retainedEarningsAccountId!,
      side: retained.isNegative() ? 'DEBIT' : 'CREDIT',
      amount: retained.abs(),
      baseAmount: retained.abs(),
      description: `Retained earnings, ${options.yearLabel}`,
    });
  }

  return ok({
    draft: {
      entryDate: options.yearEndDate,
      description: `Year-end close — ${options.yearLabel}`,
      sourceModule: 'SYSTEM',
      sourceDocumentType: 'YEAR_END_CLOSE',
      lines,
    },
    profitForYear: retained,
    accountsClosed: withBalance.length,
  });
}

/**
 * The check the close must pass, and the reason it exists.
 *
 * A close moves where profit is carried; it must not change what the profit
 * WAS. Asserted rather than assumed, the same treatment every other ledger
 * invariant gets — a close that quietly restates a year is the kind of error
 * that is found by a client, a year later, in a comparative column.
 */
export interface ClosingCheck {
  readonly consistent: boolean;
  readonly violations: readonly string[];
}

export function checkClosingEntry(
  entry: ClosingEntry,
  balancesBefore: readonly ClosableBalance[],
  baseCurrency: Currency,
): ClosingCheck {
  const violations: string[] = [];

  const debits = sumMoney(
    entry.draft.lines.filter((l) => l.side === 'DEBIT').map((l) => l.baseAmount),
    baseCurrency,
  );
  const credits = sumMoney(
    entry.draft.lines.filter((l) => l.side === 'CREDIT').map((l) => l.baseAmount),
    baseCurrency,
  );

  if (!debits.equals(credits)) {
    violations.push(
      `The closing entry does not balance: debits ${debits.toDecimalString()}, ` +
        `credits ${credits.toDecimalString()}`,
    );
  }

  const profitBefore = sumMoney(
    balancesBefore.filter((b) => isProfitOrLossAccount(b.type)).map((b) => b.amount),
    baseCurrency,
  ).negate();

  if (!entry.profitForYear.equals(profitBefore)) {
    violations.push(
      `The amount transferred to retained earnings (${entry.profitForYear.toDecimalString()}) ` +
        `is not the profit for the year (${profitBefore.toDecimalString()})`,
    );
  }

  /*
   * Every profit-and-loss account with a balance must appear exactly once.
   *
   * Missing one leaves a balance behind that next year's income statement
   * counts as if it were earned then. Including one twice zeroes it and then
   * reverses it into a balance nobody expects. Both are silent.
   */
  const closingIds = entry.draft.lines.map((l) => l.accountId);
  for (const balance of balancesBefore) {
    if (!isProfitOrLossAccount(balance.type) || balance.amount.isZero()) continue;

    const appearances = closingIds.filter((id) => id === balance.accountId).length;
    if (appearances !== 1) {
      violations.push(
        `Account ${balance.code} appears ${appearances} times in the closing entry; expected once`,
      );
    }
  }

  return { consistent: violations.length === 0, violations };
}
