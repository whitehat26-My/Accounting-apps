import { Money } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';

/**
 * Everything a printed document needs, in one read per document.
 *
 * Presentation stays in the API layer (a PDF is a rendering concern); this
 * module owns fetching, because the alternative is a controller assembling
 * six queries and the next printed document copying all six.
 */

export class DocumentDataError extends Error {
  constructor(
    readonly code: 'INVOICE_NOT_FOUND' | 'RECEIPT_NOT_FOUND' | 'CREDIT_NOTE_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'DocumentDataError';
  }
}

export interface SellerBlock {
  readonly name: string;
  readonly ssmRegistrationNo: string | null;
  readonly tin: string | null;
  readonly sstNo: string | null;
  readonly sstRegistered: boolean;
  /**
   * This tenant's own letterhead — see migration 0050.
   *
   * Null is the ordinary case, not an error: an organisation prints its name
   * alone until somebody uploads a mark, and that is a perfectly good
   * letterhead. Every printed document in this system passes through
   * `sellerBlock`, so carrying the brand here is what makes all eleven
   * renderers per-tenant at once.
   */
  readonly logo: Buffer | null;
  readonly logoContentType: string | null;
  readonly brandColour: string | null;
}

export interface InvoiceDocument {
  readonly seller: SellerBlock;
  readonly invoiceNo: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly status: string;
  readonly reference: string | null;
  readonly currency: string;
  readonly customer: { name: string; tin: string | null };
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly taxAmount: string;
    readonly lineTotal: string;
  }[];
  readonly subtotal: string;
  readonly taxTotal: string;
  readonly total: string;
  readonly amountDue: string;
}

export async function invoiceDocumentData(
  tx: Tx,
  ctx: TenantContext,
  invoiceId: string,
): Promise<InvoiceDocument> {
  const [invoice] = await tx<
    {
      invoice_no: string; issue_date: Date; due_date: Date; status: string;
      reference: string | null; currency: string; subtotal: string; tax_total: string;
      total: string; amount_due: string;
      customer_name: string; customer_tin: string | null;
    }[]
  >`
      SELECT i.invoice_no, i.issue_date, i.due_date, i.status, i.reference,
             i.currency, i.subtotal, i.tax_total, i.total, i.amount_due,
             c.name AS customer_name, c.tin AS customer_tin
        FROM invoice i
        JOIN contact c ON c.tenant_id = i.tenant_id AND c.id = i.contact_id
       WHERE i.tenant_id = ${ctx.tenantId} AND i.id = ${invoiceId}
  `;
  if (!invoice) {
    // Another tenant's invoice is indistinguishable from none — rule 9.
    throw new DocumentDataError('INVOICE_NOT_FOUND', `Invoice ${invoiceId} not found`);
  }

  const lines = await tx<
    { description: string; quantity: string; unit_price: string; tax_amount: string; line_total: string }[]
  >`
      SELECT description, quantity, unit_price, tax_amount, line_total
        FROM invoice_line
       WHERE tenant_id = ${ctx.tenantId} AND invoice_id = ${invoiceId}
       ORDER BY line_no
  `;

  return {
    seller: await sellerBlock(tx, ctx),
    invoiceNo: invoice.invoice_no,
    issueDate: toIsoDate(invoice.issue_date),
    dueDate: toIsoDate(invoice.due_date),
    status: invoice.status,
    reference: invoice.reference,
    currency: invoice.currency,
    customer: { name: invoice.customer_name, tin: invoice.customer_tin },
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      taxAmount: l.tax_amount,
      lineTotal: l.line_total,
    })),
    subtotal: invoice.subtotal,
    taxTotal: invoice.tax_total,
    total: invoice.total,
    amountDue: invoice.amount_due,
  };
}

export interface ReceiptDocument {
  readonly seller: SellerBlock;
  readonly paymentNo: string;
  readonly paymentDate: string;
  readonly method: string;
  readonly reference: string | null;
  readonly currency: string;
  readonly amount: string;
  readonly customer: { name: string };
  readonly allocations: readonly {
    readonly invoiceNo: string;
    readonly amount: string;
  }[];
  /**
   * What was bought, when this receipt settles exactly ONE invoice — the till
   * case. A thermal receipt without its lines is a card slip, not a receipt.
   * Absent when a payment settles several invoices at once: those lines would
   * be three documents' worth, and the A4 layout lists the invoices instead.
   */
  readonly lines?: readonly {
    readonly description: string;
    readonly quantity: string;
    readonly lineTotal: string;
  }[];
  readonly subtotal?: string;
  readonly taxTotal?: string;
}

export async function receiptDocumentData(
  tx: Tx,
  ctx: TenantContext,
  paymentId: string,
): Promise<ReceiptDocument> {
  const [payment] = await tx<
    {
      payment_no: string; payment_date: Date; method: string; reference: string | null;
      currency: string; amount: string; customer_name: string;
    }[]
  >`
      SELECT p.payment_no, p.payment_date, p.method, p.reference, p.currency,
             p.amount, c.name AS customer_name
        FROM payment p
        JOIN contact c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
       WHERE p.tenant_id = ${ctx.tenantId} AND p.id = ${paymentId}
         AND p.direction = 'INBOUND'
  `;
  if (!payment) {
    throw new DocumentDataError('RECEIPT_NOT_FOUND', `Receipt ${paymentId} not found`);
  }

  const allocations = await tx<{ invoice_no: string; amount: string }[]>`
      SELECT i.invoice_no, a.amount
        FROM payment_allocation a
        JOIN invoice i ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id
       WHERE a.tenant_id = ${ctx.tenantId} AND a.payment_id = ${paymentId}
       ORDER BY i.invoice_no
  `;

  // The till case: one payment, one invoice — carry its lines so the printed
  // receipt can say what was bought.
  let saleDetail: Pick<ReceiptDocument, 'lines' | 'subtotal' | 'taxTotal'> = {};
  if (allocations.length === 1) {
    const [invoice] = await tx<{ id: string; subtotal: string; tax_total: string }[]>`
        SELECT i.id, i.subtotal, i.tax_total
          FROM payment_allocation a
          JOIN invoice i ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id
         WHERE a.tenant_id = ${ctx.tenantId} AND a.payment_id = ${paymentId}
    `;
    if (invoice) {
      const lines = await tx<{ description: string; quantity: string; line_total: string }[]>`
          SELECT description, quantity, line_total FROM invoice_line
           WHERE tenant_id = ${ctx.tenantId} AND invoice_id = ${invoice.id}
           ORDER BY line_no
      `;
      saleDetail = {
        lines: lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          lineTotal: l.line_total,
        })),
        subtotal: invoice.subtotal,
        taxTotal: invoice.tax_total,
      };
    }
  }

  return {
    seller: await sellerBlock(tx, ctx),
    paymentNo: payment.payment_no,
    paymentDate: toIsoDate(payment.payment_date),
    method: payment.method,
    reference: payment.reference,
    currency: payment.currency,
    amount: payment.amount,
    customer: { name: payment.customer_name },
    allocations: allocations.map((a) => ({ invoiceNo: a.invoice_no, amount: a.amount })),
    ...saleDetail,
  };
}

/**
 * The organisation as it appears at the top of a printed document.
 *
 * Exported because a payslip needs the same block: it is the same legal entity
 * making the statement, and a second query that read the same columns into a
 * differently-shaped object would be a second place for the registration
 * numbers to go stale.
 */
export async function sellerBlock(tx: Tx, ctx: TenantContext): Promise<SellerBlock> {
  const [org] = await tx<
    {
      name: string; ssm_registration_no: string | null; tin: string | null;
      sst_no: string | null; sst_registered: boolean;
      logo: Buffer | null; logo_content_type: string | null; brand_colour: string | null;
    }[]
  >`
      SELECT name, ssm_registration_no, tin, sst_no, sst_registered,
             logo, logo_content_type, brand_colour
        FROM organisation WHERE id = ${ctx.tenantId}
  `;
  return {
    name: org!.name,
    ssmRegistrationNo: org!.ssm_registration_no,
    tin: org!.tin,
    sstNo: org!.sst_no,
    sstRegistered: org!.sst_registered,
    logo: org!.logo,
    logoContentType: org!.logo_content_type,
    brandColour: org!.brand_colour,
  };
}

/**
 * Set or clear this tenant's letterhead.
 *
 * Clearing is passing `logo: null` — a tenant that decides its mark prints
 * badly needs a way back to the name-only letterhead, and "upload a white
 * square" is not that way.
 */
export async function setOrganisationBrand(
  tx: Tx,
  ctx: TenantContext,
  input: {
    readonly logo: Buffer | null;
    readonly logoContentType: 'image/png' | 'image/jpeg' | null;
    readonly brandColour: string | null;
  },
): Promise<void> {
  await tx`
      UPDATE organisation
         SET logo              = ${input.logo},
             logo_content_type = ${input.logo === null ? null : input.logoContentType},
             brand_colour      = ${input.brandColour}
       WHERE id = ${ctx.tenantId}
  `;
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

export interface CreditNoteDocument {
  readonly seller: SellerBlock;
  readonly creditNoteNo: string;
  readonly creditDate: string;
  readonly taxPointDate: string;
  readonly status: string;
  readonly reason: string;
  readonly reasonDetail: string | null;
  readonly currency: string;
  /** The invoice being corrected, when there is one. */
  readonly againstInvoiceNo: string | null;
  readonly customer: { readonly name: string; readonly tin: string | null };
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly taxAmount: string;
    readonly lineTotal: string;
  }[];
  readonly subtotal: string;
  readonly taxTotal: string;
  readonly total: string;
  /** Credit already applied to invoices; the rest is the customer's to use. */
  readonly allocated: string;
  readonly unallocated: string;
}

/**
 * A credit note, for printing.
 *
 * ---------------------------------------------------------------------------
 * THE FIRST READ PATH THIS DOCUMENT HAS EVER HAD.
 *
 * `issueCreditNote` could write one and nothing could read it back — the note
 * existed in the ledger and on the customer's balance, and the customer could
 * not be shown the piece of paper that explains why they were credited. A
 * credit note is the document a customer files against the invoice it
 * corrects, and under SST it is what supports the reduction in output tax.
 *
 * Amounts are POSITIVE here, as they are stored. The direction of a credit
 * lives in the journal, not in the sign of a printed figure — a negative
 * number on a page that already says CREDIT NOTE reads as a double negative
 * to the person holding it, and to the accountant keying it.
 * ---------------------------------------------------------------------------
 */
export async function creditNoteDocumentData(
  tx: Tx,
  ctx: TenantContext,
  creditNoteId: string,
): Promise<CreditNoteDocument> {
  const [note] = await tx<
    {
      credit_note_no: string; credit_date: Date; tax_point_date: Date; status: string;
      reason: string; reason_detail: string | null; currency: string;
      subtotal: string; tax_total: string; total: string; allocated_amount: string;
      invoice_no: string | null;
      customer_name: string; customer_tin: string | null;
    }[]
  >`
      SELECT n.credit_note_no, n.credit_date, n.tax_point_date, n.status,
             n.reason, n.reason_detail, n.currency,
             n.subtotal, n.tax_total, n.total, n.allocated_amount,
             i.invoice_no,
             c.name AS customer_name, c.tin AS customer_tin
        FROM credit_note n
        JOIN contact c      ON c.tenant_id = n.tenant_id AND c.id = n.contact_id
        LEFT JOIN invoice i ON i.tenant_id = n.tenant_id AND i.id = n.invoice_id
       WHERE n.tenant_id = ${ctx.tenantId} AND n.id = ${creditNoteId}
  `;
  if (!note) {
    // Another tenant's credit note is indistinguishable from none — rule 9.
    throw new DocumentDataError('CREDIT_NOTE_NOT_FOUND', `Credit note ${creditNoteId} not found`);
  }

  const lines = await tx<
    { description: string; quantity: string; unit_price: string; tax_amount: string; line_total: string }[]
  >`
      SELECT description, quantity, unit_price, tax_amount, line_total
        FROM credit_note_line
       WHERE tenant_id = ${ctx.tenantId} AND credit_note_id = ${creditNoteId}
       ORDER BY line_no
  `;

  const total = Money.fromDecimal(note.total, note.currency as Parameters<typeof Money.zero>[0]);
  const allocated = Money.fromDecimal(note.allocated_amount, total.currency);

  return {
    seller: await sellerBlock(tx, ctx),
    creditNoteNo: note.credit_note_no,
    creditDate: toIsoDate(note.credit_date),
    taxPointDate: toIsoDate(note.tax_point_date),
    status: note.status,
    reason: note.reason,
    reasonDetail: note.reason_detail,
    currency: note.currency,
    againstInvoiceNo: note.invoice_no,
    customer: { name: note.customer_name, tin: note.customer_tin },
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      taxAmount: l.tax_amount,
      lineTotal: l.line_total,
    })),
    subtotal: note.subtotal,
    taxTotal: note.tax_total,
    total: note.total,
    allocated: note.allocated_amount,
    unallocated: total.subtract(allocated).toDecimalString(),
  };
}

export interface CreditNoteSummary {
  readonly id: string;
  readonly creditNoteNo: string;
  readonly creditDate: string;
  readonly customer: string;
  readonly againstInvoiceNo: string | null;
  readonly reason: string;
  readonly status: string;
  readonly total: string;
  readonly unallocated: string;
}

/** The list a screen needs before anybody can reach one to print it. */
export async function listCreditNotes(
  tx: Tx,
  ctx: TenantContext,
  options: { readonly limit?: number } = {},
): Promise<CreditNoteSummary[]> {
  const limit = Math.min(options.limit ?? 100, 500);
  const rows = await tx<
    {
      id: string; credit_note_no: string; credit_date: Date; customer: string;
      invoice_no: string | null; reason: string; status: string;
      total: string; allocated_amount: string; currency: string;
    }[]
  >`
      SELECT n.id, n.credit_note_no, n.credit_date, c.name AS customer,
             i.invoice_no, n.reason, n.status, n.total, n.allocated_amount, n.currency
        FROM credit_note n
        JOIN contact c      ON c.tenant_id = n.tenant_id AND c.id = n.contact_id
        LEFT JOIN invoice i ON i.tenant_id = n.tenant_id AND i.id = n.invoice_id
       WHERE n.tenant_id = ${ctx.tenantId}
       ORDER BY n.credit_date DESC, n.credit_note_no DESC
       LIMIT ${limit}
  `;

  return rows.map((r) => {
    const total = Money.fromDecimal(r.total, r.currency as Parameters<typeof Money.zero>[0]);
    return {
      id: r.id,
      creditNoteNo: r.credit_note_no,
      creditDate: toIsoDate(r.credit_date),
      customer: r.customer,
      againstInvoiceNo: r.invoice_no,
      reason: r.reason,
      status: r.status,
      total: r.total,
      unallocated: total.subtract(Money.fromDecimal(r.allocated_amount, total.currency))
        .toDecimalString(),
    };
  });
}
