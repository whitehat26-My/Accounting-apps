import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { issueInvoice, outstandingByCurrency, outstandingReceivables } from '../src/invoice.js';
import { recordReceipt } from '../src/payment.js';
import { detectRollupDrift } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('fx');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin);

  // Published rates for the tenant. USD strengthens against MYR over the month.
  await withTenant(admin, { tenantId: tenant.tenantId }, (tx) => tx`
      INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate, source)
      VALUES (${tenant.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000, 'BNM'),
             (${tenant.tenantId}, 'USD', 'MYR', '2026-09-01', 4.75000000, 'BNM'),
             (${tenant.tenantId}, 'USD', 'MYR', '2026-10-01', 4.55000000, 'BNM')
  `);
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });
const rm = (v: string) => Money.fromDecimal(v, 'MYR');

async function issueUsd(amount: string, issueDate = '2026-08-05', t: Tenant = tenant) {
  const c = { tenantId: t.tenantId, userId: t.userId };
  return withTenant(sql, c, (tx) =>
    issueInvoice(tx, c, {
      contactId: t.customerId,
      issueDate,
      currency: 'USD',
      lines: [{
        description: 'Export consulting',
        quantity: '1',
        unitPrice: amount,
        accountId: t.accounts['4000']!,
        taxCodeId: t.taxCodes['NONE']!,
      }],
      idempotencyKey: randomUUID(),
    }),
  );
}

async function accountBase(code: string, t: Tenant = tenant): Promise<string> {
  const c = { tenantId: t.tenantId };
  const [row] = await withTenant(sql, c, (tx) =>
    tx<{ balance: string }[]>`
        SELECT COALESCE(SUM(net_movement), 0)::text AS balance
          FROM account_period_balance
         WHERE tenant_id = ${t.tenantId} AND account_id = ${t.accounts[code]!}
    `,
  );
  return rm(row!.balance).toDecimalString();
}

describe('exchange rate resolution', () => {
  it('uses the rate in force on the invoice date', async () => {
    const invoice = await issueUsd('1000.00', '2026-08-05');

    const [row] = await withTenant(sql, ctx(), (tx) =>
      tx<{ fx_rate: string; currency: string; total: string }[]>`
          SELECT fx_rate, currency, total FROM invoice
           WHERE tenant_id = ${tenant.tenantId} AND id = ${invoice.id}
      `,
    );

    // 5 August has no published rate, so the 1 August rate carries forward.
    expect(row!.fx_rate).toBe('4.70000000');
    expect(row!.currency).toBe('USD');
    expect(row!.total).toBe('1000.0000'); // still USD
  });

  it('books AR into the ledger at the base-currency value', async () => {
    const solo = await seedTenant(admin, 'FX Booking Sdn Bhd');
    await withTenant(admin, { tenantId: solo.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate)
        VALUES (${solo.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000)
    `);

    await issueUsd('1000.00', '2026-08-05', solo);

    expect(await accountBase('1100', solo)).toBe('4700.0000'); // AR
    expect(await accountBase('4000', solo)).toBe('-4700.0000'); // revenue (credit)
  });

  it('never looks forward for a rate', async () => {
    // 2026-07-15 predates every stored rate, so there is nothing to use.
    await expect(issueUsd('100.00', '2026-07-15')).rejects.toThrow(/exchange rate/i);
  });

  it('accepts an explicitly contracted rate over the published one', async () => {
    const c = ctx();
    const invoice = await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        currency: 'USD',
        fxRate: '4.20000000',
        lines: [{
          description: 'Contracted rate deal',
          quantity: '1',
          unitPrice: '100.00',
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    const [row] = await withTenant(sql, c, (tx) =>
      tx<{ fx_rate: string }[]>`
          SELECT fx_rate FROM invoice WHERE tenant_id = ${tenant.tenantId} AND id = ${invoice.id}
      `,
    );
    expect(row!.fx_rate).toBe('4.20000000');
  });

  it('leaves base-currency invoices at a rate of 1', async () => {
    const c = ctx();
    const invoice = await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [{
          description: 'Local work',
          quantity: '1',
          unitPrice: '500.00',
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    const [row] = await withTenant(sql, c, (tx) =>
      tx<{ fx_rate: string; currency: string }[]>`
          SELECT fx_rate, currency FROM invoice
           WHERE tenant_id = ${tenant.tenantId} AND id = ${invoice.id}
      `,
    );
    expect(row!.fx_rate).toBe('1.00000000');
    expect(row!.currency).toBe('MYR');
  });
});

// ---------------------------------------------------------------------------
// Invariant #13, end to end
// ---------------------------------------------------------------------------

describe('invariant #13 — realised FX on settlement', () => {
  async function freshTenantWithRates(name: string) {
    const t = await seedTenant(admin, name);
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000),
               (${t.tenantId}, 'USD', 'MYR', '2026-09-01', 4.75000000),
               (${t.tenantId}, 'USD', 'MYR', '2026-10-01', 4.55000000)
    `);
    return t;
  }

  it('posts a realised gain and clears AR to exactly zero', async () => {
    const t = await freshTenantWithRates('FX Gain Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    const invoice = await issueUsd('1000.00', '2026-08-05', t);

    const receipt = await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-09-05',
        amount: '1000.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '1000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(receipt.realisedFx).toBe('50.0000');

    // AR back to zero, bank holds the full base value, the residue is in FX.
    expect(await accountBase('1100', t)).toBe('0.0000');
    expect(await accountBase('1000', t)).toBe('4750.0000');
    expect(await accountBase('6900', t)).toBe('-50.0000'); // credit = gain
  });

  it('posts a realised loss and still clears AR to zero', async () => {
    const t = await freshTenantWithRates('FX Loss Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    const invoice = await issueUsd('1000.00', '2026-08-05', t);

    const receipt = await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-10-05',
        amount: '1000.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '1000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(receipt.realisedFx).toBe('-150.0000');
    expect(await accountBase('1100', t)).toBe('0.0000');
    expect(await accountBase('6900', t)).toBe('150.0000'); // debit = loss
  });

  it('produces no FX line when the rate has not moved', async () => {
    const t = await freshTenantWithRates('FX Flat Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    const invoice = await issueUsd('1000.00', '2026-08-05', t);

    const receipt = await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-08-20', // still the 4.70 rate
        amount: '1000.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '1000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(receipt.realisedFx).toBeNull();
    expect(await accountBase('6900', t)).toBe('0.0000');
    expect(await accountBase('1100', t)).toBe('0.0000');
  });

  it('relieves each invoice at its own booked rate', async () => {
    const t = await freshTenantWithRates('FX Multi Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    const august = await issueUsd('1000.00', '2026-08-05', t);    // @ 4.70
    const september = await issueUsd('1000.00', '2026-09-05', t); // @ 4.75

    const receipt = await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-10-05', // @ 4.55
        amount: '2000.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [
          { invoiceId: august.id, amount: '1000.00' },
          { invoiceId: september.id, amount: '1000.00' },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    // Booked 4700 + 4750 = 9450; settled 2000 * 4.55 = 9100; loss 350.
    expect(receipt.realisedFx).toBe('-350.0000');
    expect(await accountBase('1100', t)).toBe('0.0000');
    expect(await accountBase('6900', t)).toBe('350.0000');
  });

  it('handles a partial settlement across two rate movements', async () => {
    const t = await freshTenantWithRates('FX Partial Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    const invoice = await issueUsd('1000.00', '2026-08-05', t); // AR base 4700

    await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-09-05', // 4.75 -> gain on 400
        amount: '400.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '400.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-10-05', // 4.55 -> loss on 600
        amount: '600.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '600.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    // 400 * (4.75-4.70) = +20; 600 * (4.55-4.70) = -90; net -70.
    expect(await accountBase('6900', t)).toBe('70.0000');
    expect(await accountBase('1100', t)).toBe('0.0000');
  });

  it('keeps the rollup in agreement with the raw journal throughout', async () => {
    const drift = await withTenant(sql, ctx(), (tx) => detectRollupDrift(tx, ctx()));
    expect(drift).toEqual([]);
  });
});

describe('invariant #6 survives multi-currency', () => {
  it('AR control equals the subledger valued at booked rates', async () => {
    const t = await seedTenant(admin, 'FX Subledger Sdn Bhd');
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000)
    `);
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd('1000.00', '2026-08-05', t);
    await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: t.customerId,
        issueDate: '2026-08-06',
        lines: [{
          description: 'Local work',
          quantity: '1',
          unitPrice: '2000.00',
          accountId: t.accounts['4000']!,
          taxCodeId: t.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    const subledger = await withTenant(sql, c, (tx) => outstandingReceivables(tx, c));
    const control = await accountBase('1100', t);

    // 1000 USD @ 4.70 = 4700, plus 2000 MYR = 6700.
    expect(Money.fromDecimal(subledger.total, 'MYR').toDecimalString()).toBe('6700.0000');
    expect(control).toBe('6700.0000');
  });

  it('breaks the subledger down by transaction currency', async () => {
    const t = await seedTenant(admin, 'FX Breakdown Sdn Bhd');
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000)
    `);
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd('1000.00', '2026-08-05', t);
    await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: t.customerId,
        issueDate: '2026-08-06',
        lines: [{
          description: 'Local',
          quantity: '1',
          unitPrice: '2000.00',
          accountId: t.accounts['4000']!,
          taxCodeId: t.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    const rows = await withTenant(sql, c, (tx) => outstandingByCurrency(tx, c));

    expect(rows).toEqual([
      { currency: 'MYR', total: '2000.0000', baseTotal: '2000.0000' },
      { currency: 'USD', total: '1000.0000', baseTotal: '4700.0000' },
    ]);
  });
});
