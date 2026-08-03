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
 * A repair over HTTP, end to end: intake, quote, approve, name the fitted
 * unit, collect cash. Driven as SALES — the counter runs the workshop queue.
 */

let api: TestApi;
let tenant: Tenant;
let token: string;
let itemId: string;
let jobId: string;

beforeAll(async () => {
  api = await createTestApi('repairs');
  tenant = await seedTenant(api.admin, 'Repairs Routes Sdn Bhd');
  const owner = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  const ownerToken = (await accessTokenFor(api, owner.refreshToken, tenant.tenantId)).accessToken;

  const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
  ({ accessToken: token } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId));

  const created = await call(api, {
    method: 'POST',
    url: '/v1/items',
    token: ownerToken,
    tenantId: tenant.tenantId,
    body: {
      code: 'RAM-16G',
      name: '16GB DDR5 SO-DIMM',
      itemType: 'GOODS',
      isTracked: true,
      isSerialised: true,
      isSold: true,
      isPurchased: true,
      sale: { unitPrice: '300.00', accountId: tenant.accounts['4000'], taxCodeId: tenant.taxCodes['NONE'] },
      purchase: { accountId: tenant.accounts['5000'], taxCodeId: tenant.taxCodes['NONE'] },
    },
  });
  itemId = created.body['id'] as string;

  await call(api, {
    method: 'POST',
    url: '/v1/bills',
    token: ownerToken,
    tenantId: tenant.tenantId,
    body: {
      supplierId: tenant.supplierId,
      billNo: 'RAM-SUP-1',
      billDate: '2026-08-03',
      lines: [{ itemId, quantity: '2', unitPrice: '210.00', serialNumbers: ['DDR-01', 'DDR-02'] }],
    },
  });
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

describe('the workshop over HTTP', () => {
  it('runs intake → quote → approve → fitted → collect, and the money is right', async () => {
    const intake = await call(api, {
      method: 'POST',
      ...as('/v1/repairs'),
      body: {
        contactId: tenant.customerId,
        deviceDescription: 'Lenovo IdeaPad, blue',
        reportedFault: 'Very slow; freezes with many tabs',
        receivedOn: '2026-08-04',
      },
    });
    expect(intake.status).toBe(201);
    expect(intake.body['jobNo']).toMatch(/^JOB-/);
    jobId = intake.body['id'] as string;

    const quote = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/quote`),
      body: {
        diagnosis: '8GB is not enough for the workload. Upgrade to 16GB.',
        lines: [
          { itemId, description: 'RAM upgrade to 16GB', quantity: '1', unitPrice: '280.00' },
          { description: 'Fitting and memtest', quantity: '1', unitPrice: '40.00', accountId: tenant.accounts['4000'], taxCodeId: tenant.taxCodes['NONE'] },
        ],
      },
    });
    expect(quote.status).toBe(201);
    expect(quote.body['status']).toBe('QUOTED');

    const approve = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/status`),
      body: { to: 'APPROVED', approvalNote: 'Customer agreed at the counter' },
    });
    expect(approve.status).toBe(201);

    const fitted = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/lines/1/serials`),
      body: { serialNumbers: ['DDR-02'] },
    });
    expect(fitted.status).toBe(201);

    await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/status`),
      body: { to: 'READY' },
    });

    const collect = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/collect`),
      body: {
        collectDate: '2026-08-05',
        payment: {
          method: 'CASH',
          depositAccountId: tenant.accounts['1000'],
          tenderedAmount: '350.00',
        },
      },
    });

    expect(collect.status).toBe(201);
    expect(collect.body['total']).toBe('320.0000'); // 280 + 40, as agreed
    expect(collect.body['changeDue']).toBe('30.0000');
    expect(collect.body['paid']).toBe(true);

    // The fitted stick is bound to the collection invoice.
    const lookup = await call(api, { method: 'GET', ...as('/v1/stock/serials/DDR-02') });
    const match = (lookup.body['matches'] as Record<string, unknown>[])[0]!;
    expect(match['status']).toBe('SOLD');
    expect((match['issuedTo'] as Record<string, unknown>)['documentId']).toBe(
      collect.body['invoiceId'],
    );
  });

  it('refuses collecting a job that is not READY, with the state named', async () => {
    const intake = await call(api, {
      method: 'POST',
      ...as('/v1/repairs'),
      body: {
        contactId: tenant.customerId,
        deviceDescription: 'HP Pavilion',
        reportedFault: 'No power',
        receivedOn: '2026-08-05',
      },
    });

    const collect = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${intake.body['id']}/collect`),
      body: { collectDate: '2026-08-05' },
    });

    expect(collect.status).toBe(422);
    expect(collect.body['message']).toMatch(/RECEIVED/);
  });

  it('filters the queue by status', async () => {
    const queue = await call(api, { method: 'GET', ...as('/v1/repairs?status=COLLECTED') });
    expect(queue.status).toBe(200);
    expect((queue.body['jobs'] as Record<string, unknown>[]).some((j) => j['id'] === jobId)).toBe(
      true,
    );
  });
});
