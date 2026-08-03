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
 * The five-person shop, as permissions: the boss sees everything, the
 * technician sees the bench and nothing with a ringgit sign on it, and the
 * boss builds that team over HTTP by email.
 */

let api: TestApi;
let tenant: Tenant;
let bossToken: string;

beforeAll(async () => {
  api = await createTestApi('team');
  tenant = await seedTenant(api.admin, 'Five People Sdn Bhd');
  const boss = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  ({ accessToken: bossToken } = await accessTokenFor(api, boss.refreshToken, tenant.tenantId));
}, 120_000);

afterAll(async () => {
  await api?.close();
});

describe('the technician boundary', () => {
  it('works the bench and cannot see money', async () => {
    const tech = await makeUser(api, { tenantId: tenant.tenantId, role: 'TECHNICIAN' });
    const { accessToken } = await accessTokenFor(api, tech.refreshToken, tenant.tenantId);
    const as = (url: string) => ({ url, token: accessToken, tenantId: tenant.tenantId });

    // The bench: allowed.
    expect((await call(api, { method: 'GET', ...as('/v1/repairs') })).status).toBe(200);
    expect((await call(api, { method: 'GET', ...as('/v1/stock') })).status).toBe(200);
    expect((await call(api, { method: 'GET', ...as('/v1/items') })).status).toBe(200);

    // Everything with a ringgit sign: refused.
    expect((await call(api, { method: 'GET', ...as('/v1/collections/overdue') })).status).toBe(403);
    expect((await call(api, { method: 'GET', ...as('/v1/reports/daily-takings') })).status).toBe(403);
    expect((await call(api, { method: 'GET', ...as('/v1/reports/sopl') })).status).toBe(403);
    expect((await call(api, { method: 'GET', ...as('/v1/pos/takings?date=2026-08-03') })).status).toBe(403);
    expect((await call(api, { method: 'GET', ...as('/v1/auth/members') })).status).toBe(403);
  });
});

describe('building the team by email', () => {
  it('adds a registered cashier by email, and the member list shows the whole shop', async () => {
    // The cashier registered herself but belongs to no organisation yet.
    const cashier = await makeUser(api);

    const added = await call(api, {
      method: 'POST',
      url: '/v1/auth/members',
      token: bossToken,
      tenantId: tenant.tenantId,
      body: { email: cashier.email.toUpperCase(), role: 'SALES' },
    });
    expect(added.status).toBe(201);

    const list = await call(api, {
      method: 'GET',
      url: '/v1/auth/members',
      token: bossToken,
      tenantId: tenant.tenantId,
    });
    expect(list.status).toBe(200);
    const members = list.body['members'] as { email: string; role: string }[];
    expect(members.find((m) => m.email === cashier.email)?.role).toBe('SALES');

    // And she can now sign in and ring a sale-shaped request.
    const { accessToken } = await accessTokenFor(api, cashier.refreshToken, tenant.tenantId);
    const takings = await call(api, {
      method: 'GET',
      url: '/v1/pos/takings?date=2026-08-03',
      token: accessToken,
      tenantId: tenant.tenantId,
    });
    expect(takings.status).toBe(200);
  });

  it('an Admin cannot act on an Owner, even granting a role below them', async () => {
    // The demote-the-Owner hole. `canGrantRole` lets an Admin grant READ_ONLY
    // (it is below them), and `addMember` upserts — so without the target-rank
    // guard an Admin could re-role an Owner to READ_ONLY and strip the one
    // person senior to them. The actor's rank is checked against the TARGET's
    // current rank, not just the role being granted.
    const targetOwner = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
    const admin = await makeUser(api, { tenantId: tenant.tenantId, role: 'ADMIN' });
    const { accessToken: adminToken } = await accessTokenFor(
      api, admin.refreshToken, tenant.tenantId,
    );

    const attempt = await call(api, {
      method: 'POST',
      url: '/v1/auth/members',
      token: adminToken,
      tenantId: tenant.tenantId,
      body: { userId: targetOwner.userId, role: 'READ_ONLY' },
    });
    expect(attempt.status).toBe(422);

    // The upsert never ran: the target still holds OWNER.
    const list = await call(api, {
      method: 'GET', url: '/v1/auth/members', token: bossToken, tenantId: tenant.tenantId,
    });
    const target = (list.body['members'] as { userId: string; role: string }[])
      .find((m) => m.userId === targetOwner.userId);
    expect(target?.role).toBe('OWNER');
  });

  it('says plainly when the email has no account', async () => {
    const response = await call(api, {
      method: 'POST',
      url: '/v1/auth/members',
      token: bossToken,
      tenantId: tenant.tenantId,
      body: { email: 'nobody@nowhere.my', role: 'SALES' },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(JSON.stringify(response.body)).toContain('register');
  });
});

describe('the chart series', () => {
  it('returns one point per day, zero days included', async () => {
    const response = await call(api, {
      method: 'GET',
      url: '/v1/reports/daily-takings?days=7',
      token: bossToken,
      tenantId: tenant.tenantId,
    });
    expect(response.status).toBe(200);

    const points = response.body['points'] as { date: string; receipts: string }[];
    expect(points).toHaveLength(7);
    // A tenant with no sales still charts: a flat zero line, not a gap.
    expect(points.every((p) => p.receipts === '0.0000')).toBe(true);
  });
});
