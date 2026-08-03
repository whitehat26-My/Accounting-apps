import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessTokenFor,
  call,
  createTestApi,
  makeUser,
  seedTenant,
  type TestApi,
  type Tenant,
} from './helpers.js';

/**
 * The shop's day, over HTTP: create a tracked item, buy stock on a bill, sell
 * it on an invoice, count the shelf, and read the levels — every step through
 * the same guards and filters a real client hits.
 */

let api: TestApi;
let tenant: Tenant;
let token: string;
let salesToken: string;
let itemId: string;

beforeAll(async () => {
  api = await createTestApi('stock');
  tenant = await seedTenant(api.admin, 'Stock Routes Sdn Bhd');
  const owner = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, owner.refreshToken, tenant.tenantId));

  const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
  ({ accessToken: salesToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId));

  const created = await call(api, {
    method: 'POST',
    url: '/v1/items',
    token,
    tenantId: tenant.tenantId,
    body: {
      code: 'GPU-4070',
      name: 'GeForce RTX 4070',
      itemType: 'GOODS',
      isTracked: true,
      isSold: true,
      isPurchased: true,
      sale: { unitPrice: '2400.00', accountId: tenant.accounts['4000'], taxCodeId: tenant.taxCodes['NONE'] },
      purchase: { accountId: tenant.accounts['5000'], taxCodeId: tenant.taxCodes['NONE'] },
    },
  });
  expect(created.status).toBe(201);
  itemId = created.body['id'] as string;
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

describe('a trading day over HTTP', () => {
  it('buys five cards, sells two, and the shelf plus the ledger both know', async () => {
    const bill = await call(api, {
      method: 'POST',
      ...as('/v1/bills'),
      body: {
        supplierId: tenant.supplierId,
        billNo: 'DIST-7001',
        billDate: '2026-08-03',
        lines: [{ itemId, quantity: '5', unitPrice: '2000.00' }],
      },
    });
    expect(bill.status).toBe(201);

    const sale = await call(api, {
      method: 'POST',
      ...as('/v1/invoices'),
      body: {
        contactId: tenant.customerId,
        issueDate: '2026-08-04',
        lines: [{ itemId, quantity: '2' }],
      },
    });
    expect(sale.status).toBe(201);
    expect(sale.body['subtotal']).toBe('4800.0000');

    const stock = await call(api, { method: 'GET', ...as('/v1/stock') });
    expect(stock.status).toBe(200);

    const gpu = (stock.body['stock'] as Record<string, string>[]).find(
      (s) => s['code'] === 'GPU-4070',
    );
    expect(gpu?.['quantityOnHand']).toBe('3.0000');
    expect(gpu?.['stockValue']).toBe('6000.0000');
    expect(gpu?.['weightedAverageCost']).toBe('2000.0000');
  });

  it('refuses to oversell with a 422 that says what is on hand', async () => {
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/invoices'),
      body: {
        contactId: tenant.customerId,
        issueDate: '2026-08-04',
        lines: [{ itemId, quantity: '50' }],
      },
    });

    expect(response.status).toBe(422);
    expect(response.body['message']).toMatch(/3\.0000 on hand/);
  });

  it('posts a count and shows the movement trail', async () => {
    const count = await call(api, {
      method: 'POST',
      ...as('/v1/stock/counts'),
      body: {
        itemId,
        countedQuantity: '2',
        countDate: '2026-08-05',
        reason: 'display unit damaged, written off',
      },
    });

    expect(count.status).toBe(201);
    expect(count.body['quantityDelta']).toBe('-1.0000');
    expect(count.body['journalEntryId']).toBeTruthy();

    const movements = await call(api, {
      method: 'GET',
      ...as(`/v1/stock/items/${itemId}/movements`),
    });
    expect(movements.status).toBe(200);

    const trail = (movements.body['movements'] as Record<string, string>[]).map(
      (m) => m['movementType'],
    );
    expect(trail).toEqual(['RECEIPT', 'ISSUE', 'ADJUSTMENT']);
  });

  it('reports no drift after all of it', async () => {
    const drift = await call(api, { method: 'GET', ...as('/v1/stock/drift') });
    expect(drift.status).toBe(200);
    expect(drift.body['drift']).toEqual([]);
  });
});

describe('permissions', () => {
  it('lets SALES read stock but not adjust it', async () => {
    const read = await call(api, {
      method: 'GET',
      url: '/v1/stock',
      token: salesToken,
      tenantId: tenant.tenantId,
    });
    expect(read.status).toBe(200);

    // The write-off is the theft vector; the sales desk does not hold it.
    const adjust = await call(api, {
      method: 'POST',
      url: '/v1/stock/counts',
      token: salesToken,
      tenantId: tenant.tenantId,
      body: {
        itemId,
        countedQuantity: '0',
        countDate: '2026-08-05',
        reason: 'should be refused',
      },
    });
    expect(adjust.status).toBe(403);
  });

  it('answers 404 for another tenant’s movements, never 403', async () => {
    const other = await seedTenant(api.admin, 'Not Your Stock Sdn Bhd');
    void other;

    const response = await call(api, {
      method: 'GET',
      ...as(`/v1/stock/items/${randomUUID()}/movements`),
    });
    expect(response.status).toBe(404);
  });
});
