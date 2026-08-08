import { Money, type Currency } from './money.js';
import { dedupeHash, type ParsedStatementRow } from './statement-import.js';

/**
 * Bank feeds — normalising what an outside system says into what the
 * statement-import pipeline already knows how to keep exactly once.
 *
 * ---------------------------------------------------------------------------
 * A FEED IS ANOTHER WAY FOR LINES TO ARRIVE, NOT ANOTHER KIND OF LINE.
 *
 * Everything downstream of arrival — dedupe, matching, rules, reconciliation,
 * the bank invariant — already exists and is tested. So the whole job of this
 * module is to turn a provider's transaction into a `ParsedStatementRow`, the
 * same shape a CSV row becomes, and to do it so that A FEED AND AN IMPORT OF
 * THE SAME REAL EVENT COLLIDE. The shop will overlap them constantly: a feed
 * running daily plus a monthly CSV re-import "to be safe" must produce each
 * transaction once, which means the feed must use the SAME dedupe hash as the
 * import, not a private one keyed on the provider's transaction id.
 *
 * The provider's own id, when present, therefore rides along as the reference
 * (visible, greppable, matchable by bank rules) rather than forming the hash.
 * Hashing on it would be more precise between two syncs of the same feed —
 * and would silently double every line the moment a feed and a CSV overlap,
 * which is the case that actually happens in a shop.
 * ---------------------------------------------------------------------------
 */

/** What a provider (or a push client) says happened. Amounts signed: + in, − out. */
export interface FeedTransaction {
  /** ISO date the bank booked it. */
  readonly date: string;
  readonly description: string;
  /** Signed decimal string, e.g. "-1250.00". */
  readonly amount: string;
  /** The provider's own id or reference, if it has one. */
  readonly reference?: string;
  readonly valueDate?: string;
  readonly runningBalance?: string;
}

export type FeedViolation =
  | { readonly code: 'BAD_DATE'; readonly index: number; readonly value: string }
  | { readonly code: 'BAD_AMOUNT'; readonly index: number; readonly value: string }
  | { readonly code: 'ZERO_AMOUNT'; readonly index: number }
  | { readonly code: 'EMPTY_DESCRIPTION'; readonly index: number };

export interface NormalisedFeed {
  readonly rows: readonly ParsedStatementRow[];
  readonly violations: readonly FeedViolation[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate and normalise a batch. Bad rows become violations, good rows keep
 * going — a feed of forty lines with one malformed row should deliver
 * thirty-nine and SAY one was refused, not fail the batch or, worse,
 * swallow the bad row silently.
 */
export function normaliseFeedTransactions(
  transactions: readonly FeedTransaction[],
  currency: Currency,
): NormalisedFeed {
  const rows: ParsedStatementRow[] = [];
  const violations: FeedViolation[] = [];
  const seen = new Map<string, number>();

  transactions.forEach((txn, index) => {
    if (!ISO_DATE.test(txn.date)) {
      violations.push({ code: 'BAD_DATE', index, value: txn.date });
      return;
    }
    if (txn.valueDate !== undefined && !ISO_DATE.test(txn.valueDate)) {
      violations.push({ code: 'BAD_DATE', index, value: txn.valueDate });
      return;
    }

    const description = txn.description.trim();
    if (description === '') {
      violations.push({ code: 'EMPTY_DESCRIPTION', index });
      return;
    }

    let amount: Money;
    try {
      amount = Money.fromDecimal(txn.amount, currency);
    } catch {
      violations.push({ code: 'BAD_AMOUNT', index, value: txn.amount });
      return;
    }
    if (amount.isZero()) {
      violations.push({ code: 'ZERO_AMOUNT', index });
      return;
    }

    let runningBalance: Money | undefined;
    if (txn.runningBalance !== undefined) {
      try {
        runningBalance = Money.fromDecimal(txn.runningBalance, currency);
      } catch {
        violations.push({ code: 'BAD_AMOUNT', index, value: txn.runningBalance });
        return;
      }
    }

    const hash = dedupeHash({
      txnDate: txn.date,
      description,
      amount,
      ...(runningBalance !== undefined ? { runningBalance } : {}),
    });
    // Same occurrence discipline as a CSV file: the second identical row in
    // ONE batch is a second real event, not a duplicate.
    const occurrence = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, occurrence);

    rows.push({
      lineNo: index + 1,
      txnDate: txn.date,
      description,
      amount,
      dedupeHash: hash,
      occurrence,
      ...(txn.reference !== undefined && txn.reference.trim() !== ''
        ? { reference: txn.reference.trim() }
        : {}),
      ...(txn.valueDate !== undefined ? { valueDate: txn.valueDate } : {}),
      ...(runningBalance !== undefined ? { runningBalance } : {}),
    });
  });

  return { rows, violations };
}
