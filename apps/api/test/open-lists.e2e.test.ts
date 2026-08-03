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
 * The working lists behind the Sales and Purchases screens: an open item
 * appears with its counterparty's name, and settling it makes it leave.
 */

let api: TestApi;
let tenant: Tenant;
let token: string;

beforeAll(async () => {
  api = await createTestApi('open_lists');
  tenant = await seedTenant(api.admin, 'Open Lists Sdn Bhd');
  const owner = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, owner.refreshToken, tenant.tenantId));
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

describe('GET /v1/invoices — the unpaid list', () => {
  it('shows an issued invoice with the customer name, and drops it when paid', async () => {
    const issued = await call(api, {
      method: 'POST',
      ...as('/v1/invoices'),
      body: {
        contactId: tenant.customerId,
        issueDate: '2026-08-01',
        dueDate: '2026-08-31',
        lines: [{ description: 'Custom build', quantity: '1', unitPrice: '3200.00',
                  accountId: tenant.accounts['4000'], taxCodeId: tenant.taxCodes['NONE'] }],
      },
    });
    expect(issued.status).toBe(201);

    const list = await call(api, { method: 'GET', ...as('/v1/invoices') });
    expect(list.status).toBe(200);
    const rows = list.body['invoices'] as Record<string, string>[];
    const row = rows.find((r) => r['id'] === issued.body['id']);
    expect(row).toMatchObject({
      amountDue: '3200.0000',
      dueDate: '2026-08-31',
      status: 'ISSUED',
    });
    expect(row!['contactName']!.length).toBeGreaterThan(0);

    const paid = await call(api, {
      method: 'POST',
      ...as('/v1/receipts'),
      body: {
        contactId: tenant.customerId,
        paymentDate: '2026-08-05',
        amount: '3200.00',
        method: 'TRANSFER',
        depositAccountId: tenant.accounts['1000'],
        allocations: [{ invoiceId: issued.body['id'], amount: '3200.00' }],
      },
    });
    expect(paid.status).toBe(201);

    const after = await call(api, { method: 'GET', ...as('/v1/invoices') });
    expect((after.body['invoices'] as Record<string, string>[])
      .find((r) => r['id'] === issued.body['id'])).toBeUndefined();
  });
});

describe('GET /v1/bills — the unpaid list', () => {
  it('shows an entered bill with the supplier name and both numbers', async () => {
    const entered = await call(api, {
      method: 'POST',
      ...as('/v1/bills'),
      body: {
        supplierId: tenant.supplierId,
        billNo: 'SS-4410',
        billDate: '2026-08-01',
        dueDate: '2026-08-30',
        lines: [{ description: 'Shop rental', quantity: '1', unitPrice: '1500.00',
                  accountId: tenant.accounts['5000'], taxCodeId: tenant.taxCodes['NONE'] }],
      },
    });
    expect(entered.status).toBe(201);

    const list = await call(api, { method: 'GET', ...as('/v1/bills') });
    expect(list.status).toBe(200);
    const row = (list.body['bills'] as Record<string, string>[])
      .find((r) => r['billNo'] === 'SS-4410');
    expect(row).toMatchObject({ amountDue: '1500.0000', status: 'ENTERED' });
    // Both numbers: theirs (billNo) and ours (internalRef) — a supplier quotes
    // one on the phone and the auditor asks for the other.
    expect(row!['internalRef']!.length).toBeGreaterThan(0);
    expect(row!['supplierName']!.length).toBeGreaterThan(0);
  });
});
