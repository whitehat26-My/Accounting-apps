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

// ---------------------------------------------------------------------------
// Crediting from the original document
// ---------------------------------------------------------------------------

/**
 * One line of the document being corrected, as the deriver sees it.
 *
 * `quantity` is a decimal STRING, matching how it travels everywhere else in
 * this codebase — see `document.ts` on why quantities are scaled integers
 * internally and strings at every boundary.
 */
export interface CorrectableLine {
  readonly sourceLineId: string;
  readonly lineNo: number;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: Money;
  readonly accountId: string;
  readonly taxCodeId: string;
  readonly discountBasisPoints?: number;
  readonly classificationCode?: string;
  readonly itemId?: string;
  /** Quantity already reversed by earlier credit notes against this line. */
  readonly alreadyCredited: string;
}

/** What the caller wants to credit. Omit `lines` to credit the whole invoice. */
export interface CorrectionSelection {
  readonly lines?: readonly { sourceLineId: string; quantity?: string }[];
}

export interface DerivedCorrectionLine {
  readonly sourceLineId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: Money;
  readonly accountId: string;
  readonly taxCodeId: string;
  readonly discountBasisPoints?: number;
  readonly classificationCode?: string;
  readonly itemId?: string;
}

export type CorrectionDerivationViolation =
  | { readonly code: 'NO_SUCH_LINE'; readonly sourceLineId: string }
  | { readonly code: 'NOTHING_TO_CREDIT' }
  | {
      readonly code: 'EXCEEDS_REMAINING';
      readonly sourceLineId: string;
      readonly requested: string;
      readonly remaining: string;
    }
  | { readonly code: 'NON_POSITIVE_QUANTITY'; readonly sourceLineId: string; readonly quantity: string };

/** Quantities are decimal strings; compare them as scaled integers, not floats. */
const QUANTITY_SCALE = 4;

function toScaled(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;

  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > QUANTITY_SCALE) return null;

  return BigInt(`${whole}${fraction.padEnd(QUANTITY_SCALE, '0')}`);
}

function fromScaled(units: bigint): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(QUANTITY_SCALE + 1, '0');
  const whole = digits.slice(0, -QUANTITY_SCALE);
  const fraction = digits.slice(-QUANTITY_SCALE).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Build a credit note's lines from the invoice it corrects.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIGURE COMES FROM THE ORIGINAL. THAT IS THE ENTIRE POINT.
 *
 * A credit note reverses a supply that already happened, so its price, account,
 * tax code and classification are the ones that supply carried — not today's.
 * Retyping them by hand, which is what this system required until now, means:
 *
 *   * a price typed at today's list rather than what the customer was charged,
 *     with the difference landing in revenue and nothing flagging it;
 *   * a different tax code, so the SST reversed is not the SST charged;
 *   * a different revenue account, so the credit lands somewhere the sale did
 *     not and both accounts are wrong by the same amount.
 *
 * The RATE is a separate matter and is not decided here: it follows from the
 * original supply's tax point, which the caller passes to the tax engine. See
 * migration 0023 — computing a 2023 supply's reversal at 2026's rate is what
 * made pre-2024 invoices impossible to credit at all.
 * ---------------------------------------------------------------------------
 *
 * Over-crediting is refused PER LINE rather than only on the document total.
 * A document-level check passes happily when one line is credited twice and
 * another not at all, which nets to the right total and is two wrong lines.
 */
export function deriveCorrectionLines(
  documentLines: readonly CorrectableLine[],
  selection: CorrectionSelection = {},
): Result<DerivedCorrectionLine[], CorrectionDerivationViolation[]> {
  const violations: CorrectionDerivationViolation[] = [];
  const byId = new Map(documentLines.map((l) => [l.sourceLineId, l]));

  /*
   * No selection means the whole invoice — specifically, everything not yet
   * credited, so crediting the rest of a partly-credited invoice is an
   * ordinary thing to do rather than an error.
   *
   * Whether the caller NAMED the lines changes what a fully-credited line
   * means, which is why the distinction is kept rather than normalised away:
   *
   *   * implicit — skip it. "Credit whatever is left" over a line with nothing
   *     left is not a mistake.
   *   * explicit — refuse. Naming a line and getting silence back is how a user
   *     concludes the credit went through when it did not, and reporting
   *     "every line has already been credited" when only THIS one has is a
   *     false statement about the rest of the invoice.
   */
  const explicit = selection.lines !== undefined;
  const requested =
    selection.lines ??
    documentLines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: undefined }));

  const derived: DerivedCorrectionLine[] = [];

  for (const request of requested) {
    const line = byId.get(request.sourceLineId);
    if (!line) {
      violations.push({ code: 'NO_SUCH_LINE', sourceLineId: request.sourceLineId });
      continue;
    }

    const invoiced = toScaled(line.quantity);
    const credited = toScaled(line.alreadyCredited);
    if (invoiced === null || credited === null) {
      violations.push({
        code: 'NON_POSITIVE_QUANTITY',
        sourceLineId: line.sourceLineId,
        quantity: line.quantity,
      });
      continue;
    }

    const remaining = invoiced - credited;

    let wanted: bigint;
    if (request.quantity === undefined) {
      if (remaining <= 0n) {
        // Named explicitly, and there is nothing left of it — see above.
        if (explicit) {
          violations.push({
            code: 'EXCEEDS_REMAINING',
            sourceLineId: line.sourceLineId,
            requested: fromScaled(invoiced),
            remaining: '0',
          });
        }
        continue;
      }
      wanted = remaining;
    } else {
      const parsed = toScaled(request.quantity);
      if (parsed === null || parsed <= 0n) {
        violations.push({
          code: 'NON_POSITIVE_QUANTITY',
          sourceLineId: line.sourceLineId,
          quantity: request.quantity,
        });
        continue;
      }
      wanted = parsed;
    }

    if (wanted > remaining) {
      violations.push({
        code: 'EXCEEDS_REMAINING',
        sourceLineId: line.sourceLineId,
        requested: fromScaled(wanted),
        remaining: fromScaled(remaining > 0n ? remaining : 0n),
      });
      continue;
    }

    derived.push({
      sourceLineId: line.sourceLineId,
      description: line.description,
      quantity: fromScaled(wanted),
      unitPrice: line.unitPrice,
      accountId: line.accountId,
      taxCodeId: line.taxCodeId,
      ...(line.discountBasisPoints !== undefined
        ? { discountBasisPoints: line.discountBasisPoints }
        : {}),
      ...(line.classificationCode !== undefined
        ? { classificationCode: line.classificationCode }
        : {}),
      ...(line.itemId !== undefined ? { itemId: line.itemId } : {}),
    });
  }

  if (violations.length > 0) return err(violations);

  if (derived.length === 0) {
    // Distinguished from an empty request: every line was already fully
    // credited. Silently issuing a zero-value credit note would be worse — it
    // allocates nothing, reverses nothing, and consumes a document number that
    // an auditor will later ask about.
    return err([{ code: 'NOTHING_TO_CREDIT' }]);
  }

  return ok(derived);
}
