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
 * The till over HTTP, rung by a SALES user — the role the counter will
 * actually hold, which cannot record a general receipt and does not need to.
 */

let api: TestApi;
let tenant: Tenant;
let salesToken: string;
let ownerToken: string;
let itemId: string;

beforeAll(async () => {
  api = await createTestApi('pos');
  tenant = await seedTenant(api.admin, 'POS Routes Sdn Bhd');

  const owner = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: ownerToken } = await accessTokenFor(api, owner.refreshToken, tenant.tenantId));

  const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
  ({ accessToken: salesToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId));

  // Owner sets up the catalogue and buys stock; sales rings the till.
  const created = await call(api, {
    method: 'POST',
    url: '/v1/items',
    token: ownerToken,
    tenantId: tenant.tenantId,
    body: {
      code: 'HDMI-2M',
      name: 'HDMI cable 2m',
      itemType: 'GOODS',
      isTracked: true,
      isSold: true,
      isPurchased: true,
      sale: { unitPrice: '35.00', accountId: tenant.accounts['4000'], taxCodeId: tenant.taxCodes['NONE'] },
      purchase: { accountId: tenant.accounts['5000'], taxCodeId: tenant.taxCodes['NONE'] },
    },
  });
  itemId = created.body['id'] as string;

  const bill = await call(api, {
    method: 'POST',
    url: '/v1/bills',
    token: ownerToken,
    tenantId: tenant.tenantId,
    body: {
      supplierId: tenant.supplierId,
      billNo: 'CABLE-SUP-1',
      billDate: '2026-08-03',
      lines: [{ itemId, quantity: '50', unitPrice: '12.00' }],
    },
  });
  expect(bill.status).toBe(201);
}, 120_000);

afterAll(async () => {
  await api?.close();
});

describe('the counter, as the SALES role', () => {
  it('rings a cash sale and gets the change to give back', async () => {
    const sale = await call(api, {
      method: 'POST',
      url: '/v1/pos/sales',
      token: salesToken,
      tenantId: tenant.tenantId,
      body: {
        saleDate: '2026-08-05',
        lines: [{ itemId, quantity: '3' }],
        method: 'CASH',
        depositAccountId: tenant.accounts['1000'],
        tenderedAmount: '150.00',
      },
    });

    expect(sale.status).toBe(201);
    expect(sale.body['total']).toBe('105.0000');
    expect(sale.body['changeDue']).toBe('45.0000');
    expect(sale.body['invoiceNo']).toMatch(/^INV-/);
    expect(sale.body['receiptNo']).toMatch(/^PAY-/);
  });

  it('reads the Z-report for the drawer count', async () => {
    const takings = await call(api, {
      method: 'GET',
      url: '/v1/pos/takings?date=2026-08-05',
      token: salesToken,
      tenantId: tenant.tenantId,
    });

    expect(takings.status).toBe(200);
    expect(takings.body['receiptsTotal']).toBe('105.0000');
    expect(takings.body['costOfGoodsSold']).toBe('36.0000'); // 3 × RM 12
    expect(takings.body['grossProfit']).toBe('69.0000');
  });

  it('cannot record a general receipt — pos.sale is not receipt.create', async () => {
    const receipt = await call(api, {
      method: 'POST',
      url: '/v1/receipts',
      token: salesToken,
      tenantId: tenant.tenantId,
      body: {
        contactId: tenant.customerId,
        paymentDate: '2026-08-05',
        amount: '1000.00',
        method: 'CASH',
        depositAccountId: tenant.accounts['1000'],
      },
    });

    expect(receipt.status).toBe(403);
  });

  it('refuses an under-tender with a 422 naming both figures', async () => {
    const sale = await call(api, {
      method: 'POST',
      url: '/v1/pos/sales',
      token: salesToken,
      tenantId: tenant.tenantId,
      body: {
        saleDate: '2026-08-05',
        lines: [{ itemId, quantity: '1' }],
        method: 'CASH',
        depositAccountId: tenant.accounts['1000'],
        tenderedAmount: '30.00',
      },
    });

    expect(sale.status).toBe(422);
    expect(sale.body['message']).toMatch(/30\.0000.*35\.0000/);
  });
});
