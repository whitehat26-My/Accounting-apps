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
 * The compliance calendar over HTTP: the statuses arrive computed, the tick
 * needs compliance.manage, and the counter staff see none of it.
 */

let api: TestApi;
let tenant: Tenant;
let token: string;

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

beforeAll(async () => {
  api = await createTestApi('compliance');
  tenant = await seedTenant(api.admin, 'Compliance Routes Sdn Bhd');
  const owner = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: token } = await accessTokenFor(api, owner.refreshToken, tenant.tenantId));
}, 120_000);

afterAll(async () => {
  await api?.close();
});

describe('the calendar over HTTP', () => {
  it('serves the year with statuses and provenance grades', async () => {
    const response = await call(api, { method: 'GET', ...as('/v1/compliance/calendar?year=2026') });
    expect(response.status).toBe(200);

    const entries = response.body['entries'] as {
      ruleCode: string;
      verification: string;
      status: string;
    }[];
    // No staff on this tenant: SST rows only (the seed carries an SST number).
    expect(new Set(entries.map((e) => e.ruleCode))).toEqual(new Set(['SST_RETURN']));
    // The provenance grade travels to the client — the ⚠ is data, not styling.
    expect(entries[0]!.verification).toBe('SECONDARY');
  });

  it('ticks and unticks under compliance.manage', async () => {
    const ticked = await call(api, {
      method: 'POST',
      ...as('/v1/compliance/ticks'),
      body: { ruleCode: 'SST_RETURN', periodKey: '2026-P1', note: 'Filed on MySST' },
    });
    expect(ticked.status, JSON.stringify(ticked.body)).toBe(201);

    const calendar = await call(api, { method: 'GET', ...as('/v1/compliance/calendar?year=2026') });
    const p1 = (calendar.body['entries'] as { periodKey: string; status: string }[]).find(
      (e) => e.periodKey === '2026-P1',
    )!;
    expect(p1.status).toBe('DONE');

    const unticked = await call(api, {
      method: 'DELETE',
      ...as('/v1/compliance/ticks'),
      body: { ruleCode: 'SST_RETURN', periodKey: '2026-P1' },
    });
    expect(unticked.status).toBe(200);
  });

  it('SALES sees nothing, and a BOOKKEEPER can look but not tick', async () => {
    const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
    const salesToken = (await accessTokenFor(api, sales.refreshToken, tenant.tenantId)).accessToken;
    const refused = await call(api, {
      method: 'GET',
      url: '/v1/compliance/calendar?year=2026',
      token: salesToken,
      tenantId: tenant.tenantId,
    });
    expect(refused.status).toBe(403);

    const bookkeeper = await makeUser(api, { tenantId: tenant.tenantId, role: 'BOOKKEEPER' });
    const bkToken = (await accessTokenFor(api, bookkeeper.refreshToken, tenant.tenantId)).accessToken;
    const sees = await call(api, {
      method: 'GET',
      url: '/v1/compliance/calendar?year=2026',
      token: bkToken,
      tenantId: tenant.tenantId,
    });
    expect(sees.status).toBe(200);

    const cannotTick = await call(api, {
      method: 'POST',
      url: '/v1/compliance/ticks',
      token: bkToken,
      tenantId: tenant.tenantId,
      body: { ruleCode: 'SST_RETURN', periodKey: '2026-P2' },
    });
    expect(cannotTick.status).toBe(403);
  });
});
