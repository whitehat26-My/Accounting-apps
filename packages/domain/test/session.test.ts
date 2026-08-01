import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_SESSION_POLICY,
  checkClaims,
  evaluateRefresh,
  expiryFrom,
  familyExpired,
  type SessionRecord,
} from '../src/session.js';

const NOW = '2026-08-20T12:00:00.000Z';

const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 's-1',
  userId: 'u-1',
  familyId: 'f-1',
  rotatedToId: null,
  expiresAt: '2026-09-20T12:00:00.000Z',
  revokedAt: null,
  ...over,
});

describe('evaluateRefresh', () => {
  it('rotates a live token', () => {
    const outcome = evaluateRefresh(session(), NOW);
    expect(outcome.kind).toBe('ROTATE');
  });

  it('rejects a token nobody issued', () => {
    expect(evaluateRefresh(undefined, NOW)).toMatchObject({
      kind: 'REJECT',
      reason: 'UNKNOWN_TOKEN',
    });
  });

  it('rejects an expired token', () => {
    expect(
      evaluateRefresh(session({ expiresAt: '2026-08-19T12:00:00.000Z' }), NOW),
    ).toMatchObject({ kind: 'REJECT', reason: 'EXPIRED' });
  });

  it('rejects a revoked token', () => {
    expect(
      evaluateRefresh(session({ revokedAt: '2026-08-19T12:00:00.000Z' }), NOW),
    ).toMatchObject({ kind: 'REJECT', reason: 'REVOKED' });
  });

  it('detects reuse of an already-exchanged token', () => {
    // Two parties are holding copies. There is no way to tell the thief from
    // the victim, so the only safe response is to revoke everything descended
    // from this login.
    const outcome = evaluateRefresh(session({ rotatedToId: 's-2' }), NOW);
    expect(outcome).toMatchObject({ kind: 'REUSE_DETECTED', familyId: 'f-1', userId: 'u-1' });
    if (outcome.kind === 'REUSE_DETECTED') {
      expect(outcome.reason).toMatch(/already been exchanged/i);
    }
  });

  it('reports reuse EVEN IF the token has also expired', () => {
    // Order matters. A spent token that has also aged out is still evidence
    // someone held a copy they should not have; treating it as a boring expiry
    // discards exactly the signal this mechanism exists to produce.
    const outcome = evaluateRefresh(
      session({ rotatedToId: 's-2', expiresAt: '2026-08-19T12:00:00.000Z' }),
      NOW,
    );
    expect(outcome.kind).toBe('REUSE_DETECTED');
  });

  it('reports reuse even if the family was already revoked', () => {
    // The revocation may have been triggered by the FIRST replay. A second
    // replay is more evidence, not less, and must not downgrade to a plain
    // rejection.
    const outcome = evaluateRefresh(
      session({ rotatedToId: 's-2', revokedAt: '2026-08-19T12:00:00.000Z' }),
      NOW,
    );
    expect(outcome.kind).toBe('REUSE_DETECTED');
  });

  it('a token is usable at most once (property)', () => {
    // The core guarantee. Whatever the state, a token that has been exchanged
    // never rotates again.
    fc.assert(
      fc.property(
        fc.option(fc.constant('s-2'), { nil: null }),
        fc.option(fc.constant('2026-08-19T00:00:00.000Z'), { nil: null }),
        fc.constantFrom('2026-07-01T00:00:00.000Z', '2026-09-20T12:00:00.000Z'),
        (rotatedToId, revokedAt, expiresAt) => {
          const outcome = evaluateRefresh(
            session({ rotatedToId, revokedAt, expiresAt }),
            NOW,
          );
          if (rotatedToId !== null) expect(outcome.kind).not.toBe('ROTATE');
          if (outcome.kind === 'ROTATE') {
            expect(rotatedToId).toBeNull();
            expect(revokedAt).toBeNull();
            expect(expiresAt > NOW).toBe(true);
          }
        },
      ),
    );
  });
});

describe('session policy', () => {
  it('keeps the access token short, because it cannot be revoked mid-life', () => {
    // An access token is verified by signature alone, so its lifetime IS the
    // revocation delay.
    expect(DEFAULT_SESSION_POLICY.accessTokenSeconds).toBeLessThanOrEqual(15 * 60);
  });

  it('caps the family independently of rotation', () => {
    // Rotation alone bounds how long a STOLEN token is useful, not how long a
    // login persists — without a ceiling, a session refreshed daily lives
    // forever.
    expect(DEFAULT_SESSION_POLICY.familyMaxSeconds).toBeGreaterThan(
      DEFAULT_SESSION_POLICY.refreshTokenSeconds,
    );

    expect(familyExpired('2026-01-01T00:00:00.000Z', NOW)).toBe(true);
    expect(familyExpired('2026-08-01T00:00:00.000Z', NOW)).toBe(false);
  });

  it('computes expiry from a supplied instant, never a clock', () => {
    expect(expiryFrom(NOW, 900)).toBe('2026-08-20T12:15:00.000Z');
    expect(() => expiryFrom('not a time', 900)).toThrow(RangeError);
  });
});

describe('checkClaims', () => {
  const claims = {
    sub: 'u-1',
    tenantId: 't-1',
    role: 'ADMIN',
    sessionId: 's-1',
    iat: Math.floor(Date.parse(NOW) / 1000) - 60,
    exp: Math.floor(Date.parse(NOW) / 1000) + 900,
  };

  it('accepts a well-formed token for the tenant it names', () => {
    expect(checkClaims(claims, 't-1', NOW)).toEqual([]);
  });

  it('refuses a token whose tenant claim does not match the header', () => {
    // The header is attacker-supplied. Trusting it alone lets anyone with a
    // valid token for tenant A read tenant B by changing one header value.
    const violations = checkClaims(claims, 't-2', NOW);
    expect(violations).toContainEqual({
      code: 'TENANT_MISMATCH',
      claimed: 't-1',
      requested: 't-2',
    });
  });

  it('refuses an expired token', () => {
    const expired = { ...claims, exp: Math.floor(Date.parse(NOW) / 1000) - 1 };
    expect(checkClaims(expired, 't-1', NOW)).toContainEqual({ code: 'EXPIRED' });
  });

  it('names every malformed field rather than stopping at the first', () => {
    const violations = checkClaims({}, 't-1', NOW);
    const fields = violations
      .filter((v): v is { code: 'MALFORMED'; field: string } => v.code === 'MALFORMED')
      .map((v) => v.field);
    expect(fields).toEqual(expect.arrayContaining(['sub', 'tenantId', 'sessionId', 'exp']));
  });

  it('a token missing its tenant claim never passes (property)', () => {
    // A token that names no tenant would make the header the only source of
    // truth — which is the vulnerability, not a lenient edge case.
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (requested) => {
        const { tenantId: _omitted, ...withoutTenant } = claims;
        expect(checkClaims(withoutTenant, requested, NOW).length).toBeGreaterThan(0);
      }),
    );
  });
});
