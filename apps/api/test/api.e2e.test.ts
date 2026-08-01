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
let alpha: Tenant;
let beta: Tenant;

beforeAll(async () => {
  api = await createTestApi('e2e');
  alpha = await seedTenant(api.admin, 'Alpha Trading Sdn Bhd');
  beta = await seedTenant(api.admin, 'Beta Services Sdn Bhd');
}, 120_000);

afterAll(async () => {
  await api?.close();
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('registers, logs in, and lists the user’s organisations', async () => {
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });

    const login = await call(api, {
      method: 'POST',
      url: '/v1/auth/login',
      body: { email: user.email, password: user.password },
    });

    expect(login.status).toBe(201);
    expect(login.body['refreshToken']).toBeTypeOf('string');
    // No access token yet: one is scoped to an organisation, and we do not
    // know which the user wants. Minting one for an arbitrary organisation
    // would be a credential nobody asked for.
    expect(login.body['accessToken']).toBeUndefined();
    expect(login.body['organisations']).toHaveLength(1);
  });

  it('refuses bad credentials with the same message as an unknown email', async () => {
    const user = await makeUser(api, { tenantId: alpha.tenantId });

    const wrongPassword = await call(api, {
      method: 'POST',
      url: '/v1/auth/login',
      body: { email: user.email, password: 'wrong but long enough' },
    });
    const unknownEmail = await call(api, {
      method: 'POST',
      url: '/v1/auth/login',
      body: { email: 'nobody@example.com', password: 'wrong but long enough' },
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body['message']).toBe(unknownEmail.body['message']);
  });

  it('mints an access token for one organisation', async () => {
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'ACCOUNTANT' });
    const { status, body } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    expect(status).toBe(201);
    expect(body['tenantId']).toBe(alpha.tenantId);
    expect(body['role']).toBe('ACCOUNTANT');
    expect(body['permissions']).toContain('journal.post');
  });

  it('rejects a request with no credential', async () => {
    const response = await call(api, {
      method: 'GET',
      url: '/v1/receivables',
      tenantId: alpha.tenantId,
    });
    expect(response.status).toBe(401);
  });

  it('rejects a request with no X-Tenant-Id', async () => {
    const user = await makeUser(api, { tenantId: alpha.tenantId });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const response = await call(api, { method: 'GET', url: '/v1/receivables', token: accessToken });
    expect(response.status).toBe(401);
  });

  it('rejects a tampered token without saying whether the signature or the expiry failed', async () => {
    const user = await makeUser(api, { tenantId: alpha.tenantId });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const tampered = `${accessToken.slice(0, -4)}AAAA`;
    const response = await call(api, {
      method: 'GET',
      url: '/v1/receivables',
      token: tampered,
      tenantId: alpha.tenantId,
    });

    expect(response.status).toBe(401);
    // Distinguishing the two would tell an attacker whether they have the key.
    expect(response.body['message']).toBe('Invalid or expired token');
  });
});

// ---------------------------------------------------------------------------
// The tenant boundary — the most important tests in this file
// ---------------------------------------------------------------------------

describe('the tenant boundary', () => {
  it('returns 404, NOT 403, for an organisation the user does not belong to', async () => {
    // CLAUDE.md rule 9. A 403 confirms the organisation EXISTS, which is enough
    // to enumerate this product's customer list one id at a time — and to
    // confirm whether a named company is a customer, which is commercially
    // sensitive on its own.
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });

    const switched = await accessTokenFor(api, user.refreshToken, beta.tenantId);
    expect(switched.status).toBe(404);
    expect(switched.body['error']).toBe('not_found');
  });

  it('returns 404 for an organisation that does not exist at all', async () => {
    // Indistinguishable from the case above. That is the point: the two
    // responses must be identical or the difference IS the oracle.
    const user = await makeUser(api, { tenantId: alpha.tenantId });
    const switched = await accessTokenFor(api, user.refreshToken, randomUUID());

    expect(switched.status).toBe(404);
    expect(switched.body['error']).toBe('not_found');
  });

  it('refuses a token minted for another organisation, whatever the header says', async () => {
    // The reason the tenant is asserted from BOTH the token and the header.
    // Trusting the header alone would make this request succeed.
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });
    await makeUser(api, { tenantId: beta.tenantId });

    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const response = await call(api, {
      method: 'GET',
      url: '/v1/receivables',
      token: accessToken,
      tenantId: beta.tenantId,
    });

    expect(response.status).toBe(401);
  });

  it('an invoice issued in one organisation is invisible from another', async () => {
    const inAlpha = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });
    const inBeta = await makeUser(api, { tenantId: beta.tenantId, role: 'ADMIN' });

    const alphaToken = (await accessTokenFor(api, inAlpha.refreshToken, alpha.tenantId)).accessToken;
    const betaToken = (await accessTokenFor(api, inBeta.refreshToken, beta.tenantId)).accessToken;

    const issued = await call(api, {
      method: 'POST',
      url: '/v1/invoices',
      token: alphaToken,
      tenantId: alpha.tenantId,
      body: invoiceBody(alpha),
    });
    expect(issued.status).toBe(201);

    const alphaReceivables = await call(api, {
      method: 'GET',
      url: '/v1/receivables',
      token: alphaToken,
      tenantId: alpha.tenantId,
    });
    const betaReceivables = await call(api, {
      method: 'GET',
      url: '/v1/receivables',
      token: betaToken,
      tenantId: beta.tenantId,
    });

    expect(Number(alphaReceivables.body['count'])).toBeGreaterThan(0);
    expect(Number(betaReceivables.body['count'])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe('role-based access control', () => {
  it('allows an action the role holds', async () => {
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'BOOKKEEPER' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const response = await call(api, {
      method: 'POST',
      url: '/v1/invoices',
      token: accessToken,
      tenantId: alpha.tenantId,
      body: invoiceBody(alpha),
    });

    expect(response.status).toBe(201);
  });

  it('refuses an action the role lacks with a 403 naming the permission', async () => {
    // A 403 here, not a 404: the user is legitimately inside the tenant, so
    // acknowledging the endpoint tells an attacker nothing new. And naming the
    // permission is what lets them ask an administrator for the right thing.
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'READ_ONLY' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const response = await call(api, {
      method: 'POST',
      url: '/v1/invoices',
      token: accessToken,
      tenantId: alpha.tenantId,
      body: invoiceBody(alpha),
    });

    expect(response.status).toBe(403);
    expect(response.body['permission']).toBe('invoice.create');
  });

  it('a SALES role can invoice but cannot enter a bill', async () => {
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'SALES' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const invoice = await call(api, {
      method: 'POST',
      url: '/v1/invoices',
      token: accessToken,
      tenantId: alpha.tenantId,
      body: invoiceBody(alpha),
    });
    expect(invoice.status).toBe(201);

    const bill = await call(api, {
      method: 'POST',
      url: '/v1/bills',
      token: accessToken,
      tenantId: alpha.tenantId,
      body: billBody(alpha),
    });
    expect(bill.status).toBe(403);
  });

  it('an APPROVER cannot enter the bills it approves', async () => {
    // Separation of duties. An approval workflow where the same person can
    // raise and approve is not a control, it is paperwork — and this matrix is
    // what will make the deferred M3 approval workflow meaningful.
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'APPROVER' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const bill = await call(api, {
      method: 'POST',
      url: '/v1/bills',
      token: accessToken,
      tenantId: alpha.tenantId,
      body: billBody(alpha),
    });
    expect(bill.status).toBe(403);

    const payables = await call(api, {
      method: 'GET',
      url: '/v1/payables',
      token: accessToken,
      tenantId: alpha.tenantId,
    });
    expect(payables.status).toBe(200);
  });

  it('refuses to grant a role above the actor’s own', async () => {
    const admin = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });
    const target = await makeUser(api);
    const { accessToken } = await accessTokenFor(api, admin.refreshToken, alpha.tenantId);

    const response = await call(api, {
      method: 'POST',
      url: '/v1/auth/members',
      token: accessToken,
      tenantId: alpha.tenantId,
      body: { userId: target.userId, role: 'OWNER' },
    });

    expect(response.status).toBe(422);
    expect(response.body['message']).toMatch(/outranks your own/i);
  });
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

describe('API keys', () => {
  it('authenticates and is narrowed by its scopes, not widened by the owner’s role', async () => {
    const owner = await makeUser(api, { tenantId: alpha.tenantId, role: 'OWNER' });
    const { accessToken } = await accessTokenFor(api, owner.refreshToken, alpha.tenantId);

    const issued = await call(api, {
      method: 'POST',
      url: '/v1/auth/api-keys',
      token: accessToken,
      tenantId: alpha.tenantId,
      body: { name: 'Reporting', scopes: ['report.read'] },
    });
    expect(issued.status).toBe(201);
    const key = issued.body['key'] as string;

    const allowed = await call(api, {
      method: 'GET',
      url: '/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31',
      apiKey: key,
      tenantId: alpha.tenantId,
    });
    expect(allowed.status).toBe(200);

    // The OWNER may issue invoices. The key may not.
    const refused = await call(api, {
      method: 'POST',
      url: '/v1/invoices',
      apiKey: key,
      tenantId: alpha.tenantId,
      body: invoiceBody(alpha),
    });
    expect(refused.status).toBe(403);
  });

  it('is bound to the organisation it was issued for', async () => {
    const owner = await makeUser(api, { tenantId: alpha.tenantId, role: 'OWNER' });
    const { accessToken } = await accessTokenFor(api, owner.refreshToken, alpha.tenantId);

    const issued = await call(api, {
      method: 'POST',
      url: '/v1/auth/api-keys',
      token: accessToken,
      tenantId: alpha.tenantId,
      body: { name: 'Scoped', scopes: ['report.read'] },
    });

    const crossTenant = await call(api, {
      method: 'GET',
      url: '/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31',
      apiKey: issued.body['key'] as string,
      tenantId: beta.tenantId,
    });
    expect(crossTenant.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Idempotency and validation
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('requires an Idempotency-Key on every write', async () => {
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const response = await call(api, {
      method: 'POST',
      url: '/v1/invoices',
      token: accessToken,
      tenantId: alpha.tenantId,
      idempotencyKey: null,
      body: invoiceBody(alpha),
    });

    expect(response.status).toBe(422);
    expect(response.body['message']).toMatch(/Idempotency-Key/);
  });

  it('replays rather than posting twice, and says so', async () => {
    // The guarantee comes from a UNIQUE constraint inside the same transaction
    // as the write — not from a cache in front of it. See the interceptor.
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);
    const key = randomUUID();

    const first = await call(api, {
      method: 'POST',
      url: '/v1/invoices',
      token: accessToken,
      tenantId: alpha.tenantId,
      idempotencyKey: key,
      body: invoiceBody(alpha),
    });
    const second = await call(api, {
      method: 'POST',
      url: '/v1/invoices',
      token: accessToken,
      tenantId: alpha.tenantId,
      idempotencyKey: key,
      body: invoiceBody(alpha),
    });

    expect(first.body['replayed']).toBe(false);
    expect(second.body['replayed']).toBe(true);
    expect(second.body['id']).toBe(first.body['id']);
    expect(second.body['invoiceNo']).toBe(first.body['invoiceNo']);
  });

  it('does not require a key on a read', async () => {
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const response = await call(api, {
      method: 'GET',
      url: '/v1/receivables',
      token: accessToken,
      tenantId: alpha.tenantId,
      idempotencyKey: null,
    });
    expect(response.status).toBe(200);
  });
});

describe('validation', () => {
  it('reports every problem at once rather than the first', async () => {
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const response = await call(api, {
      method: 'POST',
      url: '/v1/invoices',
      token: accessToken,
      tenantId: alpha.tenantId,
      body: { contactId: 'not-a-uuid', issueDate: '20/08/2026', lines: [] },
    });

    expect(response.status).toBe(422);
    const detail = response.body['detail'] as { path: string }[];
    expect(detail.length).toBeGreaterThan(2);
  });

  it('refuses money as a JSON number', async () => {
    // A JSON number is an IEEE-754 double. Accepting one would put a float in
    // the one place this system has been careful to keep them out of.
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const body = invoiceBody(alpha);
    const response = await call(api, {
      method: 'POST',
      url: '/v1/invoices',
      token: accessToken,
      tenantId: alpha.tenantId,
      body: {
        ...body,
        lines: [{ ...body.lines[0], unitPrice: 1080.5 }],
      },
    });

    expect(response.status).toBe(422);
  });

  it('surfaces a service-level failure as a 422 with its code', async () => {
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const response = await call(api, {
      method: 'POST',
      url: '/v1/bills',
      token: accessToken,
      tenantId: alpha.tenantId,
      // The customer, not the supplier. The service refuses by name.
      body: { ...billBody(alpha), supplierId: alpha.customerId },
    });

    expect(response.status).toBe(422);
    expect(response.body['code']).toBe('NOT_A_SUPPLIER');
  });

  it('turns a cross-tenant contact into a 404, not a 403', async () => {
    // RLS filtered beta's contact out before the service saw it, so the service
    // genuinely cannot tell "does not exist" from "not yours" — and neither
    // should the response.
    const user = await makeUser(api, { tenantId: alpha.tenantId, role: 'ADMIN' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, alpha.tenantId);

    const response = await call(api, {
      method: 'POST',
      url: '/v1/invoices',
      token: accessToken,
      tenantId: alpha.tenantId,
      body: { ...invoiceBody(alpha), contactId: beta.customerId },
    });

    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// A full cycle through the API
// ---------------------------------------------------------------------------

describe('a full accounting cycle over HTTP', () => {
  it('invoices, receipts, bills, pays and reports — and the balance sheet balances', async () => {
    const tenant = await seedTenant(api.admin, 'Cycle Sdn Bhd');
    const user = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, tenant.tenantId);

    const as = (method: 'GET' | 'POST', url: string, body?: unknown) =>
      call(api, { method, url, token: accessToken, tenantId: tenant.tenantId, ...(body !== undefined ? { body } : {}) });

    const invoice = await as('POST', '/v1/invoices', invoiceBody(tenant));
    expect(invoice.status).toBe(201);

    const receipt = await as('POST', '/v1/receipts', {
      contactId: tenant.customerId,
      paymentDate: '2026-08-20',
      amount: '500.00',
      method: 'DUITNOW',
      depositAccountId: tenant.accounts['1000'],
      allocations: [{ invoiceId: invoice.body['id'], amount: '500.00' }],
    });
    expect(receipt.status).toBe(201);

    const bill = await as('POST', '/v1/bills', billBody(tenant));
    expect(bill.status).toBe(201);

    const payment = await as('POST', '/v1/supplier-payments', {
      supplierId: tenant.supplierId,
      paymentDate: '2026-08-22',
      amount: '300.00',
      method: 'TRANSFER',
      depositAccountId: tenant.accounts['1000'],
      allocations: [{ billId: bill.body['id'], amount: '300.00' }],
    });
    expect(payment.status).toBe(201);

    const trialBalance = await as('GET', '/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    expect(trialBalance.status).toBe(200);
    expect(trialBalance.body['balanced']).toBe(true);

    const sofp = await as('GET', '/v1/reports/sofp?asOf=2026-12-31');
    expect(sofp.status).toBe(200);
    expect((sofp.body['lines'] as unknown[]).length).toBeGreaterThan(0);

    const sopl = await as('GET', '/v1/reports/sopl?from=2026-01-01&to=2026-12-31');
    expect(sopl.status).toBe(200);

    const ageing = await as('GET', '/v1/receivables/ageing?asOf=2026-12-31');
    expect(ageing.status).toBe(200);
    expect((ageing.body['buckets'] as unknown[]).length).toBe(5);

    // Money crosses the wire as a decimal STRING throughout.
    expect(typeof (ageing.body['total'] as string)).toBe('string');
  });
});

// ---------------------------------------------------------------------------

function invoiceBody(tenant: Tenant) {
  return {
    contactId: tenant.customerId,
    issueDate: '2026-08-05',
    lines: [
      {
        description: 'Consulting services',
        quantity: '1',
        unitPrice: '1080.00',
        accountId: tenant.accounts['4000'],
        taxCodeId: tenant.taxCodes['NONE'],
      },
    ],
  };
}

function billBody(tenant: Tenant) {
  return {
    supplierId: tenant.supplierId,
    billNo: `SUP-${randomUUID().slice(0, 8)}`,
    billDate: '2026-08-06',
    lines: [
      {
        description: 'Office supplies',
        quantity: '1',
        unitPrice: '600.00',
        accountId: tenant.accounts['6000'],
        taxCodeId: tenant.taxCodes['NONE'],
      },
    ],
  };
}
