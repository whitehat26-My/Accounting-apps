/**
 * The statement of cash flows — the third primary statement, and the one that
 * was missing.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DIRECT METHOD, DERIVED FROM ACTUAL CASH MOVEMENTS.
 *
 * The indirect method starts from profit and adjusts it: add back depreciation,
 * subtract the increase in receivables, add the increase in payables, and so
 * on. It is the presentation most textbooks teach, and it is the wrong thing to
 * COMPUTE, because every adjustment is a separate opportunity to be subtly
 * wrong — non-cash revaluation, credit notes, accruals, provisions, a
 * disposal's gain sitting in income while its proceeds are investing. A
 * reconstructed statement that is off by RM 4,700 gives no clue which of a
 * dozen adjustments is the culprit.
 *
 * This module instead reads the CASH ACCOUNTS THEMSELVES and asks, of each
 * movement, what the other side of the entry was. That is the direct method,
 * and it has a property the indirect method does not:
 *
 *     BECAUSE EVERY JOURNAL ENTRY BALANCES, THE CASH MOVEMENT OF AN ENTRY IS
 *     EXACTLY THE NEGATED SUM OF ITS NON-CASH LINES.
 *
 * So decomposing an entry's cash movement across its contra accounts is not an
 * apportionment or an estimate — it is an identity. Sum the decomposition and
 * you get back the cash movement, to the cent, every time. The reconciliation
 * `opening cash + net cash flow = closing cash` therefore holds BY
 * CONSTRUCTION, and when it does not, the cause is a real defect (a missing
 * line, an unbalanced entry, rollup drift) rather than a modelling
 * approximation. That is worth more than matching the textbook layout.
 *
 * A statement that presents as indirect can still be produced later FROM this
 * decomposition. Deriving the harder presentation from the exact computation is
 * the right direction; the reverse is not.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE REFUSES TO GUESS.
 *
 * Whether an account's movements are OPERATING, INVESTING or FINANCING is a
 * judgement about the business, not a fact derivable from a chart of accounts.
 * Income and expense are operating; equity is financing; those are safe. But an
 * ASSET might be a receivable (operating) or a lorry (investing), and a
 * LIABILITY might be a trade payable (operating) or a term loan (financing) —
 * and `account.type` cannot tell them apart.
 *
 * So unclassified accounts are NOT quietly defaulted into operating, which is
 * the standard shortcut and which produces an operating cash flow figure that
 * is wrong in exactly the way a lender reading it would care about. They go
 * into a visible UNCLASSIFIED section that still counts toward the total — so
 * the statement reconciles, the reader can see precisely which accounts need a
 * decision, and nothing is silently absorbed. Same discipline as
 * `evaluateReport` refusing to drop an unmapped account.
 * ---------------------------------------------------------------------------
 *
 * Pure: journal lines, the cash pool and the classification map are all passed
 * in by the caller.
 */

import { Money, sumMoney, type Currency } from './money.js';
import type { AccountType } from './account.js';

/** The three activities MPERS §7 and MFRS 107 require a cash flow split by. */
export type CashFlowActivity = 'OPERATING' | 'INVESTING' | 'FINANCING';

/** An activity, or the honest admission that nobody has decided yet. */
export type CashFlowClassification = CashFlowActivity | 'UNCLASSIFIED';

export const CASH_FLOW_ACTIVITIES: readonly CashFlowActivity[] = [
  'OPERATING',
  'INVESTING',
  'FINANCING',
];

/**
 * Tags that carry an unambiguous classification.
 *
 * These are the ones where the tag's MEANING settles the question: something
 * labelled a trade receivable is operating by definition of the label, not by
 * inference. Anything less certain is left to explicit configuration.
 */
const TAG_ACTIVITY: Readonly<Record<string, CashFlowActivity>> = {
  trade_receivables: 'OPERATING',
  trade_payables: 'OPERATING',
  ap_revaluation: 'OPERATING',
};

export interface CashFlowAccount {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly tags: readonly string[];
}

/**
 * A journal entry that touched cash, with ALL of its lines.
 *
 * All of them, not just the non-cash ones: the balance identity this module
 * relies on is only true for a complete entry, and `checkCashFlow` verifies it
 * rather than assuming the caller obeyed.
 *
 * `amount` is DEBIT-POSITIVE and in the base currency, matching every other
 * amount in the reporting layer.
 */
export interface CashFlowEntryLine {
  readonly accountId: string;
  readonly amount: Money;
}

export interface CashFlowEntry {
  readonly entryId: string;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly description?: string;
  readonly lines: readonly CashFlowEntryLine[];
}

export interface CashFlowLine {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  /** Cash effect. INFLOW POSITIVE — the way a reader expects to see it. */
  readonly amount: Money;
  readonly entryCount: number;
}

export interface CashFlowSection {
  readonly activity: CashFlowClassification;
  readonly lines: readonly CashFlowLine[];
  readonly subtotal: Money;
}

export interface CashFlowStatement {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: Currency;
  readonly sections: readonly CashFlowSection[];
  /** Sum of every section, including UNCLASSIFIED. */
  readonly netCashFlow: Money;
  readonly openingCash: Money;
  readonly closingCash: Money;
  /** Entries that moved cash in the period. */
  readonly entryCount: number;
  /** Accounts that reached the statement with no classification decision. */
  readonly unclassifiedAccounts: readonly { code: string; name: string }[];
}

/**
 * Which activity an account's movements belong to.
 *
 * Resolution order, most specific first:
 *
 *   1. An explicit per-account decision the tenant recorded.
 *   2. A tag whose meaning settles it (see TAG_ACTIVITY).
 *   3. The account type, where the type alone is conclusive.
 *   4. UNCLASSIFIED — stated, never assumed.
 */
export function classifyAccount(
  account: CashFlowAccount,
  overrides: ReadonlyMap<string, CashFlowActivity>,
): CashFlowClassification {
  const explicit = overrides.get(account.accountId);
  if (explicit) return explicit;

  for (const tag of account.tags) {
    const fromTag = TAG_ACTIVITY[tag];
    if (fromTag) return fromTag;
  }

  switch (account.type) {
    case 'INCOME':
    case 'EXPENSE':
      // Trading activity. This is what operating cash flow means.
      return 'OPERATING';

    case 'EQUITY':
      // Capital introduced, drawings, dividends. Financing by definition.
      return 'FINANCING';

    case 'ASSET':
    case 'LIABILITY':
      // A receivable and a lorry are both assets; a trade payable and a term
      // loan are both liabilities. The type does not decide it, so nothing
      // here pretends to.
      return 'UNCLASSIFIED';
  }
}

export interface BuildCashFlowOptions {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly baseCurrency: Currency;
  /** Cash and cash equivalents, treated as ONE pool — see below. */
  readonly cashAccountIds: ReadonlySet<string>;
  readonly accounts: ReadonlyMap<string, CashFlowAccount>;
  readonly overrides: ReadonlyMap<string, CashFlowActivity>;
  readonly entries: readonly CashFlowEntry[];
  readonly openingCash: Money;
  readonly closingCash: Money;
}

/**
 * Build the statement.
 *
 * Cash and cash equivalents are ONE POOL. A transfer between two bank accounts
 * therefore has no non-cash lines and contributes nothing — which is correct,
 * and is the classic way a hand-built cash flow statement doubles a business's
 * apparent operating inflow when money is swept between accounts.
 */
export function buildCashFlowStatement(options: BuildCashFlowOptions): CashFlowStatement {
  const { baseCurrency, cashAccountIds, accounts, overrides } = options;

  interface Bucket {
    activity: CashFlowClassification;
    account: CashFlowAccount;
    amounts: Money[];
    entries: Set<string>;
  }

  const buckets = new Map<string, Bucket>();
  const movingEntries = new Set<string>();

  for (const entry of options.entries) {
    let touchedCash = false;

    for (const line of entry.lines) {
      if (cashAccountIds.has(line.accountId)) {
        if (!line.amount.isZero()) touchedCash = true;
        continue;
      }

      const account = accounts.get(line.accountId);
      if (!account) {
        // The caller is expected to supply every account its own lines
        // reference. Missing one is a bug in the query, not user data.
        throw new Error(
          `Cash flow: journal entry ${entry.entryNo} references unknown account ${line.accountId}`,
        );
      }

      const bucket = buckets.get(line.accountId) ?? {
        activity: classifyAccount(account, overrides),
        account,
        amounts: [],
        entries: new Set<string>(),
      };

      // The identity: cash moved by the negation of what the other side did.
      // A credit to revenue (negative, debit-positive) is a cash INFLOW.
      bucket.amounts.push(line.amount.negate());
      bucket.entries.add(entry.entryId);
      buckets.set(line.accountId, bucket);
    }

    if (touchedCash) movingEntries.add(entry.entryId);
  }

  const sectionFor = (activity: CashFlowClassification): CashFlowSection => {
    const lines = [...buckets.values()]
      .filter((b) => b.activity === activity)
      .map((b) => ({
        accountId: b.account.accountId,
        code: b.account.code,
        name: b.account.name,
        amount: sumMoney(b.amounts, baseCurrency),
        entryCount: b.entries.size,
      }))
      // A contra account whose movements net to nothing over the period is
      // noise on a statement, not information.
      .filter((l) => !l.amount.isZero())
      .sort((a, b) => a.code.localeCompare(b.code));

    return {
      activity,
      lines,
      subtotal: sumMoney(lines.map((l) => l.amount), baseCurrency),
    };
  };

  const sections = [...CASH_FLOW_ACTIVITIES, 'UNCLASSIFIED' as const].map(sectionFor);

  return {
    periodStart: options.periodStart,
    periodEnd: options.periodEnd,
    currency: baseCurrency,
    sections,
    netCashFlow: sumMoney(sections.map((s) => s.subtotal), baseCurrency),
    openingCash: options.openingCash,
    closingCash: options.closingCash,
    entryCount: movingEntries.size,
    unclassifiedAccounts: [...buckets.values()]
      .filter((b) => b.activity === 'UNCLASSIFIED')
      .filter((b) => !sumMoney(b.amounts, baseCurrency).isZero())
      .map((b) => ({ code: b.account.code, name: b.account.name }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  };
}

export type CashFlowViolation =
  | {
      readonly code: 'DOES_NOT_RECONCILE';
      readonly opening: string;
      readonly netCashFlow: string;
      readonly closing: string;
      readonly difference: string;
    }
  | { readonly code: 'UNBALANCED_ENTRY'; readonly entryNo: string; readonly difference: string }
  | { readonly code: 'UNCLASSIFIED_MOVEMENT'; readonly accounts: readonly string[] };

export interface CashFlowCheck {
  readonly reconciles: boolean;
  readonly difference: Money;
  readonly violations: readonly CashFlowViolation[];
}

/**
 * The check the whole module exists to be able to pass.
 *
 * `opening + net cash flow = closing` is the cash flow statement's equivalent
 * of invariant #3, and it is asserted rather than assumed for the same reason:
 * a statement that does not reconcile is worthless, and one that does not
 * reconcile SILENTLY is worse than worthless.
 *
 * An unclassified movement is reported as a violation but does NOT break
 * reconciliation — the money is still in the total, it is just in a section
 * labelled honestly. The distinction matters: the statement is arithmetically
 * sound and presentationally incomplete, and conflating the two would either
 * block a usable statement or hide a real gap.
 */
export function checkCashFlow(
  statement: CashFlowStatement,
  entries: readonly CashFlowEntry[],
): CashFlowCheck {
  const violations: CashFlowViolation[] = [];
  const currency = statement.currency;

  const expectedClosing = statement.openingCash.add(statement.netCashFlow);
  const difference = statement.closingCash.subtract(expectedClosing);

  if (!difference.isZero()) {
    violations.push({
      code: 'DOES_NOT_RECONCILE',
      opening: statement.openingCash.toDecimalString(),
      netCashFlow: statement.netCashFlow.toDecimalString(),
      closing: statement.closingCash.toDecimalString(),
      difference: difference.toDecimalString(),
    });
  }

  // The identity the decomposition rests on. Checked against the entries as
  // supplied, because a query that filtered lines would silently break it and
  // the resulting statement would still look plausible.
  for (const entry of entries) {
    const net = sumMoney(entry.lines.map((l) => l.amount), currency);
    if (!net.isZero()) {
      violations.push({
        code: 'UNBALANCED_ENTRY',
        entryNo: entry.entryNo,
        difference: net.toDecimalString(),
      });
    }
  }

  if (statement.unclassifiedAccounts.length > 0) {
    violations.push({
      code: 'UNCLASSIFIED_MOVEMENT',
      accounts: statement.unclassifiedAccounts.map((a) => `${a.code} ${a.name}`),
    });
  }

  return {
    reconciles: difference.isZero(),
    difference,
    violations,
  };
}

/**
 * Cash generated from operations, stated on its own.
 *
 * The single figure a lender, a buyer or a director looks at first, and the one
 * a statement that quietly dumped unclassified movements into operating would
 * misstate. Returned with the unclassified amount alongside, so its reliability
 * is visible rather than implied.
 */
export function operatingCashFlow(statement: CashFlowStatement): {
  readonly amount: Money;
  readonly unclassified: Money;
  readonly complete: boolean;
} {
  const find = (activity: CashFlowClassification) =>
    statement.sections.find((s) => s.activity === activity)?.subtotal ??
    Money.zero(statement.currency);

  const unclassified = find('UNCLASSIFIED');

  return {
    amount: find('OPERATING'),
    unclassified,
    complete: unclassified.isZero(),
  };
}
