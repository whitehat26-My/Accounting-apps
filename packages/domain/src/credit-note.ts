/**
 * Credit notes — the sanctioned way to correct an issued invoice.
 *
 * An issued invoice is evidence given to a customer, and the database refuses
 * to edit one. That refusal is only tenable if there is a proper correction
 * path, and this is it. The relationship mirrors the ledger's: a posted
 * journal entry is corrected by a reversing entry, an issued invoice by a
 * credit note. Both leave the original visible, which is what an auditor
 * expects to see.
 *
 * Amounts are held POSITIVE throughout, exactly like an invoice, and the
 * direction is expressed by which side of the journal each line lands on. The
 * alternative — an invoice with negative amounts — breaks the `debit > 0 XOR
 * credit > 0` constraint, defeats the non-negative line checks, and makes
 * every downstream sum ambiguous about whether it has already been signed.
 */

import { Money, type Currency } from './money.js';
import { err, ok, type Result } from './result.js';
import type { JournalEntryDraft, JournalLineDraft } from './journal-entry.js';
import type { DocumentComputation } from './document.js';

/**
 * Why the credit was raised. Recorded because MyInvois requires a reason on a
 * credit note, and because "why did revenue drop in March" is the first
 * question an accountant asks.
 */
export type CreditNoteReason =
  | 'RETURN'
  | 'OVERCHARGE'
  | 'DISCOUNT'
  | 'CANCELLATION'
  | 'BAD_DEBT'
  | 'OTHER';

export interface CreditNotePostingAccounts {
  readonly accountsReceivableId: string;
  readonly taxPayableId: string;
}

export interface CreditNotePostingContext {
  readonly entryDate: string;
  readonly description?: string;
  readonly contactId?: string;
  readonly documentType: string;
  readonly documentId: string;
}

/**
 * Credit note:
 *   Dr Revenue         (net, per revenue account)
 *   Dr SST Payable     (output tax reversed)
 *   Cr Accounts Receivable (gross)
 *
 * Precisely the mirror of `buildSalesJournal` for the same document. That
 * symmetry is asserted directly in the tests rather than achieved by sharing
 * code, so a change to either builder that breaks the mirror fails the build.
 *
 * Returns `null` for a document with no ledger effect, same contract as the
 * sales and purchase builders.
 */
export function buildCreditNoteJournal(
  doc: DocumentComputation,
  accounts: CreditNotePostingAccounts,
  ctx: CreditNotePostingContext,
): JournalEntryDraft | null {
  if (doc.total.isZero()) return null;

  const lines: JournalLineDraft[] = [];

  const revenueByAccount = new Map<string, Money>();
  for (const line of doc.lines) {
    const current = revenueByAccount.get(line.accountId) ?? Money.zero(doc.currency);
    revenueByAccount.set(line.accountId, current.add(line.netAmount));
  }

  for (const [accountId, amount] of revenueByAccount) {
    if (amount.isZero()) continue;
    lines.push({
      accountId,
      side: 'DEBIT',
      amount,
      baseAmount: amount,
      description: 'Revenue credited',
      ...(ctx.contactId !== undefined ? { contactId: ctx.contactId } : {}),
    });
  }

  for (const row of doc.tax.summary) {
    if (row.taxAmount.isZero()) continue;
    lines.push({
      accountId: accounts.taxPayableId,
      side: 'DEBIT',
      amount: row.taxAmount,
      baseAmount: row.taxAmount,
      description: `Output tax reversed ${row.code}`,
      taxCodeId: row.taxCodeId,
    });
  }

  lines.push({
    accountId: accounts.accountsReceivableId,
    side: 'CREDIT',
    amount: doc.total,
    baseAmount: doc.total,
    description: 'Accounts receivable credited',
    ...(ctx.contactId !== undefined ? { contactId: ctx.contactId } : {}),
  });

  return {
    entryDate: ctx.entryDate,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    sourceModule: 'SALES',
    sourceDocumentType: ctx.documentType,
    sourceDocumentId: ctx.documentId,
    lines,
  };
}

export interface DebitNotePostingAccounts {
  readonly accountsPayableId: string;
  /** Only needed when a line's tax was RECOVERABLE. See below. */
  readonly taxClaimableId?: string;
}

/**
 * Debit note — a supplier's credit to us, and the mirror of
 * `buildPurchaseJournal`:
 *
 *   Dr Accounts Payable  (gross)
 *   Cr Expense/Asset     (net, PLUS any tax that was absorbed as a cost)
 *   Cr SST Claimable     (only the RECOVERABLE portion)
 *
 * ---------------------------------------------------------------------------
 * THE COST/RECOVERABLE SPLIT MUST BE REVERSED THE SAME WAY IT WAS BOOKED.
 *
 * When the original bill's tax was a COST, it went into the expense account —
 * so crediting only the net here would leave the absorbed tax sitting in the
 * expense forever, understating the credit and overstating the year's costs by
 * exactly the tax. When it was RECOVERABLE, it went to the claimable asset and
 * has to come back out of the asset, not out of the expense.
 *
 * Getting this backwards produces a debit note that balances perfectly and
 * misstates two accounts, which is the hardest kind of error to notice.
 * ---------------------------------------------------------------------------
 */
export function buildDebitNoteJournal(
  doc: DocumentComputation,
  accounts: DebitNotePostingAccounts,
  ctx: CreditNotePostingContext,
): JournalEntryDraft | null {
  if (doc.total.isZero()) return null;

  const lines: JournalLineDraft[] = [];

  const expenseByAccount = new Map<string, Money>();
  for (const line of doc.lines) {
    const absorbed =
      line.inputTreatment === 'COST' ? line.netAmount.add(line.taxAmount) : line.netAmount;
    const current = expenseByAccount.get(line.accountId) ?? Money.zero(doc.currency);
    expenseByAccount.set(line.accountId, current.add(absorbed));
  }

  lines.push({
    accountId: accounts.accountsPayableId,
    side: 'DEBIT',
    amount: doc.total,
    baseAmount: doc.total,
    description: 'Accounts payable debited',
    ...(ctx.contactId !== undefined ? { contactId: ctx.contactId } : {}),
  });

  for (const [accountId, amount] of expenseByAccount) {
    if (amount.isZero()) continue;
    lines.push({
      accountId,
      side: 'CREDIT',
      amount,
      baseAmount: amount,
      description: 'Purchase credited',
      ...(ctx.contactId !== undefined ? { contactId: ctx.contactId } : {}),
    });
  }

  const recoverable = doc.lines
    .filter((l) => l.inputTreatment === 'RECOVERABLE')
    .reduce((acc, l) => acc.add(l.taxAmount), Money.zero(doc.currency));

  if (!recoverable.isZero()) {
    if (accounts.taxClaimableId === undefined) {
      throw new Error(
        'A tax code on this debit note is RECOVERABLE but no SST_CLAIMABLE account is ' +
          'configured. Map the SST_CLAIMABLE posting role before reversing recoverable input tax.',
      );
    }
    lines.push({
      accountId: accounts.taxClaimableId,
      side: 'CREDIT',
      amount: recoverable,
      baseAmount: recoverable,
      description: 'Recoverable input tax reversed',
    });
  }

  return {
    entryDate: ctx.entryDate,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    sourceModule: 'PURCHASES',
    sourceDocumentType: ctx.documentType,
    sourceDocumentId: ctx.documentId,
    lines,
  };
}

export type CreditNoteViolation =
  | { readonly code: 'INVALID_CREDIT_DATE'; readonly value: string }
  | { readonly code: 'ZERO_VALUE_CREDIT' }
  | { readonly code: 'CREDIT_EXCEEDS_INVOICE'; readonly invoiceId: string; readonly credit: string; readonly invoiceTotal: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface CreditNoteCheck {
  readonly creditDate: string;
  readonly total: Money;
  /** The invoice this credit note references, if it references one. */
  readonly against?: { readonly invoiceId: string; readonly invoiceTotal: Money };
}

/**
 * Checks that apply to the credit note itself, before allocation.
 *
 * A credit note may exceed the amount *outstanding* on an invoice — crediting
 * an invoice that has already been paid is normal, and leaves the customer in
 * credit. What it may never exceed is the invoice's original total, because
 * that would credit back more than was ever charged.
 */
export function validateCreditNote(
  input: CreditNoteCheck,
): Result<CreditNoteCheck, CreditNoteViolation[]> {
  const violations: CreditNoteViolation[] = [];

  if (!ISO_DATE.test(input.creditDate) || Number.isNaN(Date.parse(input.creditDate))) {
    violations.push({ code: 'INVALID_CREDIT_DATE', value: input.creditDate });
  }

  if (!input.total.isPositive()) {
    violations.push({ code: 'ZERO_VALUE_CREDIT' });
  }

  if (input.against && input.total.compare(input.against.invoiceTotal) > 0) {
    violations.push({
      code: 'CREDIT_EXCEEDS_INVOICE',
      invoiceId: input.against.invoiceId,
      credit: input.total.toDecimalString(),
      invoiceTotal: input.against.invoiceTotal.toDecimalString(),
    });
  }

  return violations.length > 0 ? err(violations) : ok(input);
}

/**
 * Tax evidence for a credit note is recorded with NEGATIVE amounts.
 *
 * The SST return is summed from `tax_transaction`, so a credit must reduce the
 * period's output tax. Storing it positive and relying on the document type to
 * decide the sign at report time would put the sign convention in every query
 * that ever touches the table — and one of them would eventually get it wrong.
 */
export function negateTaxAmounts(
  lines: readonly { taxableAmount: Money; taxAmount: Money }[],
): { taxableAmount: Money; taxAmount: Money }[] {
  return lines.map((l) => ({
    taxableAmount: l.taxableAmount.negate(),
    taxAmount: l.taxAmount.negate(),
  }));
}

export type { Currency };
