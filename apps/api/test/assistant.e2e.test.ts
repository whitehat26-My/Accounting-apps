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

/**
 * The assistant, end to end, with the FAKE provider — which drives the REAL
 * execution path (permission filter, tool validation, database writes, draft
 * collection) through a deterministic `TOOL name {json}` grammar. What is
 * asserted here is exactly what matters about the feature:
 *
 *   1. Unconfigured is an honest state, not an error.
 *   2. A tool the role does not hold is not merely refused — it does not exist.
 *   3. Catalogue writes really write; money tools really do NOT.
 */

describe('assistant — unconfigured (the honest default)', () => {
  let api: TestApi;
  let tenant: Tenant;
  let token: string;

  beforeAll(async () => {
    delete process.env['EMIL_ENABLE_FAKE_ASSISTANT'];
    api = await createTestApi('asst_off');
    tenant = await seedTenant(api.admin, 'Unconfigured Sdn Bhd');
    const user = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
    ({ accessToken: token } = await accessTokenFor(api, user.refreshToken, tenant.tenantId));
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  it('says so on the status route', async () => {
    const response = await call(api, {
      method: 'GET', url: '/v1/assistant/status', token, tenantId: tenant.tenantId,
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ configured: false, provider: 'unconfigured' });
  });

  it('answers chat with what is missing, not a 500', async () => {
    const response = await call(api, {
      method: 'POST', url: '/v1/assistant/chat', token, tenantId: tenant.tenantId,
      idempotencyKey: randomUUID(),
      body: { messages: [{ role: 'user', content: 'How is my shop doing?' }] },
    });
    expect(response.status).toBe(201);
    expect(response.body['configured']).toBe(false);
    expect(response.body['message']).toContain('ANTHROPIC_API_KEY');
  });

  it('requires authentication like every other tenant route', async () => {
    const response = await call(api, { method: 'GET', url: '/v1/assistant/status' });
    expect(response.status).toBe(401);
  });
});

describe('assistant — fake provider drives the real tool path', () => {
  let api: TestApi;
  let tenant: Tenant;
  let owner: string;
  let cashier: string;

  beforeAll(async () => {
    process.env['EMIL_ENABLE_FAKE_ASSISTANT'] = '1';
    api = await createTestApi('asst_fake');
    delete process.env['EMIL_ENABLE_FAKE_ASSISTANT'];

    tenant = await seedTenant(api.admin, 'Assistant Sdn Bhd');
    const boss = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
    ({ accessToken: owner } = await accessTokenFor(api, boss.refreshToken, tenant.tenantId));
    const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
    ({ accessToken: cashier } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId));
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  const chat = (token: string, content: string) =>
    call(api, {
      method: 'POST', url: '/v1/assistant/chat', token, tenantId: tenant.tenantId,
      idempotencyKey: randomUUID(),
      body: { messages: [{ role: 'user', content }] },
    });

  it('reports itself configured, with the fake named as such', async () => {
    const response = await call(api, {
      method: 'GET', url: '/v1/assistant/status', token: owner, tenantId: tenant.tenantId,
    });
    expect(response.body).toEqual({ configured: true, provider: 'fake' });
  });

  it('record_item creates a real catalogue row and reports the action', async () => {
    const response = await chat(
      owner,
      'TOOL record_item {"code":"AI-MOUSE","name":"Wireless mouse","itemType":"GOODS","salePrice":"45.00"}',
    );
    expect(response.status).toBe(201);
    expect(response.body['message']).toContain('Created item AI-MOUSE');
    const actions = response.body['actions'] as { type: string; label: string }[];
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe('ITEM_CREATED');

    const items = await call(api, {
      method: 'GET', url: '/v1/items?search=AI-MOUSE', token: owner, tenantId: tenant.tenantId,
    });
    expect(JSON.stringify(items.body)).toContain('AI-MOUSE');
  });

  it('a cashier has no item tool AT ALL — filtered, not just refused', async () => {
    const response = await chat(
      cashier,
      'TOOL record_item {"code":"AI-SNEAK","name":"Should not exist"}',
    );
    expect(response.status).toBe(201);
    expect(response.body['message']).toContain('FAKE:NO_SUCH_TOOL');

    const sneak = await call(api, {
      method: 'GET', url: '/v1/items?search=AI-SNEAK', token: owner, tenantId: tenant.tenantId,
    });
    expect(JSON.stringify(sneak.body)).not.toContain('AI-SNEAK');
  });

  it('draft_cash_sale returns a DRAFT and posts nothing to the ledger', async () => {
    const response = await chat(
      cashier,
      'TOOL draft_cash_sale {"lines":[{"itemCode":"AI-MOUSE","quantity":"2"}],"method":"CASH"}',
    );
    expect(response.status).toBe(201);
    expect(response.body['message']).toContain('Draft ready');

    const drafts = response.body['drafts'] as {
      kind: string; endpoint: string; lines: { amount: string }[];
      payload: { lines: { itemId?: string }[] };
    }[];
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.kind).toBe('CASH_SALE');
    expect(drafts[0]!.endpoint).toBe('/v1/pos/sales');
    expect(drafts[0]!.payload.lines[0]!.itemId).toBeDefined();
    // Money arithmetic happened in Money: 2 x RM 45.00.
    expect(drafts[0]!.lines[0]!.amount).toBe('90.0000');

    // The proof of the whole design: NOTHING was recorded by the draft.
    // Same KL-timezone date the tool itself stamped on the payload.
    const klToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const takings = await call(api, {
      method: 'GET',
      url: `/v1/pos/takings?date=${klToday}`,
      token: cashier, tenantId: tenant.tenantId,
    });
    expect(takings.body['invoiceCount']).toBe(0);
  });

  it('draft_invoice with an unknown customer teaches instead of inventing one', async () => {
    const response = await chat(
      owner,
      'TOOL draft_invoice {"contactName":"Nobody Enterprise","lines":[{"itemCode":"AI-MOUSE","quantity":"1"}]}',
    );
    expect(response.status).toBe(201);
    expect(response.body['message']).toContain('No customer named');
    expect(response.body['drafts']).toHaveLength(0);
  });

  it('the confirmed draft rings through the NORMAL endpoint with the user token', async () => {
    // What the web's Confirm button does: POST the draft payload as-is, plus
    // the deposit account the POS screen itself would pick.
    const draft = await chat(
      cashier,
      'TOOL draft_cash_sale {"lines":[{"itemCode":"AI-MOUSE","quantity":"1"}],"method":"CASH"}',
    );
    const payload = (draft.body['drafts'] as { payload: Record<string, unknown> }[])[0]!.payload;

    const rung = await call(api, {
      method: 'POST', url: '/v1/pos/sales', token: cashier, tenantId: tenant.tenantId,
      idempotencyKey: randomUUID(),
      body: { ...payload, depositAccountId: tenant.accounts['1000'] },
    });
    expect(rung.status, JSON.stringify(rung.body)).toBe(201);
  });
});
