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
let tenant: Tenant;
let token: string;

beforeAll(async () => {
  api = await createTestApi('reports');
  tenant = await seedTenant(api.admin, 'Reports Sdn Bhd');
  const user = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, user.refreshToken, tenant.tenantId));

  // A small but complete set of books, posted through the real routes.
  await journal('2026-02-01', 'Capital introduced', [
    ['1000', 'DEBIT', '100000.00'],
    ['3000', 'CREDIT', '100000.00'],
  ]);
  await journal('2026-03-01', 'Cash sale', [
    ['1000', 'DEBIT', '30000.00'],
    ['4000', 'CREDIT', '30000.00'],
  ]);
  await journal('2026-04-01', 'Office rent', [
    ['6000', 'DEBIT', '4000.00'],
    ['1000', 'CREDIT', '4000.00'],
  ]);
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

async function journal(
  entryDate: string,
  description: string,
  lines: readonly [string, 'DEBIT' | 'CREDIT', string][],
) {
  const response = await call(api, {
    method: 'POST',
    ...as('/v1/journals'),
    idempotencyKey: randomUUID(),
    body: {
      entryDate,
      description,
      lines: lines.map(([code, side, amount]) => ({
        accountId: tenant.accounts[code],
        side,
        amount,
      })),
    },
  });

  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}

// ---------------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------------

describe('GET /v1/reports/cash-flow', () => {
  it('returns a reconciling statement with the check on the face of it', async () => {
    const response = await call(api, {
      method: 'GET',
      ...as('/v1/reports/cash-flow?from=2026-01-01&to=2026-12-31'),
    });

    expect(response.status).toBe(200);
    expect(response.body['openingCash']).toBe('0.0000');
    expect(response.body['closingCash']).toBe('126000.0000');
    expect(response.body['netCashFlow']).toBe('126000.0000');

    // The doubt travels WITH the numbers rather than being logged somewhere the
    // reader will never look.
    expect(response.body['reconciles']).toBe(true);
    expect(response.body['rollupAgrees']).toBe(true);
    expect(response.body['violations']).toEqual([]);

    const sections = response.body['sections'] as { activity: string; subtotal: string }[];
    expect(sections.find((s) => s.activity === 'OPERATING')!.subtotal).toBe('26000.0000');
    expect(sections.find((s) => s.activity === 'FINANCING')!.subtotal).toBe('100000.0000');
  });

  it('sends money as decimal strings, never as JSON numbers', async () => {
    // A JSON number is an IEEE-754 double. Every amount on a financial
    // statement leaving as one would be the single worst bug in this system.
    const response = await callRaw(api, {
      method: 'GET',
      ...as('/v1/reports/cash-flow?from=2026-01-01&to=2026-12-31'),
    });

    expect(response.body).toContain('"closingCash":"126000.0000"');
    expect(response.body).not.toMatch(/"(closingCash|netCashFlow|openingCash)":\s*-?\d/);
  });

  it('rejects a malformed date rather than guessing', async () => {
    // 422, matching the API's established vocabulary: the request was
    // well-formed, its content was not acceptable. `01/01/2026` is the DISPLAY
    // format — accepting it on the wire is how a date silently becomes the
    // first of January when it meant the first of a different month.
    const response = await call(api, {
      method: 'GET',
      ...as('/v1/reports/cash-flow?from=01/01/2026&to=2026-12-31'),
    });

    expect(response.status).toBe(422);
  });
});

describe('cash flow classification', () => {
  it('surfaces an unclassified account, then moves it once decided', async () => {
    const [asset] = await api.admin<{ id: string }[]>`
        INSERT INTO account (tenant_id, code, name, type)
        VALUES (${tenant.tenantId}, '1600', 'Plant and machinery', 'ASSET')
        RETURNING id
    `;

    // Posted by id rather than through `journal()`, which only knows the codes
    // the seeded fixture created.
    const posting = await call(api, {
      method: 'POST',
      ...as('/v1/journals'),
      idempotencyKey: randomUUID(),
      body: {
        entryDate: '2026-05-01',
        description: 'Bought a lathe',
        lines: [
          { accountId: asset!.id, side: 'DEBIT', amount: '20000.00' },
          { accountId: tenant.accounts['1000'], side: 'CREDIT', amount: '20000.00' },
        ],
      },
    });
    expect(posting.status, JSON.stringify(posting.body)).toBe(201);

    const before = await call(api, {
      method: 'GET',
      ...as('/v1/reports/cash-flow?from=2026-01-01&to=2026-12-31'),
    });

    expect(before.body['unclassifiedAccounts']).toEqual([
      { code: '1600', name: 'Plant and machinery' },
    ]);
    // Still reconciles: the money is in the total, just honestly labelled.
    expect(before.body['reconciles']).toBe(true);

    const decision = await call(api, {
      method: 'POST',
      ...as('/v1/reports/cash-flow/classifications'),
      idempotencyKey: randomUUID(),
      body: {
        accountId: asset!.id,
        classification: 'INVESTING',
        note: 'Capital equipment',
      },
    });

    expect(decision.status).toBe(201);

    const after = await call(api, {
      method: 'GET',
      ...as('/v1/reports/cash-flow?from=2026-01-01&to=2026-12-31'),
    });

    expect(after.body['unclassifiedAccounts']).toEqual([]);
    expect(after.body['netCashFlow']).toBe(before.body['netCashFlow']);

    const sections = after.body['sections'] as { activity: string; subtotal: string }[];
    expect(sections.find((s) => s.activity === 'INVESTING')!.subtotal).toBe('-20000.0000');
  });

  it('is org.manage, not report.read — it changes every statement retroactively', async () => {
    const reader = await makeUser(api, { tenantId: tenant.tenantId, role: 'READ_ONLY' });
    const { accessToken } = await accessTokenFor(api, reader.refreshToken, tenant.tenantId);

    const denied = await call(api, {
      method: 'POST',
      url: '/v1/reports/cash-flow/classifications',
      token: accessToken,
      tenantId: tenant.tenantId,
      idempotencyKey: randomUUID(),
      body: { accountId: tenant.accounts['1100'], classification: 'OPERATING' },
    });

    expect(denied.status).toBe(403);

    // The same user can still READ the statement it configures.
    const allowed = await call(api, {
      method: 'GET',
      url: '/v1/reports/cash-flow?from=2026-01-01&to=2026-12-31',
      token: accessToken,
      tenantId: tenant.tenantId,
    });
    expect(allowed.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Changes in equity
// ---------------------------------------------------------------------------

describe('GET /v1/reports/changes-in-equity', () => {
  it('closes on the figure the balance sheet shows, without a year-end close', async () => {
    const response = await call(api, {
      method: 'GET',
      ...as('/v1/reports/changes-in-equity?from=2026-01-01&to=2026-12-31'),
    });

    expect(response.status).toBe(200);
    expect(response.body['consistent'], JSON.stringify(response.body['violations'])).toBe(true);
    expect(response.body['otherMovements']).toBe('100000.0000');

    const components = response.body['components'] as { key: string; closing: string }[];
    expect(components.find((c) => c.key === 'UNCLOSED_PROFIT')).toBeDefined();

    // The SOFP, computed independently, must show the same total equity.
    const sofp = await call(api, {
      method: 'GET',
      ...as('/v1/reports/sofp?asOf=2026-12-31'),
    });
    const lines = sofp.body['lines'] as { label: string; amount: string }[];
    const totalEquityAndLiabilities = lines.find(
      (l) => l.label === 'Total equity and liabilities',
    )!;

    // No liabilities in this fixture, so the two figures are the same number.
    expect(totalEquityAndLiabilities.amount).toBe(response.body['closingEquity']);
  });
});

// ---------------------------------------------------------------------------
// The general ledger
// ---------------------------------------------------------------------------

describe('GET /v1/reports/general-ledger/:accountId', () => {
  it('carries a running balance forward from before the window', async () => {
    const response = await call(api, {
      method: 'GET',
      ...as(
        `/v1/reports/general-ledger/${tenant.accounts['1000']}?from=2026-03-01&to=2026-12-31`,
      ),
    });

    expect(response.status).toBe(200);
    expect(response.body['openingBalance']).toBe('100000.0000');

    const rows = response.body['rows'] as { balance: string; contraAccounts: string[] }[];
    expect(rows[0]!.balance).toBe('130000.0000');
    expect(rows[0]!.contraAccounts).toEqual(['4000 Sales Revenue']);
  });

  it('needs journal.read, which is more than report.read', async () => {
    const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
    const { accessToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId);

    const response = await call(api, {
      method: 'GET',
      url: `/v1/reports/general-ledger/${tenant.accounts['1000']}?from=2026-01-01&to=2026-12-31`,
      token: accessToken,
      tenantId: tenant.tenantId,
    });

    expect(response.status).toBe(403);
  });

  it('answers 404 for another tenant’s account, not 403', async () => {
    const other = await seedTenant(api.admin, 'Other Reports Sdn Bhd');

    const response = await call(api, {
      method: 'GET',
      ...as(
        `/v1/reports/general-ledger/${other.accounts['1000']}?from=2026-01-01&to=2026-12-31`,
      ),
    });

    // Confirming the row exists would leak that another organisation holds it.
    expect(response.status).toBe(404);
  });
});

describe('the owner-insight reports', () => {
  it('serve shape and CSV under report.read, and refuse SALES', async () => {
    for (const url of [
      '/v1/reports/stock-ageing',
      '/v1/reports/item-margins?from=2026-01-01&to=2026-12-31',
      '/v1/reports/repair-profit?from=2026-01-01&to=2026-12-31',
    ]) {
      const ok = await call(api, { method: 'GET', ...as(url) });
      expect(ok.status, url).toBe(200);
    }

    const csv = await callRaw(api, {
      method: 'GET',
      ...as('/v1/reports/stock-ageing/csv'),
    });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toContain('stock-ageing.csv');
    expect(csv.body).toContain('Days idle');

    const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
    const { accessToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId);
    const refused = await call(api, {
      method: 'GET',
      url: '/v1/reports/stock-ageing',
      token: accessToken,
      tenantId: tenant.tenantId,
    });
    expect(refused.status).toBe(403);
  });
});

describe('the second pair of eyes', () => {
  it('reports findings with their innocent explanations, and refuses SALES', async () => {
    const response = await call(api, {
      method: 'GET',
      ...as('/v1/reports/fraud-watch?from=2026-01-01&to=2026-12-31'),
    });
    expect(response.status).toBe(200);
    // What was CHECKED is reported even when nothing was found: a clean result
    // must be distinguishable from a check that never ran.
    expect((response.body['checksRun'] as string[]).length).toBeGreaterThan(0);
    for (const finding of response.body['findings'] as { innocentExplanation: string }[]) {
      expect(finding.innocentExplanation.length).toBeGreaterThan(0);
    }

    const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
    const { accessToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId);
    const refused = await call(api, {
      method: 'GET',
      url: '/v1/reports/fraud-watch?from=2026-01-01&to=2026-12-31',
      token: accessToken,
      tenantId: tenant.tenantId,
    });
    expect(refused.status).toBe(403);
  });
});

describe('free cash — what of the balance is actually the shop’s', () => {
  it('reports the split with a verdict, and refuses SALES', async () => {
    const response = await call(api, { method: 'GET', ...as('/v1/reports/free-cash') });
    expect(response.status).toBe(200);
    expect(response.body['bankBalance']).toBeDefined();
    expect(['COMFORTABLE', 'TIGHT', 'SHORT']).toContain(response.body['verdict']);
    // Money crosses the wire as decimal STRINGS, never JSON numbers (rule 2).
    expect(typeof response.body['freeCash']).toBe('string');

    const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
    const { accessToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId);
    const refused = await call(api, {
      method: 'GET',
      url: '/v1/reports/free-cash',
      token: accessToken,
      tenantId: tenant.tenantId,
    });
    expect(refused.status).toBe(403);
  });
});

describe('GET /v1/reports/journal', () => {
  it('returns both sides of every entry', async () => {
    const response = await call(api, {
      method: 'GET',
      ...as('/v1/reports/journal?from=2026-01-01&to=2026-12-31&sourceModule=MANUAL'),
    });

    expect(response.status).toBe(200);
    const entries = response.body['entries'] as {
      lines: unknown[]; totalDebit: string; totalCredit: string;
    }[];

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.lines.length).toBeGreaterThanOrEqual(2);
      expect(entry.totalDebit).toBe(entry.totalCredit);
    }
  });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe('CSV exports', () => {
  it('serves the general ledger as a downloadable, sniff-proof attachment', async () => {
    const response = await callRaw(api, {
      method: 'GET',
      ...as(
        `/v1/reports/general-ledger/${tenant.accounts['1000']}/export?from=2026-01-01&to=2026-12-31`,
      ),
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');
    // Without nosniff a browser may second-guess the declared type, which turns
    // a file served from the API's own origin into a content-injection surface.
    expect(response.headers['x-content-type-options']).toBe('nosniff');

    // A BOM, or Excel on Windows mangles every non-ASCII name in the file.
    expect(response.body.charCodeAt(0)).toBe(0xfeff);
    expect(response.body).toContain('Balance brought forward');
    expect(response.body).toContain('01/03/2026');
  });

  it('exports a trial balance and a cash flow statement too', async () => {
    const tb = await callRaw(api, {
      method: 'GET',
      ...as('/v1/reports/trial-balance/export?from=2026-01-01&to=2026-12-31'),
    });
    expect(tb.status).toBe(200);
    expect(tb.body).toContain('Trial balance');

    const cf = await callRaw(api, {
      method: 'GET',
      ...as('/v1/reports/cash-flow/export?from=2026-01-01&to=2026-12-31'),
    });
    expect(cf.status).toBe(200);
    expect(cf.body).toContain('Operating activities');
    expect(cf.body).toContain('Cash at the end of the period');
  });

  it('neutralises a formula planted in an account name', async () => {
    /*
     * An account name is user-controlled text that ends up in an export an
     * accountant opens in Excel. `=HYPERLINK(...)` there is a live link built
     * from the row it sits in — and this is the end-to-end proof that the guard
     * in packages/domain/src/csv.ts is actually on the path a real export takes.
     */
    const [evil] = await api.admin<{ id: string }[]>`
        INSERT INTO account (tenant_id, code, name, type)
        VALUES (${tenant.tenantId}, '1700',
                '=HYPERLINK("https://evil.example","Refund")', 'ASSET')
        RETURNING id
    `;

    await call(api, {
      method: 'POST',
      ...as('/v1/journals'),
      idempotencyKey: randomUUID(),
      body: {
        entryDate: '2026-06-01',
        description: 'Deposit paid',
        lines: [
          { accountId: evil!.id, side: 'DEBIT', amount: '10.00' },
          { accountId: tenant.accounts['1000'], side: 'CREDIT', amount: '10.00' },
        ],
      },
    });

    const response = await callRaw(api, {
      method: 'GET',
      ...as(
        `/v1/reports/general-ledger/${tenant.accounts['1000']}/export?from=2026-01-01&to=2026-12-31`,
      ),
    });

    // Present as text, guarded, and never as a formula.
    expect(response.body).toContain('HYPERLINK');
    expect(response.body).not.toMatch(/(^|[,\r\n])=HYPERLINK/);
  });
});

// ---------------------------------------------------------------------------
// Queue health — the route that would have caught the undrained outbox
// ---------------------------------------------------------------------------

describe('GET /v1/system/queues', () => {
  it('reports outbox state and the job schedule, with a verdict', async () => {
    /*
     * The outbox was written to by eight modules and read by nothing for nine
     * milestones, and it survived that long because there was nowhere to look.
     * This is that place.
     *
     * The journals posted by this suite emitted no outbox events — only
     * document services do — so the interesting assertion is the shape and the
     * verdict, not a count.
     */
    const response = await call(api, { method: 'GET', ...as('/v1/system/queues') });

    expect(response.status).toBe(200);
    expect(response.body['outbox']).toMatchObject({
      pending: expect.any(Number),
      failed: 0,
      stalledOverAnHour: 0,
    });
    expect(response.body['healthy']).toBe(true);

    const jobs = response.body['scheduledJobs'] as { name: string }[];
    expect(jobs.map((j) => j.name).sort()).toEqual([
      'audit-anchor',
      'einvoice-retry',
      'outbox-sweep',
      'payment-reminders',
      'rollup-drift',
      'weekly-digest',
    ]);
  });

  it('turns unhealthy when an event dead-letters, and names it', async () => {
    await api.admin`
        INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id,
                                  payload, status, attempts, last_error)
        VALUES (${tenant.tenantId}, 'invoice.issued', 'journal_entry', ${randomUUID()},
                '{}'::jsonb, 'FAILED', 8, 'no customer TIN')
    `;

    const response = await call(api, { method: 'GET', ...as('/v1/system/queues') });

    expect(response.body['healthy']).toBe(false);
    const dead = response.body['deadLettered'] as { eventType: string; lastError: string }[];
    // The reason travels with the failure. "Something failed eight times" is
    // not an answer anybody can act on.
    expect(dead[0]).toMatchObject({
      eventType: 'invoice.issued',
      lastError: 'no customer TIN',
    });
  });

  it('is system.read, which an accountant does not hold', async () => {
    // Queue health is an operational question, not an accounting one.
    const accountant = await makeUser(api, { tenantId: tenant.tenantId, role: 'ACCOUNTANT' });
    const { accessToken } = await accessTokenFor(api, accountant.refreshToken, tenant.tenantId);

    const response = await call(api, {
      method: 'GET',
      url: '/v1/system/queues',
      token: accessToken,
      tenantId: tenant.tenantId,
    });

    expect(response.status).toBe(403);
  });
});

describe('customer statements', () => {
  /*
   * The books above are manual journals, which means no receivables — a
   * statement needs actual documents. One invoice, part paid, gives the
   * document a shape worth checking: an opening balance of nothing, a charge, a
   * credit, and a closing balance that is neither.
   */
  beforeAll(async () => {
    const issued = await call(api, {
      method: 'POST',
      ...as('/v1/invoices'),
      idempotencyKey: randomUUID(),
      body: {
        contactId: tenant.customerId,
        issueDate: '2026-05-05',
        dueDate: '2026-06-04',
        lines: [
          {
            description: 'Workshop labour',
            quantity: '1',
            unitPrice: '1500.00',
            accountId: tenant.accounts['4000'],
            taxCodeId: tenant.taxCodes['NONE'],
          },
        ],
      },
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);

    const paid = await call(api, {
      method: 'POST',
      ...as('/v1/receipts'),
      idempotencyKey: randomUUID(),
      body: {
        contactId: tenant.customerId,
        paymentDate: '2026-05-20',
        amount: '600.00',
        method: 'TRANSFER',
        depositAccountId: tenant.accounts['1000'],
        allocations: [{ invoiceId: issued.body['invoiceId'] ?? issued.body['id'], amount: '600.00' }],
      },
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  }, 60_000);

  it('lists who owes something, then states one account', async () => {
    const owing = await call(api, { method: 'GET', ...as('/v1/statements?asOf=2026-12-31') });
    expect(owing.status).toBe(200);
    const customers = owing.body['customers'] as { id: string; balance: string }[];
    expect(customers.length).toBeGreaterThan(0);

    const first = customers[0]!;
    const statement = await call(api, {
      method: 'GET',
      ...as(`/v1/statements/${first.id}?from=2026-01-01&to=2026-12-31`),
    });

    expect(statement.status).toBe(200);
    // The list and the statement are computed by different queries. They are
    // allowed to be written separately; they are not allowed to disagree.
    expect(statement.body['closingBalance']).toBe(first.balance);
    expect(statement.body).toHaveProperty('openingBalance');
    expect(Array.isArray(statement.body['entries'])).toBe(true);
  });

  it('prints one as a PDF carrying the customer and the amount due', async () => {
    const owing = await call(api, { method: 'GET', ...as('/v1/statements?asOf=2026-12-31') });
    const first = (owing.body['customers'] as { id: string; name: string }[])[0]!;

    const response = await callRaw(api, {
      method: 'GET',
      ...as(`/v1/statements/${first.id}/pdf?from=2026-01-01&to=2026-12-31`),
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.body.startsWith('%PDF')).toBe(true);

    const text = pdfText(response.body);
    expect(text).toContain('STATEMENT OF ACCOUNT');
    expect(text).toContain(first.name);
    // The carried-forward figure is ON the page, not implied by the first row.
    expect(text).toContain('Balance brought forward');
    expect(text).toContain('AMOUNT NOW DUE');
  });

  it('refuses a period that ends before it starts', async () => {
    const owing = await call(api, { method: 'GET', ...as('/v1/statements?asOf=2026-12-31') });
    const first = (owing.body['customers'] as { id: string }[])[0]!;

    const response = await call(api, {
      method: 'GET',
      ...as(`/v1/statements/${first.id}?from=2026-12-31&to=2026-01-01`),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('answers 404 for a contact that is not this tenant’s', async () => {
    // Rule 9 at the edge: the same answer for "does not exist" and "is not
    // yours", so a customer list cannot be enumerated one id at a time.
    const response = await call(api, {
      method: 'GET',
      ...as('/v1/statements/00000000-0000-4000-8000-000000000000?from=2026-01-01&to=2026-12-31'),
    });
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The time machine
// ---------------------------------------------------------------------------

/*
 * Deliberately the LAST describe in this file. It posts an entry backdated
 * into a month the earlier suites make assertions about, and running it first
 * would move figures under tests that have nothing to do with it — which is,
 * with some irony, the exact defect this feature exists to surface.
 */
describe('the time machine', () => {
  it('reconstructs an instant, then names what changed and who', async () => {
    const closedAt = new Date().toISOString();

    const asRead = await call(api, {
      method: 'GET',
      ...as(`/v1/reports/books-as-at?asAt=${closedAt}&from=2026-03-01&to=2026-03-31`),
    });
    expect(asRead.status).toBe(200);
    const marchAsRead = (asRead.body['balances'] as { code: string; balance: string }[]).find(
      (b) => b.code === '4000',
    )!;
    // Money crosses the wire as a decimal STRING (rule 2).
    expect(typeof marchAsRead.balance).toBe('string');
    expect(marchAsRead.balance).toBe('-30000.0000');

    // Somebody finds an invoice in a drawer and posts it into closed March.
    await journal('2026-03-25', 'Invoice found in the drawer', [
      ['1100', 'DEBIT', '2500.00'],
      ['4000', 'CREDIT', '2500.00'],
    ]);

    // The earlier instant is unmoved — that is the whole claim.
    const stillAsRead = await call(api, {
      method: 'GET',
      ...as(`/v1/reports/books-as-at?asAt=${closedAt}&from=2026-03-01&to=2026-03-31`),
    });
    expect(
      (stillAsRead.body['balances'] as { code: string; balance: string }[]).find(
        (b) => b.code === '4000',
      )!.balance,
    ).toBe('-30000.0000');

    const diff = await call(api, {
      method: 'GET',
      ...as(`/v1/reports/what-changed?since=${closedAt}&from=2026-03-01&to=2026-03-31`),
    });
    expect(diff.status).toBe(200);
    expect(diff.body['unchanged']).toBe(false);

    const revenue = (diff.body['changes'] as { code: string; delta: string }[]).find(
      (c) => c.code === '4000',
    )!;
    expect(revenue.delta).toBe('-2500.0000');

    const entries = diff.body['entries'] as {
      description: string; kind: string; postedByName: string | null;
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.description).toBe('Invoice found in the drawer');
    expect(entries[0]!.kind).toBe('BACKDATED');
    // The half of the answer that matters. `makeUser` creates a real member,
    // so `audit_actor` resolves the name rather than returning null.
    expect(entries[0]!.postedByName).not.toBeNull();
  });

  it('says nothing changed rather than returning an empty table to interpret', async () => {
    const now = new Date().toISOString();
    const diff = await call(api, {
      method: 'GET',
      ...as(`/v1/reports/what-changed?since=${now}&until=${now}`),
    });
    expect(diff.status).toBe(200);
    expect(diff.body['unchanged']).toBe(true);
  });

  it('accepts a bare date as midnight in Kuala Lumpur, and refuses nonsense', async () => {
    const ok = await call(api, {
      method: 'GET',
      ...as('/v1/reports/books-as-at?asAt=2026-04-01'),
    });
    expect(ok.status).toBe(200);
    // Midnight KL on 1 April, so March's entries are in and April's are not:
    // an eight-hour slip to midnight UTC would land inside 31 March instead.
    expect(ok.body['asAt']).toBe('2026-04-01T00:00:00+08:00');

    const bad = await call(api, {
      method: 'GET',
      ...as('/v1/reports/books-as-at?asAt=last%20Tuesday'),
    });
    expect(bad.status).toBe(422);
  });

  it('offers the lock moments the screen presets itself from', async () => {
    const response = await call(api, { method: 'GET', ...as('/v1/reports/lock-moments') });
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body['moments'])).toBe(true);
  });

  it('exports the diff and the entries responsible in ONE file, and refuses SALES', async () => {
    const csv = await callRaw(api, {
      method: 'GET',
      ...as('/v1/reports/what-changed/csv?since=2026-01-01&from=2026-03-01&to=2026-03-31'),
    });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['x-content-type-options']).toBe('nosniff');
    expect(csv.body).toContain('Change (RM)');
    expect(csv.body).toContain('Posted by');
    expect(csv.body).toContain('Invoice found in the drawer');

    const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
    const { accessToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId);
    for (const url of [
      '/v1/reports/books-as-at?asAt=2026-04-01',
      '/v1/reports/what-changed?since=2026-01-01',
      '/v1/reports/lock-moments',
    ]) {
      const refused = await call(api, {
        method: 'GET', url, token: accessToken, tenantId: tenant.tenantId,
      });
      expect(refused.status, url).toBe(403);
    }
  });
});
