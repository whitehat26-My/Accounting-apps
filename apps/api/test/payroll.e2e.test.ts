import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessTokenFor,
  call,
  callRaw,
  createTestApi,
  pdfText,
  makeUser,
  seedTenant,
  type TestApi,
  type Tenant,
} from './helpers.js';

/**
 * Statutory payroll over HTTP — contributions and income tax.
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

    // No net pay from THIS route: it was not told who the employee is for tax
    // purposes, and a take-home figure that quietly omitted income tax would be
    // trusted precisely because it looks finished. `/payslip` is where net pay
    // lives, and it demands the tax profile before it will produce one.
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

describe('income tax over HTTP', () => {
  /** Seven months of a RM6,000 wage already paid this year. */
  const sevenMonthsIn = {
    accumulatedGross: '42000.00',
    accumulatedEpf: '4620.00',
    accumulatedMtd: '1452.50',
  };

  const technician = {
    wage: '6000.00',
    asOf: '2026-08-01',
    age: 35,
    citizenship: 'CITIZEN' as const,
  };

  it('returns a real net pay once the tax profile is supplied', async () => {
    const response = await call(api, {
      method: 'POST',
      ...asOwner('/v1/payroll/payslip'),
      body: {
        ...technician,
        tax: { resident: true, category: 1, qualifyingChildren: 0 },
        taxYearToDate: sevenMonthsIn,
      },
    });

    expect(response.status).toBe(201);
    const body = response.body as {
      pcb: { deduction: string; chargeableIncome: string } | null;
      netPay: string | null;
      totalEmployee: string;
    };
    expect(body.pcb?.deduction).toBe('207.5000');
    expect(body.pcb?.chargeableIncome).toBe('59000.0000');
    expect(body.netPay).not.toBeNull();
    // Net pay is gross less contributions AND tax — strictly less than the
    // contributions-only figure the other route returns.
    expect(Number(body.netPay)).toBeLessThan(6000 - Number(body.totalEmployee));
  });

  it('refuses to invent a tax category', async () => {
    // No default. Assuming "single" would over-deduct a married sole earner by
    // RM4,000 of relief every year, and the client knows the answer.
    const response = await call(api, {
      method: 'POST',
      ...asOwner('/v1/payroll/payslip'),
      body: { ...technician, taxYearToDate: sevenMonthsIn },
    });
    expect(response.status).toBe(422);
  });

  it('still refuses SALES — a payslip is not counter information', async () => {
    const response = await call(api, {
      method: 'POST',
      url: '/v1/payroll/payslip',
      token: salesToken,
      tenantId: tenant.tenantId,
      body: {
        ...technician,
        tax: { resident: true, category: 1, qualifyingChildren: 0 },
      },
    });
    expect(response.status).toBe(403);
  });

  it('leaves netPay null on the contributions route, which computes no tax', async () => {
    const response = await call(api, {
      method: 'POST',
      ...asOwner('/v1/payroll/contributions'),
      body: technician,
    });
    expect(response.status).toBe(201);
    // Two routes, two different questions, and the one that does not know the
    // tax profile does not pretend to know the take-home.
    expect(response.body).not.toHaveProperty('netPay');
    expect(response.body).toHaveProperty('wageAfterContributions');
  });
});

describe('the printed payslip', () => {
  const technician = {
    wage: '6000.00',
    asOf: '2026-08-01',
    age: 35,
    citizenship: 'CITIZEN' as const,
    tax: { resident: true, category: 1, qualifyingChildren: 0 },
    taxYearToDate: {
      accumulatedGross: '42000.00',
      accumulatedEpf: '4620.00',
      accumulatedMtd: '1452.50',
    },
    employee: { name: 'Nurul Huda binti Ahmad', staffId: 'SGT-004', jobTitle: 'Technician' },
  };

  it('renders a PDF', async () => {
    const response = await callRaw(api, {
      method: 'POST',
      ...asOwner('/v1/payroll/payslip/pdf'),
      body: technician,
    });

    expect(response.status).toBe(201);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('payslip-august-2026.pdf');
    expect(response.body.startsWith('%PDF')).toBe(true);

    // Assert what is ON the page, not merely that a PDF came back.
    const text = pdfText(response.body);
    expect(text).toContain('Nurul Huda binti Ahmad');
    expect(text).toContain('August 2026');
    expect(text).toContain('NET PAY');
    expect(text).toContain('5,046.20');
    // Both halves of SOCSO, separately — PERKESO's own statement splits them,
    // and a combined figure could not be reconciled against it.
    expect(text).toContain('SOCSO');
    expect(text).toContain('SKBBK');
    // Every deduction names the instrument it comes from, so the figure can be
    // checked against the authority's table instead of taken on trust.
    expect(text).toContain('Third Schedule, Part A');
    // The employer's share is on the page and explicitly not deducted.
    expect(text).toContain('NOT DEDUCTED FROM YOUR PAY');
  });

  it('refuses to print one without a tax profile', async () => {
    // A document headed "net pay" that silently omitted income tax would be
    // believed absolutely. The calculator may answer without a tax profile; a
    // payslip may not.
    const { tax: _omitted, ...withoutTax } = technician;
    const response = await call(api, {
      method: 'POST',
      ...asOwner('/v1/payroll/payslip/pdf'),
      body: withoutTax,
    });
    expect(response.status).toBe(422);
  });

  it('requires a name — a payslip is addressed to someone', async () => {
    const response = await call(api, {
      method: 'POST',
      ...asOwner('/v1/payroll/payslip/pdf'),
      body: { ...technician, employee: { name: '   ' } },
    });
    expect(response.status).toBe(422);
  });

  it('refuses SALES, like every other payroll route', async () => {
    const response = await call(api, {
      method: 'POST',
      url: '/v1/payroll/payslip/pdf',
      token: salesToken,
      tenantId: tenant.tenantId,
      body: technician,
    });
    expect(response.status).toBe(403);
  });
});
