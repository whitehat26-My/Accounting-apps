/**
 * The double-entry journal — the correctness core of the product.
 *
 * Two structural decisions worth stating explicitly:
 *
 * 1. A line carries a `side` and a positive `amount`, not separate `debit` and
 *    `credit` fields. The database has both columns (with a CHECK constraint),
 *    but in the domain the invariant "exactly one of debit/credit is non-zero"
 *    is made unrepresentable rather than merely validated. Mapping happens at
 *    the repository boundary.
 *
 * 2. Validation returns a `Result` with ALL violations, not the first one. An
 *    accountant fixing a 40-line journal should see every problem at once.
 */

import { Money, sumMoney, type Currency } from './money.js';
import { err, ok, type Result } from './result.js';

export type EntrySide = 'DEBIT' | 'CREDIT';

export interface JournalLineDraft {
  readonly accountId: string;
  readonly side: EntrySide;
  /** Amount in the transaction currency. Must be strictly positive. */
  readonly amount: Money;
  /**
   * Amount converted to the tenant's base currency (MYR). For a base-currency
   * transaction this equals `amount`. The ledger balances in BASE currency —
   * a multi-currency entry need not balance in each transaction currency.
   */
  readonly baseAmount: Money;
  readonly description?: string;
  readonly contactId?: string;
  readonly taxCodeId?: string;
  readonly trackingOptionId?: string;
}

export interface JournalEntryDraft {
  /** Calendar date, no timezone — an invoice date is not an instant. */
  readonly entryDate: string; // YYYY-MM-DD
  readonly description?: string;
  readonly sourceModule: SourceModule;
  readonly sourceDocumentType?: string;
  readonly sourceDocumentId?: string;
  readonly lines: readonly JournalLineDraft[];
}

export type SourceModule =
  | 'SALES'
  | 'PURCHASES'
  | 'BANKING'
  | 'MANUAL'
  | 'SYSTEM';

/** A draft that has passed every structural check and is safe to post. */
export interface ValidatedJournalEntry extends JournalEntryDraft {
  readonly _validated: true;
  readonly baseCurrency: Currency;
  readonly totalDebit: Money;
  readonly totalCredit: Money;
}

export type JournalEntryViolation =
  | { readonly code: 'NO_LINES' }
  | { readonly code: 'SINGLE_LINE' }
  | { readonly code: 'UNBALANCED'; readonly debit: string; readonly credit: string; readonly difference: string }
  | { readonly code: 'NON_POSITIVE_AMOUNT'; readonly lineIndex: number; readonly amount: string }
  | { readonly code: 'NON_POSITIVE_BASE_AMOUNT'; readonly lineIndex: number; readonly amount: string }
  | { readonly code: 'MIXED_BASE_CURRENCY'; readonly expected: Currency; readonly found: Currency; readonly lineIndex: number }
  | { readonly code: 'MISSING_ACCOUNT'; readonly lineIndex: number }
  | { readonly code: 'INVALID_ENTRY_DATE'; readonly value: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a draft entry. Returns every violation found, not just the first.
 *
 * The balance check runs in BASE currency. A payment of USD 1,000 settling an
 * invoice raised at a different rate produces an FX gain/loss line; the entry
 * balances in MYR but deliberately does not balance in USD.
 */
export function validateJournalEntry(
  draft: JournalEntryDraft,
  baseCurrency: Currency,
): Result<ValidatedJournalEntry, JournalEntryViolation[]> {
  const violations: JournalEntryViolation[] = [];

  if (!ISO_DATE.test(draft.entryDate) || Number.isNaN(Date.parse(draft.entryDate))) {
    violations.push({ code: 'INVALID_ENTRY_DATE', value: draft.entryDate });
  }

  if (draft.lines.length === 0) {
    violations.push({ code: 'NO_LINES' });
    return err(violations);
  }
  if (draft.lines.length === 1) {
    violations.push({ code: 'SINGLE_LINE' });
  }

  draft.lines.forEach((line, index) => {
    if (!line.accountId) {
      violations.push({ code: 'MISSING_ACCOUNT', lineIndex: index });
    }
    if (!line.amount.isPositive()) {
      violations.push({
        code: 'NON_POSITIVE_AMOUNT',
        lineIndex: index,
        amount: line.amount.toDecimalString(),
      });
    }
    if (!line.baseAmount.isPositive()) {
      violations.push({
        code: 'NON_POSITIVE_BASE_AMOUNT',
        lineIndex: index,
        amount: line.baseAmount.toDecimalString(),
      });
    }
    if (line.baseAmount.currency !== baseCurrency) {
      violations.push({
        code: 'MIXED_BASE_CURRENCY',
        expected: baseCurrency,
        found: line.baseAmount.currency,
        lineIndex: index,
      });
    }
  });

  // Only meaningful once every line is denominated in the base currency.
  const currencyConsistent = draft.lines.every((l) => l.baseAmount.currency === baseCurrency);

  const totalDebit = currencyConsistent
    ? sumMoney(draft.lines.filter((l) => l.side === 'DEBIT').map((l) => l.baseAmount), baseCurrency)
    : Money.zero(baseCurrency);
  const totalCredit = currencyConsistent
    ? sumMoney(draft.lines.filter((l) => l.side === 'CREDIT').map((l) => l.baseAmount), baseCurrency)
    : Money.zero(baseCurrency);

  if (currencyConsistent && !totalDebit.equals(totalCredit)) {
    violations.push({
      code: 'UNBALANCED',
      debit: totalDebit.toDecimalString(),
      credit: totalCredit.toDecimalString(),
      difference: totalDebit.subtract(totalCredit).toDecimalString(),
    });
  }

  if (violations.length > 0) return err(violations);

  return ok({ ...draft, _validated: true, baseCurrency, totalDebit, totalCredit });
}

/**
 * Build the reversing entry for a posted entry.
 *
 * This is the ONLY correction mechanism in the system. Posted entries are
 * immutable (enforced by database trigger), so "editing" a mistake means
 * posting its mirror image and then posting the corrected version. Both remain
 * visible in the audit trail, which is exactly what an auditor expects to see.
 */
export function reverseEntry(
  entry: JournalEntryDraft,
  options: { readonly entryDate: string; readonly description?: string },
): JournalEntryDraft {
  return {
    entryDate: options.entryDate,
    description: options.description ?? `Reversal of: ${entry.description ?? '(no description)'}`,
    sourceModule: entry.sourceModule,
    ...(entry.sourceDocumentType !== undefined
      ? { sourceDocumentType: entry.sourceDocumentType }
      : {}),
    ...(entry.sourceDocumentId !== undefined
      ? { sourceDocumentId: entry.sourceDocumentId }
      : {}),
    lines: entry.lines.map((line) => ({
      ...line,
      side: line.side === 'DEBIT' ? ('CREDIT' as const) : ('DEBIT' as const),
    })),
  };
}

/**
 * Net movement per account across a set of entries, expressed as a signed
 * base-currency amount where positive means a net debit.
 *
 * Used by the trial balance and by the rollup-integrity check that recomputes
 * `account_period_balance` from raw journal lines.
 */
export function netMovementByAccount(
  entries: readonly JournalEntryDraft[],
  baseCurrency: Currency,
): Map<string, Money> {
  const movements = new Map<string, Money>();

  for (const entry of entries) {
    for (const line of entry.lines) {
      const current = movements.get(line.accountId) ?? Money.zero(baseCurrency);
      const signed = line.side === 'DEBIT' ? line.baseAmount : line.baseAmount.negate();
      movements.set(line.accountId, current.add(signed));
    }
  }

  return movements;
}

/** True when debits equal credits across every supplied entry. */
export function trialBalanceIsBalanced(
  entries: readonly JournalEntryDraft[],
  baseCurrency: Currency,
): boolean {
  let net = Money.zero(baseCurrency);
  for (const movement of netMovementByAccount(entries, baseCurrency).values()) {
    net = net.add(movement);
  }
  return net.isZero();
}
