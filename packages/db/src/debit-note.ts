import {
  deriveCorrectionLines,
  type CorrectableLine,
  type CorrectionDerivationViolation,
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
  /** Decides which period this falls in. Defaults to the debit date. */
  readonly taxPointDate?: string;
  /**
   * Tax point of the SUPPLY BEING CORRECTED. Decides which RATE VERSION
   * applies, and nothing else.
   *
   * The payables twin of the same field on `IssueCreditNoteInput`, and it
   * exists for the same measured reason: computing a correction at the CURRENT
   * date's rate reverses a 6% charge with an 8% credit across Malaysia's 2024
   * service-tax change, overstating the reduction in the payable and tripping
   * the over-correction guard so the document is refused outright.
   *
   * Defaults to the referenced bill's tax point, because requiring it would
   * mean every caller has to get it right and the default is the bug.
   */
  readonly originalTaxPointDate?: string;
  readonly reason: CreditNoteReason;
  readonly reasonDetail?: string;
  readonly currency?: string;
  readonly amountsAreTaxInclusive?: boolean;
  readonly lines: readonly IssueDebitNoteLine[];
  readonly allocations?: readonly { billId: string; amount: string }[];
  readonly idempotencyKey: string;
}

export interface IssueDebitNoteLine {
  /** The bill line this reverses. Set by `debitFromBill`. */
  readonly sourceBillLineId?: string;
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
  // Which period this falls in: the debit note's own date.
  const taxPointDate = input.taxPointDate ?? input.debitDate;

  // Which RATE applies: the original supply's tax point. See the field's note.
  const [referencedBill] = input.billId
    ? await tx<{ tax_point_date: Date }[]>`
          SELECT tax_point_date FROM bill
           WHERE tenant_id = ${ctx.tenantId} AND id = ${input.billId}
      `
    : [];

  const rateTaxPointDate =
    input.originalTaxPointDate ??
    (referencedBill ? toIsoDate(referencedBill.tax_point_date) : taxPointDate);

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
    // The RATE date, not the period date. `computeTax` uses this only to
    // resolve the rate version and any exemption in force, both of which are
    // properties of the original supply rather than of the correction.
    taxPointDate: rateTaxPointDate,
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
          tax_point_date, original_tax_point_date, reason, reason_detail, currency,
          subtotal, tax_total, total, allocated_amount, status,
          idempotency_key, issued_by, issued_at
      ) VALUES (
          ${ctx.tenantId}, ${debitNoteNo}, ${input.supplierId}, ${input.billId ?? null},
          ${input.debitDate}, ${taxPointDate}, ${rateTaxPointDate}, ${input.reason},
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
            taxable_amount, tax_amount, line_total, source_bill_line_id
        ) VALUES (
            ${ctx.tenantId}, ${debitNoteId}, ${index + 1},
            ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.discountBasisPoints ?? 0}, ${line.accountId}, ${line.taxCodeId},
            ${computedLine.netAmount.toDecimalString()},
            ${computedLine.taxAmount.toDecimalString()},
            ${computedLine.lineTotal.toDecimalString()},
            ${line.sourceBillLineId ?? null}
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

// ---------------------------------------------------------------------------
// Correcting from the original document
// ---------------------------------------------------------------------------

export interface DebitFromBillInput {
  readonly billId: string;
  readonly debitDate: string;
  readonly reason: CreditNoteReason;
  readonly reasonDetail?: string;
  /** Omit to reverse everything not already reversed. */
  readonly lines?: readonly { billLineId: string; quantity?: string }[];
  readonly idempotencyKey: string;
}

/**
 * Raise a debit note from the bill it corrects.
 *
 * The payables mirror of `creditFromInvoice`, and it exists for the same
 * reason: every figure comes off the document being corrected rather than
 * being retyped. On this side the figures are the SUPPLIER's — their price,
 * their tax code, the account the spend landed in — and a debit note that
 * differs from the bill in any of them is not a reversal of that bill.
 */
export async function debitFromBill(
  tx: Tx,
  ctx: TenantContext,
  input: DebitFromBillInput,
): Promise<IssuedDebitNote> {
  const [bill] = await tx<
    { id: string; supplier_id: string; currency: string; tax_point_date: Date; status: string }[]
  >`
      SELECT id, supplier_id, currency, tax_point_date, status
        FROM bill
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.billId}
  `;

  // 404-shaped, and indistinguishable from another tenant's bill — RLS has
  // already filtered that out, so the service genuinely cannot tell.
  if (!bill) {
    throw new DebitNoteError('BILL_NOT_FOUND', `Bill ${input.billId} not found`);
  }

  if (bill.status === 'DRAFT') {
    throw new DebitNoteError(
      'DEBIT_INVALID',
      'A draft bill has not been entered, so there is nothing to correct.',
    );
  }

  /*
   * How much of each line has already been reversed, summed from
   * `debit_note_line` rather than kept in a counter on `bill_line`. VOIDED
   * debit notes are excluded: a voided document reverses nothing, so the
   * quantity it named is available again.
   */
  const lineRows = await tx<
    {
      id: string; line_no: number; description: string; quantity: string;
      unit_price: string; account_id: string; tax_code_id: string;
      discount_basis_points: number; already_reversed: string;
    }[]
  >`
      SELECT bl.id, bl.line_no, bl.description, bl.quantity::text, bl.unit_price::text,
             bl.account_id, bl.tax_code_id, bl.discount_basis_points,
             COALESCE((
                 SELECT SUM(dnl.quantity)
                   FROM debit_note_line dnl
                   JOIN debit_note dn
                     ON dn.tenant_id = dnl.tenant_id AND dn.id = dnl.debit_note_id
                  WHERE dnl.tenant_id = bl.tenant_id
                    AND dnl.source_bill_line_id = bl.id
                    AND dn.status <> 'VOIDED'
             ), 0)::text AS already_reversed
        FROM bill_line bl
       WHERE bl.tenant_id = ${ctx.tenantId} AND bl.bill_id = ${input.billId}
       ORDER BY bl.line_no
  `;

  const correctable: CorrectableLine[] = lineRows.map((r) => ({
    sourceLineId: r.id,
    lineNo: r.line_no,
    description: r.description,
    quantity: r.quantity,
    unitPrice: Money.fromDecimal(r.unit_price, bill.currency),
    accountId: r.account_id,
    taxCodeId: r.tax_code_id,
    ...(r.discount_basis_points ? { discountBasisPoints: r.discount_basis_points } : {}),
    alreadyCredited: r.already_reversed,
  }));

  const derived = deriveCorrectionLines(
    correctable,
    input.lines !== undefined
      ? {
          lines: input.lines.map((l) => ({
            sourceLineId: l.billLineId,
            ...(l.quantity !== undefined ? { quantity: l.quantity } : {}),
          })),
        }
      : {},
  );

  if (isErr(derived)) {
    throw new DebitNoteError(
      'DEBIT_INVALID',
      derived.error.map(describeDerivation).join('; '),
      derived.error,
    );
  }

  return issueDebitNote(tx, ctx, {
    supplierId: bill.supplier_id,
    billId: input.billId,
    debitDate: input.debitDate,
    originalTaxPointDate: toIsoDate(bill.tax_point_date),
    reason: input.reason,
    ...(input.reasonDetail !== undefined ? { reasonDetail: input.reasonDetail } : {}),
    currency: bill.currency,
    lines: derived.value.map((l) => ({
      sourceBillLineId: l.sourceLineId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice.toDecimalString(),
      accountId: l.accountId,
      taxCodeId: l.taxCodeId,
      ...(l.discountBasisPoints !== undefined
        ? { discountBasisPoints: l.discountBasisPoints }
        : {}),
    })),
    idempotencyKey: input.idempotencyKey,
  });
}

function describeDerivation(v: CorrectionDerivationViolation): string {
  switch (v.code) {
    case 'NO_SUCH_LINE':
      return `Bill line ${v.sourceLineId} is not on this bill`;
    case 'NOTHING_TO_CREDIT':
      return 'Every line on this bill has already been reversed in full';
    case 'EXCEEDS_REMAINING':
      return `Line ${v.sourceLineId}: asked to reverse ${v.requested}, only ${v.remaining} remains`;
    case 'NON_POSITIVE_QUANTITY':
      return `Line ${v.sourceLineId}: ${v.quantity} is not a reversible quantity`;
  }
}
