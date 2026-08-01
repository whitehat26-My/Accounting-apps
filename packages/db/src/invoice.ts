import {
  buildSalesJournal,
  computeDocument,
  isErr,
  Money,
  validateJournalEntry,
  type DocumentLine,
  type DocumentViolation,
  type TaxCode,
  type TaxExemption,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';

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
  readonly amountsAreTaxInclusive?: boolean;
  readonly reference?: string;
  readonly lines: readonly IssueInvoiceLine[];
  readonly idempotencyKey: string;
}

export interface IssueInvoiceLine {
  readonly description: string;
  /** Decimal string, e.g. "2.5". Never a float. */
  readonly quantity: string;
  /** Decimal string, e.g. "1000.00". */
  readonly unitPrice: string;
  readonly accountId: string;
  readonly taxCodeId: string;
  readonly itemId?: string;
  readonly discountBasisPoints?: number;
  readonly classificationCode?: string;
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
      | 'JOURNAL_INVALID',
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

  for (const [index, line] of input.lines.entries()) {
    const computedLine = doc.lines[index]!;
    await tx`
        INSERT INTO invoice_line (
            tenant_id, invoice_id, line_no, item_id, description, quantity,
            unit_price, discount_basis_points, account_id, tax_code_id,
            taxable_amount, tax_amount, line_total, classification_code
        ) VALUES (
            ${ctx.tenantId}, ${invoiceId}, ${index + 1}, ${line.itemId ?? null},
            ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.discountBasisPoints ?? 0}, ${line.accountId}, ${line.taxCodeId},
            ${computedLine.netAmount.toDecimalString()},
            ${computedLine.taxAmount.toDecimalString()},
            ${computedLine.lineTotal.toDecimalString()},
            ${line.classificationCode ?? null}
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
  const journalDraft = buildSalesJournal(
    doc,
    { accountsReceivableId: accounts.AR, taxPayableId: accounts.SST_PAYABLE },
    {
      entryDate: input.issueDate,
      description: `Invoice ${invoiceNo}`,
      contactId: input.contactId,
      documentType: 'INVOICE',
      documentId: invoiceId,
    },
  );

  // A zero-total invoice (free sample, warranty replacement, fully discounted
  // line) is a legitimate document with no debits and no credits. It is issued
  // and sent, but nothing is posted — there is nothing to post.
  let journalEntryId: string | null = null;

  if (journalDraft !== null) {
    const validated = validateJournalEntry(journalDraft, currency);
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
 * Aged receivables straight from the subledger.
 *
 * Ledger invariant #6 says this must always agree with the AR control account
 * in the general ledger. `packages/db/test/invoice.test.ts` asserts it.
 */
export async function outstandingReceivables(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ total: string; count: number }> {
  const [row] = await tx<{ total: string; count: string }[]>`
      SELECT COALESCE(SUM(amount_due), 0)::text AS total, COUNT(*)::text AS count
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('ISSUED','PART_PAID')
  `;
  return { total: row!.total, count: Number(row!.count) };
}

// ------------------------------------------------------------------ internals

/** "2.5" -> 25000n at scale 4. Rejects excess precision rather than rounding. */
function decimalToScaled(value: string, scale: bigint): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`Not a valid decimal string: "${value}"`);
  }
  const negative = trimmed.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  if (BigInt(fraction.length) > scale) {
    throw new RangeError(`"${value}" exceeds ${scale} decimal places`);
  }
  const padded = fraction.padEnd(Number(scale), '0');
  const units = BigInt(whole) * 10n ** scale + BigInt(padded || '0');
  return negative ? -units : units;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toIsoDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
