import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@emil/db';
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

// ---------------------------------------------------------------------------
// The externally-blocked capabilities
// ---------------------------------------------------------------------------

describe('what this deployment cannot do yet', () => {
  it('answers it in one place, naming the authority that can unblock each one', async () => {
    // Until now this lived in eight ⚠️ comments across the domain, the
    // migrations and the API — answerable by reading the source and in no other
    // way. Nobody operating the system reads the source.
    const response = await call(api, { method: 'GET', ...as('/v1/readiness') });

    expect(response.status).toBe(200);
    const capabilities = response.body['capabilities'] as {
      key: string; status: string; blockedBy?: string; source?: string;
    }[];

    // Pinned deliberately. A capability added without a decision about how it
    // reports fails here rather than appearing unannounced in an operator's
    // readiness page.
    const keys = capabilities.map((c) => c.key).sort();
    expect(keys).toEqual([
      'duitnow_qr',
      'einvoice_submission',
      'gateway_collections',
      'sst_return',
      'statement_import',
      'withholding',
    ]);

    for (const capability of capabilities.filter((c) => c.status === 'BLOCKED')) {
      expect(capability.blockedBy, capability.key).toBeTruthy();
      expect(capability.source, capability.key).toBeTruthy();
    }

    expect(response.body['fullyOperational']).toBe(false);
  });

  it('lets the person holding the ruling enter it, without a developer', async () => {
    // The gap this closes. wht_rate has shipped empty since 0010 with no
    // service and no route, so "it just needs the verified figures" was not
    // true — it needed the figures AND somebody to write the code.
    const created = await call(api, {
      method: 'POST',
      ...as('/v1/withholding-rates'),
      body: {
        paymentType: 'TECHNICAL_SERVICES',
        rateBasisPoints: 1000,
        validFrom: '2026-01-01',
        legislationRef: 'LHDN Public Ruling 11/2018 s4.2',
      },
    });

    expect(created.status).toBe(201);
    expect(created.body['ratePercent']).toBe('10.00%');

    const readiness = await call(api, { method: 'GET', ...as('/v1/readiness') });
    const withholding = (readiness.body['capabilities'] as { key: string; status: string }[])
      .find((c) => c.key === 'withholding')!;
    expect(withholding.status).toBe('READY');
  });

  it('refuses a rate with no source, at the API boundary', async () => {
    const response = await call(api, {
      method: 'POST',
      ...as('/v1/withholding-rates'),
      body: {
        paymentType: 'INTEREST',
        rateBasisPoints: 1500,
        validFrom: '2026-01-01',
        legislationRef: 'n/a',
      },
    });

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/Cite the source/);
  });

  it('cannot tell a citation from prose, and does not pretend to', async () => {
    /*
     * The honest limit of this mechanism, asserted so nobody mistakes it for
     * more than it is.
     *
     * A length floor stops an empty field, "n/a" and "guess". It cannot stop
     * someone determined from typing twelve characters of nonsense — no
     * database constraint can, short of a list of valid LHDN rulings that would
     * itself need maintaining against the same authority.
     *
     * What it buys is that the field cannot be skipped, so every rate has an
     * identifiable claim attached to it and a reviewer can check the claim. The
     * defence against a bad citation is the review, not the constraint.
     */
    const accepted = await call(api, {
      method: 'POST',
      ...as('/v1/withholding-rates'),
      body: {
        paymentType: 'PROSE_PROBE',
        rateBasisPoints: 1000,
        validFrom: '2026-01-01',
        legislationRef: 'someone said so',
      },
    });

    expect(accepted.status).toBe(201);
    // But it IS recorded, verbatim and attributed, which is what makes it
    // reviewable later.
    expect(accepted.body['legislationRef']).toBe('someone said so');
    expect(accepted.body['verifiedBy']).toBeTruthy();
  });

  it('refuses to load sandbox values in production, independently of the route', () => {
    // Two independent checks. loadConfig refuses the flag outright, so the
    // route is unreachable even if someone sets the variable on a production
    // host — a 99% rate on a real supplier payment retains almost the whole
    // invoice and remits it to LHDN.
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgres://localhost/x',
        JWT_SECRET: 'a'.repeat(32),
        NODE_ENV: 'production',
        EMIL_ENABLE_SANDBOX_VALUES: '1',
      } as NodeJS.ProcessEnv),
    ).toThrow(/never be set in production/);
  });
});

// ---------------------------------------------------------------------------
// The year-end close
//
// M1's last missing piece: `RETAINED_EARNINGS` and `YEAR_END_CLOSED` were
// reserved in migrations 0002 and 0012 and used by nothing until now.
// ---------------------------------------------------------------------------

describe('closing a fiscal year', () => {
  let fiscalYearId: string;

  beforeAll(async () => {
    /*
     * A fresh year, seeded directly.
     *
     * There is no route that creates a fiscal year — provisioning one is part
     * of onboarding, which does not exist yet. Seeding it here rather than
     * pretending otherwise; the tests below drive everything else over HTTP.
     *
     * The fixture's FY2026 is unusable for this: January is LOCKED and the
     * period-close test above has closed February through August.
     */
    await withTenant(api.admin, { tenantId: tenant.tenantId }, async (tx) => {
      const [year] = await tx<{ id: string }[]>`
          INSERT INTO fiscal_year (tenant_id, label, start_date, end_date)
          VALUES (${tenant.tenantId}, 'FY2027', '2027-01-01', '2027-12-31')
          RETURNING id
      `;
      fiscalYearId = year!.id;
      await tx`
          INSERT INTO fiscal_period (tenant_id, fiscal_year_id, sequence,
                                     start_date, end_date, status)
          VALUES (${tenant.tenantId}, ${fiscalYearId}, 1,
                  '2027-01-01', '2027-12-31', 'OPEN')
      `;
    });
  });

  it('lists fiscal years with their status', async () => {
    const response = await call(api, { method: 'GET', ...as('/v1/fiscal-years') });

    expect(response.status).toBe(200);
    const years = response.body['fiscalYears'] as { label: string; status: string }[];
    expect(years.find((y) => y.label === 'FY2027')?.status).toBe('OPEN');
  });

  it('closes the year, refuses a posting into it, then reopens it', async () => {
    const traded = await call(api, {
      method: 'POST',
      ...as('/v1/journals'),
      body: {
        entryDate: '2027-06-15',
        description: 'a year of trading, compressed',
        lines: [
          { accountId: tenant.accounts['1000'], side: 'DEBIT', amount: '80000.00' },
          { accountId: tenant.accounts['4000'], side: 'CREDIT', amount: '80000.00' },
          { accountId: tenant.accounts['6000'], side: 'DEBIT', amount: '30000.00' },
          { accountId: tenant.accounts['1000'], side: 'CREDIT', amount: '30000.00' },
        ],
      },
    });
    expect(traded.status).toBe(201);

    const closed = await call(api, {
      method: 'POST',
      ...as(`/v1/fiscal-years/${fiscalYearId}/close`),
    });

    expect(closed.status).toBe(201);
    expect(closed.body['status']).toBe('CLOSED');
    expect(closed.body['profitForYear']).toBe('50000.0000');
    expect(closed.body['accountsClosed']).toBe(2);

    // The defect this feature also fixed: `fiscal_year.status` accepted CLOSED
    // from the first migration and `assert_period_open()` never looked at it,
    // so a closed year took postings for as long as any of its periods was
    // open — which was always.
    const blocked = await call(api, {
      method: 'POST',
      ...as('/v1/journals'),
      body: {
        entryDate: '2027-06-20',
        lines: [
          { accountId: tenant.accounts['6000'], side: 'DEBIT', amount: '5.00' },
          { accountId: tenant.accounts['2000'], side: 'CREDIT', amount: '5.00' },
        ],
      },
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body['message']).toMatch(/year FY2027 is CLOSED/i);

    const withoutReason = await call(api, {
      method: 'POST',
      ...as(`/v1/fiscal-years/${fiscalYearId}/reopen`),
      body: {},
    });
    expect(withoutReason.status).toBe(422);

    const reopened = await call(api, {
      method: 'POST',
      ...as(`/v1/fiscal-years/${fiscalYearId}/reopen`),
      body: { reason: 'a late supplier invoice, agreed with the client' },
    });
    expect(reopened.status).toBe(201);
    expect(reopened.body['reversalEntryId']).toBeTruthy();

    // And it takes postings again.
    const allowed = await call(api, {
      method: 'POST',
      ...as('/v1/journals'),
      body: {
        entryDate: '2027-06-20',
        lines: [
          { accountId: tenant.accounts['6000'], side: 'DEBIT', amount: '5.00' },
          { accountId: tenant.accounts['2000'], side: 'CREDIT', amount: '5.00' },
        ],
      },
    });
    expect(allowed.status).toBe(201);
  });

  it('answers 409 when the year is already closed', async () => {
    await call(api, { method: 'POST', ...as(`/v1/fiscal-years/${fiscalYearId}/close`) });

    const again = await call(api, {
      method: 'POST',
      ...as(`/v1/fiscal-years/${fiscalYearId}/close`),
    });

    // A state conflict, not a malformed request.
    expect(again.status).toBe(409);
  });

  it('replays a retried close on the same Idempotency-Key', async () => {
    // Rule 5. Reopen first so there is a close to retry.
    await call(api, {
      method: 'POST',
      ...as(`/v1/fiscal-years/${fiscalYearId}/reopen`),
      body: { reason: 'setting up the idempotency check' },
    });

    const key = randomUUID();
    const first = await call(api, {
      method: 'POST',
      ...as(`/v1/fiscal-years/${fiscalYearId}/close`),
      idempotencyKey: key,
    });
    const second = await call(api, {
      method: 'POST',
      ...as(`/v1/fiscal-years/${fiscalYearId}/close`),
      idempotencyKey: key,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body['replayed']).toBe(true);
    expect(second.body['closingEntryId']).toBe(first.body['closingEntryId']);
  });

  it('answers 404 for another tenant’s fiscal year, never 403', async () => {
    const other = await seedTenant(api.admin, 'Not Your Books Sdn Bhd');
    const [theirYear] = await withTenant(api.admin, { tenantId: other.tenantId }, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM fiscal_year WHERE tenant_id = ${other.tenantId}`,
    );

    const response = await call(api, {
      method: 'POST',
      ...as(`/v1/fiscal-years/${theirYear!.id}/close`),
    });

    // Rule 9: 403 would confirm the record exists.
    expect(response.status).toBe(404);
  });
});
