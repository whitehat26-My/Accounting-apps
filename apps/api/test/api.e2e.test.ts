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

describe('the printed credit note', () => {
  /*
   * Until now a credit note could be ISSUED and never read back: it existed in
   * the ledger and on the customer's balance, and the customer could not be
   * shown the paper explaining why they were credited. This is that read path,
   * end to end, plus the residue case that makes the document worth printing.
   */
  it('prints the reason in words, and names the invoice it corrects', async () => {
    const tenant = await seedTenant(api.admin, 'Credit Sdn Bhd');
    const user = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, tenant.tenantId);
    const as = (url: string) => ({ url, token: accessToken, tenantId: tenant.tenantId });

    const invoice = await call(api, { method: 'POST', ...as('/v1/invoices'),
      idempotencyKey: randomUUID(), body: invoiceBody(tenant) });
    expect(invoice.status).toBe(201);

    /*
     * Omitting `lines` credits everything not already credited — the whole
     * RM 1,080. Every figure is read off the original, which is the point of
     * crediting FROM an invoice rather than raising a standalone note.
     */
    const credited = await call(api, {
      method: 'POST',
      ...as(`/v1/invoices/${invoice.body['id']}/credit-note`),
      idempotencyKey: randomUUID(),
      body: {
        creditDate: '2026-08-12',
        reason: 'RETURN',
        reasonDetail: 'Customer returned one unit, unopened, within the change-of-mind window.',
      },
    });
    expect(credited.status, JSON.stringify(credited.body)).toBe(201);

    const list = await call(api, { method: 'GET', ...as('/v1/credit-notes') });
    expect(list.status).toBe(200);
    const notes = list.body['creditNotes'] as Record<string, unknown>[];
    expect(notes).toHaveLength(1);
    expect(notes[0]!['againstInvoiceNo']).toBe(invoice.body['invoiceNo']);

    const pdf = await callRaw(api, {
      method: 'GET',
      ...as(`/v1/credit-notes/${notes[0]!['id']}/pdf`),
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');

    const text = pdfText(pdf.body);
    expect(text).toContain('CREDIT NOTE');
    // The REASON, in words rather than as the database's code.
    expect(text).toContain('Goods returned');
    expect(text).not.toContain('RETURN');
    expect(text).toContain('change-of-mind window');
    // It names the invoice it corrects, which is what makes it filable.
    expect(text).toContain(String(invoice.body['invoiceNo']));
    expect(text).toContain('1,080.00');
    // Amounts print POSITIVE — direction lives in the journal, and a minus
    // sign on a page headed CREDIT NOTE reads as a double negative.
    expect(text).not.toContain('-1,080.00');
  });

  it('answers 404 for a credit note that is not this tenant’s', async () => {
    const tenant = await seedTenant(api.admin, 'Credit Boundary Sdn Bhd');
    const user = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, tenant.tenantId);

    const response = await callRaw(api, {
      method: 'GET',
      url: `/v1/credit-notes/${randomUUID()}/pdf`,
      token: accessToken,
      tenantId: tenant.tenantId,
    });
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Bill approval over HTTP
// ---------------------------------------------------------------------------

describe('bill approval', () => {
  it('gates payment without gating recognition, and enforces two distinct people', async () => {
    const tenant = await seedTenant(api.admin, 'Approval E2E Sdn Bhd');

    const clerk = await makeUser(api, { tenantId: tenant.tenantId, role: 'BOOKKEEPER' });
    const acct = await makeUser(api, { tenantId: tenant.tenantId, role: 'ACCOUNTANT' });
    const boss = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });

    const clerkToken = (await accessTokenFor(api, clerk.refreshToken, tenant.tenantId)).accessToken;
    const acctToken = (await accessTokenFor(api, acct.refreshToken, tenant.tenantId)).accessToken;
    const bossToken = (await accessTokenFor(api, boss.refreshToken, tenant.tenantId)).accessToken;

    const as = (token: string) => (method: 'GET' | 'POST', url: string, body?: unknown) =>
      call(api, { method, url, token, tenantId: tenant.tenantId, ...(body !== undefined ? { body } : {}) });

    // Only an OWNER holds org.manage, so only they may set a threshold.
    const rule = await as(bossToken)('POST', '/v1/approval-rules', {
      name: 'Over RM 1,000',
      minAmount: '1000.00',
      requiredRole: 'ACCOUNTANT',
      sequence: 1,
    });
    expect(rule.status).toBe(201);

    const rule2 = await as(bossToken)('POST', '/v1/approval-rules', {
      name: 'Over RM 10,000',
      minAmount: '10000.00',
      requiredRole: 'OWNER',
      sequence: 2,
    });
    expect(rule2.status).toBe(201);

    // The clerk enters a large bill.
    const bill = await as(clerkToken)('POST', '/v1/bills', {
      ...billBody(tenant),
      lines: [
        {
          description: 'Contract work',
          quantity: '1',
          unitPrice: '50000.00',
          accountId: tenant.accounts['6000'],
          taxCodeId: tenant.taxCodes['NONE'],
        },
      ],
    });
    expect(bill.status).toBe(201);
    expect(bill.body['approvalRequestId']).toBeTypeOf('string');

    // It is IN THE LEDGER already. Approval gates payment, not recognition.
    const payables = await as(bossToken)('GET', '/v1/payables');
    expect(Number(payables.body['count'])).toBeGreaterThan(0);

    const billId = bill.body['id'] as string;

    // ...but it cannot be paid, and the response says who is being waited on.
    const blocked = await as(acctToken)('POST', '/v1/supplier-payments', {
      supplierId: tenant.supplierId,
      paymentDate: '2026-08-20',
      amount: '50000.00',
      method: 'TRANSFER',
      depositAccountId: tenant.accounts['1000'],
      allocations: [{ billId, amount: '50000.00' }],
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body['message']).toMatch(/awaiting approval/i);
    expect(blocked.body['message']).toMatch(/ACCOUNTANT/);

    // The clerk who raised it cannot approve it — but they also lack the
    // permission, so the guard refuses before the rule is even consulted.
    const selfApproval = await as(clerkToken)('POST', `/v1/bills/${billId}/approval`, {
      sequence: 1,
      decision: 'APPROVE',
    });
    expect(selfApproval.status).toBe(403);

    // Step 1 by the accountant.
    const first = await as(acctToken)('POST', `/v1/bills/${billId}/approval`, {
      sequence: 1,
      decision: 'APPROVE',
    });
    expect(first.status).toBe(201);
    expect(first.body['status']).toBe('PENDING');

    // Still not payable — one step outstanding.
    const stillBlocked = await as(acctToken)('POST', '/v1/supplier-payments', {
      supplierId: tenant.supplierId,
      paymentDate: '2026-08-20',
      amount: '50000.00',
      method: 'TRANSFER',
      depositAccountId: tenant.accounts['1000'],
      allocations: [{ billId, amount: '50000.00' }],
    });
    expect(stillBlocked.status).toBe(422);

    // The accountant cannot also fill step 2, even though they can reach it.
    const doubleUp = await as(acctToken)('POST', `/v1/bills/${billId}/approval`, {
      sequence: 2,
      decision: 'APPROVE',
    });
    expect(doubleUp.status).toBe(422);
    expect(doubleUp.body['message']).toMatch(/already decided|different person/i);

    // The owner completes it.
    const second = await as(bossToken)('POST', `/v1/bills/${billId}/approval`, {
      sequence: 2,
      decision: 'APPROVE',
    });
    expect(second.body['status']).toBe('APPROVED');

    const paid = await as(acctToken)('POST', '/v1/supplier-payments', {
      supplierId: tenant.supplierId,
      paymentDate: '2026-08-20',
      amount: '50000.00',
      method: 'TRANSFER',
      depositAccountId: tenant.accounts['1000'],
      allocations: [{ billId, amount: '50000.00' }],
    });
    expect(paid.status).toBe(201);
  });

  it('reports NOT_REQUIRED for a bill below every threshold', async () => {
    const tenant = await seedTenant(api.admin, 'No Threshold Sdn Bhd');
    const user = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
    const { accessToken } = await accessTokenFor(api, user.refreshToken, tenant.tenantId);

    const bill = await call(api, {
      method: 'POST',
      url: '/v1/bills',
      token: accessToken,
      tenantId: tenant.tenantId,
      body: billBody(tenant),
    });

    const approval = await call(api, {
      method: 'GET',
      url: `/v1/bills/${bill.body['id'] as string}/approval`,
      token: accessToken,
      tenantId: tenant.tenantId,
    });

    expect(approval.body['status']).toBe('NOT_REQUIRED');
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

describe('proof packs over HTTP', () => {
  it('issues, confirms, and refuses a doctored pack', async () => {
    const owner = await makeUser(api, { tenantId: alpha.tenantId, role: 'OWNER' });
    const { accessToken } = await accessTokenFor(api, owner.refreshToken, alpha.tenantId);
    const as = (url: string) => ({ url, token: accessToken, tenantId: alpha.tenantId });

    const anchored = await call(api, {
      method: 'POST',
      ...as('/v1/audit-chain/anchors'),
      body: {},
    });
    expect(anchored.status, JSON.stringify(anchored.body)).toBe(201);

    const pack = await call(api, { method: 'GET', ...as('/v1/audit-chain/proof') });
    expect(pack.status).toBe(200);
    expect(pack.body['format']).toBe('emil-proof-pack/1');
    // The algorithm travels WITH the pack, so a third party needs nothing else.
    expect(String(pack.body['algorithm'])).toContain('SHA-256');

    const confirmed = await call(api, {
      method: 'POST',
      ...as('/v1/audit-chain/proof/verify'),
      body: pack.body,
    });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body['verdict']).toBe('CONFIRMED');

    const doctored = {
      ...pack.body,
      organisation: { id: alpha.tenantId, name: 'Nicer Name Sdn Bhd' },
    };
    const refused = await call(api, {
      method: 'POST',
      ...as('/v1/audit-chain/proof/verify'),
      body: doctored,
    });
    /*
     * A successful HTTP answer carrying a damning verdict. "Your books were
     * tampered with" IS the answer to the question asked; an error status
     * would be indistinguishable from the endpoint being down, which is the
     * one thing a monitor must not confuse it with.
     */
    expect(refused.status).toBe(201);
    expect(refused.body['verdict']).toBe('PACK_ALTERED');
  });
});

/**
 * Two companies on one server, and whose name is on the paper.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO PREVENT COMING BACK.
 *
 * Every row in this database has carried `tenant_id` since migration 0001, with
 * RLS enabled and forced — two companies' books have always been genuinely
 * separate. But the LOGO on every printed document was a PNG compiled into the
 * API image, so the second company to sign up would have issued its invoices
 * under the first company's mark.
 *
 * That is not a cosmetic complaint. An invoice is the document that says who is
 * owed money; carrying someone else's mark makes it a document about the wrong
 * party. Migration 0050 moved the brand from the build into the row, and this
 * asserts the property that change exists for.
 * ---------------------------------------------------------------------------
 */
describe('two companies, two letterheads', () => {
  // Distinguishable PNGs: 1x1 and 2x2, so "which logo came back" is decidable
  // from the bytes rather than from a hopeful eyeball.
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const PNG_2PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4IScHRAwQCgAfJgQRoo8irwAAAABJRU5ErkJggg==';

  let alphaToken: string;
  let betaToken: string;

  beforeAll(async () => {
    const a = await makeUser(api, { tenantId: alpha.tenantId, role: 'OWNER' });
    ({ accessToken: alphaToken } = await accessTokenFor(api, a.refreshToken, alpha.tenantId));
    const b = await makeUser(api, { tenantId: beta.tenantId, role: 'OWNER' });
    ({ accessToken: betaToken } = await accessTokenFor(api, b.refreshToken, beta.tenantId));
  });

  const asAlpha = (url: string) => ({ url, token: alphaToken, tenantId: alpha.tenantId });
  const asBeta = (url: string) => ({ url, token: betaToken, tenantId: beta.tenantId });

  it('starts every organisation with no mark at all', async () => {
    // 204, not 404. Most organisations have no logo and the screen wants to
    // know that rather than to catch something.
    const none = await callRaw(api, { method: 'GET', ...asAlpha('/v1/organisations/logo') });
    expect(none.status).toBe(204);
  });

  it('gives each company its own mark, and never the other one’s', async () => {
    for (const [as, png] of [[asAlpha, PNG_1PX], [asBeta, PNG_2PX]] as const) {
      const set = await call(api, {
        method: 'PUT',
        ...as('/v1/organisations/brand'),
        body: { logoBase64: png, logoContentType: 'image/png', brandColour: null },
      });
      expect(set.status).toBe(200);
    }

    const mine = await callRaw(api, { method: 'GET', ...asAlpha('/v1/organisations/logo') });
    expect(mine.status).toBe(200);
    expect(Number(mine.headers['content-length'])).toBe(Buffer.from(PNG_1PX, 'base64').length);
    // A picture of one company's brand behind an authenticated route must not
    // sit in a shared cache.
    expect(mine.headers['cache-control']).toContain('no-store');

    const theirs = await callRaw(api, { method: 'GET', ...asBeta('/v1/organisations/logo') });
    expect(Number(theirs.headers['content-length'])).toBe(Buffer.from(PNG_2PX, 'base64').length);
    expect(theirs.headers['content-length']).not.toBe(mine.headers['content-length']);
  });

  it('prints each company’s OWN name on its own invoice', async () => {
    const invoiceFor = async (
      as: typeof asAlpha,
      tenant: Tenant,
    ) => {
      const contact = await call(api, {
        method: 'POST', ...as('/v1/contacts'), body: { name: 'A customer', isCustomer: true },
      });
      const invoice = await call(api, {
        method: 'POST',
        ...as('/v1/invoices'),
        body: {
          contactId: contact.body['id'],
          issueDate: '2026-03-14',
          dueDate: '2026-04-13',
          lines: [{
            description: 'Consulting', quantity: '1', unitPrice: '100.00',
            accountId: tenant.accounts['4000'], taxCodeId: tenant.taxCodes['NONE'],
          }],
        },
      });
      expect(invoice.status).toBe(201);
      return callRaw(api, {
        method: 'GET', ...as(`/v1/invoices/${invoice.body['id']}/pdf`),
      });
    };

    const alphaPdf = pdfText((await invoiceFor(asAlpha, alpha)).body);
    const betaPdf = pdfText((await invoiceFor(asBeta, beta)).body);

    expect(alphaPdf).toContain('Alpha Trading Sdn Bhd');
    expect(alphaPdf).not.toContain('Beta Services Sdn Bhd');
    expect(betaPdf).toContain('Beta Services Sdn Bhd');
    expect(betaPdf).not.toContain('Alpha Trading Sdn Bhd');
  });

  it('lets a company take its mark back off, returning to a name-only letterhead', async () => {
    const cleared = await call(api, {
      method: 'PUT',
      ...asBeta('/v1/organisations/brand'),
      body: { logoBase64: null, logoContentType: 'image/png', brandColour: null },
    });
    expect(cleared.status).toBe(200);

    const none = await callRaw(api, { method: 'GET', ...asBeta('/v1/organisations/logo') });
    expect(none.status).toBe(204);
  });

  it('refuses a logo too big to print on every document', async () => {
    // The ceiling is not arbitrary: the image is embedded in every PDF this
    // tenant prints, so its size is paid again on each one.
    const huge = Buffer.alloc(300 * 1024, 1).toString('base64');
    const refused = await call(api, {
      method: 'PUT',
      ...asAlpha('/v1/organisations/brand'),
      body: { logoBase64: huge, logoContentType: 'image/png', brandColour: null },
    });
    expect(refused.status).toBe(422);
  });

  it('refuses an image it could not print, at UPLOAD rather than at print time', async () => {
    /*
     * A real PNG header with one corrupt CRC — the shape that started this.
     * It passes every magic-byte and dimension check and then throws inside
     * pdfkit, so accepting it would break this tenant's invoices weeks later
     * with nobody near a file picker.
     */
    const corrupt =
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEYBxVSF+FAAhKAwGm4C6BAAAAAElFTkSuQmCC';
    const refused = await call(api, {
      method: 'PUT',
      ...asAlpha('/v1/organisations/brand'),
      body: { logoBase64: corrupt, logoContentType: 'image/png', brandColour: null },
    });
    expect(refused.status).toBe(422);
    expect(refused.body['message']).toMatch(/could not be read as an image/);

    // And the tenant can still print, because the bad bytes never landed.
    const stillWorks = await callRaw(api, {
      method: 'GET', ...asAlpha('/v1/organisations/logo'),
    });
    expect(stillWorks.status).toBe(200);
  });

  it('is org.manage to change and tax.read to look at', async () => {
    const clerk = await makeUser(api, { tenantId: alpha.tenantId, role: 'SALES' });
    const { accessToken } = await accessTokenFor(api, clerk.refreshToken, alpha.tenantId);
    const asClerk = { token: accessToken, tenantId: alpha.tenantId };

    const changed = await call(api, {
      method: 'PUT',
      url: '/v1/organisations/brand',
      ...asClerk,
      body: { logoBase64: PNG_1PX, logoContentType: 'image/png', brandColour: null },
    });
    expect(changed.status).toBe(403);
  });
});
