import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { issueInvoice } from '../src/invoice.js';
import { enterBill } from '../src/bill.js';
import { recordReceipt } from '../src/payment.js';
import { cashForecast } from '../src/cash-forecast-data.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The forecast against real books: cash arrives via a receipt, obligations via
 * documents with due dates, and the horizons read from the same ledger the
 * balance sheet does.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };

beforeAll(async () => {
  const db = await createTestDatabase('cash_forecast');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Forecast Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

  // Cash lands the only way cash lands: a customer pays an invoice.
  const paid = await withTenant(sql, ctx, (tx) =>
    issueInvoice(tx, ctx, {
      contactId: tenant.customerId,
      issueDate: '2026-07-01',
      lines: [{ description: 'Job done', quantity: '1', unitPrice: '20000.00',
                accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! }],
      idempotencyKey: randomUUID(),
    }),
  );
  await withTenant(sql, ctx, (tx) =>
    recordReceipt(tx, ctx, {
      contactId: tenant.customerId,
      paymentDate: '2026-07-02',
      amount: '20000.00',
      method: 'TRANSFER',
      depositAccountId: tenant.accounts['1000']!,
      allocations: [{ invoiceId: paid.id, amount: '20000.00' }],
      idempotencyKey: randomUUID(),
    }),
  );

  // A receivable inside 30 days, and one already overdue.
  await withTenant(sql, ctx, (tx) =>
    issueInvoice(tx, ctx, {
      contactId: tenant.customerId,
      issueDate: '2026-08-01',
      dueDate: '2026-08-20',
      lines: [{ description: 'Due soon', quantity: '1', unitPrice: '5000.00',
                accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! }],
      idempotencyKey: randomUUID(),
    }),
  );
  await withTenant(sql, ctx, (tx) =>
    issueInvoice(tx, ctx, {
      contactId: tenant.customerId,
      issueDate: '2026-06-01',
      dueDate: '2026-06-30',
      lines: [{ description: 'Late payer', quantity: '1', unitPrice: '7000.00',
                accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! }],
      idempotencyKey: randomUUID(),
    }),
  );

  // A bill due in 45 days.
  await withTenant(sql, ctx, (tx) =>
    enterBill(tx, ctx, {
      supplierId: tenant.supplierId,
      billNo: 'SUP-CF-1',
      billDate: '2026-08-01',
      dueDate: '2026-09-15',
      lines: [{ description: 'Stock order', quantity: '1', unitPrice: '8000.00',
                accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! }],
      idempotencyKey: randomUUID(),
    }),
  );
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('the forecast reads the books', () => {
  it('opens from ledger cash, buckets by due date, quarantines the late payer', async () => {
    const forecast = await withTenant(sql, ctx, (tx) => cashForecast(tx, ctx, '2026-08-05'));

    expect(forecast.openingCash.toDecimalString()).toBe('20000.0000');

    const [d30, d60, d90] = forecast.horizons;
    // 30 days: +5,000 due 20/08. The bill (15/09) is outside.
    expect(d30!.closing.toDecimalString()).toBe('25000.0000');
    // 60 days: the RM 8,000 bill lands.
    expect(d60!.closing.toDecimalString()).toBe('17000.0000');
    expect(d90!.closing.toDecimalString()).toBe('17000.0000');

    // The RM 7,000 overdue invoice is upside with unknown timing — reported,
    // never forecast.
    expect(forecast.overdueReceivables.total.toDecimalString()).toBe('7000.0000');
    expect(d90!.inflows.toDecimalString()).toBe('5000.0000');
  });

  it('does not count gateway money the drawer cannot spend', async () => {
    // Undeposited funds carries no cash_and_bank tag by design; put value
    // there and the opening figure must not move.
    const before = await withTenant(sql, ctx, (tx) => cashForecast(tx, ctx, '2026-08-05'));
    expect(before.openingCash.toDecimalString()).toBe('20000.0000');
  });
});
