import {
  buildSalesJournal,
  computeDocument,
  converter,
  isErr,
  Money,
  Rate,
  validateJournalEntry,
  type DocumentLine,
  type DocumentViolation,
  type TaxCode,
  type TaxExemption,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';
import { addDays, decimalToScaled, toIsoDate } from './internal.js';
import { resolveLineFromItem } from './item.js';

/**
 * InvoiceService.issue() — the DRAFT -> ISSUED transition (M2).
 *
 * One transaction: allocate the invoice number, compute tax, write the
 * invoice and its lines, record the immutable tax evidence, post the ledger
 * entry, and queue the e-invoice submission. Any failure rolls the whole lot
 * back, so an invoice can never exist without its journal entry.
 *
 * Note what is NOT here: the MyInvois call. The invoice must be issuable when
 * LHDN's gateway is down, so submission is an outbox event consumed by a
 * worker, never a synchronous dependency of issuance.
 */

export interface IssueInvoiceInput {
  readonly contactId: string;
  readonly issueDate: string;
  readonly dueDate?: string;
  /** Defaults to the issue date. The tax point selects the rate version. */
  readonly taxPointDate?: string;
  readonly currency?: string;
  /**
   * Rate to the base currency. Omit to look up the stored rate for the issue
   * date. Supplied explicitly when a contracted rate applies.
   */
  readonly fxRate?: string;
  readonly amountsAreTaxInclusive?: boolean;
  readonly reference?: string;
  readonly lines: readonly IssueInvoiceLine[];
  readonly idempotencyKey: string;
}

/**
 * One line.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING BUT `quantity` IS OPTIONAL WHEN `itemId` IS SUPPLIED.
 *
 * `itemId` has been accepted on this interface since M2 and stored and ignored
 * ever since, so a caller had to type a description, a price, an account, a tax
 * code and a MyInvois classification code on every line — including the one
 * field, `classificationCode`, whose absence dead-letters the e-Invoice
 * submission days later rather than failing here.
 *
 * With an item the defaults come from the catalogue and anything supplied
 * overrides them. Quantity is never defaulted: an item has no inherent
 * quantity, and a line that silently became "1" is a wrong invoice.
 * ---------------------------------------------------------------------------
 */
export interface IssueInvoiceLine {
  /** Decimal string, e.g. "2.5". Never a float. Never defaulted. */
  readonly quantity: string;
  readonly itemId?: string;
  /** Required unless `itemId` supplies it. */
  readonly description?: string;
  /** Decimal string, e.g. "1000.00". Required unless `itemId` supplies it. */
  readonly unitPrice?: string;
  readonly accountId?: string;
  readonly taxCodeId?: string;
  readonly discountBasisPoints?: number;
  readonly classificationCode?: string;
  readonly unitOfMeasure?: string;
}

/** A line with every field settled — from the item, the caller, or both. */
interface SettledLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly accountId: string;
  readonly taxCodeId: string;
  readonly itemId?: string;
  readonly discountBasisPoints?: number;
  readonly classificationCode?: string;
  readonly unitOfMeasure?: string;
  readonly uomCode?: string;
}

export interface IssuedInvoice {
  readonly id: string;
  readonly invoiceNo: string;
  readonly subtotal: string;
  readonly taxTotal: string;
  readonly total: string;
  /** Null for a zero-total invoice, which has no ledger effect to post. */
  readonly journalEntryId: string | null;
  readonly replayed: boolean;
}

export class InvoiceError extends Error {
  constructor(
    readonly code:
      | 'CONTACT_NOT_FOUND'
      | 'NO_POSTING_ACCOUNTS'
      | 'DOCUMENT_INVALID'
      | 'NO_EXCHANGE_RATE'
      | 'JOURNAL_INVALID'
      | 'LINE_INCOMPLETE',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'InvoiceError';
  }
}

const QUANTITY_SCALE = 4n;

export async function issueInvoice(
  tx: Tx,
  ctx: TenantContext,
  input: IssueInvoiceInput,
): Promise<IssuedInvoice> {
  // ---- Idempotency ---------------------------------------------------------
  const existing = await tx<
    { id: string; invoice_no: string; subtotal: string; tax_total: string; total: string; journal_entry_id: string | null }[]
  >`
      SELECT id, invoice_no, subtotal, tax_total, total, journal_entry_id
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND idempotency_key = ${input.idempotencyKey}
  `;

  if (existing.length > 0) {
    const row = existing[0]!;
    return {
      id: row.id,
      invoiceNo: row.invoice_no,
      subtotal: row.subtotal,
      taxTotal: row.tax_total,
      total: row.total,
      journalEntryId: row.journal_entry_id,
      replayed: true,
    };
  }

  const currency = input.currency ?? 'MYR';
  const taxPointDate = input.taxPointDate ?? input.issueDate;

  // ---- Load the tenant's tax and entity context ----------------------------
  const [contact] = await tx<{ id: string; payment_terms_days: number }[]>`
      SELECT id, payment_terms_days FROM contact
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.contactId}
  `;
  if (!contact) {
    // Deliberately the same shape of failure a cross-tenant id would produce:
    // RLS has already filtered another tenant's contact out of this query, so
    // the caller cannot distinguish "does not exist" from "not yours".
    throw new InvoiceError('CONTACT_NOT_FOUND', `Contact ${input.contactId} not found`);
  }

  const taxCodes = await loadTaxCodes(tx, ctx);
  const exemptions = await loadExemptions(tx, ctx, input.contactId);
  const accounts = await loadPostingAccounts(tx, ctx);

  const [org] = await tx<{ sst_registered: boolean }[]>`
      SELECT sst_registered FROM organisation WHERE id = ${ctx.tenantId}
  `;

  // ---- Settle each line against the catalogue ------------------------------
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const lines = await settleLines(tx, ctx, input.lines, currency, baseCurrency);

  // ---- Compute (pure domain) ----------------------------------------------
  const documentLines: DocumentLine[] = lines.map((line, index) => ({
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
    entity: { isRegistered: org?.sst_registered ?? false, exemptions },
  });

  if (isErr(computed)) {
    throw new InvoiceError('DOCUMENT_INVALID', 'Invoice failed validation', computed.error satisfies DocumentViolation[]);
  }
  const doc = computed.value;

  // ---- Persist -------------------------------------------------------------
  const [numbered] = await tx<{ allocate_document_number: string }[]>`
      SELECT allocate_document_number('INVOICE')
  `;
  const invoiceNo = numbered!.allocate_document_number;

  const dueDate = input.dueDate ?? addDays(input.issueDate, contact.payment_terms_days);

  const [invoiceRow] = await tx<{ id: string }[]>`
      INSERT INTO invoice (
          tenant_id, invoice_no, contact_id, issue_date, due_date, tax_point_date,
          currency, amounts_tax_inclusive, subtotal, tax_total, total,
          status, reference, idempotency_key, issued_by, issued_at
      ) VALUES (
          ${ctx.tenantId}, ${invoiceNo}, ${input.contactId}, ${input.issueDate},
          ${dueDate}, ${taxPointDate}, ${currency},
          ${input.amountsAreTaxInclusive ?? false},
          ${doc.subtotal.toDecimalString()}, ${doc.taxTotal.toDecimalString()},
          ${doc.total.toDecimalString()}, 'DRAFT', ${input.reference ?? null},
          ${input.idempotencyKey}, ${ctx.userId ?? null}, now()
      )
      RETURNING id
  `;
  const invoiceId = invoiceRow!.id;

  for (const [index, line] of lines.entries()) {
    const computedLine = doc.lines[index]!;
    // The SETTLED values, not the input. This copy is what makes a May invoice
    // still say RM 80 after the item's price rises in June — `item_id` is kept
    // for reporting and must never be joined to for an amount.
    await tx`
        INSERT INTO invoice_line (
            tenant_id, invoice_id, line_no, item_id, description, quantity,
            unit_price, discount_basis_points, account_id, tax_code_id,
            taxable_amount, tax_amount, line_total, classification_code,
            unit_of_measure, uom_code
        ) VALUES (
            ${ctx.tenantId}, ${invoiceId}, ${index + 1}, ${line.itemId ?? null},
            ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.discountBasisPoints ?? 0}, ${line.accountId}, ${line.taxCodeId},
            ${computedLine.netAmount.toDecimalString()},
            ${computedLine.taxAmount.toDecimalString()},
            ${computedLine.lineTotal.toDecimalString()},
            ${line.classificationCode ?? null},
            ${line.unitOfMeasure ?? null}, ${line.uomCode ?? null}
        )
    `;
  }

  // ---- Immutable tax evidence ---------------------------------------------
  // The SST return is summed from these rows, never recomputed from current
  // rates — which is what makes a filed return reproducible after a rate change.
  for (const taxLine of doc.tax.lines) {
    await tx`
        INSERT INTO tax_transaction (
            tenant_id, source_document_type, source_document_id, tax_code_id,
            rate_basis_points, taxable_amount, tax_amount, tax_point_date,
            direction, exemption_reason, certificate_no
        ) VALUES (
            ${ctx.tenantId}, 'INVOICE', ${invoiceId}, ${taxLine.taxCodeId},
            ${Number(taxLine.rateBasisPoints)},
            ${taxLine.taxableAmount.toDecimalString()},
            ${taxLine.taxAmount.toDecimalString()},
            ${taxPointDate}, 'OUTPUT',
            ${taxLine.exemptionReason ?? null}, ${taxLine.certificateNo ?? null}
        )
    `;
  }

  // ---- Post to the ledger --------------------------------------------------
  // The rate is resolved and STORED on the invoice, because AR must later be
  // relieved at this exact rate — see ledger invariant #13.
  const rate = await resolveRate(tx, ctx, currency, baseCurrency, input.issueDate, input.fxRate);

  if (!rate.isOne()) {
    await tx`
        UPDATE invoice SET fx_rate = ${rate.toDecimalString()}
         WHERE tenant_id = ${ctx.tenantId} AND id = ${invoiceId}
    `;
  }

  const journalDraft = buildSalesJournal(
    doc,
    { accountsReceivableId: accounts.AR, taxPayableId: accounts.SST_PAYABLE },
    {
      entryDate: input.issueDate,
      description: `Invoice ${invoiceNo}`,
      contactId: input.contactId,
      documentType: 'INVOICE',
      documentId: invoiceId,
      ...(rate.isOne()
        ? {}
        : { fxRate: { baseCurrency, convert: converter(rate, baseCurrency) } }),
    },
  );

  // A zero-total invoice (free sample, warranty replacement, fully discounted
  // line) is a legitimate document with no debits and no credits. It is issued
  // and sent, but nothing is posted — there is nothing to post.
  let journalEntryId: string | null = null;

  if (journalDraft !== null) {
    // The ledger balances in BASE currency. A multi-currency entry need not
    // balance in the transaction currency.
    const validated = validateJournalEntry(journalDraft, baseCurrency);
    if (isErr(validated)) {
      // Unreachable if the domain is correct — which is exactly why it must
      // throw loudly rather than post something unbalanced.
      throw new InvoiceError('JOURNAL_INVALID', 'Generated journal is invalid', validated.error);
    }

    const posted = await postJournalEntry(tx, ctx, validated.value, {
      idempotencyKey: `invoice:${input.idempotencyKey}`,
      emitEvent: {
        type: 'invoice.issued',
        payload: { invoiceId, invoiceNo, total: doc.total.toDecimalString() },
      },
    });
    journalEntryId = posted.id;
  }

  await tx`
      UPDATE invoice
         SET status = 'ISSUED', journal_entry_id = ${journalEntryId}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${invoiceId}
  `;

  return {
    id: invoiceId,
    invoiceNo,
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

export async function loadTaxCodes(tx: Tx, ctx: TenantContext): Promise<TaxCode[]> {
  const rows = await tx<
    {
      id: string;
      code: string;
      name: string;
      regime: TaxCode['regime'];
      input_treatment: TaxCode['inputTreatment'];
      rate_basis_points: number | null;
      valid_from: Date | null;
      valid_to: Date | null;
      legislation_ref: string | null;
    }[]
  >`
      SELECT c.id, c.code, c.name, c.regime, c.input_treatment,
             v.rate_basis_points, v.valid_from, v.valid_to, v.legislation_ref
        FROM tax_code c
        LEFT JOIN tax_rate_version v
          ON v.tenant_id = c.tenant_id AND v.tax_code_id = c.id
       WHERE c.tenant_id = ${ctx.tenantId} AND c.is_active
       ORDER BY c.code, v.valid_from
  `;

  const byId = new Map<string, TaxCode>();
  for (const row of rows) {
    const current = byId.get(row.id) ?? {
      id: row.id,
      code: row.code,
      name: row.name,
      regime: row.regime,
      inputTreatment: row.input_treatment,
      versions: [],
    };

    const versions = [...current.versions];
    if (row.rate_basis_points !== null && row.valid_from !== null) {
      versions.push({
        rateBasisPoints: BigInt(row.rate_basis_points),
        validFrom: toIsoDate(row.valid_from),
        validTo: row.valid_to ? toIsoDate(row.valid_to) : null,
        ...(row.legislation_ref ? { legislationRef: row.legislation_ref } : {}),
      });
    }

    byId.set(row.id, { ...current, versions });
  }

  return [...byId.values()];
}

async function loadExemptions(
  tx: Tx,
  ctx: TenantContext,
  contactId: string,
): Promise<TaxExemption[]> {
  const rows = await tx<
    { certificate_no: string; valid_from: Date; valid_to: Date | null; tax_code_ids: string[] }[]
  >`
      SELECT certificate_no, valid_from, valid_to, tax_code_ids
        FROM tax_exemption
       WHERE tenant_id = ${ctx.tenantId} AND contact_id = ${contactId}
  `;

  return rows.map((r) => ({
    certificateNo: r.certificate_no,
    validFrom: toIsoDate(r.valid_from),
    validTo: r.valid_to ? toIsoDate(r.valid_to) : null,
    taxCodeIds: r.tax_code_ids,
  }));
}

/** The roles the sales posting path requires. Absence is a setup error. */
export interface SalesPostingAccountMap {
  readonly AR: string;
  readonly SST_PAYABLE: string;
}

async function loadPostingAccounts(
  tx: Tx,
  ctx: TenantContext,
): Promise<SalesPostingAccountMap> {
  const rows = await tx<{ role: string; account_id: string }[]>`
      SELECT role, account_id FROM posting_account_map WHERE tenant_id = ${ctx.tenantId}
  `;

  const map = new Map(rows.map((r) => [r.role, r.account_id]));
  const required = ['AR', 'SST_PAYABLE'] as const;

  for (const role of required) {
    if (!map.get(role)) {
      throw new InvoiceError(
        'NO_POSTING_ACCOUNTS',
        `Posting account for role ${role} is not configured for this organisation`,
      );
    }
  }

  return { AR: map.get('AR')!, SST_PAYABLE: map.get('SST_PAYABLE')! };
}

/**
 * Outstanding receivables, valued in the BASE currency.
 *
 * Each invoice is carried at the rate it was booked at (`amount_due * fx_rate`),
 * which is what makes ledger invariant #6 — AR control equals the subledger —
 * hold for a multi-currency tenant. Summing `amount_due` across currencies
 * would add ringgit to dollars and produce a number that means nothing.
 *
 * Note this is the HISTORICAL-rate valuation. Restating open foreign balances
 * at the period-end rate (unrealised revaluation) is a separate, not yet
 * implemented, step.
 */
export async function outstandingReceivables(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ total: string; count: number }> {
  const [row] = await tx<{ total: string; count: string }[]>`
      SELECT COALESCE(SUM(ROUND(amount_due * fx_rate, 4)), 0)::text AS total,
             COUNT(*)::text                                          AS count
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('ISSUED','PART_PAID')
  `;
  return { total: row!.total, count: Number(row!.count) };
}

/** Outstanding receivables broken down by transaction currency. */
export async function outstandingByCurrency(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ currency: string; total: string; baseTotal: string }[]> {
  return tx<{ currency: string; total: string; baseTotal: string }[]>`
      SELECT currency,
             SUM(amount_due)::text                      AS total,
             SUM(ROUND(amount_due * fx_rate, 4))::text  AS "baseTotal"
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('ISSUED','PART_PAID')
       GROUP BY currency
       ORDER BY currency
  `;
}

// ------------------------------------------------------------------ internals

/** "2.5" -> 25000n at scale 4. Rejects excess precision rather than rounding. */
export async function loadBaseCurrency(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx<{ base_currency: string }[]>`
      SELECT base_currency FROM organisation WHERE id = ${ctx.tenantId}
  `;
  return row?.base_currency ?? 'MYR';
}

/**
 * Resolve the rate for a document, preferring an explicitly supplied one.
 *
 * A missing rate is an error rather than a silent fallback to 1. Posting a
 * USD invoice at 1:1 would understate revenue by a factor of four and look
 * entirely plausible on the screen.
 */
export async function resolveRate(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  baseCurrency: string,
  date: string,
  explicit?: string,
): Promise<Rate> {
  if (currency === baseCurrency) return Rate.one();
  if (explicit) return Rate.fromDecimal(explicit);

  const [row] = await tx<{ rate: string | null }[]>`
      SELECT rate_on_or_before(${currency}, ${baseCurrency}, ${date}::date) AS rate
  `;

  if (!row?.rate) {
    throw new InvoiceError(
      'NO_EXCHANGE_RATE',
      `No ${currency}/${baseCurrency} exchange rate on or before ${date}. ` +
        'Supply one explicitly or import the rate for that date.',
    );
  }

  return Rate.fromDecimal(row.rate);
}

/**
 * Fill in whatever the caller left out, from the item catalogue.
 *
 * ---------------------------------------------------------------------------
 * AN ITEM'S PRICE IS IN THE BASE CURRENCY, AND IS NOT DEFAULTED ONTO A
 * FOREIGN-CURRENCY INVOICE.
 *
 * `item.sale_unit_price` is NUMERIC with no currency column, and every other
 * amount stored without one in this system is MYR. Defaulting RM 1,000 onto a
 * USD invoice would produce a line reading $1,000 — a four-fold overstatement
 * that is arithmetically consistent all the way through the ledger, the tax
 * computation and the statements, and therefore invisible to every check.
 *
 * A per-currency price list is the real answer and is not built. Until it is,
 * a foreign-currency line must carry its own price, and the refusal says why
 * rather than failing somewhere further downstream.
 * ---------------------------------------------------------------------------
 */
async function settleLines(
  tx: Tx,
  ctx: TenantContext,
  lines: readonly IssueInvoiceLine[],
  currency: string,
  baseCurrency: string,
): Promise<SettledLine[]> {
  const settled: SettledLine[] = [];

  for (const [index, line] of lines.entries()) {
    const where = `line ${index + 1}`;

    if (line.itemId === undefined) {
      // No item: every field the document needs must be present. Checked here
      // rather than by the type system because the fields became optional to
      // support the item path, and a missing one would otherwise reach
      // `Money.fromDecimal(undefined)`.
      const missing = (['description', 'unitPrice', 'accountId', 'taxCodeId'] as const).filter(
        (field) => line[field] === undefined,
      );

      if (missing.length > 0) {
        throw new InvoiceError(
          'LINE_INCOMPLETE',
          `${where} has no itemId, so it must supply ${missing.join(', ')}`,
        );
      }

      settled.push({
        description: line.description!,
        quantity: line.quantity,
        unitPrice: line.unitPrice!,
        accountId: line.accountId!,
        taxCodeId: line.taxCodeId!,
        ...(line.discountBasisPoints !== undefined
          ? { discountBasisPoints: line.discountBasisPoints }
          : {}),
        ...(line.classificationCode !== undefined
          ? { classificationCode: line.classificationCode }
          : {}),
        ...(line.unitOfMeasure !== undefined ? { unitOfMeasure: line.unitOfMeasure } : {}),
      });
      continue;
    }

    if (currency !== baseCurrency && line.unitPrice === undefined) {
      throw new InvoiceError(
        'LINE_INCOMPLETE',
        `${where} uses an item on a ${currency} invoice. Item prices are held in ` +
          `${baseCurrency} and are not converted, so this line must supply its own unit price.`,
      );
    }

    const resolved = await resolveLineFromItem(tx, ctx, line.itemId, 'SALE', {
      quantity: line.quantity,
      ...(line.description !== undefined ? { description: line.description } : {}),
      ...(line.unitPrice !== undefined
        ? { unitPrice: Money.fromDecimal(line.unitPrice, baseCurrency) }
        : {}),
      ...(line.accountId !== undefined ? { accountId: line.accountId } : {}),
      ...(line.taxCodeId !== undefined ? { taxCodeId: line.taxCodeId } : {}),
      ...(line.classificationCode !== undefined
        ? { classificationCode: line.classificationCode }
        : {}),
      ...(line.unitOfMeasure !== undefined ? { unitOfMeasure: line.unitOfMeasure } : {}),
    });

    settled.push({
      description: resolved.description,
      quantity: resolved.quantity,
      unitPrice: resolved.unitPrice.toDecimalString(),
      accountId: resolved.accountId,
      taxCodeId: resolved.taxCodeId,
      itemId: line.itemId,
      ...(line.discountBasisPoints !== undefined
        ? { discountBasisPoints: line.discountBasisPoints }
        : {}),
      ...(resolved.classificationCode !== undefined
        ? { classificationCode: resolved.classificationCode }
        : {}),
      ...(resolved.unitOfMeasure !== undefined
        ? { unitOfMeasure: resolved.unitOfMeasure }
        : {}),
      ...(resolved.uomCode !== undefined ? { uomCode: resolved.uomCode } : {}),
    });
  }

  return settled;
}
