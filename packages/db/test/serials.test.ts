import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { enterBill } from '../src/bill.js';
import { issueInvoice } from '../src/invoice.js';
import { createItem, updateItem } from '../src/item.js';
import {
  countStock,
  detectSerialDrift,
  detectStockDrift,
  findSerial,
  stockUnits,
} from '../src/inventory.js';
import { recordCashSale } from '../src/pos.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * Serial tracking, driven as the shop drives it: laptops arrive with serials,
 * leave with serials, and the warranty question gets answered by serial alone.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };
let laptopId: string;

beforeAll(async () => {
  const db = await createTestDatabase('serials');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Serial Shop Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

  const laptop = await withTenant(sql, ctx, (tx) =>
    createItem(tx, ctx, {
      code: 'NB-X1',
      name: 'ThinkPad X1',
      itemType: 'GOODS',
      isTracked: true,
      isSerialised: true,
      isSold: true,
      isPurchased: true,
      sale: { unitPrice: '5200.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
      purchase: { accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! },
    }),
  );
  laptopId = laptop.id;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('receiving serialised stock', () => {
  it('refuses a bill line that does not name its serials', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        enterBill(tx, ctx, {
          supplierId: tenant.supplierId,
          billNo: 'LEN-001',
          billDate: '2026-08-03',
          lines: [{ itemId: laptopId, quantity: '3', unitPrice: '4000.00' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/must be identified by its serial number/);
  });

  it('receives three laptops with their serials', async () => {
    const bill = await withTenant(sql, ctx, (tx) =>
      enterBill(tx, ctx, {
        supplierId: tenant.supplierId,
        billNo: 'LEN-002',
        billDate: '2026-08-03',
        lines: [
          {
            itemId: laptopId,
            quantity: '3',
            unitPrice: '4000.00',
            serialNumbers: ['PF-3XK01', 'PF-3XK02', 'pf-3xk03'],
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );
    expect(bill.journalEntryId).toBeTruthy();

    const units = await withTenant(sql, ctx, (tx) => stockUnits(tx, ctx, laptopId, 'IN_STOCK'));
    // Normalised on the way in: the lowercase scan is the same machine.
    expect(units.map((u) => u.serialNo).sort()).toEqual(['PF-3XK01', 'PF-3XK02', 'PF-3XK03']);
    expect(units[0]!.receivedFrom.type).toBe('BILL');
  });

  it('refuses a serial count that does not match the quantity', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        enterBill(tx, ctx, {
          supplierId: tenant.supplierId,
          billNo: 'LEN-003',
          billDate: '2026-08-03',
          lines: [
            { itemId: laptopId, quantity: '2', unitPrice: '4000.00', serialNumbers: ['ONLY-1'] },
          ],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/1 serial\(s\) for a quantity of 2/);
  });

  it('refuses re-receiving a serial that is already on the shelf', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        enterBill(tx, ctx, {
          supplierId: tenant.supplierId,
          billNo: 'LEN-004',
          billDate: '2026-08-04',
          lines: [
            {
              itemId: laptopId,
              quantity: '1',
              unitPrice: '4000.00',
              serialNumbers: ['PF-3XK01'],
            },
          ],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/already in stock/);
  });
});

describe('selling serialised stock', () => {
  it('refuses a sale that does not say which unit', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        issueInvoice(tx, ctx, {
          contactId: tenant.customerId,
          issueDate: '2026-08-05',
          lines: [{ itemId: laptopId, quantity: '1' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/serial number/);
  });

  it('sells a named unit through the POS and the unit knows its invoice', async () => {
    const sale = await withTenant(sql, ctx, (tx) =>
      recordCashSale(tx, ctx, {
        saleDate: '2026-08-05',
        lines: [{ itemId: laptopId, quantity: '1', serialNumbers: ['PF-3XK02'] }],
        method: 'CARD',
        depositAccountId: tenant.accounts['1200']!,
        idempotencyKey: randomUUID(),
      }),
    );
    expect(sale.total).toBe('5200.0000');

    const matches = await withTenant(sql, ctx, (tx) => findSerial(tx, ctx, 'pf-3xk02'));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.status).toBe('SOLD');
    expect(matches[0]!.itemCode).toBe('NB-X1');
    expect(matches[0]!.issuedTo?.type).toBe('INVOICE');
    expect(matches[0]!.issuedTo?.documentId).toBe(sale.invoiceId);
  });

  it('refuses to sell a unit that is already sold, by name', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        issueInvoice(tx, ctx, {
          contactId: tenant.customerId,
          issueDate: '2026-08-05',
          lines: [{ itemId: laptopId, quantity: '1', serialNumbers: ['PF-3XK02'] }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/PF-3XK02 is SOLD/);
  });

  it('refuses a serial that has never been received', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        issueInvoice(tx, ctx, {
          contactId: tenant.customerId,
          issueDate: '2026-08-05',
          lines: [{ itemId: laptopId, quantity: '1', serialNumbers: ['GHOST-99'] }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/GHOST-99 has never been received/);
  });
});

describe('counting serialised stock', () => {
  it('writes off a named unit, and the unit record says so', async () => {
    // Two on the shelf (01, 03); the count finds only one — 03 is missing.
    const result = await withTenant(sql, ctx, (tx) =>
      countStock(tx, ctx, {
        itemId: laptopId,
        countedQuantity: '1',
        countDate: '2026-08-06',
        reason: 'Display unit missing after weekend',
        serialNumbers: ['PF-3XK03'],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result.quantityDelta).toBe('-1.0000');

    const matches = await withTenant(sql, ctx, (tx) => findSerial(tx, ctx, 'PF-3XK03'));
    expect(matches[0]!.status).toBe('WRITTEN_OFF');
    expect(matches[0]!.issuedTo?.type).toBe('STOCK_COUNT');
  });

  it('refuses a count that moves quantity without naming units', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        countStock(tx, ctx, {
          itemId: laptopId,
          countedQuantity: '0',
          countDate: '2026-08-06',
          reason: 'unnamed shrink',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/must be identified by its serial number/);
  });

  it('resurrects a written-off unit that turns up again', async () => {
    // The missing laptop was in the storeroom. Counting it back in brings the
    // SAME unit back to IN_STOCK — one machine with a longer story, not two.
    const result = await withTenant(sql, ctx, (tx) =>
      countStock(tx, ctx, {
        itemId: laptopId,
        countedQuantity: '2',
        countDate: '2026-08-07',
        unitCost: '4000.00',
        reason: 'Found in storeroom during the recount',
        serialNumbers: ['PF-3XK03'],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result.quantityDelta).toBe('1.0000');

    const matches = await withTenant(sql, ctx, (tx) => findSerial(tx, ctx, 'PF-3XK03'));
    expect(matches).toHaveLength(1); // still ONE unit record
    expect(matches[0]!.status).toBe('IN_STOCK');
  });
});

describe('the serial ledger agrees with the pool', () => {
  it('unit counts match quantities, and the pool drift is empty', async () => {
    const serialDrift = await withTenant(sql, ctx, (tx) => detectSerialDrift(tx, ctx));
    expect(serialDrift).toEqual([]);

    const drift = await withTenant(sql, ctx, (tx) => detectStockDrift(tx, ctx));
    expect(drift).toEqual([]);
  });

  it('an unknown serial answers an empty list, not an error', async () => {
    const matches = await withTenant(sql, ctx, (tx) => findSerial(tx, ctx, 'NEVER-SEEN'));
    expect(matches).toEqual([]);
  });
});

describe('flag discipline', () => {
  it('refuses serialising an item that is not tracked', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        createItem(tx, ctx, {
          code: 'BAD-SER',
          name: 'Serialised but untracked',
          itemType: 'GOODS',
          isTracked: false,
          isSerialised: true,
          isSold: true,
          sale: { unitPrice: '10.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
        }),
      ),
    ).rejects.toThrow(/must be stock-tracked/);
  });

  it('refuses toggling serials while stock is on hand', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        updateItem(tx, ctx, laptopId, {
          code: 'NB-X1',
          name: 'ThinkPad X1',
          itemType: 'GOODS',
          isTracked: true,
          isSerialised: false,
          isSold: true,
          isPurchased: true,
          sale: { unitPrice: '5200.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
          purchase: { accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! },
        }),
      ),
    ).rejects.toThrow(/empty shelf/);
  });
});
