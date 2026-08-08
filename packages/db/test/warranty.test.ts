import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { createItem } from '../src/item.js';
import { enterBill } from '../src/bill.js';
import { issueInvoice } from '../src/invoice.js';
import { createRepairJob } from '../src/repair.js';
import { countStock } from '../src/inventory.js';
import { warrantyForSerial, warrantyRegister } from '../src/warranty.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The promises register against the real schema.
 *
 * The test that matters is that NOTHING has to be maintained: selling a unit
 * creates the promise, taking it back removes it, and no code path in between
 * writes a warranty row. A stored-promise design passes the first assertion
 * and fails the second, which is exactly why this one derives.
 */

let sql: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };
let laptopId: string;
let cableId: string;

beforeAll(async () => {
  const db = await createTestDatabase('warranty');
  sql = db.sql;
  drop = db.drop;
  tenant = await seedTenant(db.admin, 'Promises Sdn Bhd');
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
      warrantyMonths: 12,
      sale: {
        unitPrice: '5200.00',
        accountId: tenant.accounts['4000']!,
        taxCodeId: tenant.taxCodes['NONE']!,
      },
      purchase: { accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! },
    }),
  );
  laptopId = laptop.id;
  expect(laptop.warrantyMonths).toBe(12);

  // Serialised but promised nothing — proves the register filters on the
  // promise, not merely on serialisation.
  const cable = await withTenant(sql, ctx, (tx) =>
    createItem(tx, ctx, {
      code: 'CBL-USB',
      name: 'USB-C cable',
      itemType: 'GOODS',
      isTracked: true,
      isSerialised: true,
      isSold: true,
      isPurchased: true,
      sale: {
        unitPrice: '60.00',
        accountId: tenant.accounts['4000']!,
        taxCodeId: tenant.taxCodes['NONE']!,
      },
      purchase: { accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! },
    }),
  );
  cableId = cable.id;

  await withTenant(sql, ctx, (tx) =>
    enterBill(tx, ctx, {
      supplierId: tenant.supplierId,
      billNo: 'LEN-100',
      billDate: '2026-02-02',
      lines: [
        {
          itemId: laptopId,
          quantity: '3',
          unitPrice: '4000.00',
          serialNumbers: ['PF-AAA01', 'PF-AAA02', 'PF-AAA03'],
        },
        { itemId: cableId, quantity: '1', unitPrice: '20.00', serialNumbers: ['CBL-001'] },
      ],
      idempotencyKey: randomUUID(),
    }),
  );
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const register = (today: string) =>
  withTenant(sql, ctx, (tx) => warrantyRegister(tx, ctx, { today }));

describe('a serialised sale makes a promise, with nothing written to make it', () => {
  it('derives the window from the sale movement and the item', async () => {
    await withTenant(sql, ctx, (tx) =>
      issueInvoice(tx, ctx, {
        contactId: tenant.customerId,
        issueDate: '2026-02-10',
        lines: [{ itemId: laptopId, quantity: '1', serialNumbers: ['PF-AAA01'] }],
        idempotencyKey: randomUUID(),
      }),
    );

    const result = await register('2026-06-01');
    const promise = result.promises.find((p) => p.serialNo === 'PF-AAA01');

    expect(promise).toBeDefined();
    expect(promise!.soldOn).toBe('2026-02-10');
    expect(promise!.expiresOn).toBe('2027-02-10');
    expect(promise!.status).toBe('ACTIVE');
    expect(promise!.warrantyMonths).toBe(12);
    // Who to answer to when they come back — the half that makes it usable.
    expect(promise!.customerName).toBeTruthy();
    expect(promise!.invoiceNo).toBeTruthy();
    expect(promise!.claims).toBe(0);
  });

  it('leaves an item with no promise out entirely', async () => {
    await withTenant(sql, ctx, (tx) =>
      issueInvoice(tx, ctx, {
        contactId: tenant.customerId,
        issueDate: '2026-02-11',
        lines: [{ itemId: cableId, quantity: '1', serialNumbers: ['CBL-001'] }],
        idempotencyKey: randomUUID(),
      }),
    );

    const result = await register('2026-06-01');
    // Sold, serialised, and correctly absent: warranty_months is 0.
    expect(result.promises.map((p) => p.serialNo)).not.toContain('CBL-001');
  });

  it('says nothing about a unit still on the shelf', async () => {
    const result = await register('2026-06-01');
    expect(result.promises.map((p) => p.serialNo)).not.toContain('PF-AAA02');
  });
});

describe('the promise moves with time on its own', () => {
  it('reads ACTIVE, then EXPIRING_SOON, then EXPIRED from the same row', async () => {
    // No job runs, no status column is updated — the same derived row answers
    // differently because the question moved, which is what "derived" buys.
    const of = async (today: string) =>
      (await register(today)).promises.find((p) => p.serialNo === 'PF-AAA01')!.status;

    expect(await of('2026-06-01')).toBe('ACTIVE');
    expect(await of('2027-01-20')).toBe('EXPIRING_SOON');
    expect(await of('2027-03-01')).toBe('EXPIRED');
  });

  it('counts the exposure the owner actually asks about', async () => {
    const soon = await register('2027-01-20');
    expect(soon.expiringSoon).toBe(1);
    expect(soon.active).toBe(1);
    expect(soon.expiringSoonDays).toBe(30);

    const later = await register('2027-03-01');
    expect(later.active).toBe(0);
  });
});

describe('a repair against a sold serial', () => {
  it('counts as a claim even when the technician typed it in lower case', async () => {
    await withTenant(sql, ctx, (tx) =>
      createRepairJob(tx, ctx, {
        contactId: tenant.customerId,
        deviceDescription: 'ThinkPad X1, screen flickering',
        // Free text on the repair side (0029), so the join normalises. Typed
        // as a human types: lowercase, with a stray space.
        deviceSerial: ' pf-aaa01 ',
        reportedFault: 'Screen flickers after ten minutes',
        receivedOn: '2026-07-01',
        idempotencyKey: randomUUID(),
      }),
    );

    const result = await register('2026-08-01');
    expect(result.promises.find((p) => p.serialNo === 'PF-AAA01')!.claims).toBe(1);
  });
});

describe('the counter question', () => {
  it('answers for a serial by name', async () => {
    const answer = await withTenant(sql, ctx, (tx) =>
      warrantyForSerial(tx, ctx, 'pf-aaa01', { today: '2026-06-01' }),
    );
    expect(answer.serialNo).toBe('PF-AAA01');
    expect(answer.promise?.expiresOn).toBe('2027-02-10');
  });

  it('says "no record" rather than 404 for a serial this shop never sold', async () => {
    // A real answer to a real question. A 404 would make the person at the
    // counter think the system was broken rather than that the shop has no
    // record of selling it.
    const answer = await withTenant(sql, ctx, (tx) =>
      warrantyForSerial(tx, ctx, 'SOMEONE-ELSES-99', { today: '2026-06-01' }),
    );
    expect(answer.promise).toBeNull();
  });
});

describe('a unit that comes back', () => {
  it('takes its promise with it, with no compensating write', async () => {
    // Sell the second laptop, then take it back: the customer returns it and
    // it is counted back onto the shelf, which flips the unit out of SOLD.
    // The promise disappears because there was never a row asserting it. A
    // stored design needs a delete here, and leaks a promise the first time
    // somebody forgets one — which is the whole argument for deriving.
    await withTenant(sql, ctx, (tx) =>
      issueInvoice(tx, ctx, {
        contactId: tenant.customerId,
        issueDate: '2026-03-01',
        lines: [{ itemId: laptopId, quantity: '1', serialNumbers: ['PF-AAA02'] }],
        idempotencyKey: randomUUID(),
      }),
    );
    expect((await register('2026-06-01')).promises.map((p) => p.serialNo)).toContain('PF-AAA02');

    // One on the shelf (AAA03); the count finds two, because AAA02 walked
    // back in. The serial list names the units that MOVED, not the whole
    // shelf, so it is the returned one alone — `bringSerialsIn` resurrects it.
    await withTenant(sql, ctx, (tx) =>
      countStock(tx, ctx, {
        itemId: laptopId,
        countedQuantity: '2',
        countDate: '2026-06-02',
        reason: 'Customer returned PF-AAA02 within the change-of-mind window',
        serialNumbers: ['PF-AAA02'],
        idempotencyKey: randomUUID(),
      }),
    );

    const after = await register('2026-06-03');
    expect(after.promises.map((p) => p.serialNo)).not.toContain('PF-AAA02');
    // And the promise on the unit that stayed sold is untouched.
    expect(after.promises.map((p) => p.serialNo)).toContain('PF-AAA01');
  });
});
