import {
  buildDebitNoteJournal,
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
import { loadPurchasePostingAccounts } from './bill.js';
import { decimalToScaled, toIsoDate } from './internal.js';

/**
 * DebitNoteService.issue() — the correction path for an entered bill (M3).
 *
 * The payables mirror of `issueCreditNote()`. An entered bill is evidence of a
 * supplier's claim and the database refuses to edit one; that refusal is only
 * tenable because this exists.
 *
 * Naming, because it trips people up: a DEBIT note is raised by the BUYER and
 * debits the payable — it reduces what we owe. It is the document we send when
 * we return goods or dispute a charge, and it usually crosses in the post with
 * the supplier's own credit note for the same amount. Only one of the two is
 * recorded here, ours.
 *
 * Tax evidence is written with NEGATIVE amounts and direction INPUT, so an
 * input-tax summary over a period nets the reversal against the original
 * charge — the same convention credit notes use on the output side.
 */

export interface IssueDebitNoteInput {
  readonly supplierId: string;
  /** The bill being corrected. Omit for a standalone supplier debit. */
  readonly billId?: string;
  readonly debitDate: string;
  readonly taxPointDate?: string;
  readonly reason: CreditNoteReason;
  readonly reasonDetail?: string;
  readonly currency?: string;
  readonly amountsAreTaxInclusive?: boolean;
  readonly lines: readonly IssueDebitNoteLine[];
  readonly allocations?: readonly { billId: string; amount: string }[];
  readonly idempotencyKey: string;
}

export interface IssueDebitNoteLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  /** The expense or asset account being credited back. */
  readonly accountId: string;
  readonly taxCodeId: string;
  readonly discountBasisPoints?: number;
}

export interface IssuedDebitNote {
  readonly id: string;
  readonly debitNoteNo: string;
  readonly subtotal: string;
  readonly taxTotal: string;
  readonly total: string;
  readonly allocatedTotal: string;
  readonly unallocated: string;
  readonly journalEntryId: string | null;
  readonly affectedBills: readonly { billId: string; status: string; amountDue: string }[];
  readonly replayed: boolean;
}

export class DebitNoteError extends Error {
  constructor(
    readonly code:
      | 'SUPPLIER_NOT_FOUND'
      | 'BILL_NOT_FOUND'
      | 'NO_POSTING_ACCOUNTS'
      | 'DOCUMENT_INVALID'
      | 'DEBIT_INVALID'
      | 'ALLOCATION_INVALID'
      | 'JOURNAL_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'DebitNoteError';
  }
}

const QUANTITY_SCALE = 4n;

export async function issueDebitNote(
  tx: Tx,
  ctx: TenantContext,
  input: IssueDebitNoteInput,
): Promise<IssuedDebitNote> {
  // ---- Idempotency ---------------------------------------------------------
  const existing = await tx<
    {
      id: string;
      debit_note_no: string;
      subtotal: string;
      tax_total: string;
      total: string;
      allocated_amount: string;
      journal_entry_id: string | null;
    }[]
  >`
      SELECT id, debit_note_no, subtotal, tax_total, total, allocated_amount, journal_entry_id
        FROM debit_note
       WHERE tenant_id = ${ctx.tenantId} AND idempotency_key = ${input.idempotencyKey}
  `;

  if (existing.length > 0) {
    const row = existing[0]!;
    const currency = input.currency ?? 'MYR';
    return {
      id: row.id,
      debitNoteNo: row.debit_note_no,
      subtotal: row.subtotal,
      taxTotal: row.tax_total,
      total: row.total,
      allocatedTotal: row.allocated_amount,
      unallocated: Money.fromDecimal(row.total, currency)
        .subtract(Money.fromDecimal(row.allocated_amount, currency))
        .toDecimalString(),
      journalEntryId: row.journal_entry_id,
      affectedBills: [],
      replayed: true,
    };
  }

  const currency = input.currency ?? 'MYR';
  const taxPointDate = input.taxPointDate ?? input.debitDate;

  const [supplier] = await tx<{ id: string }[]>`
      SELECT id FROM contact WHERE tenant_id = ${ctx.tenantId} AND id = ${input.supplierId}
  `;
  if (!supplier) {
    throw new DebitNoteError('SUPPLIER_NOT_FOUND', `Contact ${input.supplierId} not found`);
  }

  const accounts = await loadPurchasePostingAccounts(tx, ctx);
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
  }));

  const computed = computeDocument({
    lines: documentLines,
    taxPointDate,
    // INPUT, so `inputTreatment` is resolved on every line and the COST vs
    // RECOVERABLE split is reversed the same way it was originally booked.
    direction: 'INPUT',
    amountsAreTaxInclusive: input.amountsAreTaxInclusive ?? false,
    taxCodes,
    entity: { isRegistered: org?.sst_registered ?? false },
  });

  if (isErr(computed)) {
    throw new DebitNoteError('DOCUMENT_INVALID', 'Debit note failed validation', computed.error);
  }
  const doc = computed.value;

  // ---- Debit-specific checks ----------------------------------------------
  const referenced = input.billId
    ? await loadBillForUpdate(tx, ctx, input.billId, currency)
    : undefined;

  if (input.billId && !referenced) {
    throw new DebitNoteError('BILL_NOT_FOUND', `Bill ${input.billId} not found`);
  }

  // The three checks a correction note needs — a well-formed date, a positive
  // value, and not exceeding the document it corrects — are identical on both
  // sides of the ledger, so the credit-note validator runs here rather than a
  // second copy that can drift. Its violation vocabulary is sales-flavoured;
  // the codes are translated at this boundary so a payables caller is not told
  // its debit note "exceeds the invoice".
  const check = validateCreditNote({
    creditDate: input.debitDate,
    total: doc.total,
    ...(referenced
      ? { against: { invoiceId: referenced.billId, invoiceTotal: referenced.total } }
      : {}),
  });

  if (isErr(check)) {
    throw new DebitNoteError(
      'DEBIT_INVALID',
      'Debit note failed validation',
      check.error.map((v) =>
        v.code === 'INVALID_CREDIT_DATE'
          ? { ...v, code: 'INVALID_DEBIT_DATE' }
          : v.code === 'ZERO_VALUE_CREDIT'
            ? { ...v, code: 'ZERO_VALUE_DEBIT' }
            : v.code === 'CREDIT_EXCEEDS_INVOICE'
              ? { code: 'DEBIT_EXCEEDS_BILL', billId: v.invoiceId, debit: v.credit, billTotal: v.invoiceTotal }
              : v,
      ),
    );
  }

  // ---- Allocation ----------------------------------------------------------
  const openBillDocuments: OpenDocument[] = referenced
    ? [
        {
          documentId: referenced.billId,
          documentNo: referenced.internalRef,
          issueDate: referenced.billDate,
          dueDate: referenced.dueDate,
          amountDue: referenced.amountDue,
        },
      ]
    : [];

  let allocations: SettlementAllocation[];

  if (input.allocations) {
    allocations = input.allocations.map((a) => ({
      documentId: a.billId,
      amount: Money.fromDecimal(a.amount, currency),
    }));
  } else if (referenced) {
    const applied =
      doc.total.compare(referenced.amountDue) <= 0 ? doc.total : referenced.amountDue;
    allocations = applied.isPositive()
      ? [{ documentId: referenced.billId, amount: applied }]
      : [];
  } else {
    allocations = [];
  }

  for (const allocation of allocations) {
    if (openBillDocuments.some((o) => o.documentId === allocation.documentId)) continue;
    const extra = await loadBillForUpdate(tx, ctx, allocation.documentId, currency);
    if (!extra) {
      throw new DebitNoteError('BILL_NOT_FOUND', `Bill ${allocation.documentId} not found`);
    }
    openBillDocuments.push({
      documentId: extra.billId,
      documentNo: extra.internalRef,
      issueDate: extra.billDate,
      dueDate: extra.dueDate,
      amountDue: extra.amountDue,
    });
  }

  const allocationCheck = validateAllocations(doc.total, allocations, openBillDocuments);
  if (isErr(allocationCheck)) {
    throw new DebitNoteError(
      'ALLOCATION_INVALID',
      'Debit note allocation failed validation',
      allocationCheck.error,
    );
  }

  // ---- Persist -------------------------------------------------------------
  const [numbered] = await tx<{ allocate_document_number: string }[]>`
      SELECT allocate_document_number('DEBIT_NOTE')
  `;
  const debitNoteNo = numbered!.allocate_document_number;

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO debit_note (
          tenant_id, debit_note_no, supplier_id, bill_id, debit_date,
          tax_point_date, reason, reason_detail, currency,
          subtotal, tax_total, total, allocated_amount, status,
          idempotency_key, issued_by, issued_at
      ) VALUES (
          ${ctx.tenantId}, ${debitNoteNo}, ${input.supplierId}, ${input.billId ?? null},
          ${input.debitDate}, ${taxPointDate}, ${input.reason},
          ${input.reasonDetail ?? null}, ${currency},
          ${doc.subtotal.toDecimalString()}, ${doc.taxTotal.toDecimalString()},
          ${doc.total.toDecimalString()},
          ${allocationCheck.value.allocatedTotal.toDecimalString()},
          'DRAFT', ${input.idempotencyKey}, ${ctx.userId ?? null}, now()
      )
      RETURNING id
  `;
  const debitNoteId = row!.id;

  for (const [index, line] of input.lines.entries()) {
    const computedLine = doc.lines[index]!;
    await tx`
        INSERT INTO debit_note_line (
            tenant_id, debit_note_id, line_no, description, quantity,
            unit_price, discount_basis_points, account_id, tax_code_id,
            taxable_amount, tax_amount, line_total
        ) VALUES (
            ${ctx.tenantId}, ${debitNoteId}, ${index + 1},
            ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.discountBasisPoints ?? 0}, ${line.accountId}, ${line.taxCodeId},
            ${computedLine.netAmount.toDecimalString()},
            ${computedLine.taxAmount.toDecimalString()},
            ${computedLine.lineTotal.toDecimalString()}
        )
    `;
  }

  // ---- Negative tax evidence, direction INPUT ------------------------------
  for (const taxLine of doc.tax.lines) {
    await tx`
        INSERT INTO tax_transaction (
            tenant_id, source_document_type, source_document_id, tax_code_id,
            rate_basis_points, taxable_amount, tax_amount, tax_point_date,
            direction, exemption_reason, certificate_no
        ) VALUES (
            ${ctx.tenantId}, 'DEBIT_NOTE', ${debitNoteId}, ${taxLine.taxCodeId},
            ${Number(taxLine.rateBasisPoints)},
            ${taxLine.taxableAmount.negate().toDecimalString()},
            ${taxLine.taxAmount.negate().toDecimalString()},
            ${taxPointDate}, 'INPUT',
            ${taxLine.exemptionReason ?? null}, ${taxLine.certificateNo ?? null}
        )
    `;
  }

  // ---- Post ----------------------------------------------------------------
  const journalDraft = buildDebitNoteJournal(
    doc,
    {
      accountsPayableId: accounts.AP,
      ...(accounts.SST_CLAIMABLE !== undefined
        ? { taxClaimableId: accounts.SST_CLAIMABLE }
        : {}),
    },
    {
      entryDate: input.debitDate,
      description: `Debit note ${debitNoteNo}`,
      contactId: input.supplierId,
      documentType: 'DEBIT_NOTE',
      documentId: debitNoteId,
    },
  );

  let journalEntryId: string | null = null;

  if (journalDraft !== null) {
    const validJournal = validateJournalEntry(journalDraft, currency);
    if (isErr(validJournal)) {
      throw new DebitNoteError('JOURNAL_INVALID', 'Generated journal is invalid', validJournal.error);
    }

    const posted = await postJournalEntry(tx, ctx, validJournal.value, {
      idempotencyKey: `debit-note:${input.idempotencyKey}`,
      emitEvent: {
        type: 'debitnote.issued',
        payload: { debitNoteId, debitNoteNo, total: doc.total.toDecimalString() },
      },
    });
    journalEntryId = posted.id;
  }

  await tx`
      UPDATE debit_note
         SET status = 'ISSUED', journal_entry_id = ${journalEntryId}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${debitNoteId}
  `;

  // ---- Apply allocations ---------------------------------------------------
  const affectedBills: { billId: string; status: string; amountDue: string }[] = [];

  for (const allocation of allocations) {
    await tx`
        INSERT INTO debit_note_allocation (tenant_id, debit_note_id, bill_id, amount)
        VALUES (${ctx.tenantId}, ${debitNoteId}, ${allocation.documentId},
                ${allocation.amount.toDecimalString()})
    `;

    const [updated] = await tx<
      { total: string; amount_paid: string; amount_credited: string }[]
    >`
        UPDATE bill
           SET amount_credited = amount_credited + ${allocation.amount.toDecimalString()}
         WHERE tenant_id = ${ctx.tenantId} AND id = ${allocation.documentId}
        RETURNING total, amount_paid, amount_credited
    `;

    // Same reasoning as the credit-note path: a bill fully covered by a debit
    // note is CREDITED, not PAID. The distinction matters when someone asks
    // what cash actually went out.
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
          : 'ENTERED';

    await tx`
        UPDATE bill SET status = ${status}
         WHERE tenant_id = ${ctx.tenantId} AND id = ${allocation.documentId}
    `;

    affectedBills.push({
      billId: allocation.documentId,
      status,
      amountDue: total.subtract(settled).toDecimalString(),
    });
  }

  return {
    id: debitNoteId,
    debitNoteNo,
    subtotal: doc.subtotal.toDecimalString(),
    taxTotal: doc.taxTotal.toDecimalString(),
    total: doc.total.toDecimalString(),
    allocatedTotal: allocationCheck.value.allocatedTotal.toDecimalString(),
    unallocated: allocationCheck.value.unallocated.toDecimalString(),
    journalEntryId,
    affectedBills,
    replayed: false,
  };
}

// ---------------------------------------------------------------------------

interface LoadedBill {
  readonly billId: string;
  readonly internalRef: string;
  readonly billDate: string;
  readonly dueDate: string;
  readonly total: Money;
  readonly amountDue: Money;
}

async function loadBillForUpdate(
  tx: Tx,
  ctx: TenantContext,
  billId: string,
  currency: string,
): Promise<LoadedBill | undefined> {
  const [row] = await tx<
    {
      id: string;
      internal_ref: string;
      bill_date: Date;
      due_date: Date;
      total: string;
      amount_due: string;
    }[]
  >`
      SELECT id, internal_ref, bill_date, due_date, total, amount_due
        FROM bill
       WHERE tenant_id = ${ctx.tenantId} AND id = ${billId} AND status <> 'DRAFT'
         FOR UPDATE
  `;

  if (!row) return undefined;

  return {
    billId: row.id,
    internalRef: row.internal_ref,
    billDate: toIsoDate(row.bill_date),
    dueDate: toIsoDate(row.due_date),
    total: Money.fromDecimal(row.total, currency),
    amountDue: Money.fromDecimal(row.amount_due, currency),
  };
}

/** Net input tax for a period: charges less debit notes. */
export async function inputTaxForPeriod(
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
         AND direction = 'INPUT'
         AND tax_point_date BETWEEN ${from} AND ${to}
  `;
  return { taxableAmount: row!.taxable, taxAmount: row!.tax };
}
