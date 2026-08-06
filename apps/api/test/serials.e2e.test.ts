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
 * Serials over HTTP: the warranty walk-up. A device arrives at the counter;
 * one GET answers what it is, when it came in, and which invoice sold it.
 */

let api: TestApi;
let tenant: Tenant;
let token: string;
let itemId: string;

beforeAll(async () => {
  api = await createTestApi('serials');
  tenant = await seedTenant(api.admin, 'Serial Routes Sdn Bhd');
  const owner = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, owner.refreshToken, tenant.tenantId));

  const created = await call(api, {
    method: 'POST',
    url: '/v1/items',
    token,
    tenantId: tenant.tenantId,
    body: {
      code: 'RTR-AX3',
      name: 'Wi-Fi router AX3000',
      itemType: 'GOODS',
      isTracked: true,
      isSerialised: true,
      isSold: true,
      isPurchased: true,
      sale: { unitPrice: '320.00', accountId: tenant.accounts['4000'], taxCodeId: tenant.taxCodes['NONE'] },
      purchase: { accountId: tenant.accounts['5000'], taxCodeId: tenant.taxCodes['NONE'] },
    },
  });
  itemId = created.body['id'] as string;
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

describe('a serialised unit, door to door', () => {
  it('arrives on a bill, sells at the till, and answers the warranty lookup', async () => {
    const bill = await call(api, {
      method: 'POST',
      ...as('/v1/bills'),
      body: {
        supplierId: tenant.supplierId,
        billNo: 'NET-100',
        billDate: '2026-08-03',
        lines: [
          { itemId, quantity: '2', unitPrice: '250.00', serialNumbers: ['AX3-777', 'AX3-778'] },
        ],
      },
    });
    expect(bill.status).toBe(201);

    const sale = await call(api, {
      method: 'POST',
      ...as('/v1/pos/sales'),
      body: {
        saleDate: '2026-08-04',
        lines: [{ itemId, quantity: '1', serialNumbers: ['AX3-777'] }],
        method: 'CASH',
        depositAccountId: tenant.accounts['1000'],
      },
    });
    expect(sale.status).toBe(201);

    // The customer walks in with the router. Lowercase, because the counter
    // types what they see.
    const lookup = await call(api, { method: 'GET', ...as('/v1/stock/serials/ax3-777') });
    expect(lookup.status).toBe(200);

    const matches = lookup.body['matches'] as Record<string, unknown>[];
    expect(matches).toHaveLength(1);
    expect(matches[0]!['itemCode']).toBe('RTR-AX3');
    expect(matches[0]!['status']).toBe('SOLD');
    expect((matches[0]!['issuedTo'] as Record<string, unknown>)['documentId']).toBe(
      sale.body['invoiceId'],
    );
  });

  it('lists the item’s units by status', async () => {
    const inStock = await call(api, {
      method: 'GET',
      ...as(`/v1/stock/items/${itemId}/units?status=IN_STOCK`),
    });
    expect(inStock.status).toBe(200);
    expect((inStock.body['units'] as Record<string, unknown>[]).map((u) => u['serialNo'])).toEqual([
      'AX3-778',
    ]);
  });

  it('refuses a sale that does not scan the unit, with a 422', async () => {
    const sale = await call(api, {
      method: 'POST',
      ...as('/v1/pos/sales'),
      body: {
        saleDate: '2026-08-04',
        lines: [{ itemId, quantity: '1' }],
        method: 'CASH',
        depositAccountId: tenant.accounts['1000'],
      },
    });

    expect(sale.status).toBe(422);
    expect(sale.body['message']).toMatch(/serial number/);
  });

  it('answers an unknown serial with an empty list, not a 404', async () => {
    const lookup = await call(api, { method: 'GET', ...as('/v1/stock/serials/NOPE-000') });
    expect(lookup.status).toBe(200);
    expect(lookup.body['matches']).toEqual([]);
  });

  it('reports no serial drift', async () => {
    const drift = await call(api, { method: 'GET', ...as('/v1/stock/drift') });
    expect(drift.status).toBe(200);
    expect(drift.body['drift']).toEqual([]);
    expect(drift.body['serialDrift']).toEqual([]);
  });
});

describe('the promises register', () => {
  it('reports what the shop still owes, derived from the sale alone', async () => {
    // The router above was created with no warranty. Give it one, sell the
    // second unit, and the promise appears — no warranty row was ever written.
    const patched = await call(api, {
      method: 'PATCH',
      ...as(`/v1/items/${itemId}`),
      body: {
        code: 'RTR-AX3',
        name: 'Wi-Fi router AX3000',
        itemType: 'GOODS',
        isTracked: true,
        isSerialised: true,
        isSold: true,
        isPurchased: true,
        warrantyMonths: 24,
        sale: {
          unitPrice: '320.00',
          accountId: tenant.accounts['4000'],
          taxCodeId: tenant.taxCodes['NONE'],
        },
        purchase: { accountId: tenant.accounts['5000'], taxCodeId: tenant.taxCodes['NONE'] },
      },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body['warrantyMonths']).toBe(24);

    const register = await call(api, { method: 'GET', ...as('/v1/stock/warranties') });
    expect(register.status).toBe(200);

    const promises = register.body['promises'] as Record<string, unknown>[];
    const sold = promises.find((p) => p['serialNo'] === 'AX3-777')!;
    expect(sold).toBeDefined();
    // Sold 04/08/2026 with 24 months on it.
    expect(sold['soldOn']).toBe('2026-08-04');
    expect(sold['expiresOn']).toBe('2028-08-04');
    expect(sold['warrantyMonths']).toBe(24);
    // The unit still on the shelf owes nobody anything.
    expect(promises.map((p) => p['serialNo'])).not.toContain('AX3-778');
  });

  it('answers the counter question, and says so plainly when it has no record', async () => {
    const covered = await call(api, {
      method: 'GET',
      ...as('/v1/stock/warranties/ax3-777'),
    });
    expect(covered.status).toBe(200);
    // Normalised on the way in: the lowercase scan is the same machine.
    expect(covered.body['serialNo']).toBe('AX3-777');
    expect((covered.body['promise'] as Record<string, unknown>)['expiresOn']).toBe('2028-08-04');

    const stranger = await call(api, {
      method: 'GET',
      ...as('/v1/stock/warranties/SOMEONE-ELSES-99'),
    });
    expect(stranger.status).toBe(200);
    expect(stranger.body['promise']).toBeNull();
  });

  it('is stock.read — a SALES user at the counter can answer it', async () => {
    const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
    const { accessToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId);
    const response = await call(api, {
      method: 'GET',
      url: '/v1/stock/warranties/AX3-777',
      token: accessToken,
      tenantId: tenant.tenantId,
    });
    // Deliberately NOT gated tighter: the person facing the customer is
    // exactly who needs this, and it exposes no figure a till user cannot
    // already see on the invoice they raised.
    expect(response.status).toBe(200);
  });
});
