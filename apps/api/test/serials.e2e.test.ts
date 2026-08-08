import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessTokenFor,
  call,
  callRaw,
  createTestApi,
  pdfText,
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

/**
 * The card the customer keeps.
 *
 * The register and the JSON lookup answer a screen; this answers the phone
 * call. Everything asserted here is a fact the system already holds — the
 * card deliberately states no warranty TERMS, because those are the shop's
 * and the manufacturer's to state and plausible boilerplate would be worse
 * than a pointer to the counter.
 */
describe('the printed warranty card', () => {
  it('prints the promise, and says plainly what it does not state', async () => {
    const raw = await callRaw(api, {
      method: 'GET',
      // Lowercase, as somebody types it off the back of a machine.
      ...as('/v1/stock/warranties/ax3-777/card.pdf'),
    });

    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toContain('application/pdf');
    // The serial is the filename, so a folder of these sorts by the thing.
    expect(raw.headers['content-disposition']).toContain('warranty-AX3-777.pdf');

    const text = pdfText(raw.body);
    expect(text).toContain('WARRANTY CARD');
    expect(text).toContain('IN WARRANTY');
    expect(text).toContain('AX3-777');
    // The one fact somebody crossed the shop to find out.
    expect(text).toContain('04/08/2028');
    expect(text).toContain('24 months from 04/08/2026');
    // And the honest limit, in words on the page.
    expect(text).toMatch(/not reproduced here rather than.*guessed at/s);
  });

  it('is verifiable by anybody holding it', async () => {
    const raw = await callRaw(api, {
      method: 'GET',
      ...as('/v1/stock/warranties/AX3-777/card.pdf'),
    });
    const digest = /([0-9a-f]{16})\s*([0-9a-f]{16})\s*([0-9a-f]{16})\s*([0-9a-f]{16})/
      .exec(pdfText(raw.body));
    expect(digest).not.toBeNull();

    // No token, no tenant: the route a customer holding the card would use.
    const verified = await call(api, {
      method: 'POST',
      url: '/public/verify',
      body: { digest: digest!.slice(1, 5).join('') },
    });
    expect(verified.status).toBe(201);
    expect(verified.body['verdict']).toBe('GENUINE');
    expect(verified.body['documentType']).toBe('WARRANTY');
  });

  it('reprints the SAME card — the digest is the promise, not the printing', async () => {
    /*
     * A customer who loses the card gets an identical one, and the reference
     * on it still matches. If the digest moved with each print, the old card
     * in somebody's drawer would start failing verification for no reason
     * anybody could explain.
     */
    const digestOf = async () => {
      const raw = await callRaw(api, {
        method: 'GET',
        ...as('/v1/stock/warranties/AX3-777/card.pdf'),
      });
      return /([0-9a-f]{16})\s*([0-9a-f]{16})\s*([0-9a-f]{16})\s*([0-9a-f]{16})/
        .exec(pdfText(raw.body))!.slice(1, 5).join('');
    };
    expect(await digestOf()).toBe(await digestOf());
  });

  it('refuses to print a card for a device this shop has no record of selling', async () => {
    // The JSON route answers 200 with `promise: null` — a fine ANSWER for a
    // screen. A DOCUMENT saying the same thing would be believed, so this is
    // a 404 instead.
    const unknown = await call(api, {
      method: 'GET',
      ...as('/v1/stock/warranties/SOMEONE-ELSES-99/card.pdf'),
    });
    expect(unknown.status).toBe(404);

    // And the unit still on the shelf: sold to nobody, so owed to nobody.
    const unsold = await call(api, {
      method: 'GET',
      ...as('/v1/stock/warranties/AX3-778/card.pdf'),
    });
    expect(unsold.status).toBe(404);
  });
});
