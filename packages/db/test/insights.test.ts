import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { enterBill } from '../src/bill.js';
import { createItem } from '../src/item.js';
import { recordCashSale } from '../src/pos.js';
import { countStock } from '../src/inventory.js';
import {
  collectRepairJob,
  createRepairJob,
  quoteRepairJob,
  transitionRepairJob,
} from '../src/repair.js';
import { itemMargins, repairProfitability, stockAgeing } from '../src/insights.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The owner-insight reports, against the real books.
 *
 * The property under test everywhere: these reports READ the same rows the
 * ledger was posted from, so their figures must reconcile with the postings
 * exactly — a margin report that disagrees with the P&L by a sen is worse
 * than none, because it teaches the owner to trust neither.
 */

let sql: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ssdId: string;
let dustId: string;

const ctxOf = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

beforeAll(async () => {
  const db = await createTestDatabase('insights');
  sql = db.sql;
  drop = db.drop;
  tenant = await seedTenant(db.admin, 'Insights Sdn Bhd');
  const ctx = ctxOf();

  // Two tracked items: one that sells, one that gathers dust.
  const ssd = await withTenant(sql, ctx, (tx) =>
    createItem(tx, ctx, {
      code: 'SSD-500',
      name: '500GB NVMe SSD',
      itemType: 'GOODS',
      isTracked: true,
      isSold: true,
      isPurchased: true,
      sale: { unitPrice: '220.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
      purchase: { accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! },
    }),
  );
  ssdId = ssd.id;

  const dust = await withTenant(sql, ctx, (tx) =>
    createItem(tx, ctx, {
      code: 'VGA-CABLE',
      name: 'VGA cable (nobody asks any more)',
      itemType: 'GOODS',
      isTracked: true,
      isSold: true,
      isPurchased: true,
      sale: { unitPrice: '15.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
      purchase: { accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! },
    }),
  );
  dustId = dust.id;

  // Stock in: ten SSDs at RM 150, five VGA cables at RM 4 — bought in
  // February (the seeded year opens 2026-01-01 with January LOCKED, and a
  // 2025 bill has no period at all; the ledger rightly refuses both).
  await withTenant(sql, ctx, (tx) =>
    enterBill(tx, ctx, {
      supplierId: tenant.supplierId,
      billNo: 'SUP-INS-1',
      billDate: '2026-02-01',
      lines: [
        { itemId: ssdId, quantity: '10', unitPrice: '150.00' },
        { itemId: dustId, quantity: '5', unitPrice: '4.00' },
      ],
      idempotencyKey: randomUUID(),
    }),
  );

  // Two SSDs sold at the till this month. The VGA cables never move.
  await withTenant(sql, ctx, (tx) =>
    recordCashSale(tx, ctx, {
      saleDate: '2026-08-05',
      lines: [{ itemId: ssdId, quantity: '2' }],
      method: 'CASH',
      depositAccountId: tenant.accounts['1000']!,
      tenderedAmount: '440.00',
      idempotencyKey: randomUUID(),
    }),
  );
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('stock ageing', () => {
  it('separates the seller from the shelf-warmer, dating each honestly', async () => {
    const ctx = ctxOf();
    const rows = await withTenant(sql, ctx, (tx) => stockAgeing(tx, ctx));

    const ssd = rows.find((r) => r.code === 'SSD-500')!;
    const dust = rows.find((r) => r.code === 'VGA-CABLE')!;

    // The SSD sold on 05/08/2026 — idle only since then.
    expect(ssd.lastSoldOn).toBe('2026-08-05');
    expect(ssd.bucket).toBe('FRESH');

    // The cable NEVER sold; its idleness runs from the delivery a year ago,
    // and a year of silence is DEAD stock.
    expect(dust.lastSoldOn).toBeNull();
    expect(dust.lastReceivedOn).toBe('2026-02-01');
    // Two hundred-odd days of silence by August: DEAD (>180).
    expect(dust.bucket).toBe('DEAD');
    expect(dust.daysIdle).toBeGreaterThan(180);

    // Oldest silence FIRST — the report leads with the problem.
    expect(rows[0]!.code).toBe('VGA-CABLE');
  });
});

describe('item margins', () => {
  it('reconciles exactly with what the sale posted — revenue AND WAC relief', async () => {
    const ctx = ctxOf();
    const rows = await withTenant(sql, ctx, (tx) =>
      itemMargins(tx, ctx, { from: '2026-08-01', to: '2026-08-31' }),
    );

    const ssd = rows.find((r) => r.code === 'SSD-500')!;
    expect(ssd.quantitySold).toBe('2.0000');
    expect(ssd.revenue).toBe('440.0000'); // 2 × 220, ex-tax
    expect(ssd.cost).toBe('300.0000'); // 2 × the RM 150 weighted average
    expect(ssd.margin).toBe('140.0000');
    expect(ssd.marginBp).toBe(3181); // 140/440 = 31.81…%, truncated

    // The COGS the report claims is EXACTLY what the movement rows carry.
    const [movementCost] = await withTenant(sql, ctx, (tx) =>
      tx<{ cost: string }[]>`
          SELECT COALESCE(-SUM(value_delta), 0)::text AS cost FROM stock_movement
           WHERE tenant_id = ${ctx.tenantId} AND item_id = ${ssdId}
             AND movement_type = 'ISSUE'
      `,
    );
    expect(ssd.cost).toBe(movementCost!.cost);
  });
});

describe('a physical count through the service', () => {
  it('writes the shrinkage off and the ageing report follows the book', async () => {
    const ctx = ctxOf();
    // The shelf says 4 cables, the book says 5: one walked.
    const counted = await withTenant(sql, ctx, (tx) =>
      countStock(tx, ctx, {
        itemId: dustId,
        countedQuantity: '4',
        countDate: '2026-08-05',
        reason: 'Monthly stock take — one missing',
        idempotencyKey: randomUUID(),
      }),
    );
    expect(counted).toBeDefined();

    const rows = await withTenant(sql, ctx, (tx) => stockAgeing(tx, ctx));
    expect(rows.find((r) => r.code === 'VGA-CABLE')!.quantityOnHand).toBe('4.0000');
  });
});

describe('repair profitability', () => {
  it('bills minus parts at true WAC, per job and in total', async () => {
    const ctx = ctxOf();
    const job = await withTenant(sql, ctx, (tx) =>
      createRepairJob(tx, ctx, {
        contactId: tenant.customerId,
        deviceDescription: 'Lenovo IdeaPad, black',
        reportedFault: 'No boot device found',
        receivedOn: '2026-08-04',
        idempotencyKey: randomUUID(),
      }),
    );
    await withTenant(sql, ctx, (tx) =>
      quoteRepairJob(tx, ctx, job.id, {
        diagnosis: 'Failed drive. Replace and reinstall.',
        lines: [
          { itemId: ssdId, description: 'Replace failed drive', quantity: '1', unitPrice: '220.00' },
          { description: 'Labour: fitting and reinstall', quantity: '1', unitPrice: '100.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
        ],
      }),
    );
    await withTenant(sql, ctx, (tx) =>
      transitionRepairJob(tx, ctx, job.id, { to: 'APPROVED', approvalNote: 'Approved in person' }),
    );
    await withTenant(sql, ctx, (tx) => transitionRepairJob(tx, ctx, job.id, { to: 'IN_PROGRESS' }));
    await withTenant(sql, ctx, (tx) => transitionRepairJob(tx, ctx, job.id, { to: 'READY' }));
    await withTenant(sql, ctx, (tx) =>
      collectRepairJob(tx, ctx, job.id, {
        collectDate: '2026-08-06',
        idempotencyKey: randomUUID(),
      }),
    );

    const profit = await withTenant(sql, ctx, (tx) =>
      repairProfitability(tx, ctx, { from: '2026-08-01', to: '2026-08-31' }),
    );
    expect(profit.jobs).toHaveLength(1);
    const done = profit.jobs[0]!;
    expect(done.revenue).toBe('320.0000'); // 220 part + 100 labour, ex-tax
    expect(done.partsCost).toBe('150.0000'); // one SSD at weighted average
    expect(done.margin).toBe('170.0000'); // what the bench actually kept
    expect(profit.totals.margin).toBe('170.0000');
  });
});
