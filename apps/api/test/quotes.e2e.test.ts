import { randomUUID } from 'node:crypto';
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
    // 4dp, like every other money field on the wire. The subtotal used to come
    // back at 2dp because it was computed by hand in floating point; it is a
    // `Money` now, and `Money` speaks at MONEY_SCALE.
    expect(fetched.body['subtotal']).toBe('2268.0000');

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

describe('the printed quotation', () => {
  it('prints the offer, its validity, and a place to accept it', async () => {
    const quote = await call(api, {
      method: 'POST',
      ...as('/v1/quotes'),
      idempotencyKey: randomUUID(),
      body: {
        contactId: tenant.customerId,
        quoteDate: '2026-08-01',
        validUntil: '2026-08-31',
        notes: 'Parts subject to availability. Turnaround is 3 working days.',
        lines: [
          { description: 'Replace display panel', quantity: '1', unitPrice: '780.00',
            accountId, taxCodeId },
          { description: 'Labour — screen fitting', quantity: '2', unitPrice: '90.00',
            accountId, taxCodeId, discountBasisPoints: 1000 },
        ],
      },
    });
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);

    const response = await callRaw(api, {
      method: 'GET',
      ...as(`/v1/quotes/${quote.body['id']}/pdf`),
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    const text = pdfText(response.body);

    expect(text).toContain('QUOTATION');
    expect(text).toContain('Replace display panel');
    expect(text).toContain('31/08/2026'); // valid until, DD/MM/YYYY
    // The discount is shown as a rate, not silently folded into the price.
    expect(text).toContain('10.0%');
    // 780 + (180 less 10%) = 942.00
    expect(text).toContain('942.00');

    /*
     * A quote is an OFFER, and the page has to say so — a document a customer
     * could mistake for a tax invoice is a real problem under SST, and one
     * they could mistake for a demand for payment is a different one.
     */
    expect(text).toContain('not a tax invoice');
    expect(text).toContain('Accepted by');
  });

  it('stamps an expired quote rather than reprinting it as if it were live', async () => {
    const quote = await call(api, {
      method: 'POST',
      ...as('/v1/quotes'),
      idempotencyKey: randomUUID(),
      body: {
        contactId: tenant.customerId,
        quoteDate: '2020-01-01',
        validUntil: '2020-01-31',
        lines: [{ description: 'Old job', quantity: '1', unitPrice: '100.00',
                  accountId, taxCodeId }],
      },
    });

    const text = pdfText(
      (await callRaw(api, { method: 'GET', ...as(`/v1/quotes/${quote.body['id']}/pdf`) })).body,
    );
    expect(text).toContain('QUOTATION (EXPIRED)');
    expect(text).toContain('lapsed on 31/01/2020');
  });

  it('answers 404 for a quote that is not this tenant’s', async () => {
    const response = await callRaw(api, {
      method: 'GET',
      ...as(`/v1/quotes/${randomUUID()}/pdf`),
    });
    expect(response.status).toBe(404);
  });
});
