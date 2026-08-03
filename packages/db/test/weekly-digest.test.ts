import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { issueInvoice } from '../src/invoice.js';
import { enterBill } from '../src/bill.js';
import { listWeeklyDigests, runWeeklyDigest } from '../src/weekly-digest-data.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The digest against real books: five weeks of trading, then the Monday
 * question. The fixture's last week halves its sales, so the digest must both
 * notice (REVENUE_DOWN) and remember — the second run stores nothing, and the
 * stored report never changes.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };

/** Mondays: four steady weeks, then the bad one (2026-07-20). */
const STEADY_MONDAYS = ['2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13'];
const BAD_MONDAY = '2026-07-20';

async function sellOn(date: string, amount: string) {
  await withTenant(sql, ctx, (tx) =>
    issueInvoice(tx, ctx, {
      contactId: tenant.customerId,
      issueDate: date,
      dueDate: date,
      lines: [{ description: 'Service', quantity: '1', unitPrice: amount,
                accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! }],
      idempotencyKey: randomUUID(),
    }),
  );
}

beforeAll(async () => {
  const db = await createTestDatabase('weekly_digest');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Digest Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

  // Four steady weeks: RM 3,000 × 4 days = RM 12,000 each.
  for (const monday of STEADY_MONDAYS) {
    for (const offset of [0, 1, 2, 3]) {
      await sellOn(addDays(monday, offset), '3000.00');
    }
  }

  // The bad week: RM 3,000 × 2 days = RM 6,000 — half the average.
  await sellOn(addDays(BAD_MONDAY, 0), '3000.00');
  await sellOn(addDays(BAD_MONDAY, 1), '3000.00');

  // Ordinary bill inside the bad week; nowhere near the spike threshold.
  await withTenant(sql, ctx, (tx) =>
    enterBill(tx, ctx, {
      supplierId: tenant.supplierId,
      billNo: 'SUP-WD-1',
      billDate: addDays(BAD_MONDAY, 2),
      dueDate: addDays(BAD_MONDAY, 16),
      lines: [{ description: 'Consumables', quantity: '1', unitPrice: '500.00',
                accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! }],
      idempotencyKey: randomUUID(),
    }),
  );
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('runWeeklyDigest', () => {
  it('stores the last completed week once, flagging the halved sales', async () => {
    // Monday 27/07: the completed week is 20–26/07, the bad one.
    const run = await withTenant(sql, ctx, (tx) => runWeeklyDigest(tx, ctx, '2026-07-27'));

    expect(run).toMatchObject({ weekStart: '2026-07-20', stored: true });
    expect(run.warnings).toBeGreaterThanOrEqual(1);

    const [stored] = await withTenant(sql, ctx, (tx) => listWeeklyDigests(tx, ctx));
    expect(stored!.weekStart).toBe('2026-07-20');
    expect(stored!.digest.week.salesNet).toBe('6000.0000');
    expect(stored!.digest.comparedAgainstWeeks).toBe(4);

    const codes = stored!.digest.flags.map((f) => f.code);
    expect(codes).toContain('REVENUE_DOWN');
    // Two selling days against four in every prior week.
    expect(codes).toContain('QUIET_WEEK');
    // Steady expenses must NOT be flagged — a digest that cries weekly dies.
    expect(codes).not.toContain('EXPENSE_SPIKE');
  });

  it('is a no-op the next morning — one digest per week, forever', async () => {
    const again = await withTenant(sql, ctx, (tx) => runWeeklyDigest(tx, ctx, '2026-07-28'));
    expect(again).toMatchObject({ weekStart: '2026-07-20', stored: false });

    const rows = await withTenant(sql, ctx, (tx) => listWeeklyDigests(tx, ctx));
    expect(rows).toHaveLength(1);
  });

  it('catches up on a different week when the calendar moves on', async () => {
    // A month later: the completed week is 17–23/08, traded RM 0. With the
    // bad week now inside the baseline, zero sales still reads REVENUE_DOWN.
    const later = await withTenant(sql, ctx, (tx) => runWeeklyDigest(tx, ctx, '2026-08-24'));
    expect(later).toMatchObject({ weekStart: '2026-08-17', stored: true });

    const rows = await withTenant(sql, ctx, (tx) => listWeeklyDigests(tx, ctx));
    expect(rows.map((r) => r.weekStart)).toEqual(['2026-08-17', '2026-07-20']);
  });
});

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
