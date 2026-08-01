/**
 * Sales and purchase document computation — M2 / M3 core.
 *
 * Turns priced lines into totals and then into a balanced journal entry.
 * Still pure: no IO, no persistence. `InvoiceService.issue()` in the API layer
 * is what wraps this in a transaction, allocates a number and posts it.
 */

import { Money, sumMoney, type Currency } from './money.js';
import { err, ok, isErr, type Result } from './result.js';
import {
  computeTax,
  DEFAULT_TAX_POLICY,
  type EntityTaxProfile,
  type TaxCode,
  type TaxComputation,
  type TaxPolicy,
  type TaxViolation,
} from './tax.js';
import type { JournalEntryDraft, JournalLineDraft } from './journal-entry.js';

/** Quantities are held at 4 decimal places, like money. Never a float. */
export const QUANTITY_SCALE = 4;
const QUANTITY_FACTOR = 10n ** BigInt(QUANTITY_SCALE);
const BP_DENOMINATOR = 10_000n;

export interface DocumentLine {
  readonly lineId: string;
  readonly description: string;
  /** Scaled by 10^QUANTITY_SCALE. 2.5 units = 25000n. */
  readonly quantity: bigint;
  readonly unitPrice: Money;
  /** Line discount in basis points. 1000n = 10%. */
  readonly discountBasisPoints?: bigint;
  /** Revenue account for a sale, expense/asset account for a purchase. */
  readonly accountId: string;
  readonly taxCodeId: string;
  /** MyInvois line classification code. Required before e-invoice submission. */
  readonly classificationCode?: string;
}

export interface ComputedDocumentLine {
  readonly lineId: string;
  readonly accountId: string;
  readonly taxCodeId: string;
  /** Price × quantity, less discount. Tax-exclusive. */
  readonly netAmount: Money;
  readonly taxAmount: Money;
  readonly lineTotal: Money;
  readonly inputTreatment: TaxCode['inputTreatment'];
}

export interface DocumentComputation {
  readonly lines: readonly ComputedDocumentLine[];
  readonly subtotal: Money;
  readonly taxTotal: Money;
  readonly total: Money;
  readonly tax: TaxComputation;
  readonly currency: Currency;
}

export interface DocumentInput {
  readonly lines: readonly DocumentLine[];
  readonly taxPointDate: string;
  readonly direction: 'OUTPUT' | 'INPUT';
  readonly amountsAreTaxInclusive: boolean;
  readonly taxCodes: readonly TaxCode[];
  readonly entity: EntityTaxProfile;
  readonly policy?: TaxPolicy;
}

export type DocumentViolation =
  | TaxViolation
  | { readonly code: 'NO_LINES' }
  | { readonly code: 'NON_POSITIVE_QUANTITY'; readonly lineId: string }
  | { readonly code: 'NEGATIVE_UNIT_PRICE'; readonly lineId: string }
  | { readonly code: 'INVALID_DISCOUNT'; readonly lineId: string; readonly basisPoints: string };

export function computeDocument(
  input: DocumentInput,
): Result<DocumentComputation, DocumentViolation[]> {
  const policy = input.policy ?? DEFAULT_TAX_POLICY;
  const violations: DocumentViolation[] = [];

  if (input.lines.length === 0) {
    return err([{ code: 'NO_LINES' }]);
  }

  for (const line of input.lines) {
    if (line.quantity <= 0n) {
      violations.push({ code: 'NON_POSITIVE_QUANTITY', lineId: line.lineId });
    }
    if (line.unitPrice.isNegative()) {
      violations.push({ code: 'NEGATIVE_UNIT_PRICE', lineId: line.lineId });
    }
    const discount = line.discountBasisPoints ?? 0n;
    if (discount < 0n || discount > BP_DENOMINATOR) {
      violations.push({
        code: 'INVALID_DISCOUNT',
        lineId: line.lineId,
        basisPoints: discount.toString(),
      });
    }
  }

  if (violations.length > 0) return err(violations);

  const currency = input.lines[0]!.unitPrice.currency;

  // Line extension, rounded to the document's presentation precision before
  // tax is applied — so the figure the customer sees is the figure taxed.
  const netAmounts = input.lines.map((line) => {
    const extended = line.unitPrice.multiplyRatio(line.quantity, QUANTITY_FACTOR, policy.mode);
    const discount = line.discountBasisPoints ?? 0n;
    const discounted =
      discount === 0n
        ? extended
        : extended.multiplyRatio(BP_DENOMINATOR - discount, BP_DENOMINATOR, policy.mode);
    return discounted.roundToExponent(policy.exponent, policy.mode);
  });

  const taxResult = computeTax({
    lines: input.lines.map((line, i) => ({
      lineId: line.lineId,
      taxCodeId: line.taxCodeId,
      amount: netAmounts[i]!,
    })),
    taxPointDate: input.taxPointDate,
    direction: input.direction,
    amountsAreTaxInclusive: input.amountsAreTaxInclusive,
    taxCodes: input.taxCodes,
    entity: input.entity,
    policy,
  });

  if (isErr(taxResult)) return err(taxResult.error);
  const tax = taxResult.value;

  const lines: ComputedDocumentLine[] = input.lines.map((line, i) => {
    const taxLine = tax.lines[i]!;
    // When amounts are tax-inclusive the taxable base is the entered amount
    // less the extracted tax, not the entered amount.
    const netAmount = input.amountsAreTaxInclusive ? taxLine.taxableAmount : netAmounts[i]!;
    return {
      lineId: line.lineId,
      accountId: line.accountId,
      taxCodeId: line.taxCodeId,
      netAmount,
      taxAmount: taxLine.taxAmount,
      lineTotal: netAmount.add(taxLine.taxAmount),
      inputTreatment: taxLine.inputTreatment,
    };
  });

  const subtotal = sumMoney(lines.map((l) => l.netAmount), currency);
  const taxTotal = sumMoney(lines.map((l) => l.taxAmount), currency);

  return ok({
    lines,
    subtotal,
    taxTotal,
    total: subtotal.add(taxTotal),
    tax,
    currency,
  });
}

// ---------------------------------------------------------------------------
// Journal construction
// ---------------------------------------------------------------------------

export interface SalesPostingAccounts {
  readonly accountsReceivableId: string;
  /** Where output tax is accrued as a liability. */
  readonly taxPayableId: string;
}

export interface PurchasePostingAccounts {
  readonly accountsPayableId: string;
  /** Only used when a tax code is RECOVERABLE. */
  readonly taxClaimableId: string;
}

export interface PostingContext {
  readonly entryDate: string;
  readonly description?: string;
  readonly contactId?: string;
  readonly documentType: string;
  readonly documentId: string;
  /** Rate to the tenant's base currency. 1:1 for an MYR document. */
  readonly fxRate?: { readonly baseCurrency: Currency; readonly convert: (m: Money) => Money };
}

/**
 * Sales invoice:
 *   Dr Accounts Receivable   (gross)
 *   Cr Revenue               (net, per revenue account)
 *   Cr SST Payable           (output tax)
 *
 * Returns `null` when the document has no ledger effect at all — see
 * `hasLedgerEffect()`. Callers must handle that case rather than posting an
 * empty or single-sided entry.
 */
export function buildSalesJournal(
  doc: DocumentComputation,
  accounts: SalesPostingAccounts,
  ctx: PostingContext,
): JournalEntryDraft | null {
  if (!hasLedgerEffect(doc)) return null;

  const toBase = ctx.fxRate?.convert ?? ((m: Money) => m);
  const lines: JournalLineDraft[] = [];

  lines.push({
    accountId: accounts.accountsReceivableId,
    side: 'DEBIT',
    amount: doc.total,
    baseAmount: toBase(doc.total),
    description: 'Accounts receivable',
    ...(ctx.contactId !== undefined ? { contactId: ctx.contactId } : {}),
  });

  for (const [accountId, amount] of groupByAccount(doc.lines, doc.currency)) {
    if (amount.isZero()) continue;
    lines.push({
      accountId,
      side: 'CREDIT',
      amount,
      baseAmount: toBase(amount),
      description: 'Revenue',
      ...(ctx.contactId !== undefined ? { contactId: ctx.contactId } : {}),
    });
  }

  for (const row of doc.tax.summary) {
    if (row.taxAmount.isZero()) continue;
    lines.push({
      accountId: accounts.taxPayableId,
      side: 'CREDIT',
      amount: row.taxAmount,
      baseAmount: toBase(row.taxAmount),
      description: `Output tax ${row.code}`,
      taxCodeId: row.taxCodeId,
    });
  }

  return {
    entryDate: ctx.entryDate,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    sourceModule: 'SALES',
    sourceDocumentType: ctx.documentType,
    sourceDocumentId: ctx.documentId,
    lines,
  };
}

/**
 * Purchase bill:
 *   Dr Expense/Asset   (net, PLUS non-recoverable tax — see below)
 *   Dr SST Claimable   (only the RECOVERABLE portion)
 *   Cr Accounts Payable (gross)
 *
 * The `COST` branch is the SST-specific behaviour and the reason this function
 * exists rather than mirroring `buildSalesJournal`. Under a VAT/GST regime all
 * input tax would land in the claimable asset. Under SST it generally does
 * not: it is absorbed into the cost of whatever it was incurred on. Booking it
 * as an asset would overstate assets and understate expenses on every purchase
 * a Malaysian customer records.
 */
export function buildPurchaseJournal(
  doc: DocumentComputation,
  accounts: PurchasePostingAccounts,
  ctx: PostingContext,
): JournalEntryDraft | null {
  if (!hasLedgerEffect(doc)) return null;

  const toBase = ctx.fxRate?.convert ?? ((m: Money) => m);
  const lines: JournalLineDraft[] = [];

  // Net, plus any tax the regime does not let us recover.
  const expenseByAccount = new Map<string, Money>();
  for (const line of doc.lines) {
    const absorbed =
      line.inputTreatment === 'COST' ? line.netAmount.add(line.taxAmount) : line.netAmount;
    const current = expenseByAccount.get(line.accountId) ?? Money.zero(doc.currency);
    expenseByAccount.set(line.accountId, current.add(absorbed));
  }

  for (const [accountId, amount] of expenseByAccount) {
    if (amount.isZero()) continue;
    lines.push({
      accountId,
      side: 'DEBIT',
      amount,
      baseAmount: toBase(amount),
      description: 'Purchase',
      ...(ctx.contactId !== undefined ? { contactId: ctx.contactId } : {}),
    });
  }

  const recoverable = sumMoney(
    doc.lines.filter((l) => l.inputTreatment === 'RECOVERABLE').map((l) => l.taxAmount),
    doc.currency,
  );

  if (!recoverable.isZero()) {
    lines.push({
      accountId: accounts.taxClaimableId,
      side: 'DEBIT',
      amount: recoverable,
      baseAmount: toBase(recoverable),
      description: 'Recoverable input tax',
    });
  }

  lines.push({
    accountId: accounts.accountsPayableId,
    side: 'CREDIT',
    amount: doc.total,
    baseAmount: toBase(doc.total),
    description: 'Accounts payable',
    ...(ctx.contactId !== undefined ? { contactId: ctx.contactId } : {}),
  });

  return {
    entryDate: ctx.entryDate,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    sourceModule: 'PURCHASES',
    sourceDocumentType: ctx.documentType,
    sourceDocumentId: ctx.documentId,
    lines,
  };
}

/**
 * Whether this document moves the ledger at all.
 *
 * A zero-total document is a legitimate business record — a free sample, a
 * warranty replacement, a fully discounted line — but it has no debits and no
 * credits, so there is nothing to post. Because line amounts are constrained
 * to be non-negative (quantity > 0, unit price >= 0), a zero total means every
 * line is zero; there is no case where the parts are non-zero and cancel out.
 *
 * This is deliberately a null return rather than a thrown error. Refusing to
 * issue the invoice would be the wrong call: the customer still needs the
 * document. What must not happen is posting a single-sided RM 0.00 entry,
 * which is what an unconditional AR line produces.
 */
export function hasLedgerEffect(doc: DocumentComputation): boolean {
  return !doc.total.isZero();
}

function groupByAccount(
  lines: readonly ComputedDocumentLine[],
  currency: Currency,
): Map<string, Money> {
  const grouped = new Map<string, Money>();
  for (const line of lines) {
    const current = grouped.get(line.accountId) ?? Money.zero(currency);
    grouped.set(line.accountId, current.add(line.netAmount));
  }
  return grouped;
}
