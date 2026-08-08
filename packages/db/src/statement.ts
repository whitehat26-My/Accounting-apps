import { Money, type Currency } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';
import { loadBaseCurrency } from './invoice.js';

/**
 * Customer statements — everything one customer did, and what they owe now.
 *
 * ---------------------------------------------------------------------------
 * NO NEW TABLES. THE STATEMENT IS A QUESTION, NOT A RECORD.
 *
 * Every figure here already exists: invoices as issued, payments as received,
 * credit notes as raised. A statement is a way of ASKING about them, so
 * storing one would create a second copy of the truth that could disagree with
 * the first — and the copy is the one people would print.
 *
 * The consequence worth stating: re-running a statement for last March next
 * year gives last March's figures, because it is reconstructed from an
 * append-only history rather than read from a snapshot taken at the time.
 *
 * ---------------------------------------------------------------------------
 * WHAT "BALANCE" MEANS HERE, AND WHAT IT DOES NOT.
 *
 * The running balance is what the customer OWES: an invoice increases it, a
 * payment or credit note reduces it. It is not a ledger balance and it is not
 * signed the way a ledger account is — a customer statement is a business
 * document, not an extract of the accounts receivable control account, and the
 * two disagree by design whenever a payment is unallocated.
 * ---------------------------------------------------------------------------
 */

export class StatementError extends Error {
  constructor(
    readonly code: 'CONTACT_NOT_FOUND' | 'INVALID_PERIOD',
    message: string,
  ) {
    super(message);
    this.name = 'StatementError';
  }
}

export type StatementEntryType = 'INVOICE' | 'PAYMENT' | 'CREDIT_NOTE';

export interface StatementEntry {
  readonly date: string;
  readonly type: StatementEntryType;
  /** The document number a customer can quote back at you. */
  readonly reference: string;
  readonly detail: string | null;
  /** Increases what they owe. Null on a line that does not. */
  readonly charge: string | null;
  /** Reduces it. */
  readonly credit: string | null;
  /** What they owed after this line. */
  readonly balance: string;
  /** Present on invoices, so the reader can see what is overdue. */
  readonly dueDate: string | null;
}

export interface CustomerStatement {
  readonly contact: { readonly id: string; readonly name: string; readonly email: string | null };
  readonly from: string;
  readonly to: string;
  /**
   * Base currency, and stated rather than assumed.
   *
   * Amounts are converted at each document's own booked rate, the same as the
   * ageing report, so the closing balance is comparable to the receivables
   * control account. A customer invoiced in a foreign currency would want their
   * own — that is a real limitation and it is recorded in the settlement
   * register rather than hidden behind a currency symbol.
   */
  readonly currency: Currency;
  readonly openingBalance: string;
  readonly entries: readonly StatementEntry[];
  readonly closingBalance: string;
  /** Of the closing balance, how much is already past its due date. */
  readonly overdue: string;
}

/**
 * One customer's account over a period.
 *
 * `from` is inclusive and `to` is inclusive. The opening balance is what was
 * outstanding at the START of `from` — that is, everything dated strictly
 * before it — so a statement run for consecutive months joins up: March's
 * closing balance is April's opening balance, with nothing lost between them.
 */
export async function customerStatement(
  tx: Tx,
  ctx: TenantContext,
  contactId: string,
  from: string,
  to: string,
): Promise<CustomerStatement> {
  if (from > to) {
    throw new StatementError(
      'INVALID_PERIOD',
      `A statement cannot start (${from}) after it ends (${to}).`,
    );
  }

  const [contact] = await tx<{ id: string; name: string; email: string | null }[]>`
      SELECT id, name, email
        FROM contact
       WHERE tenant_id = ${ctx.tenantId} AND id = ${contactId}
  `;
  if (contact === undefined) {
    // Rule 9: a contact in another tenant is invisible, so this is the same
    // answer for "does not exist" and "is not yours".
    throw new StatementError('CONTACT_NOT_FOUND', `No contact ${contactId}.`);
  }

  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const zero = Money.zero(baseCurrency);

  const openingBalance = await balanceAsAt(tx, ctx, contactId, from, baseCurrency);

  /*
   * Three queries rather than one UNION, and then sorted in memory.
   *
   * A UNION across invoices, payments and credit notes would need every branch
   * to project the same columns, which means casting a payment's fields into an
   * invoice's shape and back out again. Three plainly-readable queries over a
   * customer's own documents is a handful of rows, and a statement is not a hot
   * path.
   */
  const invoices = await tx<
    { invoice_no: string; issue_date: Date; due_date: Date; reference: string | null; amount: string }[]
  >`
      SELECT invoice_no, issue_date, due_date, reference,
             ROUND(total * fx_rate, 4)::text AS amount
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND contact_id = ${contactId}
         AND issue_date BETWEEN ${from}::date AND ${to}::date
  `;

  /*
   * Payments are listed by what they SETTLED against this customer's invoices,
   * not by their face value.
   *
   * A payment can arrive unallocated, or be spread across several invoices. The
   * statement's job is to explain the balance, and only the allocated part of a
   * payment moves it — so an unallocated payment shows nothing here and the
   * balance stays high, which is correct and is exactly the prompt somebody
   * needs to go and allocate it.
   */
  const payments = await tx<
    { payment_no: string; payment_date: Date; reference: string | null; method: string; amount: string }[]
  >`
      SELECT p.payment_no, p.payment_date, p.reference, p.method,
             SUM(ROUND(a.amount * i.fx_rate, 4))::text AS amount
        FROM payment p
        JOIN payment_allocation a
          ON a.tenant_id = p.tenant_id AND a.payment_id = p.id
        JOIN invoice i
          ON i.tenant_id = a.tenant_id AND i.id = a.invoice_id
       WHERE p.tenant_id = ${ctx.tenantId}
         AND i.contact_id = ${contactId}
         AND p.direction = 'INBOUND'
         AND p.payment_date BETWEEN ${from}::date AND ${to}::date
       GROUP BY p.id, p.payment_no, p.payment_date, p.reference, p.method
  `;

  const creditNotes = await tx<
    { credit_note_no: string; credit_date: Date; reason: string | null; amount: string }[]
  >`
      SELECT cn.credit_note_no, cn.credit_date, cn.reason,
             ROUND(cn.total * COALESCE(i.fx_rate, 1), 4)::text AS amount
        FROM credit_note cn
        LEFT JOIN invoice i
          ON i.tenant_id = cn.tenant_id AND i.id = cn.invoice_id
       WHERE cn.tenant_id = ${ctx.tenantId}
         AND cn.contact_id = ${contactId}
         AND cn.status = 'ISSUED'
         AND cn.credit_date BETWEEN ${from}::date AND ${to}::date
  `;

  interface Pending {
    date: string;
    type: StatementEntryType;
    reference: string;
    detail: string | null;
    charge: Money | null;
    credit: Money | null;
    dueDate: string | null;
  }

  const pending: Pending[] = [
    ...invoices.map((row) => ({
      date: toIsoDate(row.issue_date),
      type: 'INVOICE' as const,
      reference: row.invoice_no,
      detail: row.reference,
      charge: Money.fromDecimal(row.amount, baseCurrency),
      credit: null,
      dueDate: toIsoDate(row.due_date),
    })),
    ...payments.map((row) => ({
      date: toIsoDate(row.payment_date),
      type: 'PAYMENT' as const,
      reference: row.payment_no,
      detail: row.reference ?? row.method,
      charge: null,
      credit: Money.fromDecimal(row.amount, baseCurrency),
      dueDate: null,
    })),
    ...creditNotes.map((row) => ({
      date: toIsoDate(row.credit_date),
      type: 'CREDIT_NOTE' as const,
      reference: row.credit_note_no,
      detail: row.reason,
      charge: null,
      credit: Money.fromDecimal(row.amount, baseCurrency),
      dueDate: null,
    })),
  ];

  /*
   * Date first, then charges before credits, then by document number.
   *
   * The middle rule is what stops a statement showing a payment landing before
   * the invoice it settles when both fall on the same day — which reads as an
   * overpayment followed by a charge, and is the sort of thing a customer
   * telephones about.
   *
   * The last rule matters for reproducibility: two invoices on the same date
   * must always come out in the same order, or two runs of the same statement
   * differ and neither is wrong.
   */
  const rank = { INVOICE: 0, CREDIT_NOTE: 1, PAYMENT: 2 } as const;
  pending.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      rank[a.type] - rank[b.type] ||
      a.reference.localeCompare(b.reference),
  );

  let running = openingBalance;
  const entries: StatementEntry[] = pending.map((row) => {
    running = row.charge !== null ? running.add(row.charge) : running.subtract(row.credit ?? zero);
    return {
      date: row.date,
      type: row.type,
      reference: row.reference,
      detail: row.detail,
      charge: row.charge?.toDecimalString() ?? null,
      credit: row.credit?.toDecimalString() ?? null,
      balance: running.toDecimalString(),
      dueDate: row.dueDate,
    };
  });

  const overdue = await overdueAsAt(tx, ctx, contactId, to, baseCurrency);

  return {
    contact: { id: contact.id, name: contact.name, email: contact.email },
    from,
    to,
    currency: baseCurrency,
    openingBalance: openingBalance.toDecimalString(),
    entries,
    closingBalance: running.toDecimalString(),
    overdue: overdue.toDecimalString(),
  };
}

/**
 * What one customer owed at the START of a date — everything strictly before it.
 *
 * Reconstructed the same way `openReceivablesAsAt` reconstructs the ageing
 * report: the invoice as issued, less allocations dated before the cut. The
 * two agree because they ask the same question of the same append-only rows,
 * and a test asserts that rather than trusting it.
 */
async function balanceAsAt(
  tx: Tx,
  ctx: TenantContext,
  contactId: string,
  before: string,
  currency: Currency,
): Promise<Money> {
  const [row] = await tx<{ balance: string | null }[]>`
      SELECT SUM(
                 ROUND(
                     (i.total
                      - COALESCE(paid.amount, 0)
                      - COALESCE(credited.amount, 0)) * i.fx_rate, 4
                 )
             )::text AS balance
        FROM invoice i
        LEFT JOIN LATERAL (
             SELECT SUM(a.amount) AS amount
               FROM payment_allocation a
               JOIN payment p
                 ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
              WHERE a.tenant_id = i.tenant_id
                AND a.invoice_id = i.id
                AND p.payment_date < ${before}::date
        ) paid ON TRUE
        LEFT JOIN LATERAL (
             SELECT SUM(ca.amount) AS amount
               FROM credit_note_allocation ca
               JOIN credit_note cn
                 ON cn.tenant_id = ca.tenant_id AND cn.id = ca.credit_note_id
              WHERE ca.tenant_id = i.tenant_id
                AND ca.invoice_id = i.id
                AND cn.status = 'ISSUED'
                AND cn.credit_date < ${before}::date
        ) credited ON TRUE
       WHERE i.tenant_id = ${ctx.tenantId}
         AND i.contact_id = ${contactId}
         AND i.issue_date < ${before}::date
  `;

  return row?.balance == null ? Money.zero(currency) : Money.fromDecimal(row.balance, currency);
}

/** How much of what they still owe was already due by `asOf`. */
async function overdueAsAt(
  tx: Tx,
  ctx: TenantContext,
  contactId: string,
  asOf: string,
  currency: Currency,
): Promise<Money> {
  const [row] = await tx<{ overdue: string | null }[]>`
      SELECT SUM(
                 ROUND(
                     (i.total
                      - COALESCE(paid.amount, 0)
                      - COALESCE(credited.amount, 0)) * i.fx_rate, 4
                 )
             )::text AS overdue
        FROM invoice i
        LEFT JOIN LATERAL (
             SELECT SUM(a.amount) AS amount
               FROM payment_allocation a
               JOIN payment p
                 ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
              WHERE a.tenant_id = i.tenant_id
                AND a.invoice_id = i.id
                AND p.payment_date <= ${asOf}::date
        ) paid ON TRUE
        LEFT JOIN LATERAL (
             SELECT SUM(ca.amount) AS amount
               FROM credit_note_allocation ca
               JOIN credit_note cn
                 ON cn.tenant_id = ca.tenant_id AND cn.id = ca.credit_note_id
              WHERE ca.tenant_id = i.tenant_id
                AND ca.invoice_id = i.id
                AND cn.status = 'ISSUED'
                AND cn.credit_date <= ${asOf}::date
        ) credited ON TRUE
       WHERE i.tenant_id = ${ctx.tenantId}
         AND i.contact_id = ${contactId}
         AND i.issue_date <= ${asOf}::date
         AND i.due_date < ${asOf}::date
  `;

  return row?.overdue == null ? Money.zero(currency) : Money.fromDecimal(row.overdue, currency);
}

/**
 * Every customer with something outstanding, so a shop can run the month's
 * statements without first working out who to run them for.
 */
export async function customersWithBalances(
  tx: Tx,
  ctx: TenantContext,
  asOf: string,
): Promise<readonly { readonly id: string; readonly name: string; readonly balance: string }[]> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const rows = await tx<{ id: string; name: string; balance: string }[]>`
      SELECT c.id, c.name,
             SUM(
                 ROUND(
                     (i.total
                      - COALESCE(paid.amount, 0)
                      - COALESCE(credited.amount, 0)) * i.fx_rate, 4
                 )
             )::text AS balance
        FROM contact c
        JOIN invoice i
          ON i.tenant_id = c.tenant_id AND i.contact_id = c.id
        LEFT JOIN LATERAL (
             SELECT SUM(a.amount) AS amount
               FROM payment_allocation a
               JOIN payment p
                 ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
              WHERE a.tenant_id = i.tenant_id
                AND a.invoice_id = i.id
                AND p.payment_date <= ${asOf}::date
        ) paid ON TRUE
        LEFT JOIN LATERAL (
             SELECT SUM(ca.amount) AS amount
               FROM credit_note_allocation ca
               JOIN credit_note cn
                 ON cn.tenant_id = ca.tenant_id AND cn.id = ca.credit_note_id
              WHERE ca.tenant_id = i.tenant_id
                AND ca.invoice_id = i.id
                AND cn.status = 'ISSUED'
                AND cn.credit_date <= ${asOf}::date
        ) credited ON TRUE
       WHERE c.tenant_id = ${ctx.tenantId}
         AND i.issue_date <= ${asOf}::date
       GROUP BY c.id, c.name
      HAVING SUM(i.total - COALESCE(paid.amount, 0) - COALESCE(credited.amount, 0)) <> 0
       ORDER BY c.name
  `;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    balance: Money.fromDecimal(r.balance, baseCurrency).toDecimalString(),
  }));
}
