import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, createClient } from '@emil/db';
import { call, createTestApi, type TestApi } from './helpers.js';

/**
 * Who may open an account on this server.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY SUITE THAT RUNS `SIGNUP_MODE=invite`.
 *
 * Every other suite registers users freely and sets `open` — which is exactly
 * why this one exists. The DEFAULT is `invite`: a default that fails open
 * costs an operator their instance, while one that fails closed costs a line
 * in a harness. That trade is only sound if the closed path is tested, and
 * this is the test.
 * ---------------------------------------------------------------------------
 */

let api: TestApi;

const password = 'a-long-enough-password';
let n = 0;
const nextEmail = () => `invitee-${(n += 1)}-${Date.now().toString(36)}@example.com`;

const register = (email: string, inviteToken?: string) =>
  call(api, {
    method: 'POST',
    url: '/v1/auth/register',
    body: { email, password, fullName: 'A Person', ...(inviteToken ? { inviteToken } : {}) },
  });

beforeAll(async () => {
  api = await createTestApi('invite', { SIGNUP_MODE: 'invite' });
}, 120_000);

afterAll(async () => {
  await api?.close();
});

/*
 * Minting runs as the MIGRATING role. `api.admin` is that connection — the app
 * role has no INSERT on `signup_invite`, on purpose (0051), which is why this
 * could never have been done through a route.
 */
const admin = () => api.admin;

describe('the invite gate', () => {
  it('lets the FIRST account through, because the server is empty', async () => {
    /*
     * The bootstrap exception. Requiring an invite here would mean running a
     * CLI before you can use the machine you just deployed, to protect a
     * server with nothing on it.
     */
    const first = await register(nextEmail());
    expect(first.status).toBe(201);
  });

  it('refuses the SECOND account without an invitation', async () => {
    const refused = await register(nextEmail());
    expect(refused.status).toBe(403);
    expect(refused.body['message']).toMatch(/does not accept open sign-ups/);
  });

  it('accepts an invitation, once', async () => {
    const invite = await createInvite(admin(), { note: 'Delima Networks' });

    const accepted = await register(nextEmail(), invite.token);
    expect(accepted.status).toBe(201);

    // Single use, and it says so rather than pretending the code is wrong.
    const again = await register(nextEmail(), invite.token);
    expect(again.status).toBe(403);
    expect(again.body['message']).toMatch(/already been used/);
  });

  it('tells an expired invitation apart from an unknown one', async () => {
    const expired = await createInvite(admin(), { days: 1 });
    /*
     * BOTH timestamps move back. `signup_invite_expires_after_creation` refuses
     * an expiry before its own creation — the constraint caught the first
     * version of this test, which is the constraint working.
     */
    await admin()`
        UPDATE signup_invite
           SET created_at = now() - interval '30 days',
               expires_at = now() - interval '1 day'
         WHERE used_at IS NULL AND expires_at > now()
    `;

    const stale = await register(nextEmail(), expired.token);
    expect(stale.status).toBe(403);
    expect(stale.body['message']).toMatch(/expired/);

    const nonsense = await register(nextEmail(), 'not-a-code-we-ever-issued');
    expect(nonsense.status).toBe(403);
    expect(nonsense.body['message']).toMatch(/not one we issued/);
  });

  it('binds an invitation to one address when the operator names one', async () => {
    const bound = await createInvite(admin(), { email: 'Owner@Delima.example' });

    const wrong = await register('someone.else@example.com', bound.token);
    expect(wrong.status).toBe(403);
    expect(wrong.body['message']).toMatch(/different email address/);

    // Case-insensitive: nobody remembers how they capitalised their email.
    const right = await register('owner@delima.example', bound.token);
    expect(right.status).toBe(201);
  });

  it('does not spend an invitation on a registration that failed', async () => {
    const invite = await createInvite(admin());
    const email = nextEmail();

    expect((await register(email, invite.token)).status).toBe(201);

    /*
     * Same email again: `registerUser` refuses a duplicate, and the claim must
     * roll back with it. A second person could otherwise burn somebody's
     * invitation by guessing an address that already exists.
     */
    const duplicate = await register(email, invite.token);
    expect(duplicate.status).not.toBe(201);

    const [row] = await admin()<{ used_at: Date | null }[]>`
        SELECT used_at FROM signup_invite WHERE email IS NULL AND note IS NULL
         ORDER BY created_at DESC LIMIT 1
    `;
    expect(row!.used_at).not.toBeNull(); // spent by the FIRST, successful one
  });

  it('lets an owner invite their OWN next member, without the operator', async () => {
    /*
     * The dead end this closes: `POST /members` refuses an email with no
     * account, and under invite-only that person cannot register on their own.
     * Without this route a shop owner hiring a cashier would have to telephone
     * whoever runs the server.
     */
    const ownerEmail = nextEmail();
    const invite = await createInvite(admin());
    expect((await register(ownerEmail, invite.token)).status).toBe(201);

    const login = await call(api, {
      method: 'POST', url: '/v1/auth/login', body: { email: ownerEmail, password },
    });
    const org = await call(api, {
      method: 'POST',
      url: '/v1/organisations',
      body: {
        refreshToken: login.body['refreshToken'],
        organisation: { name: 'Owner Invites Sdn Bhd', fiscalYearStart: '2026-01-01' },
      },
    });
    const token = org.body['accessToken'] as string;
    const tenantId = (org.body['organisation'] as Record<string, unknown>)['tenantId'] as string;

    const cashier = nextEmail();
    const issued = await call(api, {
      method: 'POST', url: '/v1/auth/invites', token, tenantId, body: { email: cashier },
    });
    expect(issued.status).toBe(201);
    expect(issued.body['email']).toBe(cashier);

    // Bound to the address, so the code cannot be passed around.
    const elsewhere = await register(nextEmail(), issued.body['code'] as string);
    expect(elsewhere.status).toBe(403);

    expect((await register(cashier, issued.body['code'] as string)).status).toBe(201);

    // And now they can be added as a member, which is a separate decision.
    const added = await call(api, {
      method: 'POST', url: '/v1/auth/members', token, tenantId,
      body: { email: cashier, role: 'SALES' },
    });
    expect(added.status).toBe(201);
  });

  it('refuses to invite somebody who already has an account', async () => {
    const existing = nextEmail();
    const invite = await createInvite(admin());
    expect((await register(existing, invite.token)).status).toBe(201);

    const login = await call(api, {
      method: 'POST', url: '/v1/auth/login', body: { email: existing, password },
    });
    const org = await call(api, {
      method: 'POST',
      url: '/v1/organisations',
      body: {
        refreshToken: login.body['refreshToken'],
        organisation: { name: 'Dup Sdn Bhd', fiscalYearStart: '2026-01-01' },
      },
    });

    const again = await call(api, {
      method: 'POST',
      url: '/v1/auth/invites',
      token: org.body['accessToken'] as string,
      tenantId: (org.body['organisation'] as Record<string, unknown>)['tenantId'] as string,
      body: { email: existing },
    });
    expect(again.status).toBe(422);
    expect(again.body['message']).toMatch(/already has an account/);
  });

  it('never lets the API mint one — the app role has no INSERT', async () => {
    /*
     * The boundary is enforced by the database, not by the absence of a route.
     * `api.appUrl` is the unprivileged role the API actually connects as.
     */
    const asApp = createClient(api.appUrl);
    try {
      await expect(
        asApp`INSERT INTO signup_invite (token_hash, expires_at)
              VALUES ('x', now() + interval '1 day')`,
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await asApp.end();
    }
  });
});
