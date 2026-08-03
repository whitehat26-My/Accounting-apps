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
 * Auto-categorisation over HTTP: the owner writes the TNB rule once, and from
 * then on every statement import codes the electricity bill by itself —
 * reported in the import response, attributed to the rule, reversible like
 * any other match.
 */

let api: TestApi;
let tenant: Tenant;
let token: string;
let bankAccountId: string;

const MAYBANK = {
  bankName: 'Maybank',
  delimiter: ',',
  dateFormat: 'DD/MM/YYYY' as const,
  amountConvention: 'SIGNED' as const,
  columns: { txnDate: 0, description: 1, amount: 2 },
};

beforeAll(async () => {
  api = await createTestApi('bank_rules');
  tenant = await seedTenant(api.admin, 'Rule Routes Sdn Bhd');
  const owner = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, owner.refreshToken, tenant.tenantId));

  const account = await call(api, {
    method: 'POST',
    url: '/v1/bank-accounts',
    token,
    tenantId: tenant.tenantId,
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

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

describe('bank rules over HTTP', () => {
  it('creates a rule, and the very next import codes the line by itself', async () => {
    const rule = await call(api, {
      method: 'POST',
      ...as('/v1/bank-rules'),
      body: {
        name: 'TNB electricity',
        contains: 'TNB',
        matchesDirection: 'OUTFLOW',
        accountId: tenant.accounts['5000'],
        autoApply: true,
      },
    });
    expect(rule.status).toBe(201);

    const imported = await call(api, {
      method: 'POST',
      ...as(`/v1/bank-accounts/${bankAccountId}/statements`),
      body: {
        content: [
          'Date,Description,Amount',
          '05/08/2026,TNB BILL PAYMENT KUALA LUMPUR,-380.50',
          '20/08/2026,CHEQUE 001234,-900.00',
        ].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
      },
    });
    expect(imported.status).toBe(201);
    expect(imported.body['imported']).toBe(2);

    // The import response SAYS what the rules did — the importer watches the
    // coding happen rather than discovering it at reconciliation.
    const applied = imported.body['autoCategorised'] as Record<string, string>[];
    expect(applied).toHaveLength(1);
    expect(applied[0]!['ruleName']).toBe('TNB electricity');
    expect(applied[0]!['amount']).toBe('-380.5000');

    const rules = await call(api, { method: 'GET', ...as('/v1/bank-rules') });
    expect(rules.status).toBe(200);
    const tnb = (rules.body['rules'] as Record<string, unknown>[])
      .find((r) => r['name'] === 'TNB electricity');
    expect(tnb?.['hitCount']).toBe(1);

    // The cheque is untouched: no rule, no posting, waiting for a human.
    const hits = await call(api, { method: 'GET', ...as('/v1/bank-rules/suggestions') });
    expect(hits.status).toBe(200);
    expect(hits.body['hits']).toEqual([]);
  });

  it('a SALES login can neither write rules nor run them', async () => {
    const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
    const { accessToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId);

    const create = await call(api, {
      method: 'POST',
      url: '/v1/bank-rules',
      token: accessToken,
      tenantId: tenant.tenantId,
      body: { name: 'Nope', contains: 'NOPE', accountId: tenant.accounts['5000'] },
    });
    expect(create.status).toBe(403);

    const run = await call(api, {
      method: 'POST',
      url: '/v1/bank-rules/run',
      token: accessToken,
      tenantId: tenant.tenantId,
      body: {},
    });
    expect(run.status).toBe(403);
  });

  it('the on-demand run codes a backlog after the rule is written', async () => {
    // The line arrived BEFORE the rule existed — the other direction.
    const imported = await call(api, {
      method: 'POST',
      ...as(`/v1/bank-accounts/${bankAccountId}/statements`),
      body: {
        content: ['Date,Description,Amount', '25/08/2026,TM UNIFI BIZ 03-1234,-129.00'].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
      },
    });
    expect(imported.status).toBe(201);
    expect(imported.body['autoCategorised']).toEqual([]);

    const rule = await call(api, {
      method: 'POST',
      ...as('/v1/bank-rules'),
      body: {
        name: 'Unifi internet',
        contains: 'UNIFI',
        accountId: tenant.accounts['5000'],
        autoApply: true,
      },
    });
    expect(rule.status).toBe(201);

    const run = await call(api, { method: 'POST', ...as('/v1/bank-rules/run'), body: {} });
    expect(run.status).toBe(201);
    expect((run.body['applied'] as unknown[])).toHaveLength(1);
  });
});
