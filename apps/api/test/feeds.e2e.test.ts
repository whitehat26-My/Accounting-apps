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
 * Bank feeds over HTTP — and the boundary that makes the push API safe to
 * hand out.
 *
 * The route an outside system calls is authenticated by an ordinary scoped
 * API key. The tests to care about are therefore the refusals: a key scoped
 * to bank.import must be able to deliver lines and do NOTHING else, and a
 * key scoped to something else must not be able to deliver lines. Get either
 * wrong and "here is a key for the bank feed" quietly hands over the books.
 */

let api: TestApi;
let tenant: Tenant;
let token: string;
let bankAccountId: string;

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

beforeAll(async () => {
  api = await createTestApi('feeds');
  tenant = await seedTenant(api.admin, 'Feed Routes Sdn Bhd');
  const owner = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, owner.refreshToken, tenant.tenantId));

  const account = await call(api, {
    method: 'POST',
    ...as('/v1/bank-accounts'),
    body: {
      name: 'Maybank Current',
      bankName: 'Malayan Banking Berhad',
      glAccountId: tenant.accounts['1000'],
    },
  });
  expect(account.status).toBe(201);
  bankAccountId = account.body['id'] as string;
}, 120_000);

afterAll(async () => {
  await api?.close();
});

describe('the sandbox pull loop', () => {
  let feedId: string;

  it('connects and fetches — and the second fetch imports nothing new', async () => {
    const connected = await call(api, {
      method: 'POST',
      ...as('/v1/bank-feeds'),
      body: { bankAccountId, provider: 'SANDBOX' },
    });
    expect(connected.status, JSON.stringify(connected.body)).toBe(201);
    feedId = connected.body['id'] as string;

    const first = await call(api, { method: 'POST', ...as(`/v1/bank-feeds/${feedId}/sync`) });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body['imported'] as number).toBeGreaterThan(0);

    // Again: the cursor narrows the window to today, the provider returns
    // the same facts for it, and the dedupe hash swallows every one. Zero
    // imported on a re-fetch is the whole pipeline proving itself.
    const second = await call(api, { method: 'POST', ...as(`/v1/bank-feeds/${feedId}/sync`) });
    expect(second.status).toBe(201);
    expect(second.body['imported']).toBe(0);
    expect(second.body['duplicates'] as number).toBeGreaterThan(0);
  });

  it('the fetched lines are ordinary bank lines in the ordinary queue', async () => {
    const lines = await call(api, {
      method: 'GET',
      ...as(`/v1/bank-accounts/${bankAccountId}/transactions`),
    });
    expect(lines.status).toBe(200);
    const rows = lines.body['transactions'] as { description: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.description.includes('DUITNOW QR'))).toBe(true);
  });

  it('is revoked cleanly, freeing the account for the push feed below', async () => {
    const revoked = await call(api, {
      method: 'PATCH',
      ...as(`/v1/bank-feeds/${feedId}`),
      body: { status: 'REVOKED' },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body['status']).toBe('REVOKED');
  });
});

describe('the push API', () => {
  let feedId: string;
  let pushKey: string;

  it('connects a push feed and issues a key scoped to bank.import only', async () => {
    const connected = await call(api, {
      method: 'POST',
      ...as('/v1/bank-feeds'),
      body: { bankAccountId, provider: 'API_PUSH' },
    });
    expect(connected.status, JSON.stringify(connected.body)).toBe(201);
    feedId = connected.body['id'] as string;

    const issued = await call(api, {
      method: 'POST',
      ...as('/v1/auth/api-keys'),
      body: { name: 'Bank feed push — Maybank Current', scopes: ['bank.import'] },
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    pushKey = issued.body['key'] as string;
  });

  it('a sync on a push feed explains itself instead of pretending to fetch', async () => {
    const synced = await call(api, { method: 'POST', ...as(`/v1/bank-feeds/${feedId}/sync`) });
    expect(synced.status).toBe(422);
    expect(synced.body['message']).toContain('pushed to, not pulled');
  });

  it('delivers lines with the KEY — no session, no password, no browser', async () => {
    const pushed = await call(api, {
      method: 'POST',
      url: `/v1/bank-feeds/${feedId}/transactions`,
      apiKey: pushKey,
      tenantId: tenant.tenantId,
      body: {
        transactions: [
          {
            date: '2026-08-05',
            description: 'DUITNOW QR SETTLEMENT EVENING',
            amount: '980.00',
            reference: 'QR-EVE-1',
          },
          { date: '2026-08-05', description: 'SHOPEE PAYOUT', amount: '445.20' },
        ],
      },
    });
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(201);
    expect(pushed.body['imported']).toBe(2);

    // Redelivery — a retrying script with a fresh idempotency key — dedupes.
    const again = await call(api, {
      method: 'POST',
      url: `/v1/bank-feeds/${feedId}/transactions`,
      apiKey: pushKey,
      tenantId: tenant.tenantId,
      body: {
        transactions: [
          {
            date: '2026-08-05',
            description: 'DUITNOW QR SETTLEMENT EVENING',
            amount: '980.00',
            reference: 'QR-EVE-1',
          },
        ],
      },
    });
    expect(again.status).toBe(201);
    expect(again.body['imported']).toBe(0);
    expect(again.body['duplicates']).toBe(1);
  });

  it('the push key can deliver bank lines and do NOTHING else', async () => {
    // The same key, pointed at the books: refused by scope, not by role.
    for (const url of ['/v1/invoices', '/v1/payroll/employees', '/v1/reports/trial-balance']) {
      const response = await call(api, {
        method: 'GET',
        url,
        apiKey: pushKey,
        tenantId: tenant.tenantId,
      });
      expect(response.status, url).toBe(403);
    }
  });

  it('a key scoped to something else cannot deliver lines', async () => {
    const issued = await call(api, {
      method: 'POST',
      ...as('/v1/auth/api-keys'),
      body: { name: 'Not a feed key', scopes: ['invoice.read'] },
    });
    expect(issued.status).toBe(201);

    const refused = await call(api, {
      method: 'POST',
      url: `/v1/bank-feeds/${feedId}/transactions`,
      apiKey: issued.body['key'] as string,
      tenantId: tenant.tenantId,
      body: {
        transactions: [{ date: '2026-08-05', description: 'SNEAKY', amount: '1.00' }],
      },
    });
    expect(refused.status).toBe(403);
  });

  it('money as JSON numbers is refused at the door', async () => {
    const refused = await call(api, {
      method: 'POST',
      url: `/v1/bank-feeds/${feedId}/transactions`,
      apiKey: pushKey,
      tenantId: tenant.tenantId,
      body: { transactions: [{ date: '2026-08-05', description: 'FLOAT', amount: 980.0 }] },
    });
    // Rule 2: an amount that travelled as a float never reaches Money.
    expect(refused.status).toBe(422);
  });

  it('SALES cannot see or touch feeds at all', async () => {
    const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
    const { accessToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId);
    const listed = await call(api, {
      method: 'GET',
      url: '/v1/bank-feeds',
      token: accessToken,
      tenantId: tenant.tenantId,
    });
    expect(listed.status).toBe(403);
  });
});
