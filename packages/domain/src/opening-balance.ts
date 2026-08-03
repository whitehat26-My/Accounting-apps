import { Money, type Currency } from './money.js';
import { err, ok, type Result } from './result.js';
import type { AccountType } from './account.js';
import type { JournalLineDraft } from './journal-entry.js';

/**
 * Opening balances — where the shop stood the day it started using this.
 *
 * ---------------------------------------------------------------------------
 * A SET OF BOOKS THAT BEGINS AT ZERO IS WRONG FROM ITS FIRST DAY.
 *
 * Nobody starts a business on the day they start an accounting system. There
 * is already money in the bank, stock on the shelf, a van outside and a loan
 * against it. Until those are stated, every report is a report of the last few
 * weeks pretending to be the whole business.
 *
 * The mechanism is the oldest one in bookkeeping: state each real balance, and
 * let the difference fall to an equity account — "Opening Balances". That
 * account is the accumulated worth the shop brought with it, and it is a
 * balancing figure BY CONSTRUCTION rather than a plug typed by hand. This
 * module computes it and never asks for it.
 * ---------------------------------------------------------------------------
 *
 * Pure: no IO, no database, no clock. The caller resolves account ids and
 * posts the result through `LedgerService.post()` like every other entry.
 */

/**
 * Roles whose balance is NOT the ledger's to state directly.
 *
 * ---------------------------------------------------------------------------
 * THE REFUSALS ARE THE FEATURE, NOT A MISSING CAPABILITY.
 *
 * Receivables, payables and inventory are CONTROL accounts: their balance is
 * the sum of a subledger, and the system checks that continuously —
 * invariant #6 (AR control equals the open-invoice subledger), its payables
 * twin, and the stock check (inventory account equals the sum of on-hand
 * value). A lump sum posted straight to any of them balances the entry and
 * breaks the invariant in the same instant, and the breakage is then
 * permanent and unattributable: there is no invoice to settle, no bill to pay,
 * no item to sell.
 *
 * So each is refused BY NAME, with the route that does it properly:
 *   - money customers owe → enter each unpaid invoice on Sales
 *   - money owed to suppliers → enter each unpaid bill on Purchases
 *   - stock on the shelf → a stock adjustment per item, which is also the
 *     only way to establish a weighted-average cost
 *
 * Longer to do, and the only version that leaves the shop able to settle an
 * individual invoice afterwards.
 * ---------------------------------------------------------------------------
 */
export const CONTROLLED_ROLES = ['AR', 'AP', 'INVENTORY'] as const;
export type ControlledRole = (typeof CONTROLLED_ROLES)[number];

export const CONTROLLED_ROLE_GUIDANCE: Record<ControlledRole, string> = {
  AR: 'Money customers already owe you is entered as the unpaid invoices themselves, on the Sales screen — otherwise there is no invoice to settle when they pay.',
  AP: 'Money you already owe suppliers is entered as the unpaid bills themselves, on the Purchases screen — otherwise there is no bill to pay.',
  INVENTORY:
    'Stock already on the shelf is entered as a stock adjustment per item, on the Stock screen — that is also what establishes each item’s average cost, which the first sale needs.',
};

export interface OpeningBalanceLine {
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: AccountType;
  /**
   * What the account is worth, stated the natural way round: positive is what
   * the shop HAS for an asset and what it OWES for a liability. The debit or
   * credit side is derived from the account type, because "is a bank overdraft
   * a debit or a credit" is not a question to ask a shop owner.
   */
  readonly amount: Money;
  /** Set when this account carries a control role — refused, with guidance. */
  readonly controlledRole?: ControlledRole;
}

export interface OpeningBalanceInput {
  readonly asOfDate: string;
  readonly baseCurrency: Currency;
  /** The account the balancing figure lands in — equity, by construction. */
  readonly openingEquityAccountId: string;
  readonly lines: readonly OpeningBalanceLine[];
}

export type OpeningBalanceViolation =
  | { code: 'NO_BALANCES'; message: string }
  | { code: 'CONTROLLED_ACCOUNT'; accountCode: string; role: ControlledRole; message: string }
  | { code: 'ZERO_AMOUNT'; accountCode: string; message: string }
  | { code: 'EQUITY_ACCOUNT_LISTED'; message: string };

export interface OpeningBalanceJournal {
  readonly entryDate: string;
  readonly description: string;
  readonly lines: readonly JournalLineDraft[];
  /**
   * What fell to equity, and which way.
   *
   * Surfaced rather than buried: a shop owner who states RM 20,000 of assets
   * and RM 5,000 of loans should see "RM 15,000 credited to Opening Balances"
   * and recognise it as roughly what the business is worth. A figure they
   * cannot recognise means they mistyped something, and this is the only
   * moment that is cheap to notice.
   */
  readonly balancingFigure: Money;
  readonly balancingSide: 'DEBIT' | 'CREDIT';
}

/**
 * An asset is a debit balance; a liability or equity is a credit balance.
 *
 * Income and expense are refused implicitly by having no natural opening
 * balance: last year's trading is closed into retained earnings, not carried
 * forward line by line.
 */
function naturalSide(type: AccountType): 'DEBIT' | 'CREDIT' | null {
  switch (type) {
    case 'ASSET':
      return 'DEBIT';
    case 'LIABILITY':
    case 'EQUITY':
      return 'CREDIT';
    default:
      return null;
  }
}

export function buildOpeningJournal(
  input: OpeningBalanceInput,
): Result<OpeningBalanceJournal, OpeningBalanceViolation[]> {
  const violations: OpeningBalanceViolation[] = [];
  const stated = input.lines.filter((line) => !line.amount.isZero());

  if (stated.length === 0) {
    violations.push({
      code: 'NO_BALANCES',
      message: 'Nothing was stated, so there is no opening position to record.',
    });
  }

  for (const line of stated) {
    if (line.controlledRole) {
      violations.push({
        code: 'CONTROLLED_ACCOUNT',
        accountCode: line.accountCode,
        role: line.controlledRole,
        message: `${line.accountCode} ${line.accountName} is a control account. ${CONTROLLED_ROLE_GUIDANCE[line.controlledRole]}`,
      });
      continue;
    }

    if (line.accountId === input.openingEquityAccountId) {
      violations.push({
        code: 'EQUITY_ACCOUNT_LISTED',
        message:
          'Opening Balances is the account the difference falls into, so it cannot also be ' +
          'stated as a balance — that would make it a plug rather than a result.',
      });
      continue;
    }

    if (naturalSide(line.accountType) === null) {
      violations.push({
        code: 'ZERO_AMOUNT',
        accountCode: line.accountCode,
        message:
          `${line.accountCode} ${line.accountName} is an income or expense account. Last ` +
          'year’s trading is carried forward as accumulated profit, never line by line.',
      });
    }
  }

  if (violations.length > 0) return err(violations);

  // Both sides are accumulated as Money — the balancing figure is the
  // difference between them, never a number typed by a person.
  const zero = Money.zero(input.baseCurrency);
  let debits = zero;
  let credits = zero;

  const lines: JournalLineDraft[] = stated.map((line) => {
    const side = naturalSide(line.accountType)!;
    const amount = line.amount.abs();
    // A negatively-stated asset (an overdrawn bank account) is a credit, and
    // vice versa — the sign flips the side rather than producing a negative
    // amount, which `validateJournalEntry` refuses outright.
    const flipped = line.amount.isNegative();
    const actualSide: 'DEBIT' | 'CREDIT' =
      flipped ? (side === 'DEBIT' ? 'CREDIT' : 'DEBIT') : side;

    if (actualSide === 'DEBIT') debits = debits.add(amount);
    else credits = credits.add(amount);

    return {
      accountId: line.accountId,
      side: actualSide,
      amount,
      baseAmount: amount,
      description: `Opening balance — ${line.accountName}`,
    };
  });

  const difference = debits.subtract(credits);
  const balancingSide: 'DEBIT' | 'CREDIT' = difference.isNegative() ? 'DEBIT' : 'CREDIT';
  const balancingFigure = difference.abs();

  if (!balancingFigure.isZero()) {
    lines.push({
      accountId: input.openingEquityAccountId,
      side: balancingSide,
      amount: balancingFigure,
      baseAmount: balancingFigure,
      description: 'Opening balance — accumulated worth brought forward',
    });
  }

  return ok({
    entryDate: input.asOfDate,
    description: `Opening balances as at ${input.asOfDate}`,
    lines,
    balancingFigure,
    balancingSide,
  });
}
