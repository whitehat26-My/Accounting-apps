import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, callRaw, createTestApi, pdfText, type TestApi } from './helpers.js';

/**
 * The first run, end to end, with NOTHING seeded.
 *
 * Every other suite provisions its tenant on the admin connection, which for
 * fifteen migrations hid the fact that no user could reach a working state.
 * This suite is the proof the gap is closed: register, sign in, create the
 * organisation, configure tax with a citation, stock a shelf, ring a sale,
 * and print the receipt — every step over HTTP, as the shop owner will do it.
 */

let api: TestApi;
let refreshToken: string;
let accessToken: string;
let tenantId: string;

const email = `owner-${randomUUID().slice(0, 8)}@emilshop.example`;

beforeAll(async () => {
  api = await createTestApi('onboarding');
}, 120_000);

afterAll(async () => {
  await api?.close();
});

describe('day zero', () => {
  it('registers and signs in — a user exists before any organisation does', async () => {
    const registered = await call(api, {
      method: 'POST',
      url: '/v1/auth/register',
      body: { email, password: 'a-long-enough-password', fullName: 'Sharif M.' },
    });
    expect(registered.status).toBe(201);

    const login = await call(api, {
      method: 'POST',
      url: '/v1/auth/login',
      body: { email, password: 'a-long-enough-password' },
    });
    expect(login.status).toBe(201);
    expect(login.body['organisations']).toEqual([]);
    refreshToken = login.body['refreshToken'] as string;
  });

  it('creates the organisation and walks away holding a working access token', async () => {
    const created = await call(api, {
      method: 'POST',
      url: '/v1/organisations',
      body: {
        refreshToken,
        organisation: {
          name: 'Emil Computer Centre Sdn Bhd',
          ssmRegistrationNo: '202401012345',
          fiscalYearStart: '2026-01-01',
        },
      },
    });

    expect(created.status).toBe(201);
    const org = created.body['organisation'] as Record<string, unknown>;
    expect(org['fiscalYearLabel']).toBe('FY2026');

    accessToken = created.body['accessToken'] as string;
    tenantId = org['tenantId'] as string;
    refreshToken = created.body['refreshToken'] as string; // rotated

    // The token works immediately: the chart is there.
    const accounts = await call(api, {
      method: 'GET',
      url: '/v1/accounts',
      token: accessToken,
      tenantId,
    });
    expect(accounts.status).toBe(200);
  });

  it('refuses a fiscal year that does not start on the first of a month', async () => {
    const login = await call(api, {
      method: 'POST',
      url: '/v1/auth/login',
      body: { email, password: 'a-long-enough-password' },
    });

    const response = await call(api, {
      method: 'POST',
      url: '/v1/organisations',
      body: {
        refreshToken: login.body['refreshToken'],
        organisation: { name: 'Bad Start Sdn Bhd', fiscalYearStart: '2026-01-15' },
      },
    });

    expect(response.status).toBe(422);
    expect(response.body['message']).toMatch(/first of a month/);
  });

  it('refuses an invalid refresh token outright', async () => {
    const response = await call(api, {
      method: 'POST',
      url: '/v1/organisations',
      body: {
        refreshToken: 'not-a-real-token',
        organisation: { name: 'Nope Sdn Bhd', fiscalYearStart: '2026-01-01' },
      },
    });
    expect(response.status).toBe(401);
  });
});

const as = (url: string) => ({ url, token: accessToken, tenantId });

/**
 * pdfkit writes text runs as hex strings inside content streams
 * (`<4f4646...> TJ`). With compression off they are readable — once decoded.
 * This pulls every hex run out and returns the concatenated text, which is
 * what lets these tests assert the CONTENT of a page, not just its magic
 * bytes.
 */

describe('first trading day', () => {
  let itemId: string;
  let supplierId: string;
  let saleInvoiceId: string;
  let saleReceiptId: string;

  it('adds a tax code only WITH a citation', async () => {
    const refused = await call(api, {
      method: 'POST',
      ...as('/v1/tax-codes'),
      body: {
        code: 'SVC-8',
        name: 'Service tax',
        regime: 'SST_SERVICE',
        inputTreatment: 'COST',
        rates: [{ rateBasisPoints: 800, validFrom: '2024-03-01', legislationRef: 'n/a' }],
      },
    });
    // 422: the request was well formed, its content was not acceptable —
    // consistent with every other schema refusal in this API.
    expect(refused.status).toBe(422);

    const accepted = await call(api, {
      method: 'POST',
      ...as('/v1/tax-codes'),
      body: {
        code: 'SVC-8',
        name: 'Service tax',
        regime: 'SST_SERVICE',
        inputTreatment: 'COST',
        rates: [
          {
            rateBasisPoints: 800,
            validFrom: '2024-03-01',
            legislationRef: 'Service Tax (Rate of Tax) (Amendment) Order 2024',
          },
        ],
      },
    });
    expect(accepted.status).toBe(201);
  });

  it('creates a supplier, an item, and stocks the shelf', async () => {
    const supplier = await call(api, {
      method: 'POST',
      ...as('/v1/contacts'),
      body: { name: 'Distributor Sdn Bhd', isSupplier: true },
    });
    expect(supplier.status).toBe(201);
    supplierId = supplier.body['id'] as string;

    // The out-of-scope code onboarding seeded — the only rate it ships.
    const taxCodes = await call(api, { method: 'GET', ...as('/v1/tax-codes') });
    const none = (taxCodes.body['taxCodes'] as Record<string, unknown>[]).find(
      (t) => t['code'] === 'NONE',
    )!;

    const accounts = await call(api, { method: 'GET', ...as('/v1/accounts') });
    const byCode = new Map(
      (accounts.body['accounts'] as { code: string; id: string }[]).map((a) => [a.code, a.id]),
    );

    const item = await call(api, {
      method: 'POST',
      ...as('/v1/items'),
      body: {
        code: 'SSD-1TB',
        name: '1TB NVMe SSD',
        itemType: 'GOODS',
        isTracked: true,
        isSold: true,
        isPurchased: true,
        sale: { unitPrice: '400.00', accountId: byCode.get('4000'), taxCodeId: none['id'] },
        purchase: { accountId: byCode.get('5000'), taxCodeId: none['id'] },
      },
    });
    expect(item.status).toBe(201);
    itemId = item.body['id'] as string;

    const bill = await call(api, {
      method: 'POST',
      ...as('/v1/bills'),
      body: {
        supplierId,
        billNo: 'DIST-0001',
        billDate: '2026-08-03',
        lines: [{ itemId, quantity: '10', unitPrice: '280.00' }],
      },
    });
    expect(bill.status).toBe(201);
  });

  it('rings the first sale', async () => {
    const accounts = await call(api, { method: 'GET', ...as('/v1/accounts') });
    const cash = (accounts.body['accounts'] as { code: string; id: string }[]).find(
      (a) => a.code === '1000',
    )!;

    const sale = await call(api, {
      method: 'POST',
      ...as('/v1/pos/sales'),
      body: {
        saleDate: '2026-08-04',
        lines: [{ itemId, quantity: '2' }],
        method: 'CASH',
        depositAccountId: cash.id,
        tenderedAmount: '850.00',
      },
    });

    expect(sale.status).toBe(201);
    expect(sale.body['total']).toBe('800.0000');
    expect(sale.body['changeDue']).toBe('50.0000');
    saleInvoiceId = sale.body['invoiceId'] as string;
    saleReceiptId = sale.body['receiptId'] as string;
  });

  it('prints the invoice: a real PDF carrying the real figures, dates DD/MM/YYYY', async () => {
    const response = await callRaw(api, {
      method: 'GET',
      ...as(`/v1/invoices/${saleInvoiceId}/pdf`),
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.body.startsWith('%PDF')).toBe(true);

    // compress:false keeps text streams readable — assert the CONTENT, not
    // just that some PDF came back.
    const text = pdfText(response.body);
    expect(text).toContain('Emil Computer Centre Sdn Bhd');
    expect(text).toContain('INVOICE');
    expect(text).toContain('04/08/2026'); // rule 8: DD/MM/YYYY on paper
    expect(text).toContain('800.00');
  });

  it('prints the receipt, naming the invoice it settles', async () => {
    const response = await callRaw(api, {
      method: 'GET',
      ...as(`/v1/receipts/${saleReceiptId}/pdf`),
    });

    expect(response.status).toBe(200);
    expect(response.body.startsWith('%PDF')).toBe(true);
    const text = pdfText(response.body);
    expect(text).toContain('OFFICIAL RECEIPT');
    expect(text).toContain('RM 800.00');
    expect(text).toContain('INV-00001');
  });

  it('answers 404 for another tenant’s invoice PDF', async () => {
    const response = await callRaw(api, {
      method: 'GET',
      ...as(`/v1/invoices/${randomUUID()}/pdf`),
    });
    expect(response.status).toBe(404);
  });
});
