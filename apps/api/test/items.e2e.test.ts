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

let api: TestApi;
let tenant: Tenant;
let token: string;

beforeAll(async () => {
  api = await createTestApi('items');
  tenant = await seedTenant(api.admin, 'Items Sdn Bhd');
  const user = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, user.refreshToken, tenant.tenantId));

  await api.admin`
      INSERT INTO einvoice_classification_code (code, description)
      VALUES ('022', 'Others') ON CONFLICT DO NOTHING
  `;
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

let sequence = 0;
const uniqueCode = () => `SVC-${(sequence += 1).toString().padStart(3, '0')}`;

async function createItem(over: Record<string, unknown> = {}) {
  const response = await call(api, {
    method: 'POST',
    ...as('/v1/items'),
    idempotencyKey: randomUUID(),
    body: {
      code: uniqueCode(),
      name: 'Consulting',
      unitOfMeasure: 'hour',
      classificationCode: '022',
      sale: {
        unitPrice: '250.00',
        accountId: tenant.accounts['4000'],
        taxCodeId: tenant.taxCodes['SST-SVC'],
      },
      ...over,
    },
  });

  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

// ---------------------------------------------------------------------------
// The routes that did not exist
// ---------------------------------------------------------------------------

describe('the item catalogue is reachable at last', () => {
  it('creates, lists and reads an item', async () => {
    /*
     * `invoice_line.item_id` has accepted an id since M2 with no way to create
     * an item — so no real user could ever have supplied a valid one.
     */
    const created = await createItem();

    const list = await call(api, { method: 'GET', ...as('/v1/items') });
    expect(list.status).toBe(200);
    expect((list.body as unknown as { id: string }[]).map((i) => i.id)).toContain(created['id']);

    const read = await call(api, { method: 'GET', ...as(`/v1/items/${created['id']}`) });
    expect(read.body['code']).toBe(created['code']);
  });

  it('refuses a sold item with no revenue account, naming the item', async () => {
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/items'),
      idempotencyKey: randomUUID(),
      body: { code: uniqueCode(), name: 'Broken', isSold: true, sale: { unitPrice: '10.00' } },
    });

    expect(response.status).toBe(422);
    expect(String(response.body['message'])).toMatch(/no revenue account/);
  });

  it('answers 404 for another tenant’s item, not 403', async () => {
    const other = await seedTenant(api.admin, 'Items Other Sdn Bhd');
    const [theirs] = await api.admin<{ id: string }[]>`
        INSERT INTO item (tenant_id, code, name, is_sold, sale_account_id)
        VALUES (${other.tenantId}, 'THEIRS', 'Theirs', TRUE, ${other.accounts['4000']!})
        RETURNING id
    `;

    const response = await call(api, { method: 'GET', ...as(`/v1/items/${theirs!.id}`) });
    expect(response.status).toBe(404);
  });
});

describe('permissions', () => {
  it('lets SALES read the catalogue but not edit it', async () => {
    // You cannot raise an invoice without picking from the catalogue. Deciding
    // which account revenue posts to is a bookkeeping decision, not a
    // sales-desk one.
    const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
    const { accessToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId);

    const read = await call(api, {
      method: 'GET',
      url: '/v1/items',
      token: accessToken,
      tenantId: tenant.tenantId,
    });
    expect(read.status).toBe(200);

    const write = await call(api, {
      method: 'POST',
      url: '/v1/items',
      token: accessToken,
      tenantId: tenant.tenantId,
      idempotencyKey: randomUUID(),
      body: { code: 'NOPE', name: 'Nope', sale: { accountId: tenant.accounts['4000'] } },
    });
    expect(write.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The payoff
// ---------------------------------------------------------------------------

describe('invoicing from the catalogue', () => {
  it('issues an invoice from an item id and a quantity alone', async () => {
    const item = await createItem();

    const response = await call(api, {
      method: 'POST',
      ...as('/v1/invoices'),
      idempotencyKey: randomUUID(),
      body: {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [{ itemId: item['id'], quantity: '2' }],
      },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    // 250 × 2, plus 8% service tax.
    expect(response.body['subtotal']).toBe('500.0000');
    expect(response.body['taxTotal']).toBe('40.0000');
  });

  it('carries the classification code the e-Invoice submission needs', async () => {
    /*
     * The through-line of this slice. A line with no classification code is
     * rejected by MyInvois, dead-letters its outbox event, and never reaches
     * LHDN — days after the customer was sent the invoice. The person raising
     * it has no reason to know the code exists; the catalogue does.
     */
    const item = await createItem();

    const invoice = await call(api, {
      method: 'POST',
      ...as('/v1/invoices'),
      idempotencyKey: randomUUID(),
      body: {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [{ itemId: item['id'], quantity: '1' }],
      },
    });

    const [line] = await api.admin<{ classification_code: string | null }[]>`
        SELECT classification_code FROM invoice_line
         WHERE tenant_id = ${tenant.tenantId} AND invoice_id = ${invoice.body['id'] as string}
    `;

    expect(line!.classification_code).toBe('022');
  });

  it('still refuses a line that has neither an item nor its own figures', async () => {
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/invoices'),
      idempotencyKey: randomUUID(),
      body: {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [{ quantity: '1', description: 'Ad hoc work' }],
      },
    });

    expect(response.status).toBe(422);
    expect(String(response.body['message'])).toMatch(/must supply unitPrice, accountId, taxCodeId/);
  });

  it('accepts a fully-specified line with no item, exactly as before', async () => {
    // The old shape must keep working — every existing caller uses it.
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/invoices'),
      idempotencyKey: randomUUID(),
      body: {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [
          {
            description: 'Ad hoc work',
            quantity: '1',
            unitPrice: '100.00',
            accountId: tenant.accounts['4000'],
            taxCodeId: tenant.taxCodes['NONE'],
          },
        ],
      },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body['total']).toBe('100.0000');
  });
});

// ---------------------------------------------------------------------------
// Crediting an invoice from the invoice
// ---------------------------------------------------------------------------

describe('POST /v1/invoices/:id/credit-note', () => {
  it('credits the whole invoice with only a date and a reason', async () => {
    const item = await createItem();

    const invoice = await call(api, {
      method: 'POST',
      ...as('/v1/invoices'),
      idempotencyKey: randomUUID(),
      body: {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [{ itemId: item['id'], quantity: '2' }],
      },
    });

    const credit = await call(api, {
      method: 'POST',
      ...as(`/v1/invoices/${invoice.body['id'] as string}/credit-note`),
      idempotencyKey: randomUUID(),
      body: { creditDate: '2026-08-06', reason: 'RETURN' },
    });

    expect(credit.status, JSON.stringify(credit.body)).toBe(201);
    // Nothing was retyped, and the totals match the original exactly.
    expect(credit.body['total']).toBe(invoice.body['total']);
  });

  it('refuses to credit more of a line than remains', async () => {
    const item = await createItem();

    const invoice = await call(api, {
      method: 'POST',
      ...as('/v1/invoices'),
      idempotencyKey: randomUUID(),
      body: {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [{ itemId: item['id'], quantity: '2' }],
      },
    });

    const [line] = await api.admin<{ id: string }[]>`
        SELECT id FROM invoice_line
         WHERE tenant_id = ${tenant.tenantId}
           AND invoice_id = ${invoice.body['id'] as string}
    `;

    const response = await call(api, {
      method: 'POST',
      ...as(`/v1/invoices/${invoice.body['id'] as string}/credit-note`),
      idempotencyKey: randomUUID(),
      body: {
        creditDate: '2026-08-06',
        reason: 'RETURN',
        lines: [{ invoiceLineId: line!.id, quantity: '5' }],
      },
    });

    expect(response.status).toBe(422);
    expect(String(response.body['message'])).toMatch(/only 2 remains uncredited/);
  });

  it('answers 404 for another tenant’s invoice, not 403', async () => {
    const other = await seedTenant(api.admin, 'Credit Other Sdn Bhd');
    const [theirs] = await api.admin<{ id: string }[]>`
        SELECT id FROM invoice WHERE tenant_id = ${other.tenantId} LIMIT 1
    `;

    const response = await call(api, {
      method: 'POST',
      ...as(`/v1/invoices/${theirs?.id ?? randomUUID()}/credit-note`),
      idempotencyKey: randomUUID(),
      body: { creditDate: '2026-08-06', reason: 'RETURN' },
    });

    expect(response.status).toBe(404);
  });
});
