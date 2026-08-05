import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { fraudWatch } from '../src/fraud-watch.js';
import { enterBill } from '../src/bill.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The watch against real books.
 *
 * The first test is the important one: an ordinary shop must produce NOTHING.
 * A detector that fires on honest trading gets switched off, and is then
 * absent for the case it existed for.
 */

let sql: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });
const window = { from: '2026-01-01', to: '2026-12-31' };

beforeAll(async () => {
  const db = await createTestDatabase('fraudwatch');
  sql = db.sql;
  drop = db.drop;
  tenant = await seedTenant(db.admin, 'Watched Sdn Bhd');
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('an ordinary shop', () => {
  it('produces no findings, and says what it checked anyway', async () => {
    const report = await withTenant(sql, ctx(), (tx) => fraudWatch(tx, ctx(), window));
    expect(report.findings).toHaveLength(0);
    // "We looked and found nothing" must be distinguishable from "nothing ran".
    expect(report.checksRun.length).toBeGreaterThan(0);
  });
});

describe('the same bill paid twice', () => {
  it('is found, named, and explained innocently first', async () => {
    for (const billNo of ['SUP-DUP-1', 'SUP-DUP-2']) {
      await withTenant(sql, ctx(), (tx) =>
        enterBill(tx, ctx(), {
          supplierId: tenant.supplierId,
          billNo,
          billDate: billNo.endsWith('1') ? '2026-08-01' : '2026-08-14',
          lines: [
            {
              description: 'Monthly stock order',
              quantity: '1',
              unitPrice: '4500.00',
              accountId: tenant.accounts['5000']!,
              taxCodeId: tenant.taxCodes['NONE']!,
            },
          ],
          idempotencyKey: randomUUID(),
        }),
      );
    }

    const report = await withTenant(sql, ctx(), (tx) => fraudWatch(tx, ctx(), window));
    const duplicate = report.findings.find((f) => f.code === 'DUPLICATE_PAYMENT');

    expect(duplicate).toBeDefined();
    expect(duplicate!.severity).toBe('CHECK');
    // The point of the whole module: it tells you it is probably fine.
    expect(duplicate!.innocentExplanation).toContain('Often genuine');

    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0]!.daysApart).toBe(13);
    expect(report.duplicates[0]!.documents).toEqual(['SUP-DUP-1', 'SUP-DUP-2']);
  });
});
