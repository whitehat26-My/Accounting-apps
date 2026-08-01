import {
  buildPurchaseJournal,
  computeDocument,
  converter,
  isErr,
  Money,
  validateJournalEntry,
  type DocumentLine,
  type DocumentViolation,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';
import { loadBaseCurrency, loadTaxCodes, resolveRate } from './invoice.js';
import { addDays, decimalToScaled } from './internal.js';

/**
 * BillService.enter() — the DRAFT -> ENTERED transition (M3).
 *
 * The mirror of `issueInvoice()`, and deliberately structured the same way so
 * the two can be read side by side. One transaction: allocate our internal
 * reference, compute tax, write the bill and its lines, record the input-tax
 * evidence, and post the ledger entry.
 *
 * ---------------------------------------------------------------------------
 * TWO NUMBERS, AND THEY ARE NOT INTERCHANGEABLE.
 *
 * `billNo` is the SUPPLIER's document number. We do not control it, it is not
 * unique across suppliers, and it is not gapless — two suppliers both
 * numbering their invoices INV-001 is entirely normal. Making it tenant-unique
 * is the most common AP modelling mistake there is, and it surfaces as a
 * customer who cannot enter a bill.
 *
 * `internalRef` is ours: gapless, allocated through
 * `allocate_document_number('BILL')`, and what an auditor follows.
 * ---------------------------------------------------------------------------
 *
 * WHAT IS NOT HERE: an approval workflow. Threshold routing and separation of
 * duties need users and roles, which arrive with M0. Until then a bill is
 * entered by whoever is connected, and pretending otherwise would give a false
 * assurance of control.
 */

export interface EnterBillInput {
  readonly supplierId: string;
  /** The supplier's own number, as printed. Not ours, not unique. */
  readonly billNo: string;
  readonly billDate: string;
  readonly dueDate?: string;
  /** Defaults to the bill date. The tax point selects the rate version. */
  readonly taxPointDate?: string;
  readonly currency?: string;
  readonly fxRate?: string;
  readonly amountsAreTaxInclusive?: boolean;
  readonly reference?: string;
  readonly lines: readonly EnterBillLine[];
  readonly idempotencyKey: string;
}

export interface EnterBillLine {
  readonly description: string;
  /** Decimal string, e.g. "2.5". Never a float. */
  readonly quantity: string;
  readonly unitPrice: string;
  /** The expense or asset account the spend lands in. */
  readonly accountId: string;
  readonly taxCodeId: string;
  readonly itemId?: string;
  readonly discountBasisPoints?: number;
}

export interface EnteredBill {
  readonly id: string;
  readonly internalRef: string;
  readonly billNo: string;
  readonly subtotal: string;
  readonly taxTotal: string;
  readonly total: string;
  /** Null for a zero-total bill, which has no ledger effect to post. */
  readonly journalEntryId: string | null;
  readonly replayed: boolean;
}

export class BillError extends Error {
  constructor(
    readonly code:
      | 'SUPPLIER_NOT_FOUND'
      | 'NOT_A_SUPPLIER'
      | 'NO_POSTING_ACCOUNTS'
      | 'DOCUMENT_INVALID'
      | 'NO_EXCHANGE_RATE'
      | 'JOURNAL_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'BillError';
  }
}

const QUANTITY_SCALE = 4n;

export async function enterBill(
  tx: Tx,
  ctx: TenantContext,
  input: EnterBillInput,
): Promise<EnteredBill> {
  // ---- Idempotency ---------------------------------------------------------
  const existing = await tx<
    {
      id: string;
      internal_ref: string;
      bill_no: string;
      subtotal: string;
      tax_total: string;
      total: string;
      journal_entry_id: string | null;
    }[]
  >`
      SELECT id, internal_ref, bill_no, subtotal, tax_total, total, journal_entry_id
        FROM bill
       WHERE tenant_id = ${ctx.tenantId}
         AND idempotency_key = ${input.idempotencyKey}
  `;

  if (existing.length > 0) {
    const row = existing[0]!;
    return {
      id: row.id,
      internalRef: row.internal_ref,
      billNo: row.bill_no,
      subtotal: row.subtotal,
      taxTotal: row.tax_total,
      total: row.total,
      journalEntryId: row.journal_entry_id,
      replayed: true,
    };
  }

  const currency = input.currency ?? 'MYR';
  const taxPointDate = input.taxPointDate ?? input.billDate;

  // ---- Load context --------------------------------------------------------
  const [supplier] = await tx<
    { id: string; is_supplier: boolean; payment_terms_days: number }[]
  >`
      SELECT id, is_supplier, payment_terms_days FROM contact
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.supplierId}
  `;
  if (!supplier) {
    // Same failure a cross-tenant id produces: RLS has already filtered the
    // other tenant's contact out, so the caller cannot tell "does not exist"
    // from "not yours". CLAUDE.md rule 9.
    throw new BillError('SUPPLIER_NOT_FOUND', `Contact ${input.supplierId} not found`);
  }
  if (!supplier.is_supplier) {
    throw new BillError(
      'NOT_A_SUPPLIER',
      `Contact ${input.supplierId} is not flagged as a supplier`,
    );
  }

  const taxCodes = await loadTaxCodes(tx, ctx);
  const accounts = await loadPurchasePostingAccounts(tx, ctx);

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
    direction: 'INPUT',
    amountsAreTaxInclusive: input.amountsAreTaxInclusive ?? false,
    taxCodes,
    // Exemptions are a SALES-side concept: a customer presents a certificate
    // and we do not charge them. Nothing our supplier does exempts us from
    // what they charged, so no exemption lookup happens here.
    entity: { isRegistered: org?.sst_registered ?? false, exemptions: [] },
  });

  if (isErr(computed)) {
    throw new BillError(
      'DOCUMENT_INVALID',
      'Bill failed validation',
      computed.error satisfies DocumentViolation[],
    );
  }
  const doc = computed.value;

  // ---- Persist -------------------------------------------------------------
  const [numbered] = await tx<{ allocate_document_number: string }[]>`
      SELECT allocate_document_number('BILL')
  `;
  const internalRef = numbered!.allocate_document_number;

  const dueDate = input.dueDate ?? addDays(input.billDate, supplier.payment_terms_days);

  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const rate = await resolveRate(tx, ctx, currency, baseCurrency, input.billDate, input.fxRate);

  const [billRow] = await tx<{ id: string }[]>`
      INSERT INTO bill (
          tenant_id, internal_ref, bill_no, supplier_id, bill_date, due_date,
          tax_point_date, currency, fx_rate, amounts_tax_inclusive,
          subtotal, tax_total, total, status, reference, idempotency_key,
          entered_by, entered_at
      ) VALUES (
          ${ctx.tenantId}, ${internalRef}, ${input.billNo}, ${input.supplierId},
          ${input.billDate}, ${dueDate}, ${taxPointDate}, ${currency},
          ${rate.toDecimalString()}, ${input.amountsAreTaxInclusive ?? false},
          ${doc.subtotal.toDecimalString()}, ${doc.taxTotal.toDecimalString()},
          ${doc.total.toDecimalString()}, 'DRAFT', ${input.reference ?? null},
          ${input.idempotencyKey}, ${ctx.userId ?? null}, now()
      )
      RETURNING id
  `;
  const billId = billRow!.id;

  for (const [index, line] of input.lines.entries()) {
    const computedLine = doc.lines[index]!;
    await tx`
        INSERT INTO bill_line (
            tenant_id, bill_id, line_no, item_id, description, quantity,
            unit_price, discount_basis_points, account_id, tax_code_id,
            taxable_amount, tax_amount, line_total
        ) VALUES (
            ${ctx.tenantId}, ${billId}, ${index + 1}, ${line.itemId ?? null},
            ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.discountBasisPoints ?? 0}, ${line.accountId}, ${line.taxCodeId},
            ${computedLine.netAmount.toDecimalString()},
            ${computedLine.taxAmount.toDecimalString()},
            ${computedLine.lineTotal.toDecimalString()}
        )
    `;
  }

  // ---- Immutable tax evidence ---------------------------------------------
  // Direction INPUT. This is the first writer of INPUT rows: `tax_transaction`
  // has carried the direction since the tax engine landed but until now only
  // sales ever wrote to it.
  for (const taxLine of doc.tax.lines) {
    await tx`
        INSERT INTO tax_transaction (
            tenant_id, source_document_type, source_document_id, tax_code_id,
            rate_basis_points, taxable_amount, tax_amount, tax_point_date,
            direction, exemption_reason, certificate_no
        ) VALUES (
            ${ctx.tenantId}, 'BILL', ${billId}, ${taxLine.taxCodeId},
            ${Number(taxLine.rateBasisPoints)},
            ${taxLine.taxableAmount.toDecimalString()},
            ${taxLine.taxAmount.toDecimalString()},
            ${taxPointDate}, 'INPUT',
            ${taxLine.exemptionReason ?? null}, ${taxLine.certificateNo ?? null}
        )
    `;
  }

  // ---- Post to the ledger --------------------------------------------------
  const journalDraft = buildPurchaseJournal(
    doc,
    {
      accountsPayableId: accounts.AP,
      // Optional by design: a tenant whose SST is always a cost has no
      // claimable account, and `buildPurchaseJournal` throws by name if a
      // RECOVERABLE line arrives without one.
      ...(accounts.SST_CLAIMABLE !== undefined
        ? { taxClaimableId: accounts.SST_CLAIMABLE }
        : {}),
    },
    {
      entryDate: input.billDate,
      description: `Bill ${internalRef} (${input.billNo})`,
      contactId: input.supplierId,
      documentType: 'BILL',
      documentId: billId,
      ...(rate.isOne()
        ? {}
        : { fxRate: { baseCurrency, convert: converter(rate, baseCurrency) } }),
    },
  );

  let journalEntryId: string | null = null;

  if (journalDraft !== null) {
    const validated = validateJournalEntry(journalDraft, baseCurrency);
    if (isErr(validated)) {
      throw new BillError('JOURNAL_INVALID', 'Generated journal is invalid', validated.error);
    }

    const posted = await postJournalEntry(tx, ctx, validated.value, {
      idempotencyKey: `bill:${input.idempotencyKey}`,
      emitEvent: {
        type: 'bill.entered',
        payload: { billId, internalRef, billNo: input.billNo, total: doc.total.toDecimalString() },
      },
    });
    journalEntryId = posted.id;
  }

  await tx`
      UPDATE bill
         SET status = 'ENTERED', journal_entry_id = ${journalEntryId}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${billId}
  `;

  return {
    id: billId,
    internalRef,
    billNo: input.billNo,
    subtotal: doc.subtotal.toDecimalString(),
    taxTotal: doc.taxTotal.toDecimalString(),
    total: doc.total.toDecimalString(),
    journalEntryId,
    replayed: false,
  };
}

// ---------------------------------------------------------------------------
// Repository reads
// ---------------------------------------------------------------------------

/**
 * The roles the purchase posting path requires.
 *
 * `SST_CLAIMABLE` is deliberately OPTIONAL. Under SST, input tax is normally a
 * cost absorbed into the expense — see `packages/domain/src/tax.ts` — so most
 * Malaysian tenants will never post to a claimable account and should not be
 * forced to create one to enter their first bill.
 */
export interface PurchasePostingAccountMap {
  readonly AP: string;
  readonly SST_CLAIMABLE?: string;
}

export async function loadPurchasePostingAccounts(
  tx: Tx,
  ctx: TenantContext,
): Promise<PurchasePostingAccountMap> {
  const rows = await tx<{ role: string; account_id: string }[]>`
      SELECT role, account_id FROM posting_account_map WHERE tenant_id = ${ctx.tenantId}
  `;

  const map = new Map(rows.map((r) => [r.role, r.account_id]));
  const ap = map.get('AP');
  if (!ap) {
    throw new BillError(
      'NO_POSTING_ACCOUNTS',
      'Posting account for role AP is not configured for this organisation',
    );
  }

  const claimable = map.get('SST_CLAIMABLE');
  return { AP: ap, ...(claimable ? { SST_CLAIMABLE: claimable } : {}) };
}

/**
 * Outstanding payables, valued in the BASE currency at BOOKED rates.
 *
 * The AP mirror of `outstandingReceivables()`, and it exists for the same
 * reason: this is the number ledger invariant #7 compares against the AP
 * control account. Summing `amount_due` across currencies would add ringgit to
 * dollars and produce a figure that reconciles to nothing.
 */
export async function outstandingPayables(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ total: string; count: number }> {
  const [row] = await tx<{ total: string; count: string }[]>`
      SELECT COALESCE(SUM(ROUND(amount_due * fx_rate, 4)), 0)::text AS total,
             COUNT(*)::text                                          AS count
        FROM bill
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('ENTERED','PART_PAID')
  `;
  return { total: row!.total, count: Number(row!.count) };
}

/** Open bills a supplier payment can be allocated against. */
export async function openBills(
  tx: Tx,
  ctx: TenantContext,
  supplierId: string,
): Promise<
  {
    id: string;
    internalRef: string;
    billNo: string;
    billDate: string;
    dueDate: string;
    currency: string;
    fxRate: string;
    amountDue: string;
  }[]
> {
  const rows = await tx<
    {
      id: string;
      internal_ref: string;
      bill_no: string;
      bill_date: Date;
      due_date: Date;
      currency: string;
      fx_rate: string;
      amount_due: string;
    }[]
  >`
      SELECT id, internal_ref, bill_no, bill_date, due_date, currency, fx_rate, amount_due
        FROM bill
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('ENTERED','PART_PAID')
         AND amount_due > 0
         AND supplier_id = ${supplierId}
       ORDER BY bill_date, internal_ref
  `;

  return rows.map((r) => ({
    id: r.id,
    internalRef: r.internal_ref,
    billNo: r.bill_no,
    billDate: r.bill_date.toISOString().slice(0, 10),
    dueDate: r.due_date.toISOString().slice(0, 10),
    currency: r.currency,
    fxRate: r.fx_rate,
    amountDue: r.amount_due,
  }));
}
