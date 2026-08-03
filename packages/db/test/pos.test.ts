import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { enterBill } from '../src/bill.js';
import { createItem } from '../src/item.js';
import { dailyTakings, recordCashSale, walkInContact } from '../src/pos.js';
import { stockLevels } from '../src/inventory.js';
import { detectRollupDrift } from '../src/ledger.js';
import { accountingEquationAt } from '../src/report.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * A day at the till, driven the way the counter will drive it.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };
let mouseId: string;

beforeAll(async () => {
  const db = await createTestDatabase('pos');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'POS Computer Shop Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

  const mouse = await withTenant(sql, ctx, (tx) =>
    createItem(tx, ctx, {
      code: 'MOUSE-G1',
      name: 'Gaming mouse',
      itemType: 'GOODS',
      isTracked: true,
      isSold: true,
      isPurchased: true,
      sale: { unitPrice: '89.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
      purchase: { accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! },
    }),
  );
  mouseId = mouse.id;

  // Twenty mice at RM 45.
  await withTenant(sql, ctx, (tx) =>
    enterBill(tx, ctx, {
      supplierId: tenant.supplierId,
      billNo: 'SUP-POS-1',
      billDate: '2026-08-03',
      lines: [{ itemId: mouseId, quantity: '20', unitPrice: '45.00' }],
      idempotencyKey: randomUUID(),
    }),
  );
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('the walk-in customer', () => {
  it('is created once and reused forever', async () => {
    const first = await withTenant(sql, ctx, (tx) => walkInContact(tx, ctx));
    const second = await withTenant(sql, ctx, (tx) => walkInContact(tx, ctx));

    expect(first).toBe(second);

    const [count] = await withTenant(sql, ctx, (tx) =>
      tx<{ n: string }[]>`
          SELECT COUNT(*)::text AS n FROM contact
           WHERE tenant_id = ${ctx.tenantId} AND name = 'Walk-in customer'
      `,
    );
    expect(count!.n).toBe('1');
  });
});

describe('ringing a sale', () => {
  it('invoices, takes the money, relieves stock and posts COGS — one call', async () => {
    // Two mice, cash, RM 200 tendered.
    const sale = await withTenant(sql, ctx, (tx) =>
      recordCashSale(tx, ctx, {
        saleDate: '2026-08-05',
        lines: [{ itemId: mouseId, quantity: '2' }],
        method: 'CASH',
        depositAccountId: tenant.accounts['1000']!,
        tenderedAmount: '200.00',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(sale.total).toBe('178.0000'); // 2 × 89
    expect(sale.changeDue).toBe('22.0000');
    expect(sale.invoiceNo).toMatch(/^INV-/);
    expect(sale.receiptNo).toMatch(/^PAY-/);

    // The invoice is PAID the moment it exists — no AR left hanging.
    const [invoice] = await withTenant(sql, ctx, (tx) =>
      tx<{ status: string; amount_due: string }[]>`
          SELECT status, amount_due FROM invoice
           WHERE tenant_id = ${ctx.tenantId} AND id = ${sale.invoiceId}
      `,
    );
    expect(invoice!.status).toBe('PAID');
    expect(Number(invoice!.amount_due)).toBe(0);

    // And the shelf moved: 20 − 2, relieved at RM 45.
    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    const mouse = levels.find((l) => l.code === 'MOUSE-G1');
    expect(mouse?.quantityOnHand).toBe('18.0000');
    expect(mouse?.stockValue).toBe('810.0000');
  });

  it('reports no change when the tender is exact, and refuses one too small', async () => {
    const exact = await withTenant(sql, ctx, (tx) =>
      recordCashSale(tx, ctx, {
        saleDate: '2026-08-05',
        lines: [{ itemId: mouseId, quantity: '1' }],
        method: 'CASH',
        depositAccountId: tenant.accounts['1000']!,
        tenderedAmount: '89.00',
        idempotencyKey: randomUUID(),
      }),
    );
    expect(exact.changeDue).toBeNull();

    await expect(
      withTenant(sql, ctx, (tx) =>
        recordCashSale(tx, ctx, {
          saleDate: '2026-08-05',
          lines: [{ itemId: mouseId, quantity: '1' }],
          method: 'CASH',
          depositAccountId: tenant.accounts['1000']!,
          tenderedAmount: '50.00',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/Tendered 50\.0000/);

    // The refusal rolled the WHOLE sale back — no invoice, no stock movement.
    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    expect(levels.find((l) => l.code === 'MOUSE-G1')?.quantityOnHand).toBe('17.0000');
  });

  it('replays a double-tapped sale instead of ringing it twice', async () => {
    const key = randomUUID();
    const input = {
      saleDate: '2026-08-05',
      lines: [{ itemId: mouseId, quantity: '1' }],
      method: 'CASH' as const,
      depositAccountId: tenant.accounts['1000']!,
      idempotencyKey: key,
    };

    const first = await withTenant(sql, ctx, (tx) => recordCashSale(tx, ctx, input));
    const second = await withTenant(sql, ctx, (tx) => recordCashSale(tx, ctx, input));

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.invoiceId).toBe(first.invoiceId);
    expect(second.receiptId).toBe(first.receiptId);

    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    expect(levels.find((l) => l.code === 'MOUSE-G1')?.quantityOnHand).toBe('16.0000');
  });

  it('puts a named customer on the sale when one is given', async () => {
    const sale = await withTenant(sql, ctx, (tx) =>
      recordCashSale(tx, ctx, {
        saleDate: '2026-08-05',
        lines: [{ itemId: mouseId, quantity: '1' }],
        method: 'CARD',
        depositAccountId: tenant.accounts['1200']!, // card clears via undeposited funds
        contactId: tenant.customerId,
        idempotencyKey: randomUUID(),
      }),
    );

    const [invoice] = await withTenant(sql, ctx, (tx) =>
      tx<{ contact_id: string }[]>`
          SELECT contact_id FROM invoice
           WHERE tenant_id = ${ctx.tenantId} AND id = ${sale.invoiceId}
      `,
    );
    expect(invoice!.contact_id).toBe(tenant.customerId);
  });

  it('refuses to ring goods the shelf cannot cover, taking no money', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        recordCashSale(tx, ctx, {
          saleDate: '2026-08-05',
          lines: [{ itemId: mouseId, quantity: '99' }],
          method: 'CASH',
          depositAccountId: tenant.accounts['1000']!,
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/on hand/);

    const [payments] = await withTenant(sql, ctx, (tx) =>
      tx<{ n: string }[]>`
          SELECT COUNT(*)::text AS n FROM payment
           WHERE tenant_id = ${ctx.tenantId} AND direction = 'INBOUND'
      `,
    );
    // Only the four successful sales above took money.
    expect(payments!.n).toBe('4');
  });
});

describe('the Z-report', () => {
  it('reports the day by method, with cost and margin', async () => {
    const takings = await withTenant(sql, ctx, (tx) => dailyTakings(tx, ctx, '2026-08-05'));

    // Five mice sold across four sales: 2+1+1 cash, 1 card. 5 × 89 = 445.
    expect(takings.invoiceCount).toBe(4);
    expect(takings.invoicedTotal).toBe('445.0000');
    expect(takings.receiptsTotal).toBe('445.0000');

    const cash = takings.byMethod.find((m) => m.method === 'CASH');
    const card = takings.byMethod.find((m) => m.method === 'CARD');
    expect(cash?.total).toBe('356.0000'); // 4 mice over three sales
    expect(cash?.count).toBe(3);
    expect(card?.total).toBe('89.0000');

    // 5 × RM 45 cost = 225; margin 445 − 225 = 220.
    expect(takings.costOfGoodsSold).toBe('225.0000');
    expect(takings.grossProfit).toBe('220.0000');
  });

  it('reports an empty day as zeros, not an error', async () => {
    const takings = await withTenant(sql, ctx, (tx) => dailyTakings(tx, ctx, '2026-08-09'));

    expect(takings.byMethod).toEqual([]);
    expect(takings.receiptsTotal).toBe('0');
    expect(takings.invoiceCount).toBe(0);
    expect(takings.grossProfit).toBe('0.0000');
  });
});

describe('the books survive the till', () => {
  it('rollup and equation still hold after the whole day', async () => {
    const drift = await withTenant(sql, ctx, (tx) => detectRollupDrift(tx, ctx));
    expect(drift).toEqual([]);

    const equation = await withTenant(sql, ctx, (tx) =>
      accountingEquationAt(tx, ctx, '2026-08-31'),
    );
    expect(equation.balances).toBe(true);
  });
});
