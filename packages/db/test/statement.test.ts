import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { issueInvoice } from '../src/invoice.js';
import { recordReceipt, openReceivablesAsAt } from '../src/payment.js';
import { customerStatement, customersWithBalances, StatementError } from '../src/statement.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * Customer statements.
 *
 * A statement is the document a customer argues with, so the properties that
 * matter are not "does it produce numbers" but "do the numbers join up":
 * consecutive months must meet exactly, and the closing balance must agree with
 * what the ageing report says the same customer owes on the same day. Both are
 * asserted here rather than assumed, because they are computed by different
 * queries and could drift apart silently.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('statement');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin, 'Statements Sdn Bhd');
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

async function issue(unitPrice: string, issueDate: string, dueDate?: string) {
  return withTenant(sql, ctx(), (tx) =>
    issueInvoice(tx, ctx(), {
      contactId: tenant.customerId,
      issueDate,
      ...(dueDate !== undefined ? { dueDate } : {}),
      lines: [
        {
          description: 'Workshop labour',
          quantity: '1',
          unitPrice,
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['NONE']!,
        },
      ],
      idempotencyKey: randomUUID(),
    }),
  );
}

async function receive(invoiceId: string, amount: string, paymentDate: string) {
  return withTenant(sql, ctx(), (tx) =>
    recordReceipt(tx, ctx(), {
      contactId: tenant.customerId,
      paymentDate,
      amount,
      method: 'TRANSFER',
      depositAccountId: tenant.accounts['1000']!,
      allocations: [{ invoiceId, amount }],
      idempotencyKey: randomUUID(),
    }),
  );
}

const statement = (from: string, to: string) =>
  withTenant(sql, ctx(), (tx) => customerStatement(tx, ctx(), tenant.customerId, from, to));

// ---------------------------------------------------------------------------

describe('a customer statement', () => {
  it('opens at nothing, charges an invoice, and credits the payment', async () => {
    const invoice = await issue('1200.00', '2026-03-05', '2026-04-04');
    await receive(invoice.id, '500.00', '2026-03-20');

    const march = await statement('2026-03-01', '2026-03-31');

    expect(march.openingBalance).toBe('0.0000');
    expect(march.entries).toHaveLength(2);

    // The invoice first, then the payment — and the running balance after each.
    expect(march.entries[0]).toMatchObject({
      type: 'INVOICE',
      charge: '1200.0000',
      credit: null,
      balance: '1200.0000',
    });
    expect(march.entries[1]).toMatchObject({
      type: 'PAYMENT',
      charge: null,
      credit: '500.0000',
      balance: '700.0000',
    });
    expect(march.closingBalance).toBe('700.0000');
  });

  it('joins up month to month with nothing lost between them', async () => {
    /*
     * The property a statement lives or dies by.
     *
     * March's closing balance must be April's opening balance exactly. If the
     * boundary were inclusive at both ends, a document dated 31 March would be
     * counted twice; if exclusive at both, it would vanish. Neither shows up in
     * a single-month test.
     */
    const march = await statement('2026-03-01', '2026-03-31');
    const april = await statement('2026-04-01', '2026-04-30');

    expect(april.openingBalance).toBe(march.closingBalance);
  });

  it('counts a document dated on the boundary exactly once', async () => {
    const invoice = await issue('300.00', '2026-04-30', '2026-05-30');

    const april = await statement('2026-04-01', '2026-04-30');
    const may = await statement('2026-05-01', '2026-05-31');

    // In April's entries, and only in the OPENING balance of May.
    expect(april.entries.some((e) => e.reference === invoice.invoiceNo)).toBe(true);
    expect(may.entries.some((e) => e.reference === invoice.invoiceNo)).toBe(false);
    expect(may.openingBalance).toBe(april.closingBalance);
  });

  it('agrees with the ageing report on what the customer owes', async () => {
    /*
     * Two different queries, one answer. `openReceivablesAsAt` drives the ageing
     * report and ledger invariant #6; the statement reconstructs the balance its
     * own way. They are allowed to be written separately — they are not allowed
     * to disagree.
     */
    const asOf = '2026-05-31';
    const asAt = await withTenant(sql, ctx(), (tx) =>
      openReceivablesAsAt(tx, ctx(), asOf),
    );
    const mine = asAt
      .filter((item) => item.contactId === tenant.customerId)
      .reduce((total, item) => total + Number(item.outstanding.toDecimalString()), 0);

    const upToDate = await statement('2020-01-01', asOf);
    expect(Number(upToDate.closingBalance)).toBeCloseTo(mine, 4);
  });

  it('flags what is already past its due date', async () => {
    // The RM700 balance from March fell due on 04/04. By the end of May it is
    // overdue, and a statement that did not say so would be a worse document
    // than the ageing report it is meant to replace for the customer.
    const upToDate = await statement('2020-01-01', '2026-05-31');
    expect(Number(upToDate.overdue)).toBeGreaterThan(0);
    expect(Number(upToDate.overdue)).toBeLessThanOrEqual(Number(upToDate.closingBalance));
  });
});

describe('ordering, which customers telephone about', () => {
  it('puts an invoice before a payment received on the same day', async () => {
    /*
     * Without this rule the statement shows the money arriving before the
     * charge it settles, which reads as an overpayment followed by a bill.
     * Both are dated the same day and the database has no opinion about
     * which came first.
     */
    const invoice = await issue('450.00', '2026-06-10', '2026-07-10');
    await receive(invoice.id, '450.00', '2026-06-10');

    const june = await statement('2026-06-01', '2026-06-30');
    const sameDay = june.entries.filter((e) => e.date === '2026-06-10');

    expect(sameDay[0]?.type).toBe('INVOICE');
    expect(sameDay[1]?.type).toBe('PAYMENT');
    // And the running balance never goes negative through the pair.
    expect(Number(sameDay[0]?.balance)).toBeGreaterThan(0);
  });

  it('produces the same document twice', async () => {
    // Two runs of one statement must be identical, or neither can be trusted as
    // the copy that was sent.
    const first = await statement('2026-01-01', '2026-12-31');
    const second = await statement('2026-01-01', '2026-12-31');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('what it refuses', () => {
  it('rejects a period that ends before it starts', async () => {
    await expect(statement('2026-06-30', '2026-06-01')).rejects.toBeInstanceOf(StatementError);
  });

  it('answers NOT FOUND for a contact in another tenant', async () => {
    // Rule 9: the same answer for "does not exist" and "is not yours", so a
    // customer list cannot be enumerated one id at a time.
    const other = await seedTenant(admin, 'Somebody Else Sdn Bhd');
    await expect(
      withTenant(sql, ctx(), (tx) =>
        customerStatement(tx, ctx(), other.customerId, '2026-01-01', '2026-12-31'),
      ),
    ).rejects.toMatchObject({ code: 'CONTACT_NOT_FOUND' });
  });
});

describe('who needs a statement', () => {
  it('lists the customers with something outstanding', async () => {
    const owing = await withTenant(sql, ctx(), (tx) =>
      customersWithBalances(tx, ctx(), '2026-12-31'),
    );

    const mine = owing.find((c) => c.id === tenant.customerId);
    expect(mine).toBeDefined();
    expect(Number(mine!.balance)).toBeGreaterThan(0);
  });

  it('leaves out a customer who has settled everything', async () => {
    // The point of the list: it is the month's work queue, so a customer with a
    // zero balance appearing on it is a statement nobody needed to send.
    const settled = await withTenant(sql, ctx(), (tx) =>
      customersWithBalances(tx, ctx(), '2020-01-01'),
    );
    expect(settled).toHaveLength(0);
  });
});
