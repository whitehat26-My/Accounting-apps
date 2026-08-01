import { createHash } from 'node:crypto';
import {
  cancellationWindow,
  isErr,
  Money,
  transition,
  validateForSubmission,
  type EInvoiceDocument,
  type EInvoiceDocumentType,
  type EInvoiceLine,
  type SubmissionEvent,
  type SubmissionStatus,
  type TaxpayerParty,
  type ValidatedEInvoice,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';

/**
 * MyInvois submission lifecycle — M6, persistence layer.
 *
 * The rule that shapes this module: ISSUANCE IS NEVER BLOCKED BY LHDN.
 * `issueInvoice()` posts the ledger entry and writes an `invoice.issued`
 * outbox event; a worker picks that up and calls this. A gateway outage
 * delays compliance, it does not stop a business from invoicing.
 *
 * There is no HTTP client here. `MyInvoisGateway` is a port declared in the
 * domain layer, and the adapter is written against LHDN's published SDK and
 * tested against their sandbox. Everything in this file is verifiable without
 * touching the network.
 */

export class EInvoiceError extends Error {
  constructor(
    readonly code:
      | 'DOCUMENT_NOT_FOUND'
      | 'NOT_ENABLED'
      | 'DOCUMENT_INVALID'
      | 'ILLEGAL_TRANSITION'
      | 'WINDOW_CLOSED'
      | 'NO_SUBMISSION',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'EInvoiceError';
  }
}

export interface EInvoiceConfig {
  readonly isEnabled: boolean;
  readonly cancellationWindowHours: number;
  readonly tinPattern: string | null;
  readonly consolidationDueDays: number;
  readonly environment: 'SANDBOX' | 'PRODUCTION';
}

const DEFAULT_CONFIG: EInvoiceConfig = {
  isEnabled: false,
  cancellationWindowHours: 72,
  tinPattern: null,
  consolidationDueDays: 7,
  environment: 'SANDBOX',
};

export async function loadConfig(tx: Tx, ctx: TenantContext): Promise<EInvoiceConfig> {
  const [row] = await tx<
    {
      is_enabled: boolean;
      cancellation_window_hours: number;
      tin_pattern: string | null;
      consolidation_due_days: number;
      environment: 'SANDBOX' | 'PRODUCTION';
    }[]
  >`
      SELECT is_enabled, cancellation_window_hours, tin_pattern,
             consolidation_due_days, environment
        FROM einvoice_config WHERE tenant_id = ${ctx.tenantId}
  `;

  if (!row) return DEFAULT_CONFIG;

  return {
    isEnabled: row.is_enabled,
    cancellationWindowHours: row.cancellation_window_hours,
    tinPattern: row.tin_pattern,
    consolidationDueDays: row.consolidation_due_days,
    environment: row.environment,
  };
}

// ---------------------------------------------------------------------------
// Building the document from ledger data
// ---------------------------------------------------------------------------

/**
 * Assemble the neutral e-invoice document for an issued invoice.
 *
 * Reads only. Everything it needs was captured when the contact, the items and
 * the invoice were created — which is precisely why the Malaysian identity
 * block is modelled as first-class columns on `contact` rather than as custom
 * fields discovered at submission time.
 */
export async function buildInvoiceDocument(
  tx: Tx,
  ctx: TenantContext,
  invoiceId: string,
  issueTime = '00:00:00Z',
): Promise<EInvoiceDocument> {
  const [invoice] = await tx<
    {
      id: string; invoice_no: string; issue_date: Date; currency: string; fx_rate: string;
      subtotal: string; tax_total: string; total: string; contact_id: string;
    }[]
  >`
      SELECT id, invoice_no, issue_date, currency, fx_rate, subtotal, tax_total, total, contact_id
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId} AND id = ${invoiceId} AND status <> 'DRAFT'
  `;

  if (!invoice) {
    throw new EInvoiceError('DOCUMENT_NOT_FOUND', `Issued invoice ${invoiceId} not found`);
  }

  const supplier = await loadSupplier(tx, ctx);
  const buyer = await loadBuyer(tx, ctx, invoice.contact_id);

  const lineRows = await tx<
    {
      line_no: number; description: string; quantity: string; unit_price: string;
      taxable_amount: string; tax_amount: string; line_total: string;
      classification_code: string | null; rate_basis_points: number | null;
    }[]
  >`
      SELECT l.line_no, l.description, l.quantity, l.unit_price,
             l.taxable_amount, l.tax_amount, l.line_total, l.classification_code,
             (SELECT v.rate_basis_points
                FROM tax_rate_version v
               WHERE v.tenant_id = l.tenant_id
                 AND v.tax_code_id = l.tax_code_id
                 AND i.tax_point_date BETWEEN v.valid_from
                                          AND COALESCE(v.valid_to, 'infinity'::date)
               LIMIT 1) AS rate_basis_points
        FROM invoice_line l
        JOIN invoice i ON i.tenant_id = l.tenant_id AND i.id = l.invoice_id
       WHERE l.tenant_id = ${ctx.tenantId} AND l.invoice_id = ${invoiceId}
       ORDER BY l.line_no
  `;

  const currency = invoice.currency;

  const lines: EInvoiceLine[] = lineRows.map((r) => ({
    lineNo: r.line_no,
    description: r.description,
    classificationCode: r.classification_code ?? '',
    quantity: r.quantity,
    unitPrice: Money.fromDecimal(r.unit_price, currency),
    taxableAmount: Money.fromDecimal(r.taxable_amount, currency),
    taxAmount: Money.fromDecimal(r.tax_amount, currency),
    taxRateBasisPoints: BigInt(r.rate_basis_points ?? 0),
    lineTotal: Money.fromDecimal(r.line_total, currency),
  }));

  return {
    documentType: 'INVOICE',
    documentNo: invoice.invoice_no,
    issueDate: toIsoDate(invoice.issue_date),
    issueTime,
    currency,
    ...(currency !== 'MYR' ? { exchangeRate: invoice.fx_rate } : {}),
    supplier,
    buyer,
    lines,
    subtotal: Money.fromDecimal(invoice.subtotal, currency),
    taxTotal: Money.fromDecimal(invoice.tax_total, currency),
    total: Money.fromDecimal(invoice.total, currency),
  };
}

/** The credit-note equivalent, carrying the mandatory original reference. */
export async function buildCreditNoteDocument(
  tx: Tx,
  ctx: TenantContext,
  creditNoteId: string,
  issueTime = '00:00:00Z',
): Promise<EInvoiceDocument> {
  const [cn] = await tx<
    {
      id: string; credit_note_no: string; credit_date: Date; currency: string;
      subtotal: string; tax_total: string; total: string; contact_id: string;
      invoice_id: string | null; reason: string;
    }[]
  >`
      SELECT id, credit_note_no, credit_date, currency, subtotal, tax_total,
             total, contact_id, invoice_id, reason
        FROM credit_note
       WHERE tenant_id = ${ctx.tenantId} AND id = ${creditNoteId} AND status <> 'DRAFT'
  `;

  if (!cn) {
    throw new EInvoiceError('DOCUMENT_NOT_FOUND', `Issued credit note ${creditNoteId} not found`);
  }

  const supplier = await loadSupplier(tx, ctx);
  const buyer = await loadBuyer(tx, ctx, cn.contact_id);

  const lineRows = await tx<
    {
      line_no: number; description: string; quantity: string; unit_price: string;
      taxable_amount: string; tax_amount: string; line_total: string;
      classification_code: string | null;
    }[]
  >`
      SELECT line_no, description, quantity, unit_price, taxable_amount,
             tax_amount, line_total, classification_code
        FROM credit_note_line
       WHERE tenant_id = ${ctx.tenantId} AND credit_note_id = ${creditNoteId}
       ORDER BY line_no
  `;

  const currency = cn.currency;

  // The original must be referenced by its LHDN UUID where it has one, because
  // that is the identifier LHDN matches on.
  let originalReference: EInvoiceDocument['originalReference'];
  if (cn.invoice_id) {
    const [original] = await tx<{ invoice_no: string; lhdn_uuid: string | null }[]>`
        SELECT i.invoice_no, s.lhdn_uuid
          FROM invoice i
          LEFT JOIN einvoice_submission s
            ON s.tenant_id = i.tenant_id
           AND s.document_type = 'INVOICE'
           AND s.document_id = i.id
         WHERE i.tenant_id = ${ctx.tenantId} AND i.id = ${cn.invoice_id}
    `;
    if (original) {
      originalReference = {
        documentNo: original.invoice_no,
        ...(original.lhdn_uuid ? { lhdnUuid: original.lhdn_uuid } : {}),
        reason: cn.reason,
      };
    }
  }

  return {
    documentType: 'CREDIT_NOTE',
    documentNo: cn.credit_note_no,
    issueDate: toIsoDate(cn.credit_date),
    issueTime,
    currency,
    supplier,
    buyer,
    lines: lineRows.map((r) => ({
      lineNo: r.line_no,
      description: r.description,
      classificationCode: r.classification_code ?? '',
      quantity: r.quantity,
      unitPrice: Money.fromDecimal(r.unit_price, currency),
      taxableAmount: Money.fromDecimal(r.taxable_amount, currency),
      taxAmount: Money.fromDecimal(r.tax_amount, currency),
      taxRateBasisPoints: 0n,
      lineTotal: Money.fromDecimal(r.line_total, currency),
    })),
    subtotal: Money.fromDecimal(cn.subtotal, currency),
    taxTotal: Money.fromDecimal(cn.tax_total, currency),
    total: Money.fromDecimal(cn.total, currency),
    ...(originalReference ? { originalReference } : {}),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface QueuedSubmission {
  readonly id: string;
  readonly documentNo: string;
  readonly status: SubmissionStatus;
  readonly attemptCount: number;
}

/**
 * Validate a document and queue it. Does NOT contact LHDN.
 *
 * Validation runs here, at queue time, so a problem surfaces against the
 * document the user just issued rather than as an async rejection minutes
 * later. Every violation it can find is local — TIN, classification codes,
 * arithmetic — and all of it is fixable in master data.
 */
export async function queueSubmission(
  tx: Tx,
  ctx: TenantContext,
  document: EInvoiceDocument,
  documentId: string,
): Promise<QueuedSubmission> {
  const config = await loadConfig(tx, ctx);
  if (!config.isEnabled) {
    throw new EInvoiceError('NOT_ENABLED', 'e-Invoice is not enabled for this organisation');
  }

  const codes = await tx<{ code: string }[]>`
      SELECT code FROM einvoice_classification_code WHERE is_active
  `;

  const validated = validateForSubmission(document, {
    ...(config.tinPattern ? { tinPattern: new RegExp(config.tinPattern) } : {}),
    classificationCodes: new Set(codes.map((c) => c.code)),
  });

  if (isErr(validated)) {
    throw new EInvoiceError(
      'DOCUMENT_INVALID',
      `Document ${document.documentNo} cannot be submitted`,
      validated.error,
    );
  }

  const [row] = await tx<{ id: string; attempt_count: number }[]>`
      INSERT INTO einvoice_submission (
          tenant_id, document_type, document_id, document_no, status
      ) VALUES (
          ${ctx.tenantId}, ${document.documentType}, ${documentId},
          ${document.documentNo}, 'QUEUED'
      )
      ON CONFLICT (tenant_id, document_type, document_id) DO UPDATE
      SET status        = 'QUEUED',
          error_code    = NULL,
          error_detail  = NULL,
          attempt_count = einvoice_submission.attempt_count + 1
      RETURNING id, attempt_count
  `;

  await storePayload(tx, ctx, row!.id, row!.attempt_count, validated.value);
  await recordEvent(tx, ctx, row!.id, 'QUEUED', null, 'QUEUED', 'SYSTEM');

  return {
    id: row!.id,
    documentNo: document.documentNo,
    status: 'QUEUED',
    attemptCount: row!.attempt_count,
  };
}

/**
 * Apply a lifecycle event, enforcing the state machine.
 *
 * The transition is checked in the pure domain layer; this function only
 * persists the outcome and appends to the compliance log.
 */
export async function applyEvent(
  tx: Tx,
  ctx: TenantContext,
  submissionId: string,
  event: SubmissionEvent,
  actor: 'SUPPLIER' | 'BUYER' | 'LHDN' | 'SYSTEM' = 'LHDN',
  rawResponse?: unknown,
): Promise<SubmissionStatus> {
  const [current] = await tx<{ status: SubmissionStatus; document_no: string }[]>`
      SELECT status, document_no FROM einvoice_submission
       WHERE tenant_id = ${ctx.tenantId} AND id = ${submissionId}
         FOR UPDATE
  `;

  if (!current) {
    throw new EInvoiceError('NO_SUBMISSION', `Submission ${submissionId} not found`);
  }

  const next = transition(current.status, event);
  if (isErr(next)) {
    throw new EInvoiceError(
      'ILLEGAL_TRANSITION',
      `Cannot apply ${event.type} to a submission in state ${current.status}`,
      next.error,
    );
  }

  switch (event.type) {
    case 'SUBMIT':
      await tx`
          UPDATE einvoice_submission
             SET status = ${next.value}, submitted_at = now()
           WHERE tenant_id = ${ctx.tenantId} AND id = ${submissionId}
      `;
      break;

    case 'ACCEPTED':
      await tx`
          UPDATE einvoice_submission
             SET status = ${next.value}, submission_uid = ${event.submissionUid},
                 submitted_at = COALESCE(submitted_at, now())
           WHERE tenant_id = ${ctx.tenantId} AND id = ${submissionId}
      `;
      break;

    case 'VALIDATED':
      await tx`
          UPDATE einvoice_submission
             SET status = ${next.value}, lhdn_uuid = ${event.lhdnUuid},
                 long_id = ${event.longId}, validated_at = ${event.validatedAt},
                 error_code = NULL, error_detail = NULL
           WHERE tenant_id = ${ctx.tenantId} AND id = ${submissionId}
      `;
      break;

    case 'REJECTED_BY_VALIDATION':
      await tx`
          UPDATE einvoice_submission
             SET status = ${next.value}, error_code = ${event.errorCode},
                 error_detail = ${tx.json((event.detail ?? null) as never)}
           WHERE tenant_id = ${ctx.tenantId} AND id = ${submissionId}
      `;
      break;

    case 'CANCELLED':
      await tx`
          UPDATE einvoice_submission
             SET status = ${next.value}, cancelled_at = now()
           WHERE tenant_id = ${ctx.tenantId} AND id = ${submissionId}
      `;
      break;

    default:
      await tx`
          UPDATE einvoice_submission SET status = ${next.value}
           WHERE tenant_id = ${ctx.tenantId} AND id = ${submissionId}
      `;
  }

  await recordEvent(tx, ctx, submissionId, event.type, current.status, next.value, actor, rawResponse);

  return next.value;
}

/**
 * Cancel a validated document, refusing once the window has closed.
 *
 * `now` is a parameter rather than a clock read so the boundary is testable
 * and the caller controls the reference time.
 */
export async function cancelSubmission(
  tx: Tx,
  ctx: TenantContext,
  submissionId: string,
  reason: string,
  now: string,
): Promise<SubmissionStatus> {
  const [row] = await tx<{ status: SubmissionStatus; validated_at: Date | null; document_no: string }[]>`
      SELECT status, validated_at, document_no FROM einvoice_submission
       WHERE tenant_id = ${ctx.tenantId} AND id = ${submissionId}
         FOR UPDATE
  `;

  if (!row) throw new EInvoiceError('NO_SUBMISSION', `Submission ${submissionId} not found`);

  if (row.validated_at) {
    const config = await loadConfig(tx, ctx);
    const window = cancellationWindow(
      row.validated_at.toISOString(),
      now,
      config.cancellationWindowHours,
    );

    if (!window.cancellable) {
      throw new EInvoiceError(
        'WINDOW_CLOSED',
        `The cancellation window for ${row.document_no} closed at ${window.deadline}. ` +
          'Raise a credit note instead.',
      );
    }
  }

  return applyEvent(tx, ctx, submissionId, { type: 'CANCELLED', reason }, 'SUPPLIER');
}

/** Submissions due for a submit or status-poll attempt. */
export async function dueForAttempt(
  tx: Tx,
  ctx: TenantContext,
  now: string,
  limit = 50,
): Promise<QueuedSubmission[]> {
  const rows = await tx<
    { id: string; document_no: string; status: SubmissionStatus; attempt_count: number }[]
  >`
      SELECT id, document_no, status, attempt_count
        FROM einvoice_submission
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('QUEUED','SUBMITTED')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}::timestamptz)
       ORDER BY created_at
       LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
  `;

  return rows.map((r) => ({
    id: r.id,
    documentNo: r.document_no,
    status: r.status,
    attemptCount: r.attempt_count,
  }));
}

/**
 * Schedule the next attempt with exponential backoff.
 *
 * Backoff is computed from the attempt count rather than stored per-row so
 * the policy can change without a migration.
 */
export async function scheduleRetry(
  tx: Tx,
  ctx: TenantContext,
  submissionId: string,
  now: string,
  baseDelaySeconds = 60,
  maxDelaySeconds = 3600,
): Promise<string> {
  const [row] = await tx<{ attempt_count: number }[]>`
      SELECT attempt_count FROM einvoice_submission
       WHERE tenant_id = ${ctx.tenantId} AND id = ${submissionId}
  `;
  if (!row) throw new EInvoiceError('NO_SUBMISSION', `Submission ${submissionId} not found`);

  const delay = Math.min(baseDelaySeconds * 2 ** row.attempt_count, maxDelaySeconds);
  const nextAt = new Date(Date.parse(now) + delay * 1000).toISOString();

  await tx`
      UPDATE einvoice_submission
         SET attempt_count = attempt_count + 1, next_attempt_at = ${nextAt}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${submissionId}
  `;

  return nextAt;
}

/** The compliance dashboard: how many documents sit in each state. */
export async function complianceSummary(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ status: SubmissionStatus; count: number }[]> {
  const rows = await tx<{ status: SubmissionStatus; count: string }[]>`
      SELECT status, COUNT(*)::text AS count
        FROM einvoice_submission
       WHERE tenant_id = ${ctx.tenantId}
       GROUP BY status
       ORDER BY status
  `;
  return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
}

// ------------------------------------------------------------------ internals

/**
 * Canonical JSON for the evidentiary payload.
 *
 * Two things plain JSON.stringify gets wrong here:
 *
 *  1. It throws on `bigint`, which the tax rate is. Rates are basis points as
 *     bigint precisely so they never become floats; they serialise as decimal
 *     strings, not numbers, so the round trip stays exact.
 *  2. Its key order follows construction order. That makes the payload hash
 *     depend on how the object was built rather than on what it contains — so
 *     a harmless reordering in the builder would change the hash of a document
 *     whose content is identical. Keys are sorted.
 *
 * Money serialises via its own toJSON() to { amount, currency } with exact
 * decimal strings.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalise);

  if (value !== null && typeof value === 'object') {
    const source =
      typeof (value as { toJSON?: () => unknown }).toJSON === 'function'
        ? (value as { toJSON: () => unknown }).toJSON()
        : value;

    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      return canonicalise(source);
    }

    const entries = Object.entries(source as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalise(v)]));
  }

  return value;
}

async function storePayload(
  tx: Tx,
  ctx: TenantContext,
  submissionId: string,
  attemptNo: number,
  document: ValidatedEInvoice,
): Promise<void> {
  const serialised = canonicalJson(document);
  const hash = createHash('sha256').update(serialised).digest();

  await tx`
      INSERT INTO einvoice_payload (tenant_id, submission_id, attempt_no, document, payload_hash)
      VALUES (${ctx.tenantId}, ${submissionId}, ${attemptNo},
              ${tx.json(JSON.parse(serialised) as never)}, ${hash})
      ON CONFLICT (tenant_id, submission_id, attempt_no) DO NOTHING
  `;
}

async function recordEvent(
  tx: Tx,
  ctx: TenantContext,
  submissionId: string,
  eventType: string,
  fromStatus: string | null,
  toStatus: string,
  actor: string,
  rawResponse?: unknown,
): Promise<void> {
  await tx`
      INSERT INTO einvoice_status_event (
          tenant_id, submission_id, event_type, from_status, to_status, actor, raw_response
      ) VALUES (
          ${ctx.tenantId}, ${submissionId}, ${eventType}, ${fromStatus}, ${toStatus},
          ${actor}, ${tx.json((rawResponse ?? null) as never)}
      )
  `;
}

async function loadSupplier(tx: Tx, ctx: TenantContext): Promise<TaxpayerParty> {
  const [org] = await tx<
    {
      name: string; tin: string | null; ssm_registration_no: string | null;
      sst_no: string | null; msic_code: string | null;
      address_line1: string | null; address_line2: string | null; city: string | null;
      postcode: string | null; state_code: string | null; country_code: string;
    }[]
  >`
      SELECT name, tin, ssm_registration_no, sst_no, msic_code,
             address_line1, address_line2, city, postcode, state_code, country_code
        FROM organisation WHERE id = ${ctx.tenantId}
  `;

  return {
    name: org?.name ?? '',
    tin: org?.tin ?? '',
    idType: 'BRN',
    idValue: org?.ssm_registration_no ?? '',
    address: {
      line1: org?.address_line1 ?? '',
      ...(org?.address_line2 ? { line2: org.address_line2 } : {}),
      city: org?.city ?? '',
      postcode: org?.postcode ?? '',
      stateCode: org?.state_code ?? '',
      countryCode: org?.country_code ?? 'MY',
    },
    ...(org?.sst_no ? { sstRegistrationNo: org.sst_no } : {}),
    ...(org?.msic_code ? { msicCode: org.msic_code } : {}),
  };
}

async function loadBuyer(tx: Tx, ctx: TenantContext, contactId: string): Promise<TaxpayerParty> {
  const [contact] = await tx<
    {
      name: string; tin: string | null; id_type: TaxpayerParty['idType'] | null;
      id_value: string | null; sst_no: string | null; msic_code: string | null;
      email: string | null; phone: string | null;
    }[]
  >`
      SELECT name, tin, id_type, id_value, sst_no, msic_code, email, phone
        FROM contact WHERE tenant_id = ${ctx.tenantId} AND id = ${contactId}
  `;

  const [address] = await tx<
    { line1: string; line2: string | null; city: string | null; postcode: string | null; state_code: string | null; country_code: string }[]
  >`
      SELECT line1, line2, city, postcode, state_code, country_code
        FROM contact_address
       WHERE tenant_id = ${ctx.tenantId} AND contact_id = ${contactId}
         AND address_type = 'BILLING'
       LIMIT 1
  `;

  return {
    name: contact?.name ?? '',
    tin: contact?.tin ?? '',
    idType: contact?.id_type ?? 'BRN',
    idValue: contact?.id_value ?? '',
    address: {
      line1: address?.line1 ?? '',
      ...(address?.line2 ? { line2: address.line2 } : {}),
      city: address?.city ?? '',
      postcode: address?.postcode ?? '',
      stateCode: address?.state_code ?? '',
      countryCode: address?.country_code ?? 'MY',
    },
    ...(contact?.sst_no ? { sstRegistrationNo: contact.sst_no } : {}),
    ...(contact?.msic_code ? { msicCode: contact.msic_code } : {}),
    ...(contact?.email ? { email: contact.email } : {}),
    ...(contact?.phone ? { phone: contact.phone } : {}),
  };
}

function toIsoDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

export type { EInvoiceDocumentType };
