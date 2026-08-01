import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  isErr,
  validateForSubmission,
  type EInvoiceDocument,
  type SubmissionEvent,
} from '@emil/domain';
import {
  applyEvent,
  buildCreditNoteDocument,
  buildInvoiceDocument,
  cancelSubmission,
  complianceSummary,
  dueForAttempt,
  loadConfig as loadEInvoiceConfig,
  queueSubmission,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';
import { ValidationError } from '../errors.js';

/**
 * MyInvois — the e-Invoice submission lifecycle.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE SENDS ANYTHING TO LHDN, AND THAT IS VISIBLE RATHER THAN HIDDEN.
 *
 * `MyInvoisGateway` is a port with no adapter: the wire format, field names,
 * code lists and cancellation window must be confirmed against LHDN's published
 * SDK and exercised against their sandbox, and a client written from
 * documentation alone would look finished and probably be wrong.
 *
 * So these routes cover everything that is genuinely ours — building the
 * document from the ledger, validating it, queueing it, tracking the lifecycle,
 * and the cancellation window — and `GET /einvoice/submissions/due` returns the
 * queue that nothing is draining. A growing number there is the honest symptom
 * of the missing adapter, and it is better seen than inferred.
 * ---------------------------------------------------------------------------
 */
@Controller('v1')
export class EInvoiceController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  // ---- Configuration -------------------------------------------------------

  @Requires('tax.read')
  @Get('einvoice/config')
  async config(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    const config = await withTenant(this.sql, ctx, (tx) => loadEInvoiceConfig(tx, ctx));

    return {
      ...config,
      // Stated on every read, because "enabled" here means "documents will be
      // built and queued", not "documents will reach LHDN".
      adapterConfigured: false,
      note:
        'Enabling e-Invoice builds, validates and queues documents. No MyInvois HTTP ' +
        'client exists in this build, so nothing is transmitted — queued submissions ' +
        'accumulate until an adapter is added. See GET /v1/readiness.',
    };
  }

  @Requires('tax.write')
  @Post('einvoice/config')
  async setConfig(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(configSchema, body);
    const ctx = tenantContextOf(request);

    await withTenant(this.sql, ctx, (tx) =>
      tx`
          INSERT INTO einvoice_config (
              tenant_id, is_enabled, cancellation_window_hours, tin_pattern,
              consolidation_due_days, environment
          ) VALUES (
              ${ctx.tenantId}, ${input.isEnabled ?? false},
              ${input.cancellationWindowHours ?? 72}, ${input.tinPattern ?? null},
              ${input.consolidationDueDays ?? 7}, ${input.environment ?? 'SANDBOX'}
          )
          ON CONFLICT (tenant_id) DO UPDATE
             SET is_enabled                = EXCLUDED.is_enabled,
                 cancellation_window_hours = EXCLUDED.cancellation_window_hours,
                 tin_pattern               = EXCLUDED.tin_pattern,
                 consolidation_due_days    = EXCLUDED.consolidation_due_days,
                 environment               = EXCLUDED.environment,
                 updated_at                = now()
      `,
    );

    return this.config(request);
  }

  // ---- Building and validating --------------------------------------------

  /**
   * Assemble the document and report what would stop it being accepted —
   * WITHOUT queueing anything.
   *
   * Every violation this can find is local and fixable in master data: a
   * missing buyer TIN, an absent classification code, arithmetic that does not
   * tie. Surfacing them against the invoice somebody just issued is far better
   * than as an async rejection later, and this route is how a user checks
   * before committing to a submission.
   */
  @Requires('invoice.read')
  @Get('invoices/:id/einvoice-document')
  async previewInvoiceDocument(
    @Param('id') invoiceId: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    const { document, config } = await withTenant(this.sql, ctx, async (tx) => ({
      document: await buildInvoiceDocument(tx, ctx, invoiceId),
      config: await loadEInvoiceConfig(tx, ctx),
    }));

    // The pattern is stored as text and compiled here. A malformed one is
    // ignored rather than fatal: a bad regex in configuration must not make an
    // invoice unpreviewable, and the TIN is checked authoritatively by LHDN
    // regardless — this pattern is only an early warning.
    const validation = compilePattern(config.tinPattern) !== undefined
      ? validateForSubmission(document, { tinPattern: compilePattern(config.tinPattern)! })
      : validateForSubmission(document);

    return {
      document: renderDocument(document),
      submittable: !isErr(validation),
      violations: isErr(validation) ? validation.error : [],
    };
  }

  @Requires('invoice.create')
  @Post('invoices/:id/einvoice')
  async submitInvoice(
    @Param('id') invoiceId: string,
    @Headers('idempotency-key') _idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, async (tx) => {
      const document = await buildInvoiceDocument(tx, ctx, invoiceId);
      return queueSubmission(tx, ctx, document, invoiceId);
    });
  }

  @Requires('creditnote.create')
  @Post('credit-notes/:id/einvoice')
  async submitCreditNote(
    @Param('id') creditNoteId: string,
    @Headers('idempotency-key') _idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, async (tx) => {
      const document = await buildCreditNoteDocument(tx, ctx, creditNoteId);
      return queueSubmission(tx, ctx, document, creditNoteId);
    });
  }

  // ---- The lifecycle -------------------------------------------------------

  @Requires('tax.read')
  @Get('einvoice/submissions')
  async listSubmissions(
    @Query('status') status: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    const rows = await withTenant(this.sql, ctx, (tx) =>
      tx<
        {
          id: string; document_no: string; document_type: string; status: string;
          attempt_count: number; lhdn_uuid: string | null; validated_at: Date | null;
          next_attempt_at: Date | null; error_code: string | null;
        }[]
      >`
          SELECT id, document_no, document_type, status, attempt_count,
                 lhdn_uuid, validated_at, next_attempt_at, error_code
            FROM einvoice_submission
           WHERE tenant_id = ${ctx.tenantId}
             AND (${status ?? null}::text IS NULL OR status = ${status ?? null})
           ORDER BY created_at DESC
           LIMIT 200
      `,
    );

    return {
      submissions: rows.map((r) => ({
        id: r.id,
        documentNo: r.document_no,
        documentType: r.document_type,
        status: r.status,
        attemptCount: r.attempt_count,
        lhdnUuid: r.lhdn_uuid,
        validatedAt: r.validated_at?.toISOString() ?? null,
        nextAttemptAt: r.next_attempt_at?.toISOString() ?? null,
        errorCode: r.error_code,
      })),
    };
  }

  /**
   * The queue a worker would drain.
   *
   * There is no worker. This route exists so that fact is observable from
   * outside the source tree: a count that only ever grows is the missing
   * adapter, stated as data rather than as a caveat in a README.
   */
  @Requires('tax.read')
  @Get('einvoice/submissions/due')
  async due(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    const submissions = await withTenant(this.sql, ctx, (tx) =>
      dueForAttempt(tx, ctx, new Date().toISOString()),
    );

    return {
      submissions,
      drainedBy: null,
      note:
        submissions.length > 0
          ? 'Nothing drains this queue in this build. These will not reach LHDN until a ' +
            'MyInvois adapter exists.'
          : 'Nothing is waiting.',
    };
  }

  /**
   * Report what LHDN said.
   *
   * ---------------------------------------------------------------------------
   * THIS IS THE ADAPTER SEAM, AND IT IS TRUSTED INPUT.
   *
   * A `VALIDATED` event carries an LHDN UUID and a long id that this system has
   * no way to verify — it did not make the call, so it cannot check the answer.
   * Anyone who can reach this route can therefore mark a document compliant
   * without it ever having been submitted.
   *
   * That is acceptable only because it requires `einvoice.submit` on an
   * authenticated tenant session, and because the alternative — an adapter that
   * writes to the database directly — is worse: it would bypass the state
   * machine, the transition rules and the compliance log. When a real adapter
   * exists it should authenticate as a service principal and come through here.
   * ---------------------------------------------------------------------------
   */
  @Requires('einvoice.submit')
  @Post('einvoice/submissions/:id/events')
  async recordEvent(
    @Param('id') submissionId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(eventSchema, body);
    const ctx = tenantContextOf(request);

    const status = await withTenant(this.sql, ctx, (tx) =>
      applyEvent(tx, ctx, submissionId, input.event as SubmissionEvent, input.actor ?? 'LHDN'),
    );

    return { submissionId, status };
  }

  /**
   * Cancel within the window.
   *
   * ⚠️ The 72-hour default is configurable and NOT confirmed against LHDN. The
   * window is a statutory deadline: cancelling outside it is not permitted, and
   * a wrong value here means either refusing a cancellation that was allowed or
   * accepting one that was not.
   */
  @Requires('einvoice.submit')
  @Post('einvoice/submissions/:id/cancel')
  async cancel(
    @Param('id') submissionId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const { reason } = parse(z.object({ reason: z.string().min(1).max(500) }), body);
    const ctx = tenantContextOf(request);

    const status = await withTenant(this.sql, ctx, (tx) =>
      cancelSubmission(tx, ctx, submissionId, reason, new Date().toISOString()),
    );

    return { submissionId, status };
  }

  @Requires('tax.read')
  @Get('einvoice/compliance')
  async compliance(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    const byStatus = await withTenant(this.sql, ctx, (tx) => complianceSummary(tx, ctx));

    const total = byStatus.reduce((sum, s) => sum + s.count, 0);
    // 'VALID' is LHDN's term for a document that passed validation.
    const validated = byStatus.find((s) => s.status === 'VALID')?.count ?? 0;

    return {
      byStatus,
      total,
      valid: validated,
      // Honest denominator: a document that was never transmitted is not
      // "pending approval", it is stuck.
      awaitingTransmission: byStatus
        .filter((s) => s.status === 'QUEUED' || s.status === 'SUBMITTED')
        .reduce((sum, s) => sum + s.count, 0),
    };
  }
}

/**
 * Turn the domain document into something that can go over the wire.
 *
 * ---------------------------------------------------------------------------
 * A `Money` IS NOT A WIRE TYPE.
 *
 * It holds a bigint, and `JSON.stringify` throws on one — so returning a domain
 * object straight from a handler produces a 500 with "Do not know how to
 * serialize a BigInt", which is exactly what this route did on first run.
 *
 * The bigint is not an implementation detail to paper over: it is the reason
 * money in this system is never a float. It crosses the boundary as an exact
 * decimal string, which is also how it is stored.
 * ---------------------------------------------------------------------------
 */
function renderDocument(document: EInvoiceDocument) {
  return {
    documentType: document.documentType,
    documentNo: document.documentNo,
    issueDate: document.issueDate,
    issueTime: document.issueTime,
    currency: document.currency,
    ...(document.exchangeRate !== undefined ? { exchangeRate: document.exchangeRate } : {}),
    supplier: document.supplier,
    buyer: document.buyer,
    lines: document.lines.map((line) => ({
      lineNo: line.lineNo,
      description: line.description,
      classificationCode: line.classificationCode,
      quantity: line.quantity,
      ...(line.unitOfMeasure !== undefined ? { unitOfMeasure: line.unitOfMeasure } : {}),
      unitPrice: line.unitPrice.toDecimalString(),
      ...(line.discountAmount !== undefined
        ? { discountAmount: line.discountAmount.toDecimalString() }
        : {}),
      taxableAmount: line.taxableAmount.toDecimalString(),
      taxAmount: line.taxAmount.toDecimalString(),
      // A bigint too, and the same rule applies: basis points cross the wire as
      // a number because they are small integers, never as a bigint.
      taxRateBasisPoints: Number(line.taxRateBasisPoints),
      ...(line.taxExemptionReason !== undefined
        ? { taxExemptionReason: line.taxExemptionReason }
        : {}),
      lineTotal: line.lineTotal.toDecimalString(),
    })),
    subtotal: document.subtotal.toDecimalString(),
    taxTotal: document.taxTotal.toDecimalString(),
    total: document.total.toDecimalString(),
    ...(document.originalReference !== undefined
      ? { originalReference: document.originalReference }
      : {}),
  };
}

function compilePattern(pattern: string | null): RegExp | undefined {
  if (pattern === null || pattern.trim().length === 0) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

const configSchema = z.object({
  isEnabled: z.boolean().optional(),
  /**
   * ⚠️ Not confirmed against LHDN. The window is a statutory deadline and the
   * default here is a placeholder, which is why it is configurable at all.
   */
  cancellationWindowHours: z.number().int().min(1).max(720).optional(),
  /**
   * A regex the buyer TIN must match. Configurable rather than hardcoded
   * because the authoritative check is LHDN's TIN lookup, and a pattern guessed
   * from examples would reject valid identifiers — stopping a real business
   * invoicing a real customer.
   */
  tinPattern: z.string().max(200).nullable().optional(),
  consolidationDueDays: z.number().int().min(1).max(31).optional(),
  environment: z.enum(['SANDBOX', 'PRODUCTION']).optional(),
});

/**
 * The lifecycle events, mirroring `SubmissionEvent` in the domain.
 *
 * Spelled out rather than passed through as an opaque object: the transition
 * rules depend on the payload, and an event missing its UUID would fail deep
 * inside the state machine instead of at the boundary.
 */
const eventSchema = z.object({
  actor: z.enum(['SUPPLIER', 'BUYER', 'LHDN', 'SYSTEM']).optional(),
  event: z.discriminatedUnion('type', [
    z.object({ type: z.literal('SUBMIT') }),
    z.object({ type: z.literal('ACCEPTED'), submissionUid: z.string().min(1) }),
    z.object({
      type: z.literal('VALIDATED'),
      lhdnUuid: z.string().min(1),
      longId: z.string().min(1),
      validatedAt: z.string().min(1),
    }),
    z.object({
      type: z.literal('REJECTED_BY_VALIDATION'),
      errorCode: z.string().min(1),
      detail: z.unknown().optional(),
    }),
    z.object({ type: z.literal('BUYER_REQUESTED_REJECTION'), reason: z.string().min(1) }),
    z.object({ type: z.literal('SUPPLIER_DECLINED_REJECTION') }),
    z.object({ type: z.literal('CANCELLED'), reason: z.string().min(1) }),
    z.object({ type: z.literal('RETRY') }),
  ]),
});

export { ValidationError };
