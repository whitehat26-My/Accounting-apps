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
 * Opening balances, and the reconciliation trap they exist to close.
 *
 * The load-bearing test is the last one: a bank account set up with a stated
 * opening balance and no matching ledger entry can never reconcile, the
 * screen refuses sign-off correctly but cannot explain why, and the gaps
 * route is what makes the explanation reachable.
 */

let api: TestApi;
let tenant: Tenant;
let token: string;

beforeAll(async () => {
  api = await createTestApi('opening');
  tenant = await seedTenant(api.admin, 'Opening Sdn Bhd');
  const user = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, user.refreshToken, tenant.tenantId));

  // The equity account the balancing figure lands in. `seedTenant` builds a
  // minimal chart, so this test supplies what onboarding would have.
  await api.admin`
      INSERT INTO account (tenant_id, code, name, type)
      VALUES (${tenant.tenantId}, '3100', 'Opening Balances', 'EQUITY')
      ON CONFLICT DO NOTHING
  `;
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

async function equityAccountId(): Promise<string> {
  const [row] = await api.admin<{ id: string }[]>`
      SELECT id FROM account WHERE tenant_id = ${tenant.tenantId} AND code = '3100'
  `;
  return row!.id;
}

describe('stating the opening position', () => {
  it('posts one balanced entry and reports what fell to equity', async () => {
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/opening-balances'),
      body: {
        asOfDate: '2026-08-01',
        balances: [
          { accountId: tenant.accounts['1000'], amount: '18540.00' },
          { accountId: tenant.accounts['2200'], amount: '3000.00' },
        ],
      },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    // 18,540 of cash less 3,000 owed to LHDN — the shop is worth 15,540.
    expect(response.body['balancingFigure']).toBe('15540.0000');
    expect(response.body['balancingSide']).toBe('CREDIT');
    expect(response.body['entryNo']).toMatch(/^JE-/);
  });

  it('leaves the trial balance balanced, which is the whole point', async () => {
    const tb = await call(api, {
      method: 'GET',
      ...as('/v1/reports/trial-balance?from=2026-08-01&to=2026-08-31'),
    });

    expect(tb.status).toBe(200);
    expect(tb.body['balanced']).toBe(true);
    expect(tb.body['totalDebit']).toBe(tb.body['totalCredit']);
  });

  it('is idempotent on the key, like every other financial write', async () => {
    const key = randomUUID();
    const body = {
      asOfDate: '2026-08-01',
      balances: [{ accountId: tenant.accounts['1000'], amount: '100.00' }],
    };

    const first = await call(api, { method: 'POST', ...as('/v1/opening-balances'), idempotencyKey: key, body });
    const second = await call(api, { method: 'POST', ...as('/v1/opening-balances'), idempotencyKey: key, body });

    expect(first.body['replayed']).toBe(false);
    expect(second.body['replayed']).toBe(true);
    expect(second.body['entryNo']).toBe(first.body['entryNo']);
  });

  it('refuses receivables by name, and points at the screen that does it properly', async () => {
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/opening-balances'),
      body: {
        asOfDate: '2026-08-01',
        balances: [{ accountId: tenant.accounts['1100'], amount: '7000.00' }],
      },
    });

    // A lump sum here would balance the entry and break invariant #6 in the
    // same instant — there would be no invoice for the customer to settle.
    expect(response.status).toBe(422);
    expect(response.body['message']).toContain('Sales screen');
  });

  it('refuses the balancing account being stated as a balance', async () => {
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/opening-balances'),
      body: {
        asOfDate: '2026-08-01',
        balances: [{ accountId: await equityAccountId(), amount: '5000.00' }],
      },
    });

    expect(response.status).toBe(422);
    expect(response.body['message']).toContain('plug');
  });

  it('answers 404 for an account belonging to nobody, never 403', async () => {
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/opening-balances'),
      body: {
        asOfDate: '2026-08-01',
        balances: [{ accountId: randomUUID(), amount: '10.00' }],
      },
    });

    expect(response.status).toBe(404);
  });
});

describe('the reconciliation trap', () => {
  it('names the bank account whose opening balance the ledger never heard of', async () => {
    // Exactly what a shop does on day one: add the bank account, type in what
    // the statement says, and start trading.
    const created = await call(api, {
      method: 'POST',
      ...as('/v1/bank-accounts'),
      body: {
        name: 'Maybank Current',
        bankName: 'Malayan Banking Berhad',
        glAccountId: tenant.accounts['1000'],
        openingBalance: '50000.00',
        openingDate: '2026-07-31',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const gaps = await call(api, { method: 'GET', ...as('/v1/opening-balances/gaps') });
    expect(gaps.status).toBe(200);

    const found = gaps.body['gaps'] as { bankAccountName: string; message: string; difference: string }[];
    expect(found).toHaveLength(1);
    expect(found[0]!.bankAccountName).toBe('Maybank Current');
    // The stated 50,000 against whatever the opening entries above put there.
    expect(found[0]!.message).toContain('can never reconcile');
    expect(found[0]!.difference).not.toBe('0.0000');
  });

  it('goes quiet once the ledger agrees with the statement', async () => {
    const [bank] = await api.admin<{ opening_balance: string }[]>`
        SELECT opening_balance::text FROM bank_account
         WHERE tenant_id = ${tenant.tenantId} AND name = 'Maybank Current'
    `;
    const gapsBefore = await call(api, { method: 'GET', ...as('/v1/opening-balances/gaps') });
    const difference = (gapsBefore.body['gaps'] as { difference: string }[])[0]!.difference;

    // Post exactly the difference the gap named, dated on the opening date.
    const posted = await call(api, {
      method: 'POST',
      ...as('/v1/opening-balances'),
      body: {
        asOfDate: '2026-07-31',
        balances: [{ accountId: tenant.accounts['1000'], amount: difference }],
      },
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect(bank!.opening_balance).toBeDefined();

    const after = await call(api, { method: 'GET', ...as('/v1/opening-balances/gaps') });
    expect(after.body['gaps']).toHaveLength(0);
  });
});
