/**
 * LHDN e-Invoice (MyInvois) — M6, domain layer.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ VERIFICATION REQUIRED BEFORE PRODUCTION USE
 *
 * The MyInvois wire format, field names, code lists, validation rules and
 * cancellation window MUST be confirmed against LHDN's published SDK before
 * this talks to the real gateway. Nothing in this file asserts a statutory
 * value: every threshold, window and code list arrives as configuration.
 *
 * The structure below is deliberately a NEUTRAL INTERMEDIATE, not the wire
 * payload. Validation and completeness logic operate on `EInvoiceDocument`,
 * and serialisation to LHDN's UBL 2.1 JSON is a thin separate layer. If the
 * wire format turns out to differ from what a serialiser assumes, only the
 * serialiser changes — the field-completeness rules, the state machine and
 * the tests all survive.
 *
 * That indirection is the point. It is cheap now and expensive to retrofit.
 * ---------------------------------------------------------------------------
 *
 * Pure: no IO, no clock, no HTTP. Submission is a worker concern.
 */

import { Money, sumMoney, type Currency } from './money.js';
import { err, ok, type Result } from './result.js';

/**
 * Document types LHDN accepts. The self-billed variants are the ones generic
 * products get wrong: they are required for foreign suppliers, imported
 * services and other specified categories, where the BUYER issues the
 * document on the supplier's behalf.
 */
export type EInvoiceDocumentType =
  | 'INVOICE'
  | 'CREDIT_NOTE'
  | 'DEBIT_NOTE'
  | 'REFUND_NOTE'
  | 'SELF_BILLED_INVOICE'
  | 'SELF_BILLED_CREDIT_NOTE'
  | 'SELF_BILLED_DEBIT_NOTE'
  | 'SELF_BILLED_REFUND_NOTE';

export function isSelfBilled(type: EInvoiceDocumentType): boolean {
  return type.startsWith('SELF_BILLED_');
}

/** Secondary identifier type accompanying the TIN. */
export type TaxpayerIdType = 'BRN' | 'NRIC' | 'PASSPORT' | 'ARMY';

export interface PostalAddress {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly postcode: string;
  /** Malaysian state code. Verified against LHDN's state code list. */
  readonly stateCode: string;
  /** ISO 3166-1 alpha-2. */
  readonly countryCode: string;
}

export interface TaxpayerParty {
  readonly name: string;
  readonly tin: string;
  readonly idType: TaxpayerIdType;
  readonly idValue: string;
  readonly address: PostalAddress;
  readonly sstRegistrationNo?: string;
  readonly msicCode?: string;
  readonly businessActivity?: string;
  readonly email?: string;
  readonly phone?: string;
}

export interface EInvoiceLine {
  readonly lineNo: number;
  readonly description: string;
  /** LHDN item classification code. Per line, not per document. */
  readonly classificationCode: string;
  readonly quantity: string;
  readonly unitOfMeasure?: string;
  readonly unitPrice: Money;
  readonly discountAmount?: Money;
  readonly taxableAmount: Money;
  readonly taxAmount: Money;
  readonly taxRateBasisPoints: bigint;
  readonly taxExemptionReason?: string;
  readonly lineTotal: Money;
}

export interface EInvoiceDocument {
  readonly documentType: EInvoiceDocumentType;
  /** The supplier's own document number, e.g. INV-00042. */
  readonly documentNo: string;
  readonly issueDate: string;
  /** HH:MM:SSZ. LHDN records issuance to the second. */
  readonly issueTime: string;
  readonly currency: Currency;
  /** Required when currency is not MYR. */
  readonly exchangeRate?: string;
  readonly supplier: TaxpayerParty;
  readonly buyer: TaxpayerParty;
  readonly lines: readonly EInvoiceLine[];
  readonly subtotal: Money;
  readonly taxTotal: Money;
  readonly total: Money;
  /** For a credit/debit/refund note: the validated document being adjusted. */
  readonly originalReference?: {
    readonly documentNo: string;
    readonly lhdnUuid?: string;
    readonly reason: string;
  };
}

// ---------------------------------------------------------------------------
// Pre-submission validation
// ---------------------------------------------------------------------------

export type EInvoiceViolation =
  | { readonly code: 'MISSING_SUPPLIER_TIN' }
  | { readonly code: 'MISSING_BUYER_TIN' }
  | { readonly code: 'MISSING_SUPPLIER_MSIC' }
  | { readonly code: 'MALFORMED_TIN'; readonly party: 'SUPPLIER' | 'BUYER'; readonly tin: string }
  | { readonly code: 'MISSING_ID_VALUE'; readonly party: 'SUPPLIER' | 'BUYER' }
  | { readonly code: 'INCOMPLETE_ADDRESS'; readonly party: 'SUPPLIER' | 'BUYER'; readonly field: string }
  | { readonly code: 'NO_LINES' }
  | { readonly code: 'MISSING_CLASSIFICATION_CODE'; readonly lineNo: number }
  | { readonly code: 'UNKNOWN_CLASSIFICATION_CODE'; readonly lineNo: number; readonly value: string }
  | { readonly code: 'TOTALS_DO_NOT_RECONCILE'; readonly expected: string; readonly found: string }
  | { readonly code: 'TAX_TOTAL_MISMATCH'; readonly expected: string; readonly found: string }
  | { readonly code: 'MISSING_EXCHANGE_RATE'; readonly currency: Currency }
  | { readonly code: 'MISSING_ORIGINAL_REFERENCE'; readonly documentType: EInvoiceDocumentType }
  | { readonly code: 'INVALID_ISSUE_DATE'; readonly value: string };

export interface ValidatedEInvoice extends EInvoiceDocument {
  readonly _validated: true;
}

export interface EInvoiceValidationConfig {
  /**
   * Pattern the TIN must match. Supplied as configuration rather than
   * hardcoded, because the authoritative check is LHDN's TIN lookup — this is
   * a fast-fail convenience so a user sees the problem while they are still
   * looking at the form, not two minutes later in an async rejection.
   *
   * A local regex must never be treated as proof a TIN is valid.
   */
  readonly tinPattern?: RegExp;
  /** Known classification codes. Empty = skip the membership check. */
  readonly classificationCodes?: ReadonlySet<string>;
  readonly baseCurrency?: Currency;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a document against everything checkable locally.
 *
 * Run this at the point of issue, not after submission. A rejection that
 * arrives asynchronously two minutes later, when the user has moved on, is a
 * far worse experience than an error shown while the invoice is still open —
 * and the fields involved (TIN, classification codes) come from master data
 * the user can fix once rather than per document.
 */
export function validateForSubmission(
  doc: EInvoiceDocument,
  config: EInvoiceValidationConfig = {},
): Result<ValidatedEInvoice, EInvoiceViolation[]> {
  const violations: EInvoiceViolation[] = [];
  const baseCurrency = config.baseCurrency ?? 'MYR';

  if (!ISO_DATE.test(doc.issueDate) || Number.isNaN(Date.parse(doc.issueDate))) {
    violations.push({ code: 'INVALID_ISSUE_DATE', value: doc.issueDate });
  }

  // --- parties -------------------------------------------------------------
  if (!doc.supplier.tin) violations.push({ code: 'MISSING_SUPPLIER_TIN' });
  if (!doc.buyer.tin) violations.push({ code: 'MISSING_BUYER_TIN' });
  if (!doc.supplier.msicCode) violations.push({ code: 'MISSING_SUPPLIER_MSIC' });

  for (const [party, taxpayer] of [
    ['SUPPLIER', doc.supplier],
    ['BUYER', doc.buyer],
  ] as const) {
    if (taxpayer.tin && config.tinPattern && !config.tinPattern.test(taxpayer.tin)) {
      violations.push({ code: 'MALFORMED_TIN', party, tin: taxpayer.tin });
    }
    if (!taxpayer.idValue) {
      violations.push({ code: 'MISSING_ID_VALUE', party });
    }
    for (const field of ['line1', 'city', 'postcode', 'stateCode', 'countryCode'] as const) {
      if (!taxpayer.address?.[field]) {
        violations.push({ code: 'INCOMPLETE_ADDRESS', party, field });
      }
    }
  }

  // --- lines ---------------------------------------------------------------
  if (doc.lines.length === 0) {
    violations.push({ code: 'NO_LINES' });
  }

  for (const line of doc.lines) {
    if (!line.classificationCode) {
      violations.push({ code: 'MISSING_CLASSIFICATION_CODE', lineNo: line.lineNo });
    } else if (
      config.classificationCodes &&
      config.classificationCodes.size > 0 &&
      !config.classificationCodes.has(line.classificationCode)
    ) {
      violations.push({
        code: 'UNKNOWN_CLASSIFICATION_CODE',
        lineNo: line.lineNo,
        value: line.classificationCode,
      });
    }
  }

  // --- arithmetic ----------------------------------------------------------
  // The tax figure on the e-invoice must agree exactly with the ledger's tax
  // postings. A single shared rounding policy is what prevents an entire class
  // of rejection here.
  if (doc.lines.length > 0) {
    const lineSubtotal = sumMoney(doc.lines.map((l) => l.taxableAmount), doc.currency);
    const lineTax = sumMoney(doc.lines.map((l) => l.taxAmount), doc.currency);

    if (!lineSubtotal.equals(doc.subtotal)) {
      violations.push({
        code: 'TOTALS_DO_NOT_RECONCILE',
        expected: lineSubtotal.toDecimalString(),
        found: doc.subtotal.toDecimalString(),
      });
    }
    if (!lineTax.equals(doc.taxTotal)) {
      violations.push({
        code: 'TAX_TOTAL_MISMATCH',
        expected: lineTax.toDecimalString(),
        found: doc.taxTotal.toDecimalString(),
      });
    }
    if (!doc.subtotal.add(doc.taxTotal).equals(doc.total)) {
      violations.push({
        code: 'TOTALS_DO_NOT_RECONCILE',
        expected: doc.subtotal.add(doc.taxTotal).toDecimalString(),
        found: doc.total.toDecimalString(),
      });
    }
  }

  if (doc.currency !== baseCurrency && !doc.exchangeRate) {
    violations.push({ code: 'MISSING_EXCHANGE_RATE', currency: doc.currency });
  }

  // --- adjustment documents ------------------------------------------------
  const isAdjustment =
    doc.documentType.includes('CREDIT_NOTE') ||
    doc.documentType.includes('DEBIT_NOTE') ||
    doc.documentType.includes('REFUND_NOTE');

  if (isAdjustment && !doc.originalReference) {
    violations.push({ code: 'MISSING_ORIGINAL_REFERENCE', documentType: doc.documentType });
  }

  return violations.length > 0 ? err(violations) : ok({ ...doc, _validated: true });
}

// ---------------------------------------------------------------------------
// Submission lifecycle
// ---------------------------------------------------------------------------

export type SubmissionStatus =
  /** Queued locally; LHDN has not seen it. */
  | 'QUEUED'
  /** Accepted for processing; awaiting a validation outcome. */
  | 'SUBMITTED'
  /** Validated. Carries the LHDN UUID and the QR/validation link. */
  | 'VALID'
  /** Rejected by validation. Correctable and resubmittable. */
  | 'INVALID'
  /** Buyer has asked the supplier to reject it; awaiting the supplier. */
  | 'REJECTION_REQUESTED'
  /** Cancelled within the permitted window. Terminal. */
  | 'CANCELLED';

export type SubmissionEvent =
  | { readonly type: 'SUBMIT' }
  | { readonly type: 'ACCEPTED'; readonly submissionUid: string }
  | { readonly type: 'VALIDATED'; readonly lhdnUuid: string; readonly longId: string; readonly validatedAt: string }
  | { readonly type: 'REJECTED_BY_VALIDATION'; readonly errorCode: string; readonly detail?: unknown }
  | { readonly type: 'BUYER_REQUESTED_REJECTION'; readonly reason: string }
  | { readonly type: 'SUPPLIER_DECLINED_REJECTION' }
  | { readonly type: 'CANCELLED'; readonly reason: string }
  | { readonly type: 'RETRY' };

export type TransitionViolation = {
  readonly code: 'ILLEGAL_TRANSITION';
  readonly from: SubmissionStatus;
  readonly event: SubmissionEvent['type'];
};

/**
 * The submission state machine.
 *
 * Modelled explicitly because the lifecycle has real deadlines attached and
 * because "what state is this invoice in with LHDN" is a question the UI has
 * to answer precisely. An `enum` plus scattered `if` statements loses the
 * legality of transitions, which is the part that matters.
 */
export function transition(
  from: SubmissionStatus,
  event: SubmissionEvent,
): Result<SubmissionStatus, TransitionViolation> {
  const illegal = err({ code: 'ILLEGAL_TRANSITION' as const, from, event: event.type });

  switch (from) {
    case 'QUEUED':
      if (event.type === 'SUBMIT') return ok('SUBMITTED');
      if (event.type === 'ACCEPTED') return ok('SUBMITTED');
      return illegal;

    case 'SUBMITTED':
      if (event.type === 'VALIDATED') return ok('VALID');
      if (event.type === 'REJECTED_BY_VALIDATION') return ok('INVALID');
      return illegal;

    case 'INVALID':
      // Corrected and resubmitted.
      if (event.type === 'RETRY' || event.type === 'SUBMIT') return ok('QUEUED');
      return illegal;

    case 'VALID':
      if (event.type === 'BUYER_REQUESTED_REJECTION') return ok('REJECTION_REQUESTED');
      if (event.type === 'CANCELLED') return ok('CANCELLED');
      return illegal;

    case 'REJECTION_REQUESTED':
      if (event.type === 'CANCELLED') return ok('CANCELLED');
      if (event.type === 'SUPPLIER_DECLINED_REJECTION') return ok('VALID');
      return illegal;

    case 'CANCELLED':
      // Terminal. After the window closes the only correction is a credit note.
      return illegal;
  }
}

export function isTerminal(status: SubmissionStatus): boolean {
  return status === 'CANCELLED';
}

/** A submission still waiting on LHDN. */
export function isPending(status: SubmissionStatus): boolean {
  return status === 'QUEUED' || status === 'SUBMITTED';
}

// ---------------------------------------------------------------------------
// Cancellation window
// ---------------------------------------------------------------------------

export interface CancellationWindow {
  readonly deadline: string;
  readonly cancellable: boolean;
  readonly hoursRemaining: number;
}

/**
 * When the supplier's right to cancel a validated document expires.
 *
 * `windowHours` is CONFIGURATION, never a constant. The statutory window has
 * changed before and the working agreements forbid hardcoding it — see
 * docs/architecture/05-malaysia-localization.md §5.1.
 *
 * `now` is passed in rather than read from a clock, so the function stays pure
 * and the boundary behaviour is testable.
 */
export function cancellationWindow(
  validatedAt: string,
  now: string,
  windowHours: number,
): CancellationWindow {
  const validated = Date.parse(validatedAt);
  const current = Date.parse(now);

  if (Number.isNaN(validated) || Number.isNaN(current)) {
    throw new TypeError(`Invalid timestamp: validatedAt=${validatedAt}, now=${now}`);
  }

  const deadlineMs = validated + windowHours * 3_600_000;
  const remainingMs = deadlineMs - current;

  return {
    deadline: new Date(deadlineMs).toISOString(),
    cancellable: remainingMs > 0,
    // Rounded down: showing "1 hour remaining" when 59 minutes are left is a
    // promise the system cannot keep.
    hoursRemaining: Math.max(0, Math.floor(remainingMs / 3_600_000)),
  };
}

// ---------------------------------------------------------------------------
// The gateway port
// ---------------------------------------------------------------------------

export interface SubmissionReceipt {
  readonly submissionUid: string;
  readonly acceptedDocumentNos: readonly string[];
  readonly rejectedDocuments: readonly { documentNo: string; errorCode: string; detail?: unknown }[];
}

export interface SubmissionOutcome {
  readonly documentNo: string;
  readonly status: 'VALID' | 'INVALID';
  readonly lhdnUuid?: string;
  readonly longId?: string;
  readonly validatedAt?: string;
  readonly qrUrl?: string;
  readonly errorCode?: string;
  readonly detail?: unknown;
}

/**
 * What a MyInvois client must provide.
 *
 * Declared as a port with NO implementation in this repository. Writing a
 * speculative HTTP client against endpoint paths and payload shapes that
 * cannot be verified here would produce code that looks finished and is
 * probably wrong — worse than an obvious gap, because it invites trust.
 *
 * The adapter is built against LHDN's published SDK and tested against their
 * sandbox. Everything above this line is verifiable without it.
 */
export interface MyInvoisGateway {
  submit(documents: readonly ValidatedEInvoice[]): Promise<SubmissionReceipt>;
  getStatus(submissionUid: string): Promise<readonly SubmissionOutcome[]>;
  cancel(lhdnUuid: string, reason: string): Promise<void>;
}
