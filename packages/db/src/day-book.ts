import { Money } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { loadBaseCurrency } from './invoice.js';

/**
 * The sales day book: every invoice issued in a period, at the figures frozen
 * when it was issued.
 *
 * ---------------------------------------------------------------------------
 * READ FROM `invoice`, NOT REBUILT FROM ITS LINES.
 *
 * The stored `subtotal`, `tax_total` and `total` are what the customer was
 * given. Re-summing the lines here would recompute them under today's rounding
 * and today's tax-code versions, and any drift would show up as a day book
 * that disagrees with the invoices it lists — with the day book, being newer,
 * looking like the correct one. The frozen figures are the record.
 *
 * DRAFT invoices are excluded: a draft is not a sale, and a day book that
 * counted them would overstate revenue for anyone reading it as one.
 * ---------------------------------------------------------------------------
 */

export interface DayBookRow {
  readonly issueDate: string;
  readonly invoiceNo: string;
  readonly customer: string;
  readonly status: string;
  readonly subtotal: string;
  readonly taxTotal: string;
  readonly total: string;
  readonly amountDue: string;
}

export interface SalesDayBook {
  readonly from: string;
  readonly to: string;
  readonly currency: string;
  readonly rows: readonly DayBookRow[];
  readonly totals: {
    readonly subtotal: string;
    readonly taxTotal: string;
    readonly total: string;
    readonly amountDue: string;
  };
}

export async function salesDayBook(
  tx: Tx,
  ctx: TenantContext,
  window: { readonly from: string; readonly to: string },
): Promise<SalesDayBook> {
  const currency = await loadBaseCurrency(tx, ctx);

  const rows = await tx<
    {
      issue_date: Date;
      invoice_no: string;
      customer: string;
      status: string;
      subtotal: string;
      tax_total: string;
      total: string;
      amount_due: string;
    }[]
  >`
      SELECT i.issue_date, i.invoice_no, c.name AS customer, i.status,
             i.subtotal::text, i.tax_total::text, i.total::text, i.amount_due::text
        FROM invoice i
        JOIN contact c ON c.tenant_id = i.tenant_id AND c.id = i.contact_id
       WHERE i.tenant_id = ${ctx.tenantId}
         AND i.issue_date >= ${window.from}
         AND i.issue_date <= ${window.to}
         AND i.status <> 'DRAFT'
       ORDER BY i.issue_date, i.invoice_no
  `;

  const zero = Money.zero(currency as Parameters<typeof Money.zero>[0]);
  let subtotal = zero;
  let taxTotal = zero;
  let total = zero;
  let amountDue = zero;

  const mapped = rows.map((r) => {
    subtotal = subtotal.add(Money.fromDecimal(r.subtotal, zero.currency));
    taxTotal = taxTotal.add(Money.fromDecimal(r.tax_total, zero.currency));
    total = total.add(Money.fromDecimal(r.total, zero.currency));
    amountDue = amountDue.add(Money.fromDecimal(r.amount_due, zero.currency));

    return {
      issueDate: r.issue_date.toISOString().slice(0, 10),
      invoiceNo: r.invoice_no,
      customer: r.customer,
      status: r.status,
      subtotal: r.subtotal,
      taxTotal: r.tax_total,
      total: r.total,
      amountDue: r.amount_due,
    };
  });

  return {
    from: window.from,
    to: window.to,
    currency,
    rows: mapped,
    totals: {
      subtotal: subtotal.toDecimalString(),
      taxTotal: taxTotal.toDecimalString(),
      total: total.toDecimalString(),
      amountDue: amountDue.toDecimalString(),
    },
  };
}
