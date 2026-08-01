import {
  buildCreditNoteJournal,
  computeDocument,
  isErr,
  Money,
  validateAllocations,
  validateCreditNote,
  validateJournalEntry,
  type CreditNoteReason,
  type DocumentLine,
  type OpenDocument,
  type SettlementAllocation,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';
import { loadTaxCodes } from './invoice.js';
import { decimalToScaled, toIsoDate } from './internal.js';

/**
 * CreditNoteService.issue() — the correction path for an issued invoice.
 *
 * Mirrors issueInvoice(): one transaction for numbering, tax, persistence,
 * immutable tax evidence, ledger posting and the e-invoice outbox event.
 *
 * The tax evidence is written with NEGATIVE amounts so the SST return, which
 * sums tax_transaction over a period, nets the credit against the original
 * charge. See packages/domain/src/credit-note.ts for why the sign lives in the
 * data rather than in every query that reads it.
 */

export interface IssueCreditNoteInput {
  readonly contactId: string;
  /** The invoice being corrected. Omit for a standalone customer credit. */
  readonly invoiceId?: string;
  readonly creditDate: string;
  readonly taxPointDate?: string;
  readonly reason: CreditNoteReason;
  readonly reasonDetail?: string;
  readonly currency?: string;
  readonly amountsAreTaxInclusive?: boolean;
  readonly lines: readonly IssueCreditNoteLine[];
  /**
   * Invoices this credit is applied against. Defaults to the referenced
   * invoice for its full outstanding amount, capped at the credit total.
   */
  readonly allocations?: readonly { invoiceId: string; amount: string }[];
  readonly idempotencyKey: string;
}

export interface IssueCreditNoteLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly accountId: string;
  readonly taxCodeId: string;
  readonly itemId?: string;
  readonly discountBasisPoints?: number;
  readonly classificationCode?: string;
}

export interface IssuedCreditNote {
  readonly id: string;
  readonly creditNoteNo: string;
  readonly subtotal: string;
  readonly taxTotal: string;
  readonly total: string;
  readonly allocatedTotal: string;
  readonly unallocated: string;
  readonly journalEntryId: string | null;
  readonly affectedInvoices: readonly { invoiceId: string; status: string; amountDue: string }[];
  readonly replayed: boolean;
}

export class CreditNoteError extends Error {
  constructor(
    readonly code:
      | 'CONTACT_NOT_FOUND'
      | 'INVOICE_NOT_FOUND'
      | 'NO_POSTING_ACCOUNTS'
      | 'DOCUMENT_INVALID'
      | 'CREDIT_INVALID'
      | 'ALLOCATION_INVALID'
      | 'JOURNAL_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'CreditNoteError';
  }
}

const QUANTITY_SCALE = 4n;

export async function issueCreditNote(
  tx: Tx,
  ctx: TenantContext,
  input: IssueCreditNoteInput,
): Promise<IssuedCreditNote> {
  // ---- Idempotency ---------------------------------------------------------
  const existing = await tx<
    {
      id: string; credit_note_no: string; subtotal: string; tax_total: string;
      total: string; allocated_amount: string; journal_entry_id: string | null;
    }[]
  >`
      SELECT id, credit_note_no, subtotal, tax_total, total, allocated_amount, journal_entry_id
        FROM credit_note
       WHERE tenant_id = ${ctx.tenantId} AND idempotency_key = ${input.idempotencyKey}
  `;

  if (existing.length > 0) {
    const row = existing[0]!;
    const currency = input.currency ?? 'MYR';
    return {
      id: row.id,
      creditNoteNo: row.credit_note_no,
      subtotal: row.subtotal,
      taxTotal: row.tax_total,
      total: row.total,
      allocatedTotal: row.allocated_amount,
      unallocated: Money.fromDecimal(row.total, currency)
        .subtract(Money.fromDecimal(row.allocated_amount, currency))
        .toDecimalString(),
      journalEntryId: row.journal_entry_id,
      affectedInvoices: [],
      replayed: true,
    };
  }

  const currency = input.currency ?? 'MYR';
  const taxPointDate = input.taxPointDate ?? input.creditDate;

  const [contact] = await tx<{ id: string }[]>`
      SELECT id FROM contact WHERE tenant_id = ${ctx.tenantId} AND id = ${input.contactId}
  `;
  if (!contact) {
    throw new CreditNoteError('CONTACT_NOT_FOUND', `Contact ${input.contactId} not found`);
  }

  const accounts = await loadCreditPostingAccounts(tx, ctx);
  const taxCodes = await loadTaxCodes(tx, ctx);

  const [org] = await tx<{ sst_registered: boolean }[]>`
      SELECT sst_registered FROM organisation WHERE id = ${ctx.tenantId}
  `;

  // ---- Compute (pure domain) ----------------------------------------------
  const documentLines: DocumentLine[] = input.lines.map((line, index) => ({
    lineId: `L${index + 1}`,
    description: line.description,
    quantity: decimalToScaled(line.quantity, QUANTITY_SCALE),
    unitPrice: Money.fromDecimal(line.unitPrice, currency),
    accountId: line.accountId,
    taxCodeId: line.taxCodeId,
    ...(line.discountBasisPoints !== undefined
      ? { discountBasisPoints: BigInt(line.discountBasisPoints) }
      : {}),
    ...(line.classificationCode !== undefined
      ? { classificationCode: line.classificationCode }
      : {}),
  }));

  const computed = computeDocument({
    lines: documentLines,
    taxPointDate,
    direction: 'OUTPUT',
    amountsAreTaxInclusive: input.amountsAreTaxInclusive ?? false,
    taxCodes,
    entity: { isRegistered: org?.sst_registered ?? false },
  });

  if (isErr(computed)) {
    throw new CreditNoteError('DOCUMENT_INVALID', 'Credit note failed validation', computed.error);
  }
  const doc = computed.value;

  // ---- Credit-specific checks ---------------------------------------------
  // Lock the referenced invoice and the allocation targets before reading
  // their balances, so a concurrent receipt cannot settle underneath us.
  const referenced = input.invoiceId
    ? await loadInvoiceForUpdate(tx, ctx, input.invoiceId, currency)
    : undefined;

  if (input.invoiceId && !referenced) {
    throw new CreditNoteError('INVOICE_NOT_FOUND', `Invoice ${input.invoiceId} not found`);
  }

  const creditCheck = validateCreditNote({
    creditDate: input.creditDate,
    total: doc.total,
    ...(referenced
      ? { against: { invoiceId: referenced.invoiceId, invoiceTotal: referenced.total } }
      : {}),
  });

  if (isErr(creditCheck)) {
    throw new CreditNoteError('CREDIT_INVALID', 'Credit note failed validation', creditCheck.error);
  }

  // ---- Allocation ----------------------------------------------------------
  const openInvoices: OpenDocument[] = referenced
    ? [
        {
          documentId: referenced.invoiceId,
          documentNo: referenced.invoiceNo,
          issueDate: referenced.issueDate,
          dueDate: referenced.dueDate,
          amountDue: referenced.amountDue,
        },
      ]
    : [];

  let allocations: SettlementAllocation[];

  if (input.allocations) {
    allocations = input.allocations.map((a) => ({
      documentId: a.invoiceId,
      amount: Money.fromDecimal(a.amount, currency),
    }));
  } else if (referenced) {
    // Default: apply as much as the invoice still owes, capped at the credit.
    const applied =
      doc.total.compare(referenced.amountDue) <= 0 ? doc.total : referenced.amountDue;
    allocations = applied.isPositive()
      ? [{ documentId: referenced.invoiceId, amount: applied }]
      : [];
  } else {
    allocations = [];
  }

  // Any invoice named explicitly must also be locked and readable.
  for (const allocation of allocations) {
    if (openInvoices.some((o) => o.documentId === allocation.documentId)) continue;
    const extra = await loadInvoiceForUpdate(tx, ctx, allocation.documentId, currency);
    if (!extra) {
      throw new CreditNoteError('INVOICE_NOT_FOUND', `Invoice ${allocation.documentId} not found`);
    }
    openInvoices.push({
      documentId: extra.invoiceId,
      documentNo: extra.invoiceNo,
      issueDate: extra.issueDate,
      dueDate: extra.dueDate,
      amountDue: extra.amountDue,
    });
  }

  const allocationCheck = validateAllocations(doc.total, allocations, openInvoices);
  if (isErr(allocationCheck)) {
    throw new CreditNoteError(
      'ALLOCATION_INVALID',
      'Credit note allocation failed validation',
      allocationCheck.error,
    );
  }

  // ---- Persist -------------------------------------------------------------
  const [numbered] = await tx<{ allocate_document_number: string }[]>`
      SELECT allocate_document_number('CREDIT_NOTE')
  `;
  const creditNoteNo = numbered!.allocate_document_number;

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO credit_note (
          tenant_id, credit_note_no, contact_id, invoice_id, credit_date,
          tax_point_date, reason, reason_detail, currency, amounts_tax_inclusive,
          subtotal, tax_total, total, allocated_amount, status,
          idempotency_key, issued_by, issued_at
      ) VALUES (
          ${ctx.tenantId}, ${creditNoteNo}, ${input.contactId}, ${input.invoiceId ?? null},
          ${input.creditDate}, ${taxPointDate}, ${input.reason},
          ${input.reasonDetail ?? null}, ${currency},
          ${input.amountsAreTaxInclusive ?? false},
          ${doc.subtotal.toDecimalString()}, ${doc.taxTotal.toDecimalString()},
          ${doc.total.toDecimalString()},
          ${allocationCheck.value.allocatedTotal.toDecimalString()},
          'DRAFT', ${input.idempotencyKey}, ${ctx.userId ?? null}, now()
      )
      RETURNING id
  `;
  const creditNoteId = row!.id;

  for (const [index, line] of input.lines.entries()) {
    const computedLine = doc.lines[index]!;
    await tx`
        INSERT INTO credit_note_line (
            tenant_id, credit_note_id, line_no, item_id, description, quantity,
            unit_price, discount_basis_points, account_id, tax_code_id,
            taxable_amount, tax_amount, line_total, classification_code
        ) VALUES (
            ${ctx.tenantId}, ${creditNoteId}, ${index + 1}, ${line.itemId ?? null},
            ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.discountBasisPoints ?? 0}, ${line.accountId}, ${line.taxCodeId},
            ${computedLine.netAmount.toDecimalString()},
            ${computedLine.taxAmount.toDecimalString()},
            ${computedLine.lineTotal.toDecimalString()},
            ${line.classificationCode ?? null}
        )
    `;
  }

  // ---- Negative tax evidence ----------------------------------------------
  for (const taxLine of doc.tax.lines) {
    await tx`
        INSERT INTO tax_transaction (
            tenant_id, source_document_type, source_document_id, tax_code_id,
            rate_basis_points, taxable_amount, tax_amount, tax_point_date,
            direction, exemption_reason, certificate_no
        ) VALUES (
            ${ctx.tenantId}, 'CREDIT_NOTE', ${creditNoteId}, ${taxLine.taxCodeId},
            ${Number(taxLine.rateBasisPoints)},
            ${taxLine.taxableAmount.negate().toDecimalString()},
            ${taxLine.taxAmount.negate().toDecimalString()},
            ${taxPointDate}, 'OUTPUT',
            ${taxLine.exemptionReason ?? null}, ${taxLine.certificateNo ?? null}
        )
    `;
  }

  // ---- Post ----------------------------------------------------------------
  const journalDraft = buildCreditNoteJournal(
    doc,
    { accountsReceivableId: accounts.AR, taxPayableId: accounts.SST_PAYABLE },
    {
      entryDate: input.creditDate,
      description: `Credit note ${creditNoteNo}`,
      contactId: input.contactId,
      documentType: 'CREDIT_NOTE',
      documentId: creditNoteId,
    },
  );

  let journalEntryId: string | null = null;

  if (journalDraft !== null) {
    const validJournal = validateJournalEntry(journalDraft, currency);
    if (isErr(validJournal)) {
      throw new CreditNoteError('JOURNAL_INVALID', 'Generated journal is invalid', validJournal.error);
    }

    const posted = await postJournalEntry(tx, ctx, validJournal.value, {
      idempotencyKey: `credit-note:${input.idempotencyKey}`,
      emitEvent: {
        type: 'creditnote.issued',
        payload: { creditNoteId, creditNoteNo, total: doc.total.toDecimalString() },
      },
    });
    journalEntryId = posted.id;
  }

  await tx`
      UPDATE credit_note
         SET status = 'ISSUED', journal_entry_id = ${journalEntryId}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${creditNoteId}
  `;

  // ---- Apply allocations ---------------------------------------------------
  const affectedInvoices: { invoiceId: string; status: string; amountDue: string }[] = [];

  for (const allocation of allocations) {
    await tx`
        INSERT INTO credit_note_allocation (tenant_id, credit_note_id, invoice_id, amount)
        VALUES (${ctx.tenantId}, ${creditNoteId}, ${allocation.documentId},
                ${allocation.amount.toDecimalString()})
    `;

    const target = openInvoices.find((o) => o.documentId === allocation.documentId)!;
    const [updated] = await tx<{ status: string; amount_due: string; total: string; amount_paid: string; amount_credited: string }[]>`
        UPDATE invoice
           SET amount_credited = amount_credited + ${allocation.amount.toDecimalString()}
         WHERE tenant_id = ${ctx.tenantId} AND id = ${allocation.documentId}
        RETURNING status, amount_due, total, amount_paid, amount_credited
    `;

    // Settlement state must consider payments and credits together. An
    // invoice fully covered by a credit is CREDITED, not PAID — the
    // distinction matters when someone asks what was actually collected.
    const total = Money.fromDecimal(updated!.total, currency);
    const paid = Money.fromDecimal(updated!.amount_paid, currency);
    const credited = Money.fromDecimal(updated!.amount_credited, currency);
    const settled = paid.add(credited);

    const status =
      settled.compare(total) >= 0
        ? paid.isZero()
          ? 'CREDITED'
          : 'PAID'
        : settled.isPositive()
          ? 'PART_PAID'
          : 'ISSUED';

    await tx`
        UPDATE invoice SET status = ${status}
         WHERE tenant_id = ${ctx.tenantId} AND id = ${allocation.documentId}
    `;

    affectedInvoices.push({
      invoiceId: target.documentId,
      status,
      amountDue: total.subtract(settled).toDecimalString(),
    });
  }

  return {
    id: creditNoteId,
    creditNoteNo,
    subtotal: doc.subtotal.toDecimalString(),
    taxTotal: doc.taxTotal.toDecimalString(),
    total: doc.total.toDecimalString(),
    allocatedTotal: allocationCheck.value.allocatedTotal.toDecimalString(),
    unallocated: allocationCheck.value.unallocated.toDecimalString(),
    journalEntryId,
    affectedInvoices,
    replayed: false,
  };
}

// ---------------------------------------------------------------------------

interface LoadedInvoice {
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly total: Money;
  readonly amountDue: Money;
}

async function loadInvoiceForUpdate(
  tx: Tx,
  ctx: TenantContext,
  invoiceId: string,
  currency: string,
): Promise<LoadedInvoice | undefined> {
  const [row] = await tx<
    { id: string; invoice_no: string; issue_date: Date; due_date: Date; total: string; amount_due: string }[]
  >`
      SELECT id, invoice_no, issue_date, due_date, total, amount_due
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId} AND id = ${invoiceId} AND status <> 'DRAFT'
         FOR UPDATE
  `;

  if (!row) return undefined;

  return {
    invoiceId: row.id,
    invoiceNo: row.invoice_no,
    issueDate: toIsoDate(row.issue_date),
    dueDate: toIsoDate(row.due_date),
    total: Money.fromDecimal(row.total, currency),
    amountDue: Money.fromDecimal(row.amount_due, currency),
  };
}

async function loadCreditPostingAccounts(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ AR: string; SST_PAYABLE: string }> {
  const rows = await tx<{ role: string; account_id: string }[]>`
      SELECT role, account_id FROM posting_account_map WHERE tenant_id = ${ctx.tenantId}
  `;
  const map = new Map(rows.map((r) => [r.role, r.account_id]));

  for (const role of ['AR', 'SST_PAYABLE'] as const) {
    if (!map.get(role)) {
      throw new CreditNoteError(
        'NO_POSTING_ACCOUNTS',
        `Posting account for role ${role} is not configured for this organisation`,
      );
    }
  }

  return { AR: map.get('AR')!, SST_PAYABLE: map.get('SST_PAYABLE')! };
}

/** Net output tax for a period: charges less credits. */
export async function outputTaxForPeriod(
  tx: Tx,
  ctx: TenantContext,
  from: string,
  to: string,
): Promise<{ taxableAmount: string; taxAmount: string }> {
  const [row] = await tx<{ taxable: string; tax: string }[]>`
      SELECT COALESCE(SUM(taxable_amount), 0)::text AS taxable,
             COALESCE(SUM(tax_amount), 0)::text     AS tax
        FROM tax_transaction
       WHERE tenant_id = ${ctx.tenantId}
         AND direction = 'OUTPUT'
         AND tax_point_date BETWEEN ${from} AND ${to}
  `;
  return { taxableAmount: row!.taxable, taxAmount: row!.tax };
}

