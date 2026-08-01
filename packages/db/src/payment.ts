import {
  autoAllocate,
  buildReceiptJournal,
  isErr,
  Money,
  settlementStatus,
  validateJournalEntry,
  validateReceipt,
  type AllocationStrategy,
  type OpenInvoice,
  type PaymentMethod,
  type ReceiptAllocation,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';

/**
 * PaymentService.recordReceipt() — money in against open invoices.
 *
 * One transaction: allocate a payment number, validate the allocation against
 * live invoice balances, post Dr Bank / Cr AR, write the allocations, and move
 * each affected invoice's settlement state.
 */

export interface RecordReceiptInput {
  readonly contactId: string;
  readonly paymentDate: string;
  /** Decimal string. Never a float. */
  readonly amount: string;
  readonly method: PaymentMethod;
  readonly depositAccountId: string;
  /**
   * Omit to auto-allocate oldest-first. An explicit list is always preferred
   * — the automatic proposal is a convenience, not a decision.
   */
  readonly allocations?: readonly { invoiceId: string; amount: string }[];
  readonly allocationStrategy?: AllocationStrategy;
  readonly reference?: string;
  readonly currency?: string;
  readonly idempotencyKey: string;
}

export interface RecordedReceipt {
  readonly id: string;
  readonly paymentNo: string;
  readonly amount: string;
  readonly allocatedTotal: string;
  readonly unallocated: string;
  readonly journalEntryId: string;
  readonly settledInvoices: readonly { invoiceId: string; status: string; amountDue: string }[];
  readonly replayed: boolean;
}

export class PaymentError extends Error {
  constructor(
    readonly code: 'CONTACT_NOT_FOUND' | 'NO_POSTING_ACCOUNTS' | 'RECEIPT_INVALID' | 'JOURNAL_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

export async function recordReceipt(
  tx: Tx,
  ctx: TenantContext,
  input: RecordReceiptInput,
): Promise<RecordedReceipt> {
  // ---- Idempotency ---------------------------------------------------------
  const existing = await tx<
    { id: string; payment_no: string; amount: string; unallocated_amount: string; journal_entry_id: string }[]
  >`
      SELECT id, payment_no, amount, unallocated_amount, journal_entry_id
        FROM payment
       WHERE tenant_id = ${ctx.tenantId} AND idempotency_key = ${input.idempotencyKey}
  `;

  if (existing.length > 0) {
    const row = existing[0]!;
    const amount = Money.fromDecimal(row.amount, input.currency ?? 'MYR');
    const unallocated = Money.fromDecimal(row.unallocated_amount, input.currency ?? 'MYR');
    return {
      id: row.id,
      paymentNo: row.payment_no,
      amount: row.amount,
      allocatedTotal: amount.subtract(unallocated).toDecimalString(),
      unallocated: row.unallocated_amount,
      journalEntryId: row.journal_entry_id,
      settledInvoices: [],
      replayed: true,
    };
  }

  const currency = input.currency ?? 'MYR';
  const amount = Money.fromDecimal(input.amount, currency);

  const [contact] = await tx<{ id: string }[]>`
      SELECT id FROM contact WHERE tenant_id = ${ctx.tenantId} AND id = ${input.contactId}
  `;
  if (!contact) {
    throw new PaymentError('CONTACT_NOT_FOUND', `Contact ${input.contactId} not found`);
  }

  const accountsReceivableId = await loadArAccount(tx, ctx);

  // ---- Read live balances, locked for update -------------------------------
  // FOR UPDATE so two concurrent receipts against the same invoice serialise
  // rather than both reading the same amount_due and both allocating it.
  const openRows = await tx<
    { id: string; invoice_no: string; issue_date: Date; due_date: Date; amount_due: string; total: string; amount_paid: string }[]
  >`
      SELECT id, invoice_no, issue_date, due_date, amount_due, total, amount_paid
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND contact_id = ${input.contactId}
         AND status IN ('ISSUED','PART_PAID')
         AND amount_due > 0
       ORDER BY issue_date, invoice_no
         FOR UPDATE
  `;

  const openInvoices: OpenInvoice[] = openRows.map((r) => ({
    invoiceId: r.id,
    invoiceNo: r.invoice_no,
    issueDate: toIsoDate(r.issue_date),
    dueDate: toIsoDate(r.due_date),
    amountDue: Money.fromDecimal(r.amount_due, currency),
  }));

  const allocations: ReceiptAllocation[] = input.allocations
    ? input.allocations.map((a) => ({
        invoiceId: a.invoiceId,
        amount: Money.fromDecimal(a.amount, currency),
      }))
    : autoAllocate(amount, openInvoices, input.allocationStrategy ?? 'OLDEST_FIRST');

  // ---- Validate (pure domain) ---------------------------------------------
  const validated = validateReceipt(
    {
      contactId: input.contactId,
      paymentDate: input.paymentDate,
      amount,
      method: input.method,
      depositAccountId: input.depositAccountId,
      allocations,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
    },
    openInvoices,
  );

  if (isErr(validated)) {
    throw new PaymentError('RECEIPT_INVALID', 'Receipt failed validation', validated.error);
  }
  const receipt = validated.value;

  // ---- Post ----------------------------------------------------------------
  const [numbered] = await tx<{ allocate_document_number: string }[]>`
      SELECT allocate_document_number('PAYMENT')
  `;
  const paymentNo = numbered!.allocate_document_number;

  // The payment id is allocated up front rather than by the INSERT's default.
  // `payment.journal_entry_id` is NOT NULL, so the entry must be posted before
  // the row exists — but the entry's `source_document_id` still has to point
  // at this payment. Minting the uuid here resolves the ordering without
  // making either column nullable.
  const [generated] = await tx<{ id: string }[]>`SELECT gen_random_uuid() AS id`;
  const paymentId = generated!.id;

  const journalDraft = buildReceiptJournal(
    receipt,
    { accountsReceivableId },
    {
      entryDate: input.paymentDate,
      description: `Receipt ${paymentNo}`,
      documentType: 'PAYMENT',
      documentId: paymentId,
    },
  );

  if (journalDraft === null) {
    throw new PaymentError('RECEIPT_INVALID', 'A zero-value receipt has nothing to record');
  }

  const validJournal = validateJournalEntry(journalDraft, currency);
  if (isErr(validJournal)) {
    throw new PaymentError('JOURNAL_INVALID', 'Generated journal is invalid', validJournal.error);
  }

  const posted = await postJournalEntry(tx, ctx, validJournal.value, {
    idempotencyKey: `payment:${input.idempotencyKey}`,
    emitEvent: {
      type: 'payment.received',
      payload: { paymentNo, amount: amount.toDecimalString(), contactId: input.contactId },
    },
  });

  await tx`
      INSERT INTO payment (
          tenant_id, id, payment_no, contact_id, direction, payment_date, method,
          deposit_account_id, currency, amount, unallocated_amount, reference,
          journal_entry_id, idempotency_key, recorded_by
      ) VALUES (
          ${ctx.tenantId}, ${paymentId}, ${paymentNo}, ${input.contactId}, 'INBOUND',
          ${input.paymentDate}, ${input.method}, ${input.depositAccountId},
          ${currency}, ${amount.toDecimalString()},
          ${receipt.unallocated.toDecimalString()}, ${input.reference ?? null},
          ${posted.id}, ${input.idempotencyKey}, ${ctx.userId ?? null}
      )
  `;

  // ---- Apply allocations ---------------------------------------------------
  const settledInvoices: { invoiceId: string; status: string; amountDue: string }[] = [];

  for (const allocation of receipt.allocations) {
    await tx`
        INSERT INTO payment_allocation (tenant_id, payment_id, target_type, target_id, amount)
        VALUES (${ctx.tenantId}, ${paymentId}, 'INVOICE', ${allocation.invoiceId},
                ${allocation.amount.toDecimalString()})
    `;

    const source = openRows.find((r) => r.id === allocation.invoiceId)!;
    const total = Money.fromDecimal(source.total, currency);
    const newPaid = Money.fromDecimal(source.amount_paid, currency).add(allocation.amount);
    const status = settlementStatus(total, newPaid);

    await tx`
        UPDATE invoice
           SET amount_paid = ${newPaid.toDecimalString()}, status = ${status}
         WHERE tenant_id = ${ctx.tenantId} AND id = ${allocation.invoiceId}
    `;

    settledInvoices.push({
      invoiceId: allocation.invoiceId,
      status,
      amountDue: total.subtract(newPaid).toDecimalString(),
    });
  }

  return {
    id: paymentId,
    paymentNo,
    amount: amount.toDecimalString(),
    allocatedTotal: receipt.allocatedTotal.toDecimalString(),
    unallocated: receipt.unallocated.toDecimalString(),
    journalEntryId: posted.id,
    settledInvoices,
    replayed: false,
  };
}

/**
 * Aged receivables, bucketed the way a Malaysian SME expects to see them.
 * `asOfDate` is passed in rather than read from a clock so the report is
 * reproducible and the function stays testable.
 */
export async function agedReceivables(
  tx: Tx,
  ctx: TenantContext,
  asOfDate: string,
): Promise<{ bucket: string; total: string; count: number }[]> {
  const rows = await tx<{ bucket: string; total: string; count: string }[]>`
      SELECT CASE
               WHEN ${asOfDate}::date <= due_date                       THEN 'CURRENT'
               WHEN ${asOfDate}::date - due_date BETWEEN 1 AND 30       THEN '1_30'
               WHEN ${asOfDate}::date - due_date BETWEEN 31 AND 60      THEN '31_60'
               WHEN ${asOfDate}::date - due_date BETWEEN 61 AND 90      THEN '61_90'
               ELSE '90_PLUS'
             END                       AS bucket,
             SUM(amount_due)::text     AS total,
             COUNT(*)::text            AS count
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('ISSUED','PART_PAID')
         AND amount_due > 0
       GROUP BY 1
       ORDER BY 1
  `;

  return rows.map((r) => ({ bucket: r.bucket, total: r.total, count: Number(r.count) }));
}

async function loadArAccount(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx<{ account_id: string }[]>`
      SELECT account_id FROM posting_account_map
       WHERE tenant_id = ${ctx.tenantId} AND role = 'AR'
  `;
  if (!row) {
    throw new PaymentError(
      'NO_POSTING_ACCOUNTS',
      'Posting account for role AR is not configured for this organisation',
    );
  }
  return row.account_id;
}

function toIsoDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
