/**
 * Withholding tax — the mechanism, not the rates.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ THERE ARE NO RATES IN THIS FILE, AND THERE MUST NEVER BE.
 *
 * Malaysian withholding rates depend on the payment type (royalties, technical
 * or management fees, interest, contract payments, rent for movable property,
 * public entertainer fees) and on whether a double taxation agreement with the
 * recipient's country applies. The correct rate for a given payment must be
 * verified against LHDN's published tables and the relevant treaty. This
 * module computes a withholding from a rate that someone else supplied from an
 * effective-dated table (`wht_rate`), which ships seeded EMPTY.
 *
 * A plausible-looking wrong rate is worse than an explicit gap: the gap fails
 * loudly at the point of payment, the wrong rate produces a confidently
 * incorrect CP37 and an under-remittance the taxpayer is liable for.
 * ---------------------------------------------------------------------------
 *
 * WHY WITHHOLDING IS A PAYMENT EVENT, NOT A DOCUMENT EVENT
 *
 * SST attaches to a document at its tax point: the bill is the taxable event
 * and the tax is part of what is owed. Withholding is the opposite shape — the
 * supplier is owed the gross, and the payer discharges part of that obligation
 * by paying the revenue authority instead of the supplier. Nothing about the
 * bill changes. It is settled in full; the cash just goes to two places.
 *
 * That is why `computeTax()` rejects a WHT-regime code outright rather than
 * treating it as another rate, and why this lives in its own module with its
 * own posting shape.
 */

import { Money, type Currency, type RoundingMode } from './money.js';
import { err, ok, type Result } from './result.js';
import type { BasisPoints } from './tax.js';
import type { JournalEntryDraft, JournalLineDraft } from './journal-entry.js';

/**
 * A withholding rate as it comes out of the effective-dated table.
 *
 * `paymentType` is deliberately free text rather than a union: the statutory
 * categories are set by legislation and have changed more than once. A closed
 * union here would mean a code deployment every time LHDN adds a category.
 */
export interface WithholdingRate {
  readonly id: string;
  readonly paymentType: string;
  /** ISO-3166 alpha-2 of the recipient, or null for the non-treaty default. */
  readonly countryCode: string | null;
  readonly rateBasisPoints: BasisPoints;
  readonly validFrom: string;
  readonly validTo: string | null;
  /** Statute or treaty article. Carried for audit, never used in logic. */
  readonly legislationRef?: string;
}

export interface WithholdingComputation {
  readonly rateId: string;
  readonly paymentType: string;
  readonly countryCode: string | null;
  readonly rateBasisPoints: BasisPoints;
  /** What the supplier is owed. */
  readonly grossAmount: Money;
  /** What goes to the revenue authority. */
  readonly withheldAmount: Money;
  /** What actually leaves the bank. `gross - withheld`, exactly. */
  readonly netPayable: Money;
}

export type WithholdingViolation =
  | { readonly code: 'NO_RATE_IN_FORCE'; readonly paymentType: string; readonly date: string }
  | { readonly code: 'NON_POSITIVE_GROSS' }
  | { readonly code: 'WITHHOLDING_EXCEEDS_GROSS' };

const BP_DENOMINATOR = 10_000n;

/**
 * Resolve a rate for a payment type at a date, preferring a treaty rate for
 * the recipient's country over the general one.
 *
 * The country-specific match wins because a treaty rate, where one exists,
 * overrides the domestic rate — never the other way round. Ordering the
 * candidates rather than filtering means a table holding both still resolves
 * deterministically.
 */
export function resolveWithholdingRate(
  rates: readonly WithholdingRate[],
  paymentType: string,
  countryCode: string | null,
  date: string,
): WithholdingRate | undefined {
  const inForce = rates.filter(
    (r) =>
      r.paymentType === paymentType &&
      date >= r.validFrom &&
      (r.validTo === null || date <= r.validTo),
  );

  return (
    (countryCode !== null
      ? inForce.find((r) => r.countryCode === countryCode)
      : undefined) ?? inForce.find((r) => r.countryCode === null)
  );
}

/**
 * Split a gross payment into what the supplier receives and what is withheld.
 *
 * The net is computed by SUBTRACTION, never by a second rate multiplication.
 * `gross × (1 - rate)` and `gross - gross × rate` differ by a sen whenever the
 * rounding lands unluckily, and the resulting entry does not balance. This way
 * the three amounts reconcile by construction.
 */
export function computeWithholding(
  grossAmount: Money,
  rate: WithholdingRate,
  rounding: RoundingMode = 'HALF_UP',
): Result<WithholdingComputation, WithholdingViolation[]> {
  if (!grossAmount.isPositive()) {
    return err([{ code: 'NON_POSITIVE_GROSS' }]);
  }

  const withheldAmount = grossAmount.multiplyRatio(
    rate.rateBasisPoints,
    BP_DENOMINATOR,
    rounding,
  );

  if (withheldAmount.compare(grossAmount) > 0) {
    return err([{ code: 'WITHHOLDING_EXCEEDS_GROSS' }]);
  }

  return ok({
    rateId: rate.id,
    paymentType: rate.paymentType,
    countryCode: rate.countryCode,
    rateBasisPoints: rate.rateBasisPoints,
    grossAmount,
    withheldAmount,
    netPayable: grossAmount.subtract(withheldAmount),
  });
}

export interface WithholdingPostingAccounts {
  readonly accountsPayableId: string;
  readonly bankAccountId: string;
  /** Owed to LHDN until remitted. A liability, not an expense. */
  readonly withholdingPayableId: string;
}

export interface WithholdingPostingContext {
  readonly entryDate: string;
  readonly documentType: string;
  readonly documentId: string;
  readonly contactId: string;
  readonly description?: string;
  /** Converts a document-currency amount to base. Identity when already base. */
  readonly toBase?: (amount: Money) => Money;
  readonly baseCurrency?: Currency;
}

/**
 * The posting:
 *
 *   Dr Accounts payable   gross      — the supplier's claim is fully discharged
 *   Cr Bank               net        — what actually left
 *   Cr WHT payable        withheld   — now owed to LHDN instead
 *
 * Note the debit is the GROSS. This is the whole point: the supplier is paid
 * in full as far as the ledger is concerned, and the withheld portion is a
 * liability transferred from the supplier to the revenue authority. Debiting
 * only the net would leave the bill permanently part-paid and the AP subledger
 * disagreeing with the control account forever.
 *
 * Returns `null` when nothing is withheld, so the caller falls back to the
 * ordinary settlement path rather than posting a zero line.
 */
export function buildWithholdingPaymentJournal(
  computation: WithholdingComputation,
  accounts: WithholdingPostingAccounts,
  ctx: WithholdingPostingContext,
): JournalEntryDraft | null {
  if (computation.withheldAmount.isZero()) return null;

  const toBase = ctx.toBase ?? ((m: Money) => m);

  const lines: JournalLineDraft[] = [
    {
      accountId: accounts.accountsPayableId,
      side: 'DEBIT',
      amount: computation.grossAmount,
      baseAmount: toBase(computation.grossAmount),
      description: 'Accounts payable settled (gross)',
      contactId: ctx.contactId,
    },
    {
      accountId: accounts.bankAccountId,
      side: 'CREDIT',
      amount: computation.netPayable,
      baseAmount: toBase(computation.netPayable),
      description: 'Payment to supplier (net of withholding)',
      contactId: ctx.contactId,
    },
    {
      accountId: accounts.withholdingPayableId,
      side: 'CREDIT',
      amount: computation.withheldAmount,
      baseAmount: toBase(computation.withheldAmount),
      description: `Withholding tax retained (${computation.paymentType})`,
      contactId: ctx.contactId,
    },
  ];

  return {
    entryDate: ctx.entryDate,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    sourceModule: 'PURCHASES',
    sourceDocumentType: ctx.documentType,
    sourceDocumentId: ctx.documentId,
    lines: lines.filter((l) => !l.amount.isZero()),
  };
}
