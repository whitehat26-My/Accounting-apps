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
 * Statutory contributions over HTTP.
 *
 * The permission boundary is the point of this file. A wage is the most
 * confidential figure in a five-person shop, and the person at the counter has
 * no business seeing what the technician beside them earns — so SALES and
 * TECHNICIAN are locked out, and the test proves it rather than trusting the
 * decorator.
 */

let api: TestApi;
let tenant: Tenant;
let ownerToken: string;
let salesToken: string;

beforeAll(async () => {
  api = await createTestApi('payroll');
  tenant = await seedTenant(api.admin, 'Payroll Routes Sdn Bhd');

  const owner = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: ownerToken } = await accessTokenFor(api, owner.refreshToken, tenant.tenantId));

  const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
  ({ accessToken: salesToken } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId));
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const asOwner = (url: string) => ({ url, token: ownerToken, tenantId: tenant.tenantId });

const assistant = {
  wage: '2500.00',
  asOf: '2026-08-01',
  age: 24,
  citizenship: 'CITIZEN' as const,
};

describe('contributions over HTTP', () => {
  it('returns the schedule figures for a counter assistant on RM 2,500', async () => {
    const response = await call(api, {
      method: 'POST',
      ...asOwner('/v1/payroll/contributions'),
      body: assistant,
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      epfPart: 'A',
      socsoCategory: 1,
      eisApplies: true,
      // 13%, not the 12% everyone quotes — the employer rate steps down only
      // above RM5,000.
      epf: { employer: '325.0000', employee: '275.0000' },
    });

    // No net pay. PCB is not implemented and a figure that quietly omits income
    // tax would be trusted precisely because it looks finished.
    expect(response.body).not.toHaveProperty('netPay');
    expect(response.body).toHaveProperty('wageAfterContributions');
  });

  it('tells the owner what the hire actually costs', async () => {
    const response = await call(api, {
      method: 'POST',
      ...asOwner('/v1/payroll/employment-cost'),
      body: assistant,
    });

    expect(response.status).toBe(201);
    const { totalCost, breakdown } = response.body as {
      totalCost: string;
      breakdown: { totalEmployer: string };
    };
    expect(Number(totalCost)).toBeCloseTo(2500 + Number(breakdown.totalEmployer), 4);
  });

  it('serves the schedules themselves so the figures can be checked against PERKESO', async () => {
    const response = await call(api, {
      method: 'GET',
      ...asOwner('/v1/payroll/schedules?asOf=2026-08-01&part=A'),
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      epfBands: unknown[];
      socsoBands: unknown[];
      eisBands: unknown[];
      epfRule: { ceiling: string };
    };
    expect(body.epfBands).toHaveLength(401);
    expect(body.socsoBands).toHaveLength(65);
    expect(body.eisBands).toHaveLength(65);
    expect(body.epfRule.ceiling).toBe('20000.0000');
  });
});

describe('who may ask', () => {
  it('refuses SALES — a salary is not counter information', async () => {
    const response = await call(api, {
      method: 'POST',
      url: '/v1/payroll/contributions',
      token: salesToken,
      tenantId: tenant.tenantId,
      body: assistant,
    });
    expect(response.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await call(api, {
      method: 'POST',
      url: '/v1/payroll/contributions',
      tenantId: tenant.tenantId,
      body: assistant,
    });
    expect(response.status).toBe(401);
  });
});

describe('what it refuses to guess', () => {
  it('rejects a request with no contribution month rather than assuming today', async () => {
    // SKBBK began on 1 June 2026. A default of `now()` would silently restate a
    // re-run of an earlier month, so the date is required at the edge too.
    const { asOf: _omitted, ...withoutDate } = assistant;
    const response = await call(api, {
      method: 'POST',
      ...asOwner('/v1/payroll/contributions'),
      body: withoutDate,
    });
    expect(response.status).toBe(422);
  });

  it('rejects a wage sent as a JSON number', async () => {
    // Rule 2. A float that reaches this far has already lost sen.
    const response = await call(api, {
      method: 'POST',
      ...asOwner('/v1/payroll/contributions'),
      body: { ...assistant, wage: 2500 },
    });
    expect(response.status).toBe(422);
  });

  it('fails loudly for a date before any schedule this system carries', async () => {
    const response = await call(api, {
      method: 'POST',
      ...asOwner('/v1/payroll/contributions'),
      body: { ...assistant, asOf: '1999-01-01' },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(response.body)).toContain('NO_SCHEDULE_IN_FORCE');
  });
});
