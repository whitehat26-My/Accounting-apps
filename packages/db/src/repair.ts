import {
  checkRepairTransition,
  describeRepairViolation,
  isErr,
  type RepairStatus,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { recordCashSale, type CashSaleResult } from './pos.js';
import { issueInvoice, type IssueInvoiceLine } from './invoice.js';
import { toIsoDate } from './internal.js';
import type { PaymentMethod } from '@emil/domain';

/**
 * Repair jobs: the workshop service.
 *
 * The domain owns which transitions are legal; this module owns persistence
 * and the one conversion that touches money — collection, which turns the
 * job's quote lines into an invoice through `recordCashSale` (paid at the
 * counter) or `issueInvoice` (billed for later). Both are the existing sales
 * paths, so stock relief, COGS at weighted average, serial consumption and
 * SST all behave at the workshop door exactly as they behave at the till.
 */

export class RepairError extends Error {
  constructor(
    readonly code:
      | 'JOB_NOT_FOUND'
      | 'CONTACT_NOT_FOUND'
      | 'ILLEGAL_TRANSITION'
      | 'JOB_NOT_EDITABLE'
      | 'JOB_NOT_COLLECTABLE'
      | 'QUOTE_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'RepairError';
  }
}

export interface RepairJobLineInput {
  readonly description: string;
  readonly quantity: string;
  /** The AGREED price. Quoted prices survive catalogue changes — see 0029. */
  readonly unitPrice: string;
  readonly itemId?: string;
  readonly taxCodeId?: string;
  readonly accountId?: string;
  readonly serialNumbers?: readonly string[];
}

export interface RepairJobView {
  readonly id: string;
  readonly jobNo: string;
  readonly contactId: string;
  readonly deviceDescription: string;
  readonly deviceSerial: string | null;
  readonly reportedFault: string;
  readonly diagnosis: string | null;
  readonly status: RepairStatus;
  readonly approvalNote: string | null;
  readonly closedReason: string | null;
  readonly invoiceId: string | null;
  readonly receivedOn: string;
  readonly collectedOn: string | null;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly description: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly itemId: string | null;
    readonly serialNumbers: readonly string[] | null;
  }[];
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export interface IntakeInput {
  readonly contactId: string;
  readonly deviceDescription: string;
  readonly deviceSerial?: string;
  readonly reportedFault: string;
  readonly receivedOn: string;
  readonly idempotencyKey: string;
}

export async function createRepairJob(
  tx: Tx,
  ctx: TenantContext,
  input: IntakeInput,
): Promise<{ id: string; jobNo: string; replayed: boolean }> {
  // Idempotent on the job_no's own uniqueness via the key column below.
  const [existing] = await tx<{ id: string; job_no: string }[]>`
      SELECT id, job_no FROM repair_job
       WHERE tenant_id = ${ctx.tenantId} AND created_idempotency_key = ${input.idempotencyKey}
  `;
  if (existing) return { id: existing.id, jobNo: existing.job_no, replayed: true };

  const [contact] = await tx<{ id: string }[]>`
      SELECT id FROM contact WHERE tenant_id = ${ctx.tenantId} AND id = ${input.contactId}
  `;
  if (!contact) {
    // Indistinguishable from another tenant's contact — rule 9.
    throw new RepairError('CONTACT_NOT_FOUND', `Contact ${input.contactId} not found`);
  }

  /*
   * Self-provision the JOB sequence. Every other sequence is seeded at tenant
   * creation, which predates this table for every existing tenant — and
   * `allocate_document_number` throws on a missing row. ON CONFLICT keeps it
   * race-safe and a no-op forever after.
   */
  await tx`
      INSERT INTO number_sequence (tenant_id, document_type, prefix, next_value, padding)
      VALUES (${ctx.tenantId}, 'REPAIR_JOB', 'JOB-', 1, 5)
      ON CONFLICT (tenant_id, document_type) DO NOTHING
  `;

  const [numbered] = await tx<{ allocate_document_number: string }[]>`
      SELECT allocate_document_number('REPAIR_JOB')
  `;

  const [job] = await tx<{ id: string; job_no: string }[]>`
      INSERT INTO repair_job (
          tenant_id, job_no, contact_id, device_description, device_serial,
          reported_fault, received_on, created_by, created_idempotency_key
      ) VALUES (
          ${ctx.tenantId}, ${numbered!.allocate_document_number}, ${input.contactId},
          ${input.deviceDescription}, ${input.deviceSerial ?? null},
          ${input.reportedFault}, ${input.receivedOn}, ${ctx.userId ?? null},
          ${input.idempotencyKey}
      )
      RETURNING id, job_no
  `;

  return { id: job!.id, jobNo: job!.job_no, replayed: false };
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export interface QuoteInput {
  readonly diagnosis: string;
  readonly lines: readonly RepairJobLineInput[];
}

/**
 * Set the diagnosis and quote lines, and move the job to QUOTED.
 *
 * Replaces the whole line set — a quote is one document, not an accumulation
 * of edits — and is legal from RECEIVED, QUOTED (revising) and DECLINED
 * (re-quoting cheaper after a "no").
 */
export async function quoteRepairJob(
  tx: Tx,
  ctx: TenantContext,
  jobId: string,
  input: QuoteInput,
): Promise<RepairJobView> {
  const job = await lockJob(tx, ctx, jobId);

  const check = checkRepairTransition(job.status, 'QUOTED', {
    quoteLineCount: input.lines.length,
  });
  if (isErr(check)) {
    throw new RepairError('ILLEGAL_TRANSITION', describeRepairViolation(check.error), check.error);
  }

  await tx`
      DELETE FROM repair_job_line
       WHERE tenant_id = ${ctx.tenantId} AND repair_job_id = ${jobId}
  `;

  for (const [index, line] of input.lines.entries()) {
    await tx`
        INSERT INTO repair_job_line (
            tenant_id, repair_job_id, line_no, item_id, description,
            quantity, unit_price, tax_code_id, account_id, serial_numbers
        ) VALUES (
            ${ctx.tenantId}, ${jobId}, ${index + 1}, ${line.itemId ?? null},
            ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.taxCodeId ?? null}, ${line.accountId ?? null},
            ${line.serialNumbers !== undefined ? (line.serialNumbers as string[]) : null}
        )
    `;
  }

  await tx`
      UPDATE repair_job
         SET status = 'QUOTED', diagnosis = ${input.diagnosis}, updated_at = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
  `;

  return getRepairJob(tx, ctx, jobId);
}

/**
 * Record WHICH units the bench actually fitted.
 *
 * Separate from quoting, deliberately. A quote is frozen once approved — the
 * price was agreed — but the exact serial fitted is decided on the bench,
 * usually after approval. This updates serials and NOTHING else, so the
 * agreed figures cannot drift in through the side door. Legal while the job
 * is APPROVED, IN_PROGRESS or READY; the serials are verified against stock
 * at collection, when they actually move.
 */
export async function setFittedSerials(
  tx: Tx,
  ctx: TenantContext,
  jobId: string,
  lineNo: number,
  serialNumbers: readonly string[],
): Promise<RepairJobView> {
  const job = await lockJob(tx, ctx, jobId);

  if (!['APPROVED', 'IN_PROGRESS', 'READY'].includes(job.status)) {
    throw new RepairError(
      'JOB_NOT_EDITABLE',
      `Serials are recorded on the bench: job ${job.job_no} is ${job.status}, and fitted ` +
        'units can only be named between approval and collection.',
    );
  }

  const [line] = await tx<{ id: string }[]>`
      SELECT id FROM repair_job_line
       WHERE tenant_id = ${ctx.tenantId} AND repair_job_id = ${jobId} AND line_no = ${lineNo}
  `;
  if (!line) {
    throw new RepairError('QUOTE_INVALID', `Job ${job.job_no} has no line ${lineNo}`);
  }

  await tx`
      UPDATE repair_job_line
         SET serial_numbers = ${serialNumbers as string[]}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${line.id}
  `;

  return getRepairJob(tx, ctx, jobId);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface TransitionInput {
  readonly to: RepairStatus;
  /** Required for DECLINED and CANCELLED. */
  readonly reason?: string;
  /** For APPROVED: how the yes was given — "WhatsApp 14:32", "signed slip". */
  readonly approvalNote?: string;
}

export async function transitionRepairJob(
  tx: Tx,
  ctx: TenantContext,
  jobId: string,
  input: TransitionInput,
): Promise<RepairJobView> {
  const job = await lockJob(tx, ctx, jobId);

  const [lineCount] = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM repair_job_line
       WHERE tenant_id = ${ctx.tenantId} AND repair_job_id = ${jobId}
  `;

  const check = checkRepairTransition(job.status, input.to, {
    quoteLineCount: lineCount!.n,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  if (isErr(check)) {
    throw new RepairError('ILLEGAL_TRANSITION', describeRepairViolation(check.error), check.error);
  }

  await tx`
      UPDATE repair_job
         SET status = ${input.to},
             approval_note = ${input.to === 'APPROVED' ? (input.approvalNote ?? null) : job.approval_note},
             approved_at   = ${input.to === 'APPROVED' ? new Date() : job.approved_at},
             closed_reason = ${input.to === 'DECLINED' || input.to === 'CANCELLED' ? (input.reason ?? null) : job.closed_reason},
             updated_at = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
  `;

  return getRepairJob(tx, ctx, jobId);
}

// ---------------------------------------------------------------------------
// Collection — the one step that touches money
// ---------------------------------------------------------------------------

export interface CollectInput {
  readonly collectDate: string;
  /**
   * Present: paid at the counter now, through the POS path (invoice + receipt
   * in one transaction). Absent: invoiced on account — a corporate customer
   * collecting against 30-day terms.
   */
  readonly payment?: {
    readonly method: PaymentMethod;
    readonly depositAccountId: string;
    readonly tenderedAmount?: string;
  };
  readonly idempotencyKey: string;
}

export interface CollectedJob {
  readonly jobId: string;
  readonly jobNo: string;
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly total: string;
  /** Null when invoiced on account, or exact tender. */
  readonly changeDue: string | null;
  readonly paid: boolean;
}

export async function collectRepairJob(
  tx: Tx,
  ctx: TenantContext,
  jobId: string,
  input: CollectInput,
): Promise<CollectedJob> {
  const job = await lockJob(tx, ctx, jobId);

  // A retried collection: the invoice is already on the job.
  if (job.status === 'COLLECTED' && job.collect_idempotency_key === input.idempotencyKey) {
    const [invoice] = await tx<{ invoice_no: string; total: string }[]>`
        SELECT invoice_no, total FROM invoice
         WHERE tenant_id = ${ctx.tenantId} AND id = ${job.invoice_id!}
    `;
    return {
      jobId,
      jobNo: job.job_no,
      invoiceId: job.invoice_id!,
      invoiceNo: invoice!.invoice_no,
      total: invoice!.total,
      changeDue: null,
      paid: job.collected_paid ?? false,
    };
  }

  const check = checkRepairTransition(job.status, 'COLLECTED', {
    quoteLineCount: 0,
    viaCollection: true,
  });
  if (isErr(check)) {
    throw new RepairError(
      'JOB_NOT_COLLECTABLE',
      `Job ${job.job_no} is ${job.status}: ${describeRepairViolation(check.error)}`,
      check.error,
    );
  }

  const lines = await tx<
    {
      item_id: string | null; description: string; quantity: string;
      unit_price: string; tax_code_id: string | null; account_id: string | null;
      serial_numbers: string[] | null;
    }[]
  >`
      SELECT item_id, description, quantity, unit_price, tax_code_id, account_id,
             serial_numbers
        FROM repair_job_line
       WHERE tenant_id = ${ctx.tenantId} AND repair_job_id = ${jobId}
       ORDER BY line_no
  `;

  if (lines.length === 0) {
    throw new RepairError('QUOTE_INVALID', `Job ${job.job_no} has no lines to invoice`);
  }

  /*
   * Quote lines become invoice lines VERBATIM — the agreed price, not today's
   * catalogue price. The description is always carried even when an item is
   * present, because "replace screen (agreed after diagnosis)" is the line the
   * customer approved, and the invoice must read like the quote did.
   */
  const invoiceLines: IssueInvoiceLine[] = lines.map((l) => ({
    quantity: l.quantity,
    description: l.description,
    unitPrice: l.unit_price,
    ...(l.item_id !== null ? { itemId: l.item_id } : {}),
    ...(l.tax_code_id !== null ? { taxCodeId: l.tax_code_id } : {}),
    ...(l.account_id !== null ? { accountId: l.account_id } : {}),
    ...(l.serial_numbers !== null ? { serialNumbers: l.serial_numbers } : {}),
  }));

  let invoiceId: string;
  let invoiceNo: string;
  let total: string;
  let changeDue: string | null = null;
  let paid = false;

  if (input.payment !== undefined) {
    const sale: CashSaleResult = await recordCashSale(tx, ctx, {
      saleDate: input.collectDate,
      lines: invoiceLines,
      method: input.payment.method,
      depositAccountId: input.payment.depositAccountId,
      contactId: job.contact_id,
      reference: `Repair ${job.job_no}`,
      ...(input.payment.tenderedAmount !== undefined
        ? { tenderedAmount: input.payment.tenderedAmount }
        : {}),
      idempotencyKey: input.idempotencyKey,
    });
    invoiceId = sale.invoiceId;
    invoiceNo = sale.invoiceNo;
    total = sale.total;
    changeDue = sale.changeDue;
    paid = true;
  } else {
    const invoice = await issueInvoice(tx, ctx, {
      contactId: job.contact_id,
      issueDate: input.collectDate,
      reference: `Repair ${job.job_no}`,
      lines: invoiceLines,
      idempotencyKey: input.idempotencyKey,
    });
    invoiceId = invoice.id;
    invoiceNo = invoice.invoiceNo;
    total = invoice.total;
  }

  await tx`
      UPDATE repair_job
         SET status = 'COLLECTED', invoice_id = ${invoiceId},
             collected_on = ${input.collectDate},
             collect_idempotency_key = ${input.idempotencyKey},
             collected_paid = ${paid},
             updated_at = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
  `;

  return { jobId, jobNo: job.job_no, invoiceId, invoiceNo, total, changeDue, paid };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getRepairJob(
  tx: Tx,
  ctx: TenantContext,
  jobId: string,
): Promise<RepairJobView> {
  const [job] = await tx<JobRow[]>`
      SELECT ${tx.unsafe(JOB_COLUMNS)} FROM repair_job
       WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
  `;
  if (!job) throw new RepairError('JOB_NOT_FOUND', `Repair job ${jobId} not found`);

  const lines = await tx<
    {
      line_no: number; description: string; quantity: string; unit_price: string;
      item_id: string | null; serial_numbers: string[] | null;
    }[]
  >`
      SELECT line_no, description, quantity, unit_price, item_id, serial_numbers
        FROM repair_job_line
       WHERE tenant_id = ${ctx.tenantId} AND repair_job_id = ${jobId}
       ORDER BY line_no
  `;

  return toView(job, lines);
}

export async function listRepairJobs(
  tx: Tx,
  ctx: TenantContext,
  options: { readonly status?: RepairStatus } = {},
): Promise<RepairJobView[]> {
  const jobs = await tx<JobRow[]>`
      SELECT ${tx.unsafe(JOB_COLUMNS)} FROM repair_job
       WHERE tenant_id = ${ctx.tenantId}
         AND (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
       ORDER BY created_at DESC
       LIMIT 200
  `;

  // The queue view carries no lines; the detail view does. A workshop list of
  // 200 jobs does not need 200 line sub-queries.
  return jobs.map((j) => toView(j, []));
}

// ------------------------------------------------------------------ internal

const JOB_COLUMNS = `
    id, job_no, contact_id, device_description, device_serial, reported_fault,
    diagnosis, status, approval_note, approved_at, closed_reason, invoice_id,
    received_on, collected_on, collect_idempotency_key, collected_paid
`;

interface JobRow {
  id: string; job_no: string; contact_id: string; device_description: string;
  device_serial: string | null; reported_fault: string; diagnosis: string | null;
  status: RepairStatus; approval_note: string | null; approved_at: Date | null;
  closed_reason: string | null; invoice_id: string | null;
  received_on: Date; collected_on: Date | null;
  collect_idempotency_key: string | null; collected_paid: boolean | null;
}

async function lockJob(tx: Tx, ctx: TenantContext, jobId: string): Promise<JobRow> {
  const [job] = await tx<JobRow[]>`
      SELECT ${tx.unsafe(JOB_COLUMNS)} FROM repair_job
       WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
         FOR UPDATE
  `;
  // Another tenant's job is indistinguishable from none — rule 9.
  if (!job) throw new RepairError('JOB_NOT_FOUND', `Repair job ${jobId} not found`);
  return job;
}

function toView(
  job: JobRow,
  lines: readonly {
    line_no: number; description: string; quantity: string; unit_price: string;
    item_id: string | null; serial_numbers: string[] | null;
  }[],
): RepairJobView {
  return {
    id: job.id,
    jobNo: job.job_no,
    contactId: job.contact_id,
    deviceDescription: job.device_description,
    deviceSerial: job.device_serial,
    reportedFault: job.reported_fault,
    diagnosis: job.diagnosis,
    status: job.status,
    approvalNote: job.approval_note,
    closedReason: job.closed_reason,
    invoiceId: job.invoice_id,
    receivedOn: toIsoDate(job.received_on),
    collectedOn: job.collected_on ? toIsoDate(job.collected_on) : null,
    lines: lines.map((l) => ({
      lineNo: l.line_no,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      itemId: l.item_id,
      serialNumbers: l.serial_numbers,
    })),
  };
}
