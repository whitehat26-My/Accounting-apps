import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { issueInvoice, outstandingReceivables } from '../src/invoice.js';
import { agedReceivables, openReceivablesAsAt, recordReceipt } from '../src/payment.js';
import { detectRollupDrift } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('payment');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin);
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

async function issue(unitPrice: string, issueDate = '2026-08-05') {
  return withTenant(sql, ctx(), (tx) =>
    issueInvoice(tx, ctx(), {
      contactId: tenant.customerId,
      issueDate,
      lines: [
        {
          description: 'Consulting services',
          quantity: '1',
          unitPrice,
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['NONE']!, // keep the arithmetic obvious
        },
      ],
      idempotencyKey: randomUUID(),
    }),
  );
}

/** AR control account balance from the rollup. */
async function arControlBalance(): Promise<string> {
  const [row] = await withTenant(sql, ctx(), (tx) =>
    tx<{ balance: string }[]>`
        SELECT COALESCE(SUM(net_movement), 0)::text AS balance
          FROM account_period_balance
         WHERE tenant_id = ${tenant.tenantId} AND account_id = ${tenant.accounts['1100']!}
    `,
  );
  return Money.fromDecimal(row!.balance, 'MYR').toDecimalString();
}

describe('recording a receipt', () => {
  it('settles an invoice in full and posts Dr Bank / Cr AR', async () => {
    const invoice = await issue('1000.00');

    const receipt = await withTenant(sql, ctx(), (tx) =>
      recordReceipt(tx, ctx(), {
        contactId: tenant.customerId,
        paymentDate: '2026-08-20',
        amount: '1000.00',
        method: 'DUITNOW',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '1000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(receipt.paymentNo).toMatch(/^PAY-\d{5}$/);
    expect(receipt.allocatedTotal).toBe('1000.0000');
    expect(receipt.unallocated).toBe('0.0000');
    expect(receipt.settledInvoices[0]).toMatchObject({ status: 'PAID', amountDue: '0.0000' });

    const lines = await withTenant(sql, ctx(), (tx) =>
      tx<{ code: string; debit: string; credit: string }[]>`
          SELECT a.code, l.base_debit AS debit, l.base_credit AS credit
            FROM journal_line l
            JOIN account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
           WHERE l.tenant_id = ${tenant.tenantId}
             AND l.journal_entry_id = ${receipt.journalEntryId}
           ORDER BY a.code
      `,
    );

    expect(lines).toEqual([
      { code: '1000', debit: '1000.0000', credit: '0.0000' },
      { code: '1100', debit: '0.0000', credit: '1000.0000' },
    ]);
  });

  it('moves an invoice to PART_PAID on a partial receipt', async () => {
    const invoice = await issue('800.00');

    const receipt = await withTenant(sql, ctx(), (tx) =>
      recordReceipt(tx, ctx(), {
        contactId: tenant.customerId,
        paymentDate: '2026-08-20',
        amount: '300.00',
        method: 'FPX',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '300.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(receipt.settledInvoices[0]).toMatchObject({
      status: 'PART_PAID',
      amountDue: '500.0000',
    });
  });

  it('accumulates instalments until the invoice is PAID', async () => {
    const invoice = await issue('900.00');

    for (const amount of ['300.00', '300.00']) {
      await withTenant(sql, ctx(), (tx) =>
        recordReceipt(tx, ctx(), {
          contactId: tenant.customerId,
          paymentDate: '2026-08-21',
          amount,
          method: 'TRANSFER',
          depositAccountId: tenant.accounts['1000']!,
          allocations: [{ invoiceId: invoice.id, amount }],
          idempotencyKey: randomUUID(),
        }),
      );
    }

    const final = await withTenant(sql, ctx(), (tx) =>
      recordReceipt(tx, ctx(), {
        contactId: tenant.customerId,
        paymentDate: '2026-08-22',
        amount: '300.00',
        method: 'TRANSFER',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '300.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(final.settledInvoices[0]).toMatchObject({ status: 'PAID', amountDue: '0.0000' });
  });

  it('settles several invoices from one transfer', async () => {
    const a = await issue('200.00', '2026-08-10');
    const b = await issue('300.00', '2026-08-11');

    const receipt = await withTenant(sql, ctx(), (tx) =>
      recordReceipt(tx, ctx(), {
        contactId: tenant.customerId,
        paymentDate: '2026-08-25',
        amount: '500.00',
        method: 'DUITNOW',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [
          { invoiceId: a.id, amount: '200.00' },
          { invoiceId: b.id, amount: '300.00' },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(receipt.settledInvoices).toHaveLength(2);
    expect(receipt.settledInvoices.every((i) => i.status === 'PAID')).toBe(true);
  });

  it('is idempotent', async () => {
    const invoice = await issue('150.00');
    const input = {
      contactId: tenant.customerId,
      paymentDate: '2026-08-26',
      amount: '150.00',
      method: 'CASH' as const,
      depositAccountId: tenant.accounts['1000']!,
      allocations: [{ invoiceId: invoice.id, amount: '150.00' }],
      idempotencyKey: randomUUID(),
    };

    const first = await withTenant(sql, ctx(), (tx) => recordReceipt(tx, ctx(), input));
    const second = await withTenant(sql, ctx(), (tx) => recordReceipt(tx, ctx(), input));

    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);

    // And the invoice was not double-settled.
    const [row] = await withTenant(sql, ctx(), (tx) =>
      tx<{ amount_paid: string }[]>`
          SELECT amount_paid FROM invoice
           WHERE tenant_id = ${tenant.tenantId} AND id = ${invoice.id}
      `,
    );
    expect(row!.amount_paid).toBe('150.0000');
  });
});

describe('auto-allocation against live balances', () => {
  // A dedicated tenant, so the allocation order is determined by this test's
  // invoices rather than whatever earlier tests left outstanding.
  it('applies oldest-first when no allocation is given', async () => {
    const solo = await seedTenant(admin, 'Auto Allocate Sdn Bhd');
    const soloCtx = { tenantId: solo.tenantId, userId: solo.userId };

    const issueFor = (unitPrice: string, issueDate: string) =>
      withTenant(sql, soloCtx, (tx) =>
        issueInvoice(tx, soloCtx, {
          contactId: solo.customerId,
          issueDate,
          lines: [
            {
              description: 'Services',
              quantity: '1',
              unitPrice,
              accountId: solo.accounts['4000']!,
              taxCodeId: solo.taxCodes['NONE']!,
            },
          ],
          idempotencyKey: randomUUID(),
        }),
      );

    const older = await issueFor('100.00', '2026-08-01');
    const newer = await issueFor('100.00', '2026-08-02');

    const receipt = await withTenant(sql, soloCtx, (tx) =>
      recordReceipt(tx, soloCtx, {
        contactId: solo.customerId,
        paymentDate: '2026-08-27',
        amount: '150.00',
        method: 'FPX',
        depositAccountId: solo.accounts['1000']!,
        idempotencyKey: randomUUID(),
      }),
    );

    expect(receipt.allocatedTotal).toBe('150.0000');
    expect(receipt.unallocated).toBe('0.0000');
    expect(receipt.settledInvoices).toEqual([
      { invoiceId: older.id, status: 'PAID', amountDue: '0.0000' },
      { invoiceId: newer.id, status: 'PART_PAID', amountDue: '50.0000' },
    ]);
  });

  it('leaves a remainder unallocated when it exceeds everything owing', async () => {
    const solo = await seedTenant(admin, 'Overpay Sdn Bhd');
    const soloCtx = { tenantId: solo.tenantId, userId: solo.userId };

    await withTenant(sql, soloCtx, (tx) =>
      issueInvoice(tx, soloCtx, {
        contactId: solo.customerId,
        issueDate: '2026-08-01',
        lines: [
          {
            description: 'Services',
            quantity: '1',
            unitPrice: '100.00',
            accountId: solo.accounts['4000']!,
            taxCodeId: solo.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const receipt = await withTenant(sql, soloCtx, (tx) =>
      recordReceipt(tx, soloCtx, {
        contactId: solo.customerId,
        paymentDate: '2026-08-27',
        amount: '250.00',
        method: 'DUITNOW',
        depositAccountId: solo.accounts['1000']!,
        idempotencyKey: randomUUID(),
      }),
    );

    expect(receipt.allocatedTotal).toBe('100.0000');
    expect(receipt.unallocated).toBe('150.0000');

    // The overpayment leaves the customer in credit: AR goes negative, which
    // says the business owes them RM 150.
    const [row] = await withTenant(sql, soloCtx, (tx) =>
      tx<{ balance: string }[]>`
          SELECT COALESCE(SUM(net_movement), 0)::text AS balance
            FROM account_period_balance
           WHERE tenant_id = ${solo.tenantId} AND account_id = ${solo.accounts['1100']!}
      `,
    );
    expect(Money.fromDecimal(row!.balance, 'MYR').toDecimalString()).toBe('-150.0000');
  });
});

describe('over-settlement is refused', () => {
  it('rejects an allocation larger than the amount still owing', async () => {
    const invoice = await issue('100.00');

    await expect(
      withTenant(sql, ctx(), (tx) =>
        recordReceipt(tx, ctx(), {
          contactId: tenant.customerId,
          paymentDate: '2026-08-28',
          amount: '500.00',
          method: 'CASH',
          depositAccountId: tenant.accounts['1000']!,
          allocations: [{ invoiceId: invoice.id, amount: '500.00' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/failed validation/i);
  });

  it('rejects allocating more than was received', async () => {
    const invoice = await issue('900.00');

    await expect(
      withTenant(sql, ctx(), (tx) =>
        recordReceipt(tx, ctx(), {
          contactId: tenant.customerId,
          paymentDate: '2026-08-28',
          amount: '100.00',
          method: 'CASH',
          depositAccountId: tenant.accounts['1000']!,
          allocations: [{ invoiceId: invoice.id, amount: '900.00' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/failed validation/i);
  });

  it('is also enforced by the database, not only the service', async () => {
    const invoice = await issue('100.00');

    // Write the allocation rows directly, bypassing every application check.
    await expect(
      withTenant(sql, ctx(), async (tx) => {
        const [payment] = await tx<{ id: string }[]>`
            SELECT id FROM payment WHERE tenant_id = ${tenant.tenantId} LIMIT 1
        `;
        await tx`
            INSERT INTO payment_allocation (tenant_id, payment_id, invoice_id, amount)
            VALUES (${tenant.tenantId}, ${payment!.id}, ${invoice.id}, 100),
                   (${tenant.tenantId}, ${payment!.id}, ${invoice.id}, 100)
        `;
      }),
    ).rejects.toThrow(/over-allocated|duplicate key/i);
  });
});

describe('payments are immutable', () => {
  it('refuses to change a recorded amount', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          UPDATE payment SET amount = amount + 1 WHERE tenant_id = ${tenant.tenantId}
      `),
    ).rejects.toThrow(/immutable|reverse it/i);
  });

  it('refuses deletion', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          DELETE FROM payment WHERE tenant_id = ${tenant.tenantId}
      `),
    ).rejects.toThrow(/cannot be deleted|reverse it/i);
  });
});

describe('ledger invariant #6 holds through partial settlement', () => {
  it('AR control equals the sum of outstanding invoice balances', async () => {
    const subledger = await withTenant(sql, ctx(), (tx) => outstandingReceivables(tx, ctx()));
    const control = await arControlBalance();

    expect(Money.fromDecimal(subledger.total, 'MYR').toDecimalString()).toBe(control);
  });

  it('still holds after another mixed round of invoices and receipts', async () => {
    const a = await issue('1234.56', '2026-08-15');
    await issue('99.99', '2026-08-16');

    await withTenant(sql, ctx(), (tx) =>
      recordReceipt(tx, ctx(), {
        contactId: tenant.customerId,
        paymentDate: '2026-08-29',
        amount: '234.56',
        method: 'FPX',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ invoiceId: a.id, amount: '234.56' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const subledger = await withTenant(sql, ctx(), (tx) => outstandingReceivables(tx, ctx()));
    expect(Money.fromDecimal(subledger.total, 'MYR').toDecimalString()).toBe(await arControlBalance());
  });

  it('leaves the rollup in agreement with the raw journal', async () => {
    const drift = await withTenant(sql, ctx(), (tx) => detectRollupDrift(tx, ctx()));
    expect(drift).toEqual([]);
  });
});

describe('aged receivables', () => {
  it('buckets outstanding invoices by how overdue they are', async () => {
    const report = await withTenant(sql, ctx(), (tx) => agedReceivables(tx, ctx(), '2026-10-15'));

    expect(report.buckets.map((b) => b.key)).toEqual([
      'CURRENT',
      '1_30',
      '31_60',
      '61_90',
      '90_PLUS',
    ]);

    // The buckets must reconcile to the subledger total.
    const subledger = await withTenant(sql, ctx(), (tx) => outstandingReceivables(tx, ctx()));
    const bucketTotal = report.buckets.reduce((acc, b) => acc.add(b.total), Money.zero('MYR'));
    expect(bucketTotal.toDecimalString()).toBe(
      Money.fromDecimal(subledger.total, 'MYR').toDecimalString(),
    );
  });
});

describe('aged receivables are genuinely as-at', () => {
  /**
   * The bug this suite exists for.
   *
   * The original implementation bucketed by `asOfDate` but measured
   * `invoice.amount_due` — today's live balance — with no filter on the issue
   * date. So a report run for 31/03 showed March's buckets against June's
   * balances: invoices issued in April appeared, invoices settled in May had
   * vanished, and the total tied to the AR control account at no date at all.
   *
   * Each assertion below fails against that version.
   */
  const t = () => tenant;

  /** AR control account balance restricted to periods starting on or before a date. */
  async function arControlAsAt(asOf: string): Promise<string> {
    const [row] = await withTenant(sql, ctx(), (tx) =>
      tx<{ balance: string }[]>`
          SELECT COALESCE(SUM(b.net_movement), 0)::text AS balance
            FROM account_period_balance b
            JOIN fiscal_period p
              ON p.tenant_id = b.tenant_id AND p.id = b.fiscal_period_id
           WHERE b.tenant_id = ${t().tenantId}
             AND b.account_id = ${t().accounts['1100']!}
             AND p.start_date <= ${asOf}::date
      `,
    );
    return Money.fromDecimal(row!.balance, 'MYR').toDecimalString();
  }

  it('excludes an invoice issued after the report date', async () => {
    const before = await withTenant(sql, ctx(), (tx) => agedReceivables(tx, ctx(), '2026-09-30'));
    await issue('4321.00', '2026-10-15');
    const after = await withTenant(sql, ctx(), (tx) => agedReceivables(tx, ctx(), '2026-09-30'));

    // The October invoice was not a receivable on 30 September.
    expect(after.total.toDecimalString()).toBe(before.total.toDecimalString());

    const later = await withTenant(sql, ctx(), (tx) => agedReceivables(tx, ctx(), '2026-10-31'));
    expect(later.total.subtract(before.total).toDecimalString()).toBe('4321.0000');
  });

  it('still shows an invoice that was open then and has since been settled', async () => {
    const invoice = await issue('2500.00', '2026-09-02');

    const openThen = await withTenant(sql, ctx(), (tx) =>
      openReceivablesAsAt(tx, ctx(), '2026-09-30'),
    );
    expect(openThen.some((i) => i.documentId === invoice.id)).toBe(true);

    await withTenant(sql, ctx(), (tx) =>
      recordReceipt(tx, ctx(), {
        contactId: tenant.customerId,
        paymentDate: '2026-11-05',
        amount: '2500.00',
        method: 'DUITNOW',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '2500.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    // Settled in November, so it was STILL outstanding at 30 September. The
    // buggy version measured the live balance and dropped it retrospectively.
    const stillOpen = await withTenant(sql, ctx(), (tx) =>
      openReceivablesAsAt(tx, ctx(), '2026-09-30'),
    );
    expect(stillOpen.find((i) => i.documentId === invoice.id)?.outstanding.toDecimalString()).toBe(
      '2500.0000',
    );

    // And gone by the end of November.
    const settled = await withTenant(sql, ctx(), (tx) =>
      openReceivablesAsAt(tx, ctx(), '2026-11-30'),
    );
    expect(settled.some((i) => i.documentId === invoice.id)).toBe(false);
  });

  it('ties to the AR control account at a PAST date, which is the point', async () => {
    // The assertion the old implementation could not satisfy at any date but
    // today, and the reason an auditor asks for this report first.
    for (const asOf of ['2026-09-30', '2026-10-31', '2026-11-30']) {
      const report = await withTenant(sql, ctx(), (tx) => agedReceivables(tx, ctx(), asOf));
      expect(report.total.toDecimalString(), `aged AR at ${asOf}`).toBe(await arControlAsAt(asOf));
    }
  });
});
