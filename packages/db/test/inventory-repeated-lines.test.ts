import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { enterBill } from '../src/bill.js';
import { issueInvoice } from '../src/invoice.js';
import { createItem } from '../src/item.js';
import { detectStockDrift, stockLevels } from '../src/inventory.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * ONE DOCUMENT, THE SAME ITEM ON TWO LINES.
 *
 * Two scans at the till, or one line at a discount and one at list price.
 * Nothing on the path merges them, and `issueTrackedStockForInvoice` saves its
 * pools only after the COGS entry is posted — so every line used to re-read
 * the same untouched `item_stock` row and the last save won. A shelf of ten
 * sold as 2 + 3 was left holding seven.
 *
 * The movements were right the whole time, which is what makes this a
 * `detectStockDrift` case rather than a lost-entry case, and why the drift
 * assertion below is the one that matters most.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };
let ssdId: string;

beforeAll(async () => {
  const db = await createTestDatabase('inventory_repeated');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Emil Computer Shop Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

  const ssd = await withTenant(sql, ctx, (tx) =>
    createItem(tx, ctx, {
      code: 'SSD-1TB',
      name: '1TB NVMe SSD',
      itemType: 'GOODS',
      isTracked: true,
      isSold: true,
      isPurchased: true,
      sale: {
        unitPrice: '400.00',
        accountId: tenant.accounts['4000']!,
        taxCodeId: tenant.taxCodes['NONE']!,
      },
      purchase: { accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! },
    }),
  );
  ssdId = ssd.id;

  await withTenant(sql, ctx, (tx) =>
    enterBill(tx, ctx, {
      supplierId: tenant.supplierId,
      billNo: 'SUP-0001',
      billDate: '2026-08-03',
      lines: [{ itemId: ssdId, quantity: '10', unitPrice: '280.00' }],
      idempotencyKey: randomUUID(),
    }),
  );
});

afterAll(async () => {
  await drop();
});

describe('the same tracked item on two lines of one invoice', () => {
  it('relieves both lines, and the cached pool still agrees with the movements', async () => {
    const invoice = await withTenant(sql, ctx, (tx) =>
      issueInvoice(tx, ctx, {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [
          { itemId: ssdId, quantity: '2' },
          { itemId: ssdId, quantity: '3' },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    // 5 × RM 280 relieved in one COGS entry for the document.
    const cogs = await withTenant(sql, ctx, (tx) =>
      tx<{ code: string; debit: string; credit: string }[]>`
          SELECT a.code, l.base_debit AS debit, l.base_credit AS credit
            FROM journal_line l
            JOIN account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
            JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
           WHERE l.tenant_id = ${ctx.tenantId}
             AND e.source_document_type = 'INVOICE_COGS'
             AND e.source_document_id = ${invoice.id}
           ORDER BY a.code
      `,
    );
    expect(cogs).toEqual([
      { code: '1300', debit: '0.0000', credit: '1400.0000' },
      { code: '5100', debit: '1400.0000', credit: '0.0000' },
    ]);

    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    const ssd = levels.find((l) => l.code === 'SSD-1TB');

    // 10 − 5 = 5 units, RM 2,800 − RM 1,400 = RM 1,400. Read the same pool
    // twice and this is 7 units at RM 1,960 — two units from nowhere.
    expect(ssd?.quantityOnHand).toBe('5.0000');
    expect(ssd?.stockValue).toBe('1400.0000');

    expect(await withTenant(sql, ctx, (tx) => detectStockDrift(tx, ctx))).toEqual([]);
  });

  it('refuses when the lines TOGETHER exceed the shelf, not just line by line', async () => {
    // Five left. 4 + 4 passes every per-line check and still cannot be sold.
    await expect(
      withTenant(sql, ctx, (tx) =>
        issueInvoice(tx, ctx, {
          contactId: tenant.customerId,
          issueDate: '2026-08-06',
          lines: [
            { itemId: ssdId, quantity: '4' },
            { itemId: ssdId, quantity: '4' },
          ],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/on hand/);

    // The whole invoice rolled back — no partial relief, no orphaned COGS.
    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    expect(levels.find((l) => l.code === 'SSD-1TB')?.quantityOnHand).toBe('5.0000');
  });
});
