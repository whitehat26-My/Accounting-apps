import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { enterBill } from '../src/bill.js';
import { issueInvoice } from '../src/invoice.js';
import { createItem } from '../src/item.js';
import {
  countStock,
  detectStockDrift,
  stockLevels,
  stockMovements,
} from '../src/inventory.js';
import { detectRollupDrift } from '../src/ledger.js';
import { accountingEquationAt } from '../src/report.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * Perpetual inventory, driven the way the shop will drive it:
 * buy stock on a bill, sell it on an invoice, count the shelf.
 *
 * The scenario runs in ORDER — each block builds on the stock state the
 * previous one left, the same way a trading week does.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };
let ssdId: string;
let labourId: string;

beforeAll(async () => {
  const db = await createTestDatabase('inventory');
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
      sale: { unitPrice: '400.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
      purchase: { accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! },
    }),
  );
  ssdId = ssd.id;

  // A service item on the same documents, proving tracking is opt-in.
  const labour = await withTenant(sql, ctx, (tx) =>
    createItem(tx, ctx, {
      code: 'LABOUR',
      name: 'Installation labour',
      itemType: 'SERVICE',
      isSold: true,
      sale: { unitPrice: '50.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
    }),
  );
  labourId = labour.id;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('buying stock', () => {
  it('routes a tracked purchase to the INVENTORY asset, not an expense', async () => {
    // Ten SSDs at RM 280.
    const bill = await withTenant(sql, ctx, (tx) =>
      enterBill(tx, ctx, {
        supplierId: tenant.supplierId,
        billNo: 'SUP-0001',
        billDate: '2026-08-03',
        lines: [{ itemId: ssdId, quantity: '10', unitPrice: '280.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const lines = await withTenant(sql, ctx, (tx) =>
      tx<{ code: string; debit: string; credit: string }[]>`
          SELECT a.code, l.base_debit AS debit, l.base_credit AS credit
            FROM journal_line l
            JOIN account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
           WHERE l.tenant_id = ${ctx.tenantId} AND l.journal_entry_id = ${bill.journalEntryId}
           ORDER BY a.code
      `,
    );

    // Dr Inventory 2,800 / Cr AP 2,800 — nothing touches an expense. The item
    // carries a purchase account (5000) and the override routed past it.
    expect(lines).toEqual([
      { code: '1300', debit: '2800.0000', credit: '0.0000' },
      { code: '2000', debit: '0.0000', credit: '2800.0000' },
    ]);
  });

  it('shows the shelf: 10 on hand at RM 280 average', async () => {
    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    const ssd = levels.find((l) => l.code === 'SSD-1TB');

    expect(ssd?.quantityOnHand).toBe('10.0000');
    expect(ssd?.stockValue).toBe('2800.0000');
    expect(ssd?.weightedAverageCost).toBe('280.0000');
  });

  it('averages a second delivery at a different price', async () => {
    // Ten more at RM 265 — the market moved.
    await withTenant(sql, ctx, (tx) =>
      enterBill(tx, ctx, {
        supplierId: tenant.supplierId,
        billNo: 'SUP-0002',
        billDate: '2026-08-04',
        lines: [{ itemId: ssdId, quantity: '10', unitPrice: '265.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    const ssd = levels.find((l) => l.code === 'SSD-1TB');

    expect(ssd?.quantityOnHand).toBe('20.0000');
    expect(ssd?.stockValue).toBe('5450.0000');
    expect(ssd?.weightedAverageCost).toBe('272.5000');
  });
});

describe('selling stock', () => {
  it('posts revenue AND cost in one transaction, at the weighted average', async () => {
    // Three SSDs at RM 400 plus installation labour.
    const invoice = await withTenant(sql, ctx, (tx) =>
      issueInvoice(tx, ctx, {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [
          { itemId: ssdId, quantity: '3' },
          { itemId: labourId, quantity: '1' },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(invoice.subtotal).toBe('1250.0000'); // 3 × 400 + 50

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

    // 3 × RM 272.50 = RM 817.50. The labour line moved no stock.
    expect(cogs).toEqual([
      { code: '1300', debit: '0.0000', credit: '817.5000' },
      { code: '5100', debit: '817.5000', credit: '0.0000' },
    ]);

    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    const ssd = levels.find((l) => l.code === 'SSD-1TB');
    expect(ssd?.quantityOnHand).toBe('17.0000');
    expect(ssd?.stockValue).toBe('4632.5000');
  });

  it('refuses to sell more than the shelf holds, and the whole invoice rolls back', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        issueInvoice(tx, ctx, {
          contactId: tenant.customerId,
          issueDate: '2026-08-05',
          lines: [{ itemId: ssdId, quantity: '100' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/17\.0000 on hand/);

    // Nothing half-happened: no orphan invoice, no revenue without stock.
    const [orphans] = await withTenant(sql, ctx, (tx) =>
      tx<{ n: string }[]>`
          SELECT COUNT(*)::text AS n FROM invoice
           WHERE tenant_id = ${ctx.tenantId} AND status <> 'ISSUED'
      `,
    );
    expect(orphans!.n).toBe('0');

    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    expect(levels.find((l) => l.code === 'SSD-1TB')?.quantityOnHand).toBe('17.0000');
  });

  it('replays an invoice retry without issuing stock twice', async () => {
    const key = randomUUID();
    const input = {
      contactId: tenant.customerId,
      issueDate: '2026-08-06',
      lines: [{ itemId: ssdId, quantity: '2' }],
      idempotencyKey: key,
    };

    const first = await withTenant(sql, ctx, (tx) => issueInvoice(tx, ctx, input));
    const second = await withTenant(sql, ctx, (tx) => issueInvoice(tx, ctx, input));

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);

    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    expect(levels.find((l) => l.code === 'SSD-1TB')?.quantityOnHand).toBe('15.0000');
  });
});

describe('counting the shelf', () => {
  it('writes a shortfall down at the average and posts it to shrinkage', async () => {
    // The shelf says 14; the system says 15. One SSD walked.
    const result = await withTenant(sql, ctx, (tx) =>
      countStock(tx, ctx, {
        itemId: ssdId,
        countedQuantity: '14',
        countDate: '2026-08-07',
        reason: 'Monthly count — one unit missing',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result.quantityDelta).toBe('-1.0000');
    expect(result.quantityOnHand).toBe('14.0000');
    expect(result.journalEntryId).not.toBeNull();

    const lines = await withTenant(sql, ctx, (tx) =>
      tx<{ code: string; debit: string; credit: string }[]>`
          SELECT a.code, l.base_debit AS debit, l.base_credit AS credit
            FROM journal_line l
            JOIN account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
           WHERE l.tenant_id = ${ctx.tenantId} AND l.journal_entry_id = ${result.journalEntryId}
           ORDER BY a.code
      `,
    );

    // Dr Shrinkage / Cr Inventory at the pool average — its own account, so
    // the owner sees "stock disappeared" as a line, not as quietly worse COGS.
    expect(lines[0]!.code).toBe('1300');
    expect(lines[1]!.code).toBe('5900');
    expect(lines[1]!.debit).toBe(lines[0]!.credit);
  });

  it('records a STOCK_COUNTED event carrying the reason', async () => {
    const events = await withTenant(sql, ctx, (tx) =>
      tx<{ detail: Record<string, unknown> }[]>`
          SELECT detail FROM financial_event_log
           WHERE tenant_id = ${ctx.tenantId} AND event_type = 'STOCK_COUNTED'
      `,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.detail['reason']).toBe('Monthly count — one unit missing');
  });

  it('replays a retried count instead of moving stock twice', async () => {
    const key = randomUUID();
    const input = {
      itemId: ssdId,
      countedQuantity: '13',
      countDate: '2026-08-07',
      reason: 'recount after the first went missing too',
      idempotencyKey: key,
    };

    const first = await withTenant(sql, ctx, (tx) => countStock(tx, ctx, input));
    const second = await withTenant(sql, ctx, (tx) => countStock(tx, ctx, input));

    expect(first.quantityDelta).toBe('-1.0000');
    expect(second.quantityDelta).toBe('-1.0000');
    expect(second.quantityOnHand).toBe('13.0000');

    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    expect(levels.find((l) => l.code === 'SSD-1TB')?.quantityOnHand).toBe('13.0000');
  });

  it('brings in opening stock at a stated cost, offset to a chosen account', async () => {
    const keyboard = await withTenant(sql, ctx, (tx) =>
      createItem(tx, ctx, {
        code: 'KB-MECH',
        name: 'Mechanical keyboard',
        itemType: 'GOODS',
        isTracked: true,
        isSold: true,
        sale: { unitPrice: '250.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
      }),
    );

    const result = await withTenant(sql, ctx, (tx) =>
      countStock(tx, ctx, {
        itemId: keyboard.id,
        countedQuantity: '5',
        countDate: '2026-08-07',
        unitCost: '150.00',
        offsetAccountId: tenant.accounts['3000']!,
        reason: 'Opening stock at migration from the old system',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result.stockValue).toBe('750.0000');
    expect(result.journalEntryId).not.toBeNull();
  });
});

describe('everything still reconciles', () => {
  it('movement log and stock cache agree', async () => {
    const drift = await withTenant(sql, ctx, (tx) => detectStockDrift(tx, ctx));
    expect(drift).toEqual([]);
  });

  it('journal and rollup agree', async () => {
    const drift = await withTenant(sql, ctx, (tx) => detectRollupDrift(tx, ctx));
    expect(drift).toEqual([]);
  });

  it('the accounting equation still balances', async () => {
    const equation = await withTenant(sql, ctx, (tx) =>
      accountingEquationAt(tx, ctx, '2026-08-31'),
    );
    expect(equation.balances).toBe(true);
  });

  it('the inventory GL balance IS the stock valuation', async () => {
    /*
     * The invariant the whole slice exists to hold: the 1300 account on the
     * balance sheet and SUM(item_stock.stock_value) are two views of one
     * number. If they ever part ways, either a movement posted no journal or
     * a journal moved no stock.
     */
    const [gl] = await withTenant(sql, ctx, (tx) =>
      tx<{ balance: string }[]>`
          SELECT COALESCE(SUM(l.base_debit - l.base_credit), 0)::text AS balance
            FROM journal_line l
            JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
           WHERE l.tenant_id = ${ctx.tenantId}
             AND l.account_id = ${tenant.accounts['1300']!}
             AND e.status IN ('POSTED', 'REVERSED')
      `,
    );

    const [shelf] = await withTenant(sql, ctx, (tx) =>
      tx<{ total: string }[]>`
          SELECT COALESCE(SUM(stock_value), 0)::text AS total FROM item_stock
           WHERE tenant_id = ${ctx.tenantId}
      `,
    );

    expect(Number(gl!.balance)).toBe(Number(shelf!.total));
  });

  it('every movement is traceable to a document', async () => {
    const movements = await withTenant(sql, ctx, (tx) => stockMovements(tx, ctx, ssdId));

    expect(movements.length).toBeGreaterThan(0);
    for (const m of movements) {
      expect(['BILL', 'INVOICE', 'STOCK_COUNT']).toContain(m.sourceDocumentType);
    }
  });
});

describe('cross-tenant isolation', () => {
  it('another tenant’s item answers not-found on a count', async () => {
    const other = await seedTenant(admin, 'Rival Shop Sdn Bhd');
    const theirItem = await withTenant(sql, { tenantId: other.tenantId, userId: other.userId }, (tx) =>
      createItem(tx, { tenantId: other.tenantId, userId: other.userId }, {
        code: 'THEIRS',
        name: 'Their item',
        itemType: 'GOODS',
        isTracked: true,
        isSold: true,
        sale: { unitPrice: '10.00', accountId: other.accounts['4000']!, taxCodeId: other.taxCodes['NONE']! },
      }),
    );

    // Rule 9: indistinguishable from an item that does not exist.
    await expect(
      withTenant(sql, ctx, (tx) =>
        countStock(tx, ctx, {
          itemId: theirItem.id,
          countedQuantity: '99',
          countDate: '2026-08-07',
          reason: 'hostile count',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/not found/i);
  });
});
