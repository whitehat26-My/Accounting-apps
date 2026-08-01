import {
  ageItems,
  autoAllocate,
  buildSettlementJournal,
  DEFAULT_AGEING_BUCKETS,
  isErr,
  Money,
  Rate,
  settlementStatus,
  toBase,
  validateJournalEntry,
  validateReceipt,
  type AgeingBucket,
  type AgeingItem,
  type AgeingReport,
  type AllocationStrategy,
  type OpenDocument,
  type PaymentMethod,
  type SettlementAllocation,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';
import { loadBaseCurrency, resolveRate } from './invoice.js';
import { toIsoDate } from './internal.js';

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
  /** Settlement-date rate. Omit to look up the stored rate for that date. */
  readonly fxRate?: string;
  readonly idempotencyKey: string;
}

export interface RecordedReceipt {
  readonly id: string;
  readonly paymentNo: string;
  readonly amount: string;
  readonly allocatedTotal: string;
  readonly unallocated: string;
  readonly journalEntryId: string;
  /** Signed base-currency amount: positive a gain, negative a loss. */
  readonly realisedFx: string | null;
  readonly settledInvoices: readonly { invoiceId: string; status: string; amountDue: string }[];
  readonly replayed: boolean;
}

export class PaymentError extends Error {
  constructor(
    readonly code:
      | 'CONTACT_NOT_FOUND'
      | 'NO_POSTING_ACCOUNTS'
      | 'RECEIPT_INVALID'
      | 'NO_FX_ACCOUNT'
      | 'JOURNAL_INVALID',
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
    { id: string; payment_no: string; amount: string; unallocated_amount: string; journal_entry_id: string; realised_fx: string | null }[]
  >`
      SELECT id, payment_no, amount, unallocated_amount, journal_entry_id, realised_fx
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
      realisedFx: row.realised_fx,
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
  const fxAccountId = await loadOptionalAccount(tx, ctx, 'FX_GAIN_LOSS');

  // ---- Read live balances, locked for update -------------------------------
  // FOR UPDATE so two concurrent receipts against the same invoice serialise
  // rather than both reading the same amount_due and both allocating it.
  const openRows = await tx<
    { id: string; invoice_no: string; issue_date: Date; due_date: Date; amount_due: string; total: string; amount_paid: string; fx_rate: string }[]
  >`
      SELECT id, invoice_no, issue_date, due_date, amount_due, total, amount_paid, fx_rate
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND contact_id = ${input.contactId}
         AND status IN ('ISSUED','PART_PAID')
         AND amount_due > 0
       ORDER BY issue_date, invoice_no
         FOR UPDATE
  `;

  // Each invoice carries the rate its AR was booked at. That is the rate it
  // must be relieved at — ledger invariant #13.
  const openInvoices: OpenDocument[] = openRows.map((r) => ({
    documentId: r.id,
    documentNo: r.invoice_no,
    issueDate: toIsoDate(r.issue_date),
    dueDate: toIsoDate(r.due_date),
    amountDue: Money.fromDecimal(r.amount_due, currency),
    bookedRate: Rate.fromDecimal(r.fx_rate),
  }));

  const allocations: SettlementAllocation[] = input.allocations
    ? input.allocations.map((a) => ({
        documentId: a.invoiceId,
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

  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const settlementRate = await resolveSettlementRate(
    tx, ctx, currency, baseCurrency, input.paymentDate, input.fxRate,
  );

  const journalDraft = buildSettlementJournal(
    'INBOUND',
    receipt,
    { controlAccountId: accountsReceivableId, ...(fxAccountId ? { fxGainLossId: fxAccountId } : {}) },
    {
      entryDate: input.paymentDate,
      description: `Receipt ${paymentNo}`,
      documentType: 'PAYMENT',
      documentId: paymentId,
    },
    { baseCurrency, settlementRate, openDocuments: openInvoices },
  );

  if (journalDraft === null) {
    throw new PaymentError('RECEIPT_INVALID', 'A zero-value receipt has nothing to record');
  }

  // The ledger balances in BASE currency; a foreign receipt deliberately does
  // not balance in the transaction currency once an FX line is present.
  const validJournal = validateJournalEntry(journalDraft, baseCurrency);
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

  // Derive the realised difference from what was actually posted, rather than
  // recomputing it — the journal is the truth.
  const fxLine = journalDraft.lines.find((l) => l.accountId === fxAccountId);
  const realisedFxAmount = fxLine
    ? (fxLine.side === 'CREDIT' ? fxLine.baseAmount : fxLine.baseAmount.negate())
    : null;

  await tx`
      INSERT INTO payment (
          tenant_id, id, payment_no, contact_id, direction, payment_date, method,
          deposit_account_id, currency, amount, unallocated_amount, reference,
          journal_entry_id, idempotency_key, recorded_by, fx_rate, base_amount, realised_fx
      ) VALUES (
          ${ctx.tenantId}, ${paymentId}, ${paymentNo}, ${input.contactId}, 'INBOUND',
          ${input.paymentDate}, ${input.method}, ${input.depositAccountId},
          ${currency}, ${amount.toDecimalString()},
          ${receipt.unallocated.toDecimalString()}, ${input.reference ?? null},
          ${posted.id}, ${input.idempotencyKey}, ${ctx.userId ?? null},
          ${settlementRate.toDecimalString()},
          ${toBase(amount, settlementRate, baseCurrency).toDecimalString()},
          ${realisedFxAmount ? realisedFxAmount.toDecimalString() : null}
      )
  `;

  // ---- Apply allocations ---------------------------------------------------
  const settledInvoices: { invoiceId: string; status: string; amountDue: string }[] = [];

  for (const allocation of receipt.allocations) {
    await tx`
        INSERT INTO payment_allocation (tenant_id, payment_id, invoice_id, amount)
        VALUES (${ctx.tenantId}, ${paymentId}, ${allocation.documentId},
                ${allocation.amount.toDecimalString()})
    `;

    const source = openRows.find((r) => r.id === allocation.documentId)!;
    const total = Money.fromDecimal(source.total, currency);
    const newPaid = Money.fromDecimal(source.amount_paid, currency).add(allocation.amount);
    const status = settlementStatus(total, newPaid);

    await tx`
        UPDATE invoice
           SET amount_paid = ${newPaid.toDecimalString()}, status = ${status}
         WHERE tenant_id = ${ctx.tenantId} AND id = ${allocation.documentId}
    `;

    settledInvoices.push({
      invoiceId: allocation.documentId,
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
    realisedFx: realisedFxAmount ? realisedFxAmount.toDecimalString() : null,
    settledInvoices,
    replayed: false,
  };
}

/**
 * Aged receivables as at a date — genuinely as at that date.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS USED TO DO, AND WHY IT WAS WRONG
 *
 * The previous version bucketed by `asOfDate` but measured `invoice.amount_due`
 * — today's live balance — with no filter on the issue date. So an aged report
 * run for 31/03 showed March's buckets against June's balances: invoices
 * issued in April appeared, invoices settled in May had vanished, and the
 * total could not tie to the AR control account at any date at all. An aged
 * report that does not tie to the control account is not evidence of anything,
 * and this is the report an auditor asks for first.
 *
 * The fix reconstructs the balance at the date from the append-only history
 * that was already there: the invoice as issued, less payments allocated on or
 * before the date, less credit notes allocated on or before the date. `payment`
 * is append-only and credit-note allocations carry their date, so the past is
 * genuinely recoverable rather than approximated.
 * ---------------------------------------------------------------------------
 *
 * Valued in BASE currency at the booked rate, for the same reason
 * `outstandingReceivables()` is: so the total is comparable to the control
 * account. Bucketing itself lives in `packages/domain/src/ageing.ts` — one
 * definition of "31-60 days", shared with payables.
 */
export async function agedReceivables(
  tx: Tx,
  ctx: TenantContext,
  asOfDate: string,
  buckets: readonly AgeingBucket[] = DEFAULT_AGEING_BUCKETS,
): Promise<AgeingReport> {
  const items = await openReceivablesAsAt(tx, ctx, asOfDate);
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  return ageItems(items, asOfDate, baseCurrency, buckets);
}

/**
 * Open receivables reconstructed as at a date, in base currency at booked rates.
 *
 * Exported because ledger invariant #6 is asserted against exactly this number
 * at a past date, and a test that recomputes it independently would be testing
 * its own copy of the logic.
 */
export async function openReceivablesAsAt(
  tx: Tx,
  ctx: TenantContext,
  asOfDate: string,
): Promise<AgeingItem[]> {
  const rows = await tx<
    {
      id: string;
      invoice_no: string;
      contact_id: string;
      due_date: Date;
      outstanding_base: string;
    }[]
  >`
      SELECT i.id,
             i.invoice_no,
             i.contact_id,
             i.due_date,
             ROUND(
                 (i.total
                  - COALESCE(paid.amount, 0)
                  - COALESCE(credited.amount, 0)) * i.fx_rate, 4
             )::text AS outstanding_base
        FROM invoice i
        LEFT JOIN LATERAL (
             SELECT SUM(a.amount) AS amount
               FROM payment_allocation a
               JOIN payment p
                 ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
              WHERE a.tenant_id = i.tenant_id
                AND a.invoice_id = i.id
                AND p.payment_date <= ${asOfDate}::date
        ) paid ON TRUE
        LEFT JOIN LATERAL (
             SELECT SUM(ca.amount) AS amount
               FROM credit_note_allocation ca
               JOIN credit_note cn
                 ON cn.tenant_id = ca.tenant_id AND cn.id = ca.credit_note_id
              WHERE ca.tenant_id = i.tenant_id
                AND ca.invoice_id = i.id
                AND cn.status = 'ISSUED'
                AND cn.credit_date <= ${asOfDate}::date
        ) credited ON TRUE
       WHERE i.tenant_id = ${ctx.tenantId}
         AND i.status <> 'DRAFT'
         AND i.status <> 'VOIDED'
         /* Issued after the report date: it did not exist yet. */
         AND i.issue_date <= ${asOfDate}::date
       ORDER BY i.due_date, i.invoice_no
  `;

  const baseCurrency = await loadBaseCurrency(tx, ctx);

  return rows
    .map((r) => ({
      documentId: r.id,
      documentNo: r.invoice_no,
      contactId: r.contact_id,
      dueDate: toIsoDate(r.due_date),
      outstanding: Money.fromDecimal(r.outstanding_base, baseCurrency),
    }))
    .filter((i) => !i.outstanding.isZero());
}

async function resolveSettlementRate(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  baseCurrency: string,
  date: string,
  explicit?: string,
): Promise<Rate> {
  try {
    return await resolveRate(tx, ctx, currency, baseCurrency, date, explicit);
  } catch (error) {
    throw new PaymentError(
      'RECEIPT_INVALID',
      error instanceof Error ? error.message : 'Could not resolve an exchange rate',
    );
  }
}

async function loadOptionalAccount(
  tx: Tx,
  ctx: TenantContext,
  role: string,
): Promise<string | undefined> {
  const [row] = await tx<{ account_id: string }[]>`
      SELECT account_id FROM posting_account_map
       WHERE tenant_id = ${ctx.tenantId} AND role = ${role}
  `;
  return row?.account_id;
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

