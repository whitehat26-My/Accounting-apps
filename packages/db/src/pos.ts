import { Money, type PaymentMethod } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { issueInvoice, type IssueInvoiceLine } from './invoice.js';
import { recordReceipt } from './payment.js';
import { toIsoDate } from './internal.js';

/**
 * Point of sale: the counter operation.
 *
 * ---------------------------------------------------------------------------
 * ONE OPERATION, ZERO NEW WRITE PATHS.
 *
 * A cash sale is an invoice and its receipt in the same breath, so this module
 * COMPOSES `issueInvoice` and `recordReceipt` in one transaction and adds no
 * document type of its own. Everything those two enforce — SST at the rate
 * version the tax point selects, gapless numbering, stock relief and COGS at
 * weighted average, the AR-subledger invariant — applies at the till exactly
 * as it applies to a 30-day trade invoice. A parallel "POS receipt" path would
 * be the version of this that drifts.
 *
 * The composition is also why overselling protection works at the counter: if
 * the shelf cannot cover the sale, `issueInvoice` refuses and the WHOLE sale
 * rolls back — no invoice, no receipt, no money taken for goods that are not
 * there.
 * ---------------------------------------------------------------------------
 */

export class PosError extends Error {
  constructor(
    readonly code: 'TENDER_TOO_SMALL' | 'FOREIGN_CURRENCY' | 'ACCOUNT_NOT_FOUND',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'PosError';
  }
}

/**
 * The tenant's designated anonymous customer, created on first use.
 *
 * One per tenant, remembered on `organisation.walk_in_contact_id`, so
 * nameless counter sales aggregate under a single AR contact instead of
 * scattering "Cash customer 1/2/3" through the contact list.
 */
export async function walkInContact(tx: Tx, ctx: TenantContext): Promise<string> {
  const [org] = await tx<{ walk_in_contact_id: string | null }[]>`
      SELECT walk_in_contact_id FROM organisation WHERE id = ${ctx.tenantId}
  `;
  if (org?.walk_in_contact_id) return org.walk_in_contact_id;

  /*
   * No TIN, deliberately. Consolidating counter sales into a periodic
   * e-Invoice uses LHDN's general-public arrangement, and which TIN that
   * carries is a MyInvois-adapter question (register §3.2) — recorded as a
   * gap by the contact's own e-invoice check, not guessed here.
   *
   * Payment terms zero: a walk-in owes nothing after walking out.
   */
  const [contact] = await tx<{ id: string }[]>`
      INSERT INTO contact (tenant_id, name, is_customer, payment_terms_days, default_currency)
      VALUES (${ctx.tenantId}, 'Walk-in customer', TRUE, 0, 'MYR')
      RETURNING id
  `;

  await tx`
      UPDATE organisation SET walk_in_contact_id = ${contact!.id}
       WHERE id = ${ctx.tenantId}
  `;

  return contact!.id;
}

export interface CashSaleInput {
  readonly saleDate: string;
  readonly lines: readonly IssueInvoiceLine[];
  readonly method: PaymentMethod;
  /** The GL account the money lands in: the cash drawer, or the card/QR clearing account. */
  readonly depositAccountId: string;
  /** Omit for an anonymous walk-in; supply to put the sale on a named customer. */
  readonly contactId?: string;
  /**
   * Cash handed over, for the change calculation. Display mechanics only —
   * the RECEIPT is for the invoice total regardless, because the drawer gives
   * the change back and the books never saw it.
   */
  readonly tenderedAmount?: string;
  readonly reference?: string;
  readonly amountsAreTaxInclusive?: boolean;
  readonly idempotencyKey: string;
}

export interface CashSaleResult {
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly receiptId: string;
  readonly receiptNo: string;
  readonly subtotal: string;
  readonly taxTotal: string;
  readonly total: string;
  /** Null unless cash was tendered above the total. */
  readonly changeDue: string | null;
  readonly replayed: boolean;
}

export async function recordCashSale(
  tx: Tx,
  ctx: TenantContext,
  input: CashSaleInput,
): Promise<CashSaleResult> {
  /*
   * Base currency only. A till takes ringgit; a foreign-currency counter sale
   * is not a thing a Malaysian shop rings, and allowing the field would let a
   * typo price a sale in a currency the drawer does not hold.
   */
  const contactId = input.contactId ?? (await walkInContact(tx, ctx));

  const invoice = await issueInvoice(tx, ctx, {
    contactId,
    issueDate: input.saleDate,
    // Due the day it is issued: a counter sale is settled before the customer
    // leaves, and an unpaid one should look overdue IMMEDIATELY, not in 30 days.
    dueDate: input.saleDate,
    lines: input.lines,
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
    ...(input.amountsAreTaxInclusive !== undefined
      ? { amountsAreTaxInclusive: input.amountsAreTaxInclusive }
      : {}),
    idempotencyKey: input.idempotencyKey,
  });

  const total = Money.fromDecimal(invoice.total, 'MYR');

  let changeDue: string | null = null;
  if (input.tenderedAmount !== undefined) {
    const tendered = Money.fromDecimal(input.tenderedAmount, 'MYR');
    if (tendered.compare(total) < 0) {
      // Refused BEFORE the receipt exists. The invoice insert rolls back with
      // the transaction, so an underpaid tender leaves nothing behind.
      throw new PosError(
        'TENDER_TOO_SMALL',
        `Tendered ${tendered.toDecimalString()} against a total of ${total.toDecimalString()}.`,
      );
    }
    const change = tendered.subtract(total);
    changeDue = change.isZero() ? null : change.toDecimalString();
  }

  /*
   * The receipt: the full total, allocated to this invoice explicitly. The
   * allocation being explicit matters — auto-allocation is oldest-first, and
   * a walk-in contact ACCUMULATES invoices, so "oldest first" would pay off
   * some earlier counter sale and leave today's open.
   */
  const receipt = await recordReceipt(tx, ctx, {
    contactId,
    paymentDate: input.saleDate,
    amount: invoice.total,
    method: input.method,
    depositAccountId: input.depositAccountId,
    allocations: [{ invoiceId: invoice.id, amount: invoice.total }],
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
    idempotencyKey: `pos-receipt:${input.idempotencyKey}`,
  });

  return {
    invoiceId: invoice.id,
    invoiceNo: invoice.invoiceNo,
    receiptId: receipt.id,
    receiptNo: receipt.paymentNo,
    subtotal: invoice.subtotal,
    taxTotal: invoice.taxTotal,
    total: invoice.total,
    changeDue,
    replayed: invoice.replayed && receipt.replayed,
  };
}

// ---------------------------------------------------------------------------
// The Z-report: what the day took, and what the drawer should hold
// ---------------------------------------------------------------------------

export interface DailyTakings {
  readonly date: string;
  /** Money in, by method and landing account — the drawer reconciliation. */
  readonly byMethod: readonly {
    readonly method: string;
    readonly depositAccount: string;
    readonly total: string;
    readonly count: number;
  }[];
  readonly receiptsTotal: string;
  /** Invoices issued this day, whether or not paid at the counter. */
  readonly invoicedTotal: string;
  readonly invoiceCount: number;
  /** Weighted-average cost relieved by this day's sales. */
  readonly costOfGoodsSold: string;
  /**
   * Invoiced net of tax, minus COGS. The number the owner actually runs the
   * shop on — takings say what the drawer holds, THIS says what the day made.
   */
  readonly grossProfit: string;
}

export async function dailyTakings(
  tx: Tx,
  ctx: TenantContext,
  date: string,
): Promise<DailyTakings> {
  const byMethod = await tx<
    { method: string; deposit_account: string; total: string; count: number }[]
  >`
      SELECT p.method,
             a.name                 AS deposit_account,
             SUM(p.amount)::text    AS total,
             COUNT(*)::int          AS count
        FROM payment p
        JOIN account a ON a.tenant_id = p.tenant_id AND a.id = p.deposit_account_id
       WHERE p.tenant_id = ${ctx.tenantId}
         AND p.direction = 'INBOUND'
         AND p.payment_date = ${date}::date
       GROUP BY p.method, a.name
       ORDER BY p.method, a.name
  `;

  const [receipts] = await tx<{ total: string }[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total FROM payment
       WHERE tenant_id = ${ctx.tenantId}
         AND direction = 'INBOUND'
         AND payment_date = ${date}::date
  `;

  const [invoiced] = await tx<{ subtotal: string; count: number }[]>`
      SELECT COALESCE(SUM(subtotal), 0)::text AS subtotal, COUNT(*)::int AS count
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND issue_date = ${date}::date
         AND status <> 'VOIDED'
  `;

  // COGS from the entries the inventory slice posts alongside each sale —
  // filtered by SOURCE, not by account, so a manual journal touching the COGS
  // account does not masquerade as a day's trading cost.
  const [cogs] = await tx<{ total: string }[]>`
      SELECT COALESCE(SUM(l.base_debit - l.base_credit), 0)::text AS total
        FROM journal_line l
        JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
        JOIN posting_account_map m
          ON m.tenant_id = l.tenant_id AND m.account_id = l.account_id AND m.role = 'COGS'
       WHERE l.tenant_id = ${ctx.tenantId}
         AND e.source_document_type = 'INVOICE_COGS'
         AND e.entry_date = ${date}::date
         AND e.status IN ('POSTED', 'REVERSED')
  `;

  const revenue = Money.fromDecimal(invoiced!.subtotal, 'MYR');
  const cost = Money.fromDecimal(cogs!.total, 'MYR');

  return {
    date: toIsoDate(new Date(`${date}T00:00:00Z`)),
    byMethod: byMethod.map((r) => ({
      method: r.method,
      depositAccount: r.deposit_account,
      total: r.total,
      count: r.count,
    })),
    receiptsTotal: receipts!.total,
    invoicedTotal: invoiced!.subtotal,
    invoiceCount: invoiced!.count,
    costOfGoodsSold: cogs!.total,
    grossProfit: revenue.subtract(cost).toDecimalString(),
  };
}
