/**
 * Unrealised foreign exchange revaluation at reporting date.
 *
 * Monetary items denominated in a foreign currency are carried at the rate
 * they were booked at. At a reporting date they must be restated to the
 * closing rate, and the difference recognised in profit or loss (MFRS 121 /
 * MPERS Section 30). It is *unrealised* because no money has moved.
 *
 * ---------------------------------------------------------------------------
 * TWO DESIGN DECISIONS, both with real trade-offs. Stating them plainly
 * because either could reasonably have gone the other way.
 *
 * 1. THE REVALUATION REVERSES.
 *
 *    It is posted dated the reporting date and reversed on the first day of
 *    the next period, so the carrying amount returns to the historical rate.
 *
 *    This is forced by how settlement works. `fx.ts` relieves AR at the rate
 *    the invoice was BOOKED at, and computes the realised gain from the gap
 *    between that and the settlement rate. If a revaluation permanently
 *    adjusted the carrying amount, the realised gain on eventual settlement
 *    would double-count the portion already recognised as unrealised. A
 *    non-reversing revaluation would mean tracking a "last revalued rate" per
 *    invoice and measuring realised FX from there — more state, more ways to
 *    be wrong, and no benefit for a system that revalues every period anyway.
 *
 * 2. IT POSTS TO A SEPARATE REVALUATION ACCOUNT, NOT TO AR ITSELF.
 *
 *    Adjusting the AR control account directly is what most textbooks
 *    describe, and it would immediately break ledger invariant #6 — the
 *    control account would no longer equal the subledger, because no
 *    individual invoice changed. A trial balance drawn at the reporting date
 *    would show the discrepancy with nothing to explain it.
 *
 *    So the adjustment lands in its own account, which the SOFP maps onto the
 *    same "Trade receivables" line as the control account. Presentation is
 *    identical; the invariant survives; and the revaluation is separately
 *    visible, which is what an auditor wants anyway.
 * ---------------------------------------------------------------------------
 *
 * Pure: rates and balances are supplied by the caller.
 */

import { Money, sumMoney, type Currency } from './money.js';
import { err, ok, type Result } from './result.js';
import { Rate, toBase } from './fx.js';
import type { JournalEntryDraft, JournalLineDraft } from './journal-entry.js';

/**
 * One open monetary item to be restated.
 *
 * Today these are open invoices (AR). Payables and foreign bank balances
 * follow exactly the same shape and will use the same function.
 */
export interface RevaluationItem {
  /** Document number or account code, for the audit detail. */
  readonly reference: string;
  /** Amount still outstanding, in the transaction currency. */
  readonly outstanding: Money;
  /** The rate this item is currently carried at. */
  readonly bookedRate: Rate;
}

export interface RevaluationCurrencyLine {
  readonly currency: Currency;
  readonly itemCount: number;
  /** Total outstanding in the transaction currency. */
  readonly outstanding: Money;
  /** What the ledger currently carries, at booked rates. */
  readonly carryingBase: Money;
  readonly closingRate: Rate;
  /** What it is worth at the closing rate. */
  readonly closingBase: Money;
  /** closingBase - carryingBase. Positive is a gain on an asset. */
  readonly difference: Money;
}

export interface Revaluation {
  readonly asOfDate: string;
  readonly baseCurrency: Currency;
  readonly byCurrency: readonly RevaluationCurrencyLine[];
  readonly totalDifference: Money;
}

export type RevaluationViolation =
  | { readonly code: 'MISSING_CLOSING_RATE'; readonly currency: Currency }
  | { readonly code: 'INVALID_AS_OF_DATE'; readonly value: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Restate open items at closing rates.
 *
 * Items already in the base currency are skipped entirely — they are not
 * monetary items in a foreign currency and have nothing to restate. Grouping
 * is by currency because that is how the adjustment is reported and how a
 * missing rate must be surfaced.
 */
export function revalue(
  items: readonly RevaluationItem[],
  closingRates: ReadonlyMap<Currency, Rate>,
  baseCurrency: Currency,
  asOfDate: string,
): Result<Revaluation, RevaluationViolation[]> {
  const violations: RevaluationViolation[] = [];

  if (!ISO_DATE.test(asOfDate) || Number.isNaN(Date.parse(asOfDate))) {
    violations.push({ code: 'INVALID_AS_OF_DATE', value: asOfDate });
  }

  const foreign = items.filter((i) => i.outstanding.currency !== baseCurrency);
  const currencies = [...new Set(foreign.map((i) => i.outstanding.currency))].sort();

  for (const currency of currencies) {
    if (!closingRates.has(currency)) {
      // Deliberately an error. Skipping a currency would silently understate
      // the adjustment, and the resulting balance sheet would be wrong in a
      // way nothing else in the system would catch.
      violations.push({ code: 'MISSING_CLOSING_RATE', currency });
    }
  }

  if (violations.length > 0) return err(violations);

  const byCurrency: RevaluationCurrencyLine[] = currencies.map((currency) => {
    const forCurrency = foreign.filter((i) => i.outstanding.currency === currency);
    const closingRate = closingRates.get(currency)!;

    const outstanding = sumMoney(forCurrency.map((i) => i.outstanding), currency);

    // Carrying value is summed PER ITEM at each item's own booked rate. The
    // items were booked on different days at different rates; converting the
    // aggregate at any single rate would be a different number.
    const carryingBase = forCurrency.reduce(
      (acc, item) => acc.add(toBase(item.outstanding, item.bookedRate, baseCurrency)),
      Money.zero(baseCurrency),
    );

    const closingBase = toBase(outstanding, closingRate, baseCurrency);

    return {
      currency,
      itemCount: forCurrency.length,
      outstanding,
      carryingBase,
      closingRate,
      closingBase,
      difference: closingBase.subtract(carryingBase),
    };
  });

  return ok({
    asOfDate,
    baseCurrency,
    byCurrency,
    totalDifference: sumMoney(byCurrency.map((c) => c.difference), baseCurrency),
  });
}

export interface RevaluationPostingAccounts {
  /**
   * Where the adjustment sits. Presented on the same statement line as the
   * control account it adjusts — see the note at the top of this file.
   */
  readonly revaluationAccountId: string;
  /** Unrealised gain/loss, a P&L account. */
  readonly unrealisedFxAccountId: string;
}

export interface RevaluationPostingContext {
  readonly entryDate: string;
  readonly description?: string;
  readonly documentType: string;
  readonly documentId: string;
}

/**
 * Build the revaluation entry for a RECEIVABLE-side adjustment.
 *
 *   difference > 0 (asset worth more):
 *     Dr AR revaluation / Cr Unrealised FX gain
 *   difference < 0:
 *     Dr Unrealised FX loss / Cr AR revaluation
 *
 * Returns null when nothing moved — a period where every rate held steady
 * should not leave a trail of empty journal entries.
 */
export function buildRevaluationJournal(
  revaluation: Revaluation,
  accounts: RevaluationPostingAccounts,
  ctx: RevaluationPostingContext,
): JournalEntryDraft | null {
  const total = revaluation.totalDifference;
  if (total.isZero()) return null;

  const gain = total.isPositive();
  const amount = total.abs();

  const lines: JournalLineDraft[] = [
    {
      accountId: accounts.revaluationAccountId,
      side: gain ? 'DEBIT' : 'CREDIT',
      amount,
      baseAmount: amount,
      description: `Foreign currency revaluation at ${revaluation.asOfDate}`,
    },
    {
      accountId: accounts.unrealisedFxAccountId,
      side: gain ? 'CREDIT' : 'DEBIT',
      amount,
      baseAmount: amount,
      description: gain
        ? 'Unrealised foreign exchange gain'
        : 'Unrealised foreign exchange loss',
    },
  ];

  return {
    entryDate: ctx.entryDate,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    sourceModule: 'SYSTEM',
    sourceDocumentType: ctx.documentType,
    sourceDocumentId: ctx.documentId,
    lines,
  };
}

/** One side of a two-sided revaluation and the account its adjustment lands in. */
export interface RevaluationSide {
  readonly revaluation: Revaluation;
  readonly revaluationAccountId: string;
}

/**
 * Build one entry covering several monetary-item populations at once —
 * receivables and payables at a period end.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE ENTRY WITH SEVERAL BALANCE-SHEET LINES, RATHER THAN ONE ENTRY EACH
 *
 * A period-end revaluation is a single event with a single reversal, and the
 * schema's guarantee that a posted run has both an entry AND its reversal is
 * worth keeping. But the two sides cannot share a balance-sheet line: a
 * receivables adjustment belongs next to AR and a payables adjustment next to
 * AP. Netting them would park a payables movement inside trade receivables.
 *
 * So each side gets its own balance-sheet line, and the P&L line is the
 * BALANCING FIGURE — the same technique the settlement journal uses. Nothing
 * here decides a sign from a direction, so no side can silently invert.
 * ---------------------------------------------------------------------------
 *
 * Returns null when nothing moved on any side.
 */
export function buildCombinedRevaluationJournal(
  sides: readonly RevaluationSide[],
  unrealisedFxAccountId: string,
  ctx: RevaluationPostingContext,
  baseCurrency: Currency,
): JournalEntryDraft | null {
  const lines: JournalLineDraft[] = [];

  for (const side of sides) {
    const total = side.revaluation.totalDifference;
    if (total.isZero()) continue;
    const amount = total.abs();
    lines.push({
      accountId: side.revaluationAccountId,
      side: total.isPositive() ? 'DEBIT' : 'CREDIT',
      amount,
      baseAmount: amount,
      description: `Foreign currency revaluation at ${side.revaluation.asOfDate}`,
    });
  }

  if (lines.length === 0) return null;

  const debits = lines
    .filter((l) => l.side === 'DEBIT')
    .reduce((acc, l) => acc.add(l.baseAmount), Money.zero(baseCurrency));
  const credits = lines
    .filter((l) => l.side === 'CREDIT')
    .reduce((acc, l) => acc.add(l.baseAmount), Money.zero(baseCurrency));

  const imbalance = debits.subtract(credits);

  // Only reachable when the sides exactly offset: a gain on receivables
  // matched to the sen by a loss on payables. The balance sheet moved on both
  // lines but the P&L did not, so there is no unrealised gain or loss to post.
  if (!imbalance.isZero()) {
    const gain = imbalance.isPositive();
    lines.push({
      accountId: unrealisedFxAccountId,
      side: gain ? 'CREDIT' : 'DEBIT',
      amount: imbalance.abs(),
      baseAmount: imbalance.abs(),
      description: gain
        ? 'Unrealised foreign exchange gain'
        : 'Unrealised foreign exchange loss',
    });
  }

  return {
    entryDate: ctx.entryDate,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    sourceModule: 'SYSTEM',
    sourceDocumentType: ctx.documentType,
    sourceDocumentId: ctx.documentId,
    lines,
  };
}

/**
 * The date the revaluation reverses on: the day after the reporting date.
 *
 * Computed rather than passed so it cannot drift from the entry it reverses.
 */
export function reversalDate(asOfDate: string): string {
  const date = new Date(`${asOfDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
