import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can, canGrantRole, unwrap, validateJournalEntry, Money, type JournalEntryDraft } from '@emil/domain';
import { withTenant, withUser, type Sql } from '../src/client.js';
import {
  addMember,
  authenticate,
  createSession,
  hashToken,
  IdentityError,
  issueApiKey,
  membershipsForUser,
  mintToken,
  principalFor,
  refreshSession,
  registerUser,
  resolveApiKey,
  revokeSession,
  verifyPassword,
  hashPassword,
} from '../src/identity.js';
import { postJournalEntry } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let alpha: Tenant;
let beta: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('identity');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  alpha = await seedTenant(db.admin, 'Alpha Trading Sdn Bhd');
  beta = await seedTenant(db.admin, 'Beta Services Sdn Bhd');
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const register = (email: string) =>
  withUser(sql, null, (tx) =>
    registerUser(tx, { email, password: 'correct horse battery staple', fullName: 'Test User' }),
  );

describe('passwords', () => {
  it('hashes with Argon2id and verifies', async () => {
    const hash = await hashPassword('a good password');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'a good password')).toBe(true);
    expect(await verifyPassword(hash, 'a bad password')).toBe(false);
  });

  it('produces a different hash each time, so equal passwords are not equal hashes', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });

  it('fails closed on a malformed stored hash rather than throwing', async () => {
    // A 500 here tells the caller their password was probably right.
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('registration and authentication', () => {
  it('registers and authenticates', async () => {
    const email = `owner-${randomUUID().slice(0, 8)}@example.com`;
    const { id } = await register(email);

    const user = await withUser(sql, null, (tx) =>
      authenticate(tx, email, 'correct horse battery staple'),
    );
    expect(user.id).toBe(id);
  });

  it('is case-insensitive on email', async () => {
    const email = `Mixed-${randomUUID().slice(0, 8)}@Example.com`;
    await register(email);
    const user = await withUser(sql, null, (tx) =>
      authenticate(tx, email.toLowerCase(), 'correct horse battery staple'),
    );
    expect(user.email.toLowerCase()).toBe(email.toLowerCase());
  });

  it('refuses a duplicate email', async () => {
    const email = `dupe-${randomUUID().slice(0, 8)}@example.com`;
    await register(email);
    await expect(register(email)).rejects.toThrow(/already registered/i);
  });

  it('gives the same message for a wrong email and a wrong password', async () => {
    const email = `known-${randomUUID().slice(0, 8)}@example.com`;
    await register(email);

    const wrongPassword = await withUser(sql, null, (tx) =>
      authenticate(tx, email, 'wrong').catch((e: IdentityError) => e),
    );
    const unknownEmail = await withUser(sql, null, (tx) =>
      authenticate(tx, 'nobody@example.com', 'wrong').catch((e: IdentityError) => e),
    );

    expect((wrongPassword as IdentityError).code).toBe('INVALID_CREDENTIALS');
    expect((unknownEmail as IdentityError).code).toBe('INVALID_CREDENTIALS');
    expect((wrongPassword as IdentityError).message).toBe((unknownEmail as IdentityError).message);
  });

  it('takes comparable time for an unknown email and a wrong password', async () => {
    // Returning early on an unknown email skips the deliberately-slow Argon2
    // verification. That timing gap is measurable over a network and turns the
    // login form into an account-enumeration oracle.
    const email = `timing-${randomUUID().slice(0, 8)}@example.com`;
    await register(email);

    const time = async (fn: () => Promise<unknown>) => {
      const started = performance.now();
      await fn().catch(() => {});
      return performance.now() - started;
    };

    const wrongPassword = await time(() =>
      withUser(sql, null, (tx) => authenticate(tx, email, 'wrong')),
    );
    const unknownEmail = await time(() =>
      withUser(sql, null, (tx) => authenticate(tx, 'ghost@example.com', 'wrong')),
    );

    // Generous bound: this asserts the dummy verification actually happens,
    // not a precise timing guarantee, which a shared CI box cannot give.
    const ratio = Math.max(wrongPassword, unknownEmail) / Math.max(1, Math.min(wrongPassword, unknownEmail));
    expect(ratio).toBeLessThan(10);
  });

  it('locks an account after repeated failures', async () => {
    const email = `lockout-${randomUUID().slice(0, 8)}@example.com`;
    await register(email);

    for (let i = 0; i < 10; i++) {
      await withUser(sql, null, (tx) => authenticate(tx, email, 'wrong').catch(() => {}));
    }

    await expect(
      withUser(sql, null, (tx) => authenticate(tx, email, 'correct horse battery staple')),
    ).rejects.toThrow(/too many failed attempts/i);
  });

  it('clears the failure count on a successful login', async () => {
    const email = `recover-${randomUUID().slice(0, 8)}@example.com`;
    await register(email);

    for (let i = 0; i < 3; i++) {
      await withUser(sql, null, (tx) => authenticate(tx, email, 'wrong').catch(() => {}));
    }
    await withUser(sql, null, (tx) => authenticate(tx, email, 'correct horse battery staple'));

    const [row] = await admin<{ failed_logins: number }[]>`
        SELECT failed_logins FROM app_user WHERE lower(email) = lower(${email})
    `;
    expect(row!.failed_logins).toBe(0);
  });
});

describe('refresh token rotation', () => {
  async function loggedIn() {
    const email = `session-${randomUUID().slice(0, 8)}@example.com`;
    const { id } = await register(email);
    const session = await withUser(sql, id, (tx) => createSession(tx, id));
    return { userId: id, session };
  }

  const refresh = (token: string) => withUser(sql, null, (tx) => refreshSession(tx, token));

  it('rotates a token, invalidating the old one', async () => {
    const { session } = await loggedIn();

    const rotated = await refresh(session.refreshToken);
    expect(rotated.ok).toBe(true);
    if (rotated.ok) expect(rotated.session.refreshToken).not.toBe(session.refreshToken);

    // The old one is now spent. Using it is reuse, not merely invalid.
    const replay = await refresh(session.refreshToken);
    expect(replay).toMatchObject({ ok: false, code: 'SESSION_REUSED' });
  });

  it('revokes the ENTIRE family when a spent token is replayed', async () => {
    // The critical behaviour. Revoking only the presented token would leave a
    // thief who refreshed first holding a live session — which is the attack.
    const { session } = await loggedIn();

    const first = await refresh(session.refreshToken);
    expect(first.ok).toBe(true);
    const second = first.ok ? await refresh(first.session.refreshToken) : first;
    expect(second.ok).toBe(true);

    // Replay the original.
    expect(await refresh(session.refreshToken)).toMatchObject({
      ok: false,
      code: 'SESSION_REUSED',
    });

    // The token that was live a moment ago is dead too.
    if (second.ok) {
      expect(await refresh(second.session.refreshToken)).toMatchObject({
        ok: false,
        code: 'SESSION_INVALID',
      });
    }

    const [row] = await admin<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM user_session
         WHERE family_id = ${session.familyId} AND revoked_at IS NULL
    `;
    expect(row!.count).toBe('0');
  });

  it('COMMITS the family revocation rather than rolling it back', async () => {
    // The bug this test exists for. An earlier version threw an error on reuse
    // — from inside the transaction — which rolled back the family revocation
    // performed moments before. The system detected the theft, reported it,
    // and then quietly undid its own response.
    const { session } = await loggedIn();
    const rotated = await refresh(session.refreshToken);
    expect(rotated.ok).toBe(true);

    await refresh(session.refreshToken); // trigger reuse detection

    // Read on a SEPARATE connection: this only passes if the revocation was
    // actually committed.
    const rows = await admin<{ revoked_at: Date | null; revoked_reason: string | null }[]>`
        SELECT revoked_at, revoked_reason FROM user_session
         WHERE family_id = ${session.familyId}
    `;
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
    expect(rows.every((r) => /reuse/i.test(r.revoked_reason ?? ''))).toBe(true);
  });

  it('rejects a token nobody issued without revoking anything', async () => {
    const { token } = mintToken();
    expect(await refresh(token)).toMatchObject({ ok: false, code: 'SESSION_INVALID' });
  });

  it('rejects a revoked session', async () => {
    const { session } = await loggedIn();
    await withUser(sql, null, (tx) => revokeSession(tx, session.sessionId));
    const result = await refresh(session.refreshToken);
    expect(result).toMatchObject({ ok: false, code: 'SESSION_INVALID' });
    if (!result.ok) expect(result.message).toMatch(/REVOKED/);
  });

  it('stores only the digest, never the token', async () => {
    const { session } = await loggedIn();

    const [row] = await admin<{ refresh_token_hash: string }[]>`
        SELECT refresh_token_hash FROM user_session WHERE id = ${session.sessionId}
    `;
    expect(row!.refresh_token_hash).toBe(hashToken(session.refreshToken));
    expect(row!.refresh_token_hash).not.toBe(session.refreshToken);
  });
});

describe('the identity tables are unreachable to the application role', () => {
  it('refuses a direct read of app_user', async () => {
    // The claim migration 0012 makes in prose, checked. Authentication reaches
    // these tables only through narrow SECURITY DEFINER functions.
    await expect(withUser(sql, null, (tx) => tx`SELECT * FROM app_user`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('refuses a direct read of user_session', async () => {
    await expect(
      withUser(sql, null, (tx) => tx`SELECT * FROM user_session`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('still allows the sanctioned lookups', async () => {
    const email = `reachable-${randomUUID().slice(0, 8)}@example.com`;
    await register(email);
    const found = await withUser(sql, null, (tx) =>
      tx`SELECT id FROM find_user_for_authentication(${email})`,
    );
    expect(found).toHaveLength(1);
  });
});

describe('memberships and the organisation switcher', () => {
  it('lists a user’s organisations with no tenant context', async () => {
    const { id } = await register(`multi-${randomUUID().slice(0, 8)}@example.com`);

    for (const t of [alpha, beta]) {
      const ctx = { tenantId: t.tenantId, userId: id };
      await withTenant(sql, ctx, (tx) => addMember(tx, ctx, { userId: id, role: 'ACCOUNTANT' }));
    }

    const memberships = await withUser(sql, id, (tx) => membershipsForUser(tx, id));
    expect(memberships.map((m) => m.tenantId).sort()).toEqual(
      [alpha.tenantId, beta.tenantId].sort(),
    );
  });

  it('shows a user only their OWN memberships outside a tenant context', async () => {
    // The membership policy is the one deliberate exception to
    // `tenant_id = current_tenant_id()`. It must widen visibility by exactly
    // the caller's own rows and nothing more.
    const mine = await register(`mine-${randomUUID().slice(0, 8)}@example.com`);
    const theirs = await register(`theirs-${randomUUID().slice(0, 8)}@example.com`);

    for (const userId of [mine.id, theirs.id]) {
      const ctx = { tenantId: alpha.tenantId, userId };
      await withTenant(sql, ctx, (tx) => addMember(tx, ctx, { userId, role: 'SALES' }));
    }

    const visible = await withUser(sql, mine.id, (tx) =>
      tx<{ user_id: string }[]>`SELECT user_id FROM membership`,
    );

    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((r) => r.user_id === mine.id)).toBe(true);
  });

  it('resolves a principal with the role’s permissions', async () => {
    const { id } = await register(`principal-${randomUUID().slice(0, 8)}@example.com`);
    const ctx = { tenantId: alpha.tenantId, userId: id };
    await withTenant(sql, ctx, (tx) => addMember(tx, ctx, { userId: id, role: 'BOOKKEEPER' }));

    const principal = await withTenant(sql, ctx, (tx) => principalFor(tx, id, alpha.tenantId));

    expect(principal).toBeDefined();
    expect(can(principal!, 'invoice.create')).toBe(true);
    expect(can(principal!, 'period.override')).toBe(false);
    expect(can(principal!, 'org.delete')).toBe(false);
  });

  it('returns no principal for a tenant the user does not belong to', async () => {
    // The caller turns this into a 404, never a 403 — CLAUDE.md rule 9.
    const { id } = await register(`outsider-${randomUUID().slice(0, 8)}@example.com`);
    const ctx = { tenantId: alpha.tenantId, userId: id };
    await withTenant(sql, ctx, (tx) => addMember(tx, ctx, { userId: id, role: 'SALES' }));

    const principal = await withTenant(sql, { tenantId: beta.tenantId, userId: id }, (tx) =>
      principalFor(tx, id, beta.tenantId),
    );
    expect(principal).toBeUndefined();
  });

  it('expires a time-boxed external auditor', async () => {
    const { id } = await register(`auditor-${randomUUID().slice(0, 8)}@example.com`);
    const ctx = { tenantId: alpha.tenantId, userId: id };

    await withTenant(sql, ctx, (tx) =>
      addMember(tx, ctx, {
        userId: id,
        role: 'EXTERNAL_AUDITOR',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    );

    expect(await withTenant(sql, ctx, (tx) => principalFor(tx, id, alpha.tenantId))).toBeUndefined();
  });

  it('the domain refuses a grant above the actor’s own rank', async () => {
    expect(canGrantRole('ADMIN', 'OWNER')).toBe(false);
    expect(canGrantRole('OWNER', 'ADMIN')).toBe(true);
  });
});

describe('API keys', () => {
  it('is scoped to one organisation and narrows the role’s permissions', async () => {
    const { id } = await register(`apikey-${randomUUID().slice(0, 8)}@example.com`);
    const ctx = { tenantId: alpha.tenantId, userId: id };
    await withTenant(sql, ctx, (tx) => addMember(tx, ctx, { userId: id, role: 'OWNER' }));

    const issued = await withTenant(sql, ctx, (tx) =>
      issueApiKey(tx, ctx, { name: 'Reporting integration', scopes: ['report.read'] }),
    );

    const resolved = await resolveApiKey(admin, issued.key);
    expect(resolved?.tenantId).toBe(alpha.tenantId);

    const principal = await withTenant(sql, ctx, (tx) =>
      principalFor(tx, id, alpha.tenantId, { id: resolved!.id, scopes: resolved!.scopes }),
    );

    // The user is an Owner, so the ROLE permits everything. The key does not.
    expect(can(principal!, 'report.read')).toBe(true);
    expect(can(principal!, 'invoice.create')).toBe(false);
    expect(can(principal!, 'org.delete')).toBe(false);
  });

  it('stores only the digest', async () => {
    const { id } = await register(`digest-${randomUUID().slice(0, 8)}@example.com`);
    const ctx = { tenantId: alpha.tenantId, userId: id };
    await withTenant(sql, ctx, (tx) => addMember(tx, ctx, { userId: id, role: 'ADMIN' }));

    const issued = await withTenant(sql, ctx, (tx) =>
      issueApiKey(tx, ctx, { name: 'Digest check', scopes: ['report.read'] }),
    );

    const [row] = await admin<{ key_hash: string }[]>`
        SELECT key_hash FROM api_key WHERE id = ${issued.id}
    `;
    expect(row!.key_hash).toBe(hashToken(issued.key));
    expect(row!.key_hash).not.toContain(issued.key);
  });

  it('does not resolve a revoked key', async () => {
    const { id } = await register(`revoked-${randomUUID().slice(0, 8)}@example.com`);
    const ctx = { tenantId: alpha.tenantId, userId: id };
    await withTenant(sql, ctx, (tx) => addMember(tx, ctx, { userId: id, role: 'ADMIN' }));

    const issued = await withTenant(sql, ctx, (tx) =>
      issueApiKey(tx, ctx, { name: 'To revoke', scopes: ['report.read'] }),
    );
    await withTenant(sql, ctx, (tx) => tx`
        UPDATE api_key SET revoked_at = now()
         WHERE tenant_id = ${alpha.tenantId} AND id = ${issued.id}
    `);

    expect(await resolveApiKey(admin, issued.key)).toBeUndefined();
  });
});

describe('ledger invariant #9 — a locked-period override leaves a financial event', () => {
  const entry = (t: Tenant, date: string): JournalEntryDraft => ({
    entryDate: date,
    description: 'Override posting',
    sourceModule: 'MANUAL',
    lines: [
      {
        accountId: t.accounts['1100']!,
        side: 'DEBIT',
        amount: Money.fromDecimal('250', 'MYR'),
        baseAmount: Money.fromDecimal('250', 'MYR'),
      },
      {
        accountId: t.accounts['4000']!,
        side: 'CREDIT',
        amount: Money.fromDecimal('250', 'MYR'),
        baseAmount: Money.fromDecimal('250', 'MYR'),
      },
    ],
  });

  it('refuses without the override permission and logs nothing', async () => {
    const ctx = { tenantId: alpha.tenantId, userId: alpha.userId };
    const before = await eventCount(alpha.tenantId);

    await expect(
      withTenant(sql, ctx, (tx) =>
        postJournalEntry(tx, ctx, unwrap(validateJournalEntry(entry(alpha, '2026-01-15'), 'MYR')), {
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/LOCKED/i);

    expect(await eventCount(alpha.tenantId)).toBe(before);
  });

  it('writes a LOCKED_PERIOD_OVERRIDE row when the permission is used', async () => {
    // The half of invariant #9 that had nowhere to go until now: the override
    // has been enforced since the ledger core landed, but the log row that
    // makes exercising it visible did not exist.
    const ctx = { tenantId: alpha.tenantId, userId: alpha.userId, allowLockedPeriod: true };

    const posted = await withTenant(sql, ctx, (tx) =>
      postJournalEntry(tx, ctx, unwrap(validateJournalEntry(entry(alpha, '2026-01-16'), 'MYR')), {
        idempotencyKey: randomUUID(),
      }),
    );
    expect(posted.replayed).toBe(false);

    const [event] = await withTenant(sql, ctx, (tx) =>
      tx<{ event_type: string; permission: string; actor_user_id: string; detail: unknown }[]>`
          SELECT event_type, permission, actor_user_id, detail
            FROM financial_event_log
           WHERE tenant_id = ${alpha.tenantId} AND event_type = 'LOCKED_PERIOD_OVERRIDE'
           ORDER BY id DESC LIMIT 1
      `,
    );

    expect(event).toMatchObject({
      event_type: 'LOCKED_PERIOD_OVERRIDE',
      permission: 'period.override',
      actor_user_id: alpha.userId,
    });
    expect(event!.detail).toMatchObject({ entryDate: '2026-01-16', sourceModule: 'MANUAL' });
  });

  it('posting into an OPEN period writes no financial event', async () => {
    const ctx = { tenantId: alpha.tenantId, userId: alpha.userId, allowLockedPeriod: true };
    const before = await eventCount(alpha.tenantId);

    await withTenant(sql, ctx, (tx) =>
      postJournalEntry(tx, ctx, unwrap(validateJournalEntry(entry(alpha, '2026-08-16'), 'MYR')), {
        idempotencyKey: randomUUID(),
      }),
    );

    expect(await eventCount(alpha.tenantId)).toBe(before);
  });

  it('the financial event log is append-only', async () => {
    const ctx = { tenantId: alpha.tenantId, userId: alpha.userId };
    await expect(
      withTenant(sql, ctx, (tx) => tx`
          UPDATE financial_event_log SET event_type = 'PERIOD_LOCKED'
           WHERE tenant_id = ${alpha.tenantId}
      `),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  async function eventCount(tenantId: string): Promise<number> {
    const [row] = await withTenant(sql, { tenantId }, (tx) =>
      tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM financial_event_log
           WHERE tenant_id = ${tenantId} AND event_type = 'LOCKED_PERIOD_OVERRIDE'
      `,
    );
    return Number(row!.count);
  }
});
