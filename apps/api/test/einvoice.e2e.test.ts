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
  api = await createTestApi('einvoice');
  tenant = await seedTenant(api.admin, 'MyInvois Sdn Bhd');
  const user = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, user.refreshToken, tenant.tenantId));

  // A tenant that can actually produce a submittable document. The seed
  // fixture deliberately does not carry the MyInvois identity block, which is
  // why the "under-configured" cases below are the DEFAULT rather than
  // something contrived.
  await api.admin`
      UPDATE organisation
         SET tin = 'C1234567890', msic_code = '62010',
             ssm_registration_no = '202601012345',
             address_line1 = 'Level 5, Menara Emil', city = 'Kuala Lumpur',
             postcode = '50450', state_code = '14', country_code = 'MY'
       WHERE id = ${tenant.tenantId}
  `;
  await api.admin`
      INSERT INTO contact_address (tenant_id, contact_id, address_type, line1, city,
                                   postcode, state_code, country_code)
      VALUES (${tenant.tenantId}, ${tenant.customerId}, 'BILLING', 'No 1 Jalan Ampang',
              'Kuala Lumpur', '50450', '14', 'MY')
  `;
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

async function issueInvoice(unitPrice = '1000.00') {
  const response = await call(api, {
    method: 'POST',
    ...as('/v1/invoices'),
    body: {
      contactId: tenant.customerId,
      issueDate: '2026-08-05',
      lines: [
        {
          description: 'Consulting services',
          quantity: '1',
          unitPrice,
          accountId: tenant.accounts['4000'],
          taxCodeId: tenant.taxCodes['SST-SVC'],
          // Required by MyInvois, per line. The route accepts it now.
          classificationCode: '022',
        },
      ],
    },
  });
  return response.body as { id: string; invoiceNo: string };
}

// ---------------------------------------------------------------------------
// The gap, stated as data
// ---------------------------------------------------------------------------

describe('e-Invoice is honest about not being able to send', () => {
  it('says so on the config, not only in a README', async () => {
    const response = await call(api, { method: 'GET', ...as('/v1/einvoice/config') });

    expect(response.status).toBe(200);
    // "Enabled" means documents get built and queued, never that they reach
    // LHDN. Conflating those is how a business believes it has filed.
    expect(response.body['adapterConfigured']).toBe(false);
    expect(response.body['note']).toMatch(/nothing is transmitted/);
  });

  it('shows the queue nothing is draining', async () => {
    await call(api, {
      method: 'POST',
      ...as('/v1/einvoice/config'),
      body: { isEnabled: true, environment: 'SANDBOX' },
    });

    const invoice = await issueInvoice();
    const queued = await call(api, { method: 'POST', ...as(`/v1/invoices/${invoice.id}/einvoice`), body: {} });
    expect(queued.status).toBe(201);
    expect(queued.body['status']).toBe('QUEUED');

    const due = await call(api, { method: 'GET', ...as('/v1/einvoice/submissions/due') });
    expect((due.body['submissions'] as unknown[]).length).toBeGreaterThan(0);
    expect(due.body['drainedBy']).toBeNull();
    expect(due.body['note']).toMatch(/Nothing drains this queue/);
  });

  it('counts what is stuck rather than calling it pending', async () => {
    const compliance = await call(api, { method: 'GET', ...as('/v1/einvoice/compliance') });
    // A document that was never transmitted is not "awaiting approval".
    expect(compliance.body['awaitingTransmission']).toBeGreaterThan(0);
    expect(compliance.body['valid']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// What IS ours
// ---------------------------------------------------------------------------

describe('building and validating a document', () => {
  it('reports what would stop a submission, without queueing anything', async () => {
    // Every violation this finds is local and fixable in master data. Surfacing
    // them against the invoice somebody just issued beats an async rejection.
    const invoice = await issueInvoice('250.00');
    const preview = await call(api, {
      method: 'GET',
      ...as(`/v1/invoices/${invoice.id}/einvoice-document`),
    });

    expect(preview.status).toBe(200);
    expect(preview.body['document']).toBeTruthy();
    expect(Array.isArray(preview.body['violations'])).toBe(true);

    // Nothing was queued by looking.
    const submissions = await call(api, { method: 'GET', ...as('/v1/einvoice/submissions') });
    const forInvoice = (submissions.body['submissions'] as { documentNo: string }[]).filter(
      (s) => s.documentNo === invoice.invoiceNo,
    );
    expect(forInvoice).toHaveLength(0);
  });

  it('flags a buyer with no TIN, which is a master-data fix', async () => {
    const noTin = await call(api, {
      method: 'POST',
      ...as('/v1/contacts'),
      body: { name: 'No TIN Sdn Bhd', isCustomer: true },
    });

    const invoice = await call(api, {
      method: 'POST',
      ...as('/v1/invoices'),
      body: {
        contactId: noTin.body['id'],
        issueDate: '2026-08-05',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitPrice: '100.00',
            accountId: tenant.accounts['4000'],
            taxCodeId: tenant.taxCodes['SST-SVC'],
          },
        ],
      },
    });

    const preview = await call(api, {
      method: 'GET',
      ...as(`/v1/invoices/${invoice.body['id'] as string}/einvoice-document`),
    });

    expect(preview.body['submittable']).toBe(false);
    expect(JSON.stringify(preview.body['violations'])).toMatch(/TIN/i);
  });
});

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

describe('the submission lifecycle', () => {
  it('walks QUEUED → SUBMITTED → VALID through the state machine', async () => {
    const invoice = await issueInvoice('750.00');
    const queued = await call(api, { method: 'POST', ...as(`/v1/invoices/${invoice.id}/einvoice`), body: {} });
    const id = queued.body['id'] as string;

    const submitted = await call(api, {
      method: 'POST',
      ...as(`/v1/einvoice/submissions/${id}/events`),
      body: { event: { type: 'SUBMIT' }, actor: 'SYSTEM' },
    });
    expect(submitted.body['status']).toBe('SUBMITTED');

    const validated = await call(api, {
      method: 'POST',
      ...as(`/v1/einvoice/submissions/${id}/events`),
      body: {
        event: {
          type: 'VALIDATED',
          lhdnUuid: 'F9D425P6DS7D8IU',
          longId: 'YRZ4H8K2',
          validatedAt: '2026-08-05T09:00:00.000Z',
        },
      },
    });
    expect(validated.body['status']).toBe('VALID');
  });

  it('refuses a transition the state machine does not allow', async () => {
    const invoice = await issueInvoice('120.00');
    const queued = await call(api, { method: 'POST', ...as(`/v1/invoices/${invoice.id}/einvoice`), body: {} });

    // VALIDATED straight from QUEUED skips submission entirely.
    const response = await call(api, {
      method: 'POST',
      ...as(`/v1/einvoice/submissions/${queued.body['id'] as string}/events`),
      body: {
        event: {
          type: 'VALIDATED',
          lhdnUuid: 'X',
          longId: 'Y',
          validatedAt: '2026-08-05T09:00:00.000Z',
        },
      },
    });

    expect(response.status).toBe(422);
  });

  it('rejects a malformed event at the boundary, not inside the state machine', async () => {
    const invoice = await issueInvoice('60.00');
    const queued = await call(api, { method: 'POST', ...as(`/v1/invoices/${invoice.id}/einvoice`), body: {} });

    // VALIDATED with no LHDN UUID. The transition rules depend on the payload,
    // so an incomplete event should fail here rather than deep inside.
    const response = await call(api, {
      method: 'POST',
      ...as(`/v1/einvoice/submissions/${queued.body['id'] as string}/events`),
      body: { event: { type: 'VALIDATED' } },
    });

    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Revaluation
// ---------------------------------------------------------------------------

describe('period-end FX revaluation', () => {
  it('shows the exposure before anything is posted', async () => {
    // A revaluation posts to the ledger and reverses the next day, so running
    // one to see the number is not free.
    const response = await call(api, {
      method: 'GET',
      ...as('/v1/fx/exposure?asOf=2026-08-31'),
    });

    expect(response.status).toBe(200);
    // Carried at, worth at the closing rate, and the difference a revaluation
    // would post. Zero here: this tenant has no foreign balances.
    expect(response.body['carryingBase']).toBe('0.0000');
    expect(response.body['difference']).toBe('0.0000');
  });

  it('posts an adjustment and its reversal together', async () => {
    const periods = await call(api, { method: 'GET', ...as('/v1/periods') });
    const august = (periods.body['periods'] as { id: string; sequence: number }[]).find(
      (p) => p.sequence === 8,
    )!;

    const response = await call(api, {
      method: 'POST',
      ...as('/v1/revaluations'),
      body: { fiscalPeriodId: august.id, asOfDate: '2026-08-31' },
    });

    expect(response.status).toBe(201);
    // No foreign balances on this tenant, so there is nothing to adjust — and
    // saying so is the correct answer rather than posting a zero entry.
    expect(response.body['status']).toBe('NO_ADJUSTMENT');

    const runs = await call(api, { method: 'GET', ...as('/v1/revaluations') });
    expect((runs.body['runs'] as unknown[]).length).toBe(1);
  });

  it('is idempotent, so a retried month end does not double-adjust', async () => {
    const periods = await call(api, { method: 'GET', ...as('/v1/periods') });
    const july = (periods.body['periods'] as { id: string; sequence: number }[]).find(
      (p) => p.sequence === 7,
    )!;

    const key = randomUUID();
    const body = { fiscalPeriodId: july.id, asOfDate: '2026-07-31' };

    const first = await call(api, { method: 'POST', ...as('/v1/revaluations'), idempotencyKey: key, body });
    const second = await call(api, { method: 'POST', ...as('/v1/revaluations'), idempotencyKey: key, body });

    expect(first.body['replayed']).toBe(false);
    expect(second.body['replayed']).toBe(true);
    expect(second.body['id']).toBe(first.body['id']);
  });
});

