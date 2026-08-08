import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessTokenFor,
  call,
  callRaw,
  createTestApi,
  makeUser,
  pdfText,
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
      barcode: '9556000112233',
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

  it('answers the scanner: exact barcode in, one item out, and only exact', async () => {
    const hit = await call(api, {
      method: 'GET',
      url: '/v1/items?direction=SALE&barcode=9556000112233',
      token: salesToken,
      tenantId: tenant.tenantId,
    });
    expect(hit.status).toBe(200);
    const items = hit.body as unknown as { id: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(itemId);

    // A near-miss returns NOTHING — a scanner types the whole code, and a
    // substring match here would put the wrong item in a sale.
    const miss = await call(api, {
      method: 'GET',
      url: '/v1/items?direction=SALE&barcode=955600011223',
      token: salesToken,
      tenantId: tenant.tenantId,
    });
    expect(miss.body as unknown as unknown[]).toHaveLength(0);
  });

  it('prints the till receipt on 80mm paper, same figures as the A4', async () => {
    const sale = await call(api, {
      method: 'POST',
      url: '/v1/pos/sales',
      token: salesToken,
      tenantId: tenant.tenantId,
      body: {
        // Its own day, so the Z-report assertions for the 5th stay exact.
        saleDate: '2026-08-06',
        lines: [{ itemId, quantity: '2' }],
        method: 'CASH',
        depositAccountId: tenant.accounts['1000'],
        tenderedAmount: '100.00',
      },
    });
    expect(sale.status).toBe(201);
    const receiptId = sale.body['receiptId'] as string;

    const thermal = await callRaw(api, {
      method: 'GET',
      url: `/v1/receipts/${receiptId}/pdf?format=thermal`,
      token: salesToken,
      tenantId: tenant.tenantId,
    });
    expect(thermal.status).toBe(200);
    expect(thermal.body.startsWith('%PDF')).toBe(true);

    const a4 = await callRaw(api, {
      method: 'GET',
      url: `/v1/receipts/${receiptId}/pdf`,
      token: salesToken,
      tenantId: tenant.tenantId,
    });

    // Same document, different garment: both carry the receipt number and the
    // total; the thermal one additionally itemises what was bought.
    const thermalText = pdfText(thermal.body);
    const a4Text = pdfText(a4.body);
    expect(thermalText).toContain('70.00');
    expect(a4Text).toContain('70.00');
    expect(thermalText).toContain('HDMI cable 2m');
    expect(thermalText).toContain('TOTAL');
    // 80mm wide, not A4: the MediaBox says so in the bytes.
    expect(thermal.body).toContain('[0 0 227');
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

describe('the day sheet', () => {
  /*
   * Printed by the SALES user on purpose. Closing up is the counter's job, and
   * a Z-report only the owner can print is one nobody prints at 9pm — so the
   * route rides `pos.sale`, the same permission that rang the sales it totals.
   */
  const till = (url: string) => ({ url, token: salesToken, tenantId: tenant.tenantId });

  it('prints the Z-report the shop signs and files', async () => {
    const response = await callRaw(api, {
      method: 'GET',
      ...till('/v1/pos/takings/pdf?date=2026-08-05'),
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.body.startsWith('%PDF')).toBe(true);

    const text = pdfText(response.body);
    expect(text).toContain('DAY SHEET');
    expect(text).toContain('05/08/2026'); // rule 8, on paper

    /*
     * The two numbers a shop confuses, under headings that say which question
     * each answers. If these ever merge into one block the document has lost
     * the thing it was built to prevent.
     */
    expect(text).toContain('MONEY IN TODAY');
    expect(text).toContain('WHAT THE DAY SOLD');

    // The control: a box for a person to write what they actually counted.
    expect(text).toContain('COUNTED BY HAND');
    expect(text).toContain('Cash counted');
    expect(text).toContain('Counted by');
    expect(text).toContain('Checked by');
  });

  it('prints a quiet day honestly rather than as an empty table', async () => {
    const text = pdfText(
      (await callRaw(api, { method: 'GET', ...till('/v1/pos/takings/pdf?date=2019-01-01') })).body,
    );
    expect(text).toContain('Nothing was taken today');
  });
});
