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
  api = await createTestApi('ledger');
  tenant = await seedTenant(api.admin, 'Ledger Routes Sdn Bhd');
  const user = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, user.refreshToken, tenant.tenantId));
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

// ---------------------------------------------------------------------------
// Manual journals — the operation the whole system is built around, unreachable
// until now
// ---------------------------------------------------------------------------

describe('manual journal entries', () => {
  it('posts a balanced entry through the same path every invoice uses', async () => {
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/journals'),
      body: {
        entryDate: '2026-08-05',
        description: 'August rent accrual',
        lines: [
          { accountId: tenant.accounts['6000'], side: 'DEBIT', amount: '3000.00' },
          { accountId: tenant.accounts['2000'], side: 'CREDIT', amount: '3000.00' },
        ],
      },
    });

    expect(response.status).toBe(201);
    expect(response.body['entryNo']).toMatch(/^JE-/);
    expect(response.body['totalDebit']).toBe('3000.0000');
  });

  it('refuses an unbalanced entry with a 422, not a 500', async () => {
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/journals'),
      body: {
        entryDate: '2026-08-05',
        lines: [
          { accountId: tenant.accounts['6000'], side: 'DEBIT', amount: '3000.00' },
          { accountId: tenant.accounts['2000'], side: 'CREDIT', amount: '2999.00' },
        ],
      },
    });

    // The request was well formed; its content was not acceptable.
    expect(response.status).toBe(422);
  });

  it('refuses a one-line entry before the database has to', async () => {
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/journals'),
      body: {
        entryDate: '2026-08-05',
        lines: [{ accountId: tenant.accounts['6000'], side: 'DEBIT', amount: '10.00' }],
      },
    });

    expect(response.status).toBe(422);
  });

  it('is idempotent on the key, like every other financial write', async () => {
    const key = randomUUID();
    const body = {
      entryDate: '2026-08-06',
      lines: [
        { accountId: tenant.accounts['6000'], side: 'DEBIT', amount: '25.00' },
        { accountId: tenant.accounts['2000'], side: 'CREDIT', amount: '25.00' },
      ],
    };

    const first = await call(api, { method: 'POST', ...as('/v1/journals'), idempotencyKey: key, body });
    const second = await call(api, { method: 'POST', ...as('/v1/journals'), idempotencyKey: key, body });

    expect(first.body['replayed']).toBe(false);
    expect(second.body['replayed']).toBe(true);
    expect(second.body['entryNo']).toBe(first.body['entryNo']);
  });
});

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

describe('the chart of accounts', () => {
  it('creates an account a real user could not create before', async () => {
    const created = await call(api, {
      method: 'POST',
      ...as('/v1/accounts'),
      body: { code: '6700', name: 'Subscriptions', type: 'EXPENSE' },
    });

    expect(created.status).toBe(201);
    expect(created.body['normalBalance']).toBe('DEBIT');

    const listed = await call(api, { method: 'GET', ...as('/v1/accounts?type=EXPENSE') });
    const codes = (listed.body['accounts'] as { code: string }[]).map((a) => a.code);
    expect(codes).toContain('6700');
  });

  it('refuses to reclassify an account that already carries posted history', async () => {
    const response = await call(api, {
      method: 'PATCH',
      ...as(`/v1/accounts/${tenant.accounts['6000']}/type`),
      body: { type: 'ASSET' },
    });

    // Reclassifying moves every posted amount to the other statement,
    // retrospectively, for periods that have already been reported.
    expect(response.status).toBe(422);
    expect(response.body['code']).toBe('TYPE_LOCKED_BY_HISTORY');
  });
});

// ---------------------------------------------------------------------------
// Period close
// ---------------------------------------------------------------------------

describe('closing a period', () => {
  it('closes, refuses a posting into it, then reopens with a reason', async () => {
    const periods = await call(api, { method: 'GET', ...as('/v1/periods') });
    const august = (periods.body['periods'] as { id: string; sequence: number }[]).find(
      (p) => p.sequence === 8,
    )!;

    // February through July first: closing out of order would make figures
    // final on top of comparatives that can still move.
    for (const seq of [2, 3, 4, 5, 6, 7]) {
      const p = (periods.body['periods'] as { id: string; sequence: number }[]).find(
        (x) => x.sequence === seq,
      )!;
      await call(api, { method: 'POST', ...as(`/v1/periods/${p.id}/status`), body: { status: 'CLOSED' } });
    }

    const closed = await call(api, {
      method: 'POST',
      ...as(`/v1/periods/${august.id}/status`),
      body: { status: 'CLOSED' },
    });
    expect(closed.status).toBe(201);
    expect(closed.body['status']).toBe('CLOSED');

    const blocked = await call(api, {
      method: 'POST',
      ...as('/v1/journals'),
      body: {
        entryDate: '2026-08-20',
        lines: [
          { accountId: tenant.accounts['6000'], side: 'DEBIT', amount: '5.00' },
          { accountId: tenant.accounts['2000'], side: 'CREDIT', amount: '5.00' },
        ],
      },
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body['message']).toMatch(/CLOSED/);

    const withoutReason = await call(api, {
      method: 'POST',
      ...as(`/v1/periods/${august.id}/status`),
      body: { status: 'OPEN' },
    });
    expect(withoutReason.status).toBe(422);
    expect(withoutReason.body['message']).toMatch(/needs a reason/);

    const reopened = await call(api, {
      method: 'POST',
      ...as(`/v1/periods/${august.id}/status`),
      body: { status: 'OPEN', reason: 'Late supplier invoice, agreed with the client' },
    });
    expect(reopened.body['status']).toBe('OPEN');

    const allowed = await call(api, {
      method: 'POST',
      ...as('/v1/journals'),
      body: {
        entryDate: '2026-08-20',
        lines: [
          { accountId: tenant.accounts['6000'], side: 'DEBIT', amount: '5.00' },
          { accountId: tenant.accounts['2000'], side: 'CREDIT', amount: '5.00' },
        ],
      },
    });
    expect(allowed.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Banking
// ---------------------------------------------------------------------------

describe('bank accounts and reconciliation', () => {
  it('creates a bank account and records it as a financial event', async () => {
    const created = await call(api, {
      method: 'POST',
      ...as('/v1/bank-accounts'),
      body: {
        name: 'Maybank Current',
        bankName: 'Malayan Banking Berhad',
        glAccountId: tenant.accounts['1000'],
        accountNoMasked: '****4455',
        openingBalance: '0',
        openingDate: '2026-01-01',
      },
    });

    expect(created.status).toBe(201);

    const [event] = await api.admin<{ event_type: string }[]>`
        SELECT event_type FROM financial_event_log
         WHERE tenant_id = ${tenant.tenantId} AND event_type = 'BANK_DETAILS_CHANGED'
    `;
    expect(event!.event_type).toBe('BANK_DETAILS_CHANGED');
  });

  it('imports a statement, matches a line, and unmatches it again', async () => {
    const listed = await call(api, { method: 'GET', ...as('/v1/bank-accounts') });
    const bankAccountId = (listed.body['bankAccounts'] as { id: string }[])[0]!.id;

    const profile = {
      bankName: 'Maybank',
      delimiter: ',',
      dateFormat: 'DD/MM/YYYY',
      amountConvention: 'SIGNED',
      columns: { txnDate: 0, description: 1, amount: 2, runningBalance: 3 },
    };

    // Preview first: a wrong column map should fail in front of the person who
    // can fix it, not as plausible-looking wrong numbers at year end.
    const preview = await call(api, {
      method: 'POST',
      ...as(`/v1/bank-accounts/${bankAccountId}/statements/preview`),
      body: { content: 'Date,Description,Amount,Balance\n05/08/2026,BANK CHARGES,-25.00,-25.00', profile },
    });
    expect(preview.status).toBe(201);

    await call(api, {
      method: 'POST',
      ...as(`/v1/bank-accounts/${bankAccountId}/statements`),
      body: {
        content: 'Date,Description,Amount,Balance\n05/08/2026,BANK CHARGES,-25.00,-25.00',
        statementDate: '2026-08-05',
        profile,
      },
    });

    const transactions = await call(api, {
      method: 'GET',
      ...as(`/v1/bank-accounts/${bankAccountId}/transactions?asOf=2026-08-31`),
    });
    const line = (transactions.body['transactions'] as { id: string }[])[0]!;

    // A bank charge nothing in the ledger explains: the fix is a journal, not
    // an edit to the statement, which is evidence.
    const journal = await call(api, {
      method: 'POST',
      ...as(`/v1/bank-transactions/${line.id}/journal`),
      body: { accountId: tenant.accounts['6000'], description: 'Bank charges' },
    });

    expect(journal.status).toBe(201);
    expect(journal.body['matchId']).toBeTruthy();

    const removed = await call(api, {
      method: 'DELETE',
      ...as(`/v1/reconciliation-matches/${journal.body['matchId'] as string}`),
      body: { reason: 'Coded to the wrong account' },
    });
    expect(removed.status).toBe(200);
  });
});
