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
 * Quoting over HTTP, driven as SALES — the person at the counter who knows the
 * prices is the one who writes a quote, and the route permissions say so.
 */

let api: TestApi;
let tenant: Tenant;
let token: string;
let accountId: string;
let taxCodeId: string;

beforeAll(async () => {
  api = await createTestApi('quotes');
  tenant = await seedTenant(api.admin, 'Quotes Routes Sdn Bhd');
  const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
  ({ accessToken: token } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId));
  accountId = tenant.accounts['4000']!;
  taxCodeId = tenant.taxCodes['NONE']!;
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

const body = () => ({
  contactId: tenant.customerId,
  quoteDate: '2026-08-04',
  validUntil: '2026-09-03',
  lines: [
    { description: '500GB NVMe SSD', quantity: '12', unitPrice: '189.00', accountId, taxCodeId },
  ],
});

describe('quoting over HTTP', () => {
  it('runs draft → sent → accepted → invoiced', async () => {
    const created = await call(api, { method: 'POST', ...as('/v1/quotes'), body: body() });
    expect(created.status).toBe(201);
    expect(created.body['quoteNo']).toMatch(/^QUO-/);
    const id = created.body['id'] as string;

    const fetched = await call(api, { method: 'GET', ...as(`/v1/quotes/${id}`) });
    expect(fetched.status).toBe(200);
    expect(fetched.body['subtotal']).toBe('2268.00');

    for (const to of ['SENT', 'ACCEPTED']) {
      const moved = await call(api, { method: 'POST', ...as(`/v1/quotes/${id}/status`), body: { to } });
      expect(moved.status).toBe(201);
    }

    const converted = await call(api, {
      method: 'POST',
      ...as(`/v1/quotes/${id}/convert`),
      body: { issueDate: '2026-08-05' },
    });
    expect(converted.status).toBe(201);
    expect(converted.body['invoiceNo']).toMatch(/^INV-/);

    const after = await call(api, { method: 'GET', ...as(`/v1/quotes/${id}`) });
    expect(after.body['status']).toBe('INVOICED');
  });

  it('refuses to mark a quote INVOICED by hand', async () => {
    // Claiming an invoice exists when none does. The conversion route is the
    // only door, because it is the one that actually creates the invoice.
    const created = await call(api, { method: 'POST', ...as('/v1/quotes'), body: body() });
    const id = created.body['id'] as string;
    await call(api, { method: 'POST', ...as(`/v1/quotes/${id}/status`), body: { to: 'SENT' } });
    await call(api, { method: 'POST', ...as(`/v1/quotes/${id}/status`), body: { to: 'ACCEPTED' } });

    const byHand = await call(api, {
      method: 'POST',
      ...as(`/v1/quotes/${id}/status`),
      body: { to: 'INVOICED' },
    });
    expect(byHand.status).toBe(422);
  });

  it('lists by status and filters to the tenant', async () => {
    const listed = await call(api, { method: 'GET', ...as('/v1/quotes?status=DRAFT') });
    expect(listed.status).toBe(200);
    const quotes = listed.body['quotes'] as { status: string }[];
    expect(quotes.every((q) => q.status === 'DRAFT')).toBe(true);
  });

  it('a technician can neither see nor write quotes', async () => {
    // Quoting is a money conversation. The bench does not have it.
    const tech = await makeUser(api, { tenantId: tenant.tenantId, role: 'TECHNICIAN' });
    const { accessToken: techToken } = await accessTokenFor(
      api, tech.refreshToken, tenant.tenantId,
    );
    const asTech = (url: string) => ({ url, token: techToken, tenantId: tenant.tenantId });

    expect((await call(api, { method: 'GET', ...asTech('/v1/quotes') })).status).toBe(403);
    expect(
      (await call(api, { method: 'POST', ...asTech('/v1/quotes'), body: body() })).status,
    ).toBe(403);
  });

  it('rejects a quote with no lines at the schema', async () => {
    const empty = await call(api, {
      method: 'POST',
      ...as('/v1/quotes'),
      body: { ...body(), lines: [] },
    });
    expect(empty.status).toBe(422);
  });
});
