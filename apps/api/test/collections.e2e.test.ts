import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, withTenant } from '@emil/db';
import { loadConfig } from '../src/config.js';
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
  api = await createTestApi('collections');
  tenant = await seedTenant(api.admin, 'Collections Sdn Bhd');

  const user = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, user.refreshToken, tenant.tenantId));

  // FPX, clearing through 1200 Undeposited Funds with fees to 6100.
  const sql = createClient(api.appUrl);
  try {
    const ctx = { tenantId: tenant.tenantId, userId: user.userId };
    await withTenant(sql, ctx, async (tx) => {
      const [bank] = await tx<{ id: string }[]>`
          INSERT INTO bank_account (tenant_id, name, bank_name, gl_account_id,
                                    opening_balance, opening_date)
          VALUES (${ctx.tenantId}, 'Maybank Current', 'Malayan Banking Berhad',
                  ${tenant.accounts['1000']!}, 0, '2026-01-01')
          RETURNING id
      `;
      bankAccountId = bank!.id;

      await tx`
          INSERT INTO payment_gateway_config (
              tenant_id, provider, display_name, clearing_account_id,
              fee_account_id, settlement_bank_account_id
          )
          VALUES (${ctx.tenantId}, 'FAKE', 'Fake Gateway',
                  ${tenant.accounts['1200']!}, ${tenant.accounts['6100']!}, ${bank!.id})
      `;
    });
  } finally {
    await sql.end();
  }
}, 120_000);

afterAll(async () => {
  await api?.close();
});

let bankAccountId: string;

// ---------------------------------------------------------------------------
// Contacts — the gap that made a clean tenant unable to invoice
// ---------------------------------------------------------------------------

describe('contacts', () => {
  it('creates a customer through the API and lists it back', async () => {
    const created = await call(api, {
      method: 'POST',
      url: '/v1/contacts',
      token,
      tenantId: tenant.tenantId,
      body: {
        name: 'Kuching Traders Sdn Bhd',
        isCustomer: true,
        tin: 'C1122334455',
        idType: 'BRN',
        idValue: '202401011234',
        email: 'ap@kuchingtraders.example',
      },
    });

    expect(created.status).toBe(201);
    expect(created.body['einvoiceGaps']).toEqual([]);

    const list = await call(api, {
      method: 'GET',
      url: '/v1/contacts?role=CUSTOMER',
      token,
      tenantId: tenant.tenantId,
    });

    const names = (list.body['contacts'] as { name: string }[]).map((c) => c.name);
    expect(names).toContain('Kuching Traders Sdn Bhd');
  });

  it('reports what would block a MyInvois submission, without guessing a format', () =>
    call(api, {
      method: 'POST',
      url: '/v1/contacts',
      token,
      tenantId: tenant.tenantId,
      body: { name: 'No TIN Enterprise', isCustomer: true },
    }).then((created) => {
      // A missing TIN is a FACT. The shape of a valid one is not something this
      // codebase asserts — the authoritative check is LHDN's TIN lookup, and a
      // guessed regex would reject valid identifiers and stop a real business
      // invoicing a real customer.
      expect(created.body['einvoiceGaps']).toContain('tin');
      expect(created.body['einvoiceGaps']).toContain('idType/idValue');
    }));

  it('refuses a contact that is neither customer nor supplier', async () => {
    const created = await call(api, {
      method: 'POST',
      url: '/v1/contacts',
      token,
      tenantId: tenant.tenantId,
      body: { name: 'Nobody At All' },
    });

    expect(created.status).toBe(422);
  });

  it('answers 404 for another tenant’s contact, never 403', async () => {
    const other = await seedTenant(api.admin, 'Other Sdn Bhd');

    const response = await call(api, {
      method: 'GET',
      url: `/v1/contacts/${other.customerId}`,
      token,
      tenantId: tenant.tenantId,
    });

    // Rule 9. A 403 would confirm the record exists.
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The pay page
// ---------------------------------------------------------------------------

describe('the public pay page', () => {
  it('shows an invoice to someone holding the link and nobody else', async () => {
    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);

    const page = await publicCall({ method: 'GET', url: `/public/pay/${link.token}` });

    expect(page.status).toBe(200);
    expect(page.body['amount']).toBe('1080.0000');
    expect(page.body['invoiceNo']).toBe(invoice.invoiceNo);
    expect(page.body['merchantName']).toBe('Collections Sdn Bhd');
    expect(page.body['reference']).toBe(`INV${invoice.invoiceNo.replace(/\D/g, '')}`);

    // Rule 3: the minimum. Nothing that helps anyone enumerate further.
    const keys = Object.keys(page.body);
    expect(keys).not.toContain('tenantId');
    expect(keys).not.toContain('contactId');
    expect(keys).not.toContain('invoiceId');
    expect(JSON.stringify(page.body)).not.toContain(tenant.tenantId);
  });

  it('gives an unknown and an expired token the same 404', async () => {
    // Rule 2. Telling them apart hands a brute-forcer the one signal that
    // makes guessing worth doing: "this token was real once".
    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);

    await api.admin`
        UPDATE payment_link SET expires_at = now() - interval '1 hour'
         WHERE token_hash IS NOT NULL AND id = ${link.id}
    `;

    const expired = await publicCall({ method: 'GET', url: `/public/pay/${link.token}` });
    const unknown = await publicCall({
      method: 'GET',
      url: `/public/pay/${'x'.repeat(43)}`,
    });

    expect(expired.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Byte for byte, apart from the per-request id. Any other difference is a
    // signal a brute-forcer can use.
    const { requestId: _a, ...expiredBody } = expired.body;
    const { requestId: _b, ...unknownBody } = unknown.body;
    expect(expiredBody).toEqual(unknownBody);
  });

  it('ignores an X-Tenant-Id header entirely', async () => {
    // Rule 1. Honouring it would let anyone read across tenants by pairing a
    // valid token with someone else's organisation id.
    const other = await seedTenant(api.admin, 'Unrelated Sdn Bhd');
    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);

    const response = await api.app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: `/public/pay/${link.token}`,
      headers: { 'x-tenant-id': other.tenantId },
    });

    // Still resolves, still to the RIGHT tenant's invoice.
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)['merchantName']).toBe('Collections Sdn Bhd');
  });

  it('has no confirm route the browser can call', async () => {
    // Rule 4, asserted as an absence. A `POST .../confirm` would be a way to
    // mark any invoice paid for free: the route is unauthenticated by
    // necessity, and a redirect back from a bank proves nothing because the
    // payer controls their own browser.
    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);

    const response = await publicCall({
      method: 'POST',
      url: `/public/pay/${link.token}/confirm`,
      body: { paid: true },
    });

    expect(response.status).toBe(404);
  });

  it('tells a payer their invoice is already paid rather than 404ing them', async () => {
    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);
    await payThrough(link, invoice.total);

    const page = await publicCall({ method: 'GET', url: `/public/pay/${link.token}` });

    // Deliberately NOT a 404, unlike every other refusal. A page saying "not
    // found" makes a customer pay a second time.
    expect(page.status).toBe(422);
    expect(page.body['message']).toMatch(/already been paid/);
  });
});

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

describe('the gateway webhook', () => {
  it('settles the invoice into CLEARING, leaving the bank untouched', async () => {
    // Deltas, not absolutes: these tests share one tenant, so a balance is the
    // running total of everything before it. Asserting the MOVEMENT is what
    // actually says what this webhook did.
    const before = await balances();

    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);
    const result = await payThrough(link, invoice.total, '1.00');

    expect(result.body['applied'], JSON.stringify(result.body)).toBe(true);

    const moved = await movementSince(before);
    // Gross 1,080 into clearing, 1.00 straight back out as the fee.
    expect(moved['1200']).toBe('1079.0000');
    expect(moved['6100']).toBe('1.0000');
    // The bank has not seen a sen of it, and will not until Wednesday.
    expect(moved['1000']).toBe('0.0000');

    const [row] = await api.admin<{ status: string }[]>`
        SELECT status FROM invoice WHERE id = ${invoice.id}
    `;
    expect(row!.status).toBe('PAID');
  });

  it('applies a replayed provider event exactly once', async () => {
    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);

    const eventId = `evt_${randomUUID()}`;
    const first = await payThrough(link, invoice.total, undefined, eventId);
    const second = await payThrough(link, invoice.total, undefined, eventId);

    expect(first.body['applied']).toBe(true);
    expect(second.body['applied']).toBe(false);
    expect(second.body['reason']).toBe('REPLAY');

    const [payments] = await api.admin<{ count: string }[]>`
        SELECT count(*)::text FROM payment
         WHERE tenant_id = ${tenant.tenantId} AND gateway_txn_id = ${link.providerRef}
    `;
    expect(payments!.count).toBe('1');
  });

  it('needs no Idempotency-Key, because the database guarantees more', async () => {
    // No provider sends a header this product invented. The guarantee is
    // UNIQUE (tenant_id, provider, provider_event_id), which is keyed on the
    // PROVIDER's notion of the event rather than on a client remembering.
    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);
    await initiate(link);

    const response = await publicCall({
      method: 'POST',
      url: '/public/gateways/FAKE/webhook',
      idempotencyKey: null,
      body: {
        eventId: `evt_${randomUUID()}`,
        providerRef: link.providerRef,
        type: 'PAID',
        amount: invoice.total,
        sentAt: new Date().toISOString(),
      },
    });

    expect(response.status).toBe(201);
    expect(response.body['applied']).toBe(true);
  });

  it('routes on OUR order id, so two merchants may share a provider reference', async () => {
    // The reason migration 0015 does not key on the provider's reference. A
    // provider's ids are unique within THEIR namespace, not across merchants,
    // so two tenants on one gateway can legitimately be handed the same one.
    // Routing on it would either refuse a real payment or — far worse — apply
    // this webhook to the other tenant's invoice.
    const shared = `provider-ref-${randomUUID().slice(0, 8)}`;

    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);
    await initiate(link);

    const before = await balances();

    const response = await publicCall({
      method: 'POST',
      url: '/public/gateways/FAKE/webhook',
      idempotencyKey: null,
      body: {
        eventId: `evt_${randomUUID()}`,
        // A reference this gateway has handed out before, to somebody else.
        providerRef: shared,
        merchantOrderId: link.id,
        type: 'PAID',
        amount: invoice.total,
        sentAt: new Date().toISOString(),
      },
    });

    expect(response.body['applied']).toBe(true);

    const moved = await movementSince(before);
    expect(moved['1200']).toBe('1080.0000');
  });

  it('acknowledges an unknown reference without retrying forever', async () => {
    const response = await publicCall({
      method: 'POST',
      url: '/public/gateways/FAKE/webhook',
      idempotencyKey: null,
      body: {
        eventId: `evt_${randomUUID()}`,
        merchantOrderId: '00000000-0000-4000-8000-000000000000',
      providerRef: 'nothing-we-issued',
        type: 'PAID',
        amount: '10.00',
        sentAt: new Date().toISOString(),
      },
    });

    expect(response.status).toBe(201);
    expect(response.body['applied']).toBe(false);
    expect(response.body['reason']).toBe('UNKNOWN_REFERENCE');
  });

  it('does not acknowledge a webhook for a provider it cannot verify', async () => {
    // A route with no adapter cannot check a signature, and one that accepts an
    // unverifiable payment notification is a way to mark any invoice paid.
    const response = await publicCall({
      method: 'POST',
      url: '/public/gateways/BILLPLZ/webhook',
      idempotencyKey: null,
      body: { eventId: 'x', providerRef: 'y', type: 'PAID', amount: '1.00', sentAt: 'now' },
    });

    expect(response.status).toBe(404);
  });

  it('refuses hosted hand-off when no adapter is configured', async () => {
    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);

    const response = await publicCall({
      method: 'POST',
      url: `/public/pay/${link.token}/initiate`,
      body: { provider: 'IPAY88', returnUrl: 'https://merchant.example/thanks' },
    });

    expect(response.status).toBe(503);
    expect(response.body['error']).toBe('gateway_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Settlement — the end of the money's journey
// ---------------------------------------------------------------------------

describe('settlement', () => {
  it('moves the batch out of clearing and into the bank', async () => {
    const before = await balances();

    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);
    await payThrough(link, invoice.total, '1.00');

    const [payment] = await api.admin<{ id: string }[]>`
        SELECT id FROM payment WHERE tenant_id = ${tenant.tenantId}
           AND gateway_txn_id = ${link.providerRef}
    `;

    const settled = await call(api, {
      method: 'POST',
      url: '/v1/gateways/FAKE/settlements',
      token,
      tenantId: tenant.tenantId,
      body: {
        providerBatchId: `BATCH-${randomUUID().slice(0, 8)}`,
        settlementDate: '2026-08-07',
        bankAccountId,
        reportedNet: '1079.00',
        items: [{ paymentId: payment!.id, gross: invoice.total, fee: '1.00' }],
      },
    });

    expect(settled.status).toBe(201);
    expect(settled.body['net']).toBe('1079.0000');

    const moved = await movementSince(before);
    // Collected and then settled: clearing nets to zero across the pair, which
    // is the property that says no money was recognised and never banked.
    expect(moved['1200']).toBe('0.0000');
    expect(moved['1000']).toBe('1079.0000');
    // The fee was booked once, at confirmation. The settlement reports the same
    // ringgit again and must not book it twice.
    expect(moved['6100']).toBe('1.0000');
  });

  it('refuses a batch whose parts do not add up', async () => {
    const invoice = await issueInvoice();
    const link = await createLink(invoice.id);
    await payThrough(link, invoice.total);

    const [payment] = await api.admin<{ id: string }[]>`
        SELECT id FROM payment WHERE tenant_id = ${tenant.tenantId}
           AND gateway_txn_id = ${link.providerRef}
    `;

    const response = await call(api, {
      method: 'POST',
      url: '/v1/gateways/FAKE/settlements',
      token,
      tenantId: tenant.tenantId,
      body: {
        providerBatchId: `BATCH-${randomUUID().slice(0, 8)}`,
        settlementDate: '2026-08-07',
        bankAccountId,
        reportedNet: '999.00',
        items: [{ paymentId: payment!.id, gross: invoice.total }],
      },
    });

    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('the fake gateway is refused in production', () => {
  it('will not start with EMIL_ENABLE_FAKE_GATEWAY set and NODE_ENV=production', () => {
    // It accepts any signature, so enabling it in production is a way to mark
    // any invoice paid. Refused at boot rather than left to a checklist.
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://localhost/x',
        JWT_SECRET: 'a'.repeat(32),
        NODE_ENV: 'production',
        EMIL_ENABLE_FAKE_GATEWAY: '1',
      } as NodeJS.ProcessEnv),
    ).toThrow(/never be set in production/);
  });

  it('starts happily without it', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://localhost/x',
        JWT_SECRET: 'a'.repeat(32),
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Link {
  id: string;
  token: string;
  reference: string;
  providerRef: string;
}

async function issueInvoice(): Promise<{ id: string; invoiceNo: string; total: string }> {
  const response = await call(api, {
    method: 'POST',
    url: '/v1/invoices',
    token,
    tenantId: tenant.tenantId,
    body: {
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
    },
  });

  return {
    id: response.body['id'] as string,
    invoiceNo: response.body['invoiceNo'] as string,
    total: response.body['total'] as string,
  };
}

async function createLink(invoiceId: string): Promise<Link> {
  const response = await call(api, {
    method: 'POST',
    url: `/v1/invoices/${invoiceId}/payment-link`,
    token,
    tenantId: tenant.tenantId,
    body: {},
  });

  return {
    id: response.body['id'] as string,
    token: response.body['token'] as string,
    reference: response.body['reference'] as string,
    providerRef: '',
  };
}

/** Hand off to the gateway, recording the provider reference on the link. */
async function initiate(link: Link): Promise<void> {
  const response = await publicCall({
    method: 'POST',
    url: `/public/pay/${link.token}/initiate`,
    body: { provider: 'FAKE', returnUrl: 'https://merchant.example/thanks' },
  });

  // Fail here rather than three assertions later with an undefined providerRef,
  // which says nothing about what actually went wrong.
  if (response.status !== 201) {
    throw new Error(`Hand-off failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  link.providerRef = response.body['providerRef'] as string;
}

/** The whole payer journey: hand off, then the provider's webhook. */
async function payThrough(link: Link, amount: string, fee?: string, eventId?: string) {
  if (link.providerRef === '') await initiate(link);

  return publicCall({
    method: 'POST',
    url: '/public/gateways/FAKE/webhook',
    idempotencyKey: null,
    body: {
      eventId: eventId ?? `evt_${randomUUID()}`,
      providerRef: link.providerRef,
      type: 'PAID',
      amount,
      ...(fee !== undefined ? { fee } : {}),
      sentAt: new Date().toISOString(),
    },
  });
}

/**
 * A call with NO tenant header and NO credential, which is how a payer's
 * browser and a provider's server actually reach these routes.
 */
async function publicCall(options: {
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
  idempotencyKey?: string | null;
}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.idempotencyKey !== null) {
    headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
  }

  const response = await api.app.getHttpAdapter().getInstance().inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  });

  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
  };
}

const WATCHED = ['1000', '1100', '1200', '6100'] as const;

/** Debit-positive balances for the accounts these tests care about. */
async function balances(): Promise<Record<string, bigint>> {
  const rows = await api.admin<{ code: string; balance: string }[]>`
      SELECT a.code,
             COALESCE(SUM(l.base_debit - l.base_credit), 0)::numeric(19,4)::text AS balance
        FROM account a
        LEFT JOIN journal_line l
          ON l.tenant_id = a.tenant_id AND l.account_id = a.id
       WHERE a.tenant_id = ${tenant.tenantId}
         AND a.code IN ${api.admin(WATCHED as unknown as string[])}
       GROUP BY a.code
  `;

  const out: Record<string, bigint> = {};
  // Held as scaled integers. A float would defeat the whole point of the
  // NUMERIC(19,4) column these came out of.
  for (const row of rows) out[row.code] = BigInt(row.balance.replace('.', ''));
  return out;
}

async function movementSince(before: Record<string, bigint>): Promise<Record<string, string>> {
  const after = await balances();
  const out: Record<string, string> = {};

  for (const code of WATCHED) {
    const delta = (after[code] ?? 0n) - (before[code] ?? 0n);
    const negative = delta < 0n;
    const abs = negative ? -delta : delta;
    out[code] = `${negative ? '-' : ''}${abs / 10000n}.${(abs % 10000n).toString().padStart(4, '0')}`;
  }

  return out;
}

// ---------------------------------------------------------------------------
// The audit trail, end to end
// ---------------------------------------------------------------------------

describe('the audit trail through the real HTTP application', () => {
  it('records the request id, IP and user agent that caused a change', async () => {
    // The end of the wire that migration 0016 opened. These three columns were
    // NULL on every audit row in the system before it, because the API
    // collected them and TenantContext had no way to carry them into the
    // transaction. This asserts they survive a real request.
    const created = await call(api, {
      method: 'POST',
      url: '/v1/contacts',
      token,
      tenantId: tenant.tenantId,
      body: { name: 'Traceable Through HTTP Sdn Bhd', isCustomer: true },
    });

    const [row] = await api.admin<
      { request_id: string | null; actor_ip: string | null; user_agent: string | null;
        actor_user_id: string | null; action: string }[]
    >`
        SELECT request_id, host(actor_ip) AS actor_ip, user_agent,
               actor_user_id::text, action
          FROM audit_log
         WHERE tenant_id = ${tenant.tenantId}
           AND entity_type = 'contact' AND entity_id = ${created.body['id'] as string}
    `;

    expect(row!.action).toBe('CREATE');
    expect(row!.request_id).toBeTruthy();
    expect(row!.actor_user_id).toBeTruthy();
    // Fastify resolves an injected request's address; the point is that
    // whatever it was reached the row rather than being dropped.
    expect(row!.actor_ip).toBeTruthy();
  });

  it('exposes the trail to a role that holds audit.read, and hides it from one that does not', async () => {
    const reader = await makeUser(api, { tenantId: tenant.tenantId, role: 'ADMIN' });
    const { accessToken: adminToken } = await accessTokenFor(
      api, reader.refreshToken, tenant.tenantId,
    );

    const allowed = await call(api, {
      method: 'GET', url: '/v1/audit?entityType=contact&limit=5',
      token: adminToken, tenantId: tenant.tenantId,
    });
    expect(allowed.status).toBe(200);
    expect((allowed.body['entries'] as unknown[]).length).toBeGreaterThan(0);

    // BOOKKEEPER does not hold audit.read. The people whose work the trail
    // records should not routinely read what it captured about them.
    const clerk = await makeUser(api, { tenantId: tenant.tenantId, role: 'BOOKKEEPER' });
    const { accessToken: clerkToken } = await accessTokenFor(
      api, clerk.refreshToken, tenant.tenantId,
    );

    const refused = await call(api, {
      method: 'GET', url: '/v1/audit', token: clerkToken, tenantId: tenant.tenantId,
    });
    // 403, not 404: they are legitimately inside the tenant, so naming the
    // missing permission tells an attacker nothing new — and tells a real user
    // what to ask their administrator for.
    expect(refused.status).toBe(403);
    expect(refused.body['permission']).toBe('audit.read');
  });

  it('reports the tenant’s hash chain as intact', async () => {
    const reader = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
    const { accessToken: ownerToken } = await accessTokenFor(
      api, reader.refreshToken, tenant.tenantId,
    );

    const verified = await call(api, {
      method: 'GET', url: '/v1/audit-chain/verify',
      token: ownerToken, tenantId: tenant.tenantId,
    });

    expect(verified.status).toBe(200);
    expect(verified.body['intact']).toBe(true);
    // Says how many rows it checked, so an empty answer can never be mistaken
    // for a clean one.
    expect(verified.body['entries']).toBeGreaterThan(0);
    expect(verified.body['breaks']).toEqual([]);
  });
});
