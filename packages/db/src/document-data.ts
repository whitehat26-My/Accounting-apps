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
    readonly code: 'INVOICE_NOT_FOUND' | 'RECEIPT_NOT_FOUND',
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
    }[]
  >`
      SELECT name, ssm_registration_no, tin, sst_no, sst_registered
        FROM organisation WHERE id = ${ctx.tenantId}
  `;
  return {
    name: org!.name,
    ssmRegistrationNo: org!.ssm_registration_no,
    tin: org!.tin,
    sstNo: org!.sst_no,
    sstRegistered: org!.sst_registered,
  };
}
