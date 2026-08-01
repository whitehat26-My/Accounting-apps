/**
 * Refresh-token rotation with reuse detection — M0.
 *
 * ---------------------------------------------------------------------------
 * WHY ROTATION, AND WHY REUSE MUST KILL THE WHOLE FAMILY.
 *
 * A refresh token is a long-lived bearer credential. If it never changes, a
 * copy taken once — from a backup, a log, a shared machine, an XSS payload —
 * is a permanent login, and nothing about the legitimate user's behaviour ever
 * reveals it.
 *
 * Rotation fixes that by making every refresh single-use: presenting a token
 * mints a replacement and marks the old one spent. The stolen copy then works
 * exactly once, and only until whichever party refreshes next.
 *
 * That leaves the detection problem. When a SPENT token is presented, one of
 * two parties is holding a copy they should not have — and there is no way to
 * tell which. The thief may have refreshed first, leaving the victim holding
 * the spent one; or the victim refreshed and the thief is now replaying.
 *
 * Because the two cases are indistinguishable, the only safe response is to
 * revoke the entire family descended from that login and force a fresh
 * authentication. Revoking just the presented token would leave a thief who
 * refreshed first in possession of a live session, which is precisely the
 * attack. Logging the real user out is the cost, and it is the right trade:
 * one inconvenient re-login against an undetectable persistent compromise.
 * ---------------------------------------------------------------------------
 *
 * Pure. No clock, no crypto, no database — the token strings and the current
 * time are supplied. That is what lets the awkward cases below be tested
 * exhaustively instead of hopefully.
 */

/** A session row as this module needs to see it. */
export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  /** Shared by every token descended from one login. */
  readonly familyId: string;
  /** Set once this token has been exchanged. Its presence means "spent". */
  readonly rotatedToId: string | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export type RefreshOutcome =
  /** Mint a replacement and mark this one spent. */
  | { readonly kind: 'ROTATE'; readonly session: SessionRecord }
  /**
   * A spent token was presented. Revoke the whole family and make the user
   * authenticate again.
   */
  | {
      readonly kind: 'REUSE_DETECTED';
      readonly familyId: string;
      readonly userId: string;
      readonly reason: string;
    }
  /** No such token, or it is expired or already revoked. Just refuse. */
  | { readonly kind: 'REJECT'; readonly reason: RefreshRejection };

export type RefreshRejection = 'UNKNOWN_TOKEN' | 'EXPIRED' | 'REVOKED';

/**
 * Decide what to do with a presented refresh token.
 *
 * Order matters. Reuse is checked BEFORE expiry: a spent token that has also
 * aged out is still evidence that someone held a copy they should not have,
 * and treating it as a boring expiry would discard exactly the signal this
 * mechanism exists to produce.
 */
export function evaluateRefresh(
  session: SessionRecord | undefined,
  now: string,
): RefreshOutcome {
  if (session === undefined) {
    return { kind: 'REJECT', reason: 'UNKNOWN_TOKEN' };
  }

  if (session.rotatedToId !== null) {
    return {
      kind: 'REUSE_DETECTED',
      familyId: session.familyId,
      userId: session.userId,
      reason:
        'A refresh token that had already been exchanged was presented again. ' +
        'Two parties are holding copies and they cannot be told apart, so every ' +
        'session from this login has been revoked.',
    };
  }

  if (session.revokedAt !== null) {
    return { kind: 'REJECT', reason: 'REVOKED' };
  }

  if (session.expiresAt <= now) {
    return { kind: 'REJECT', reason: 'EXPIRED' };
  }

  return { kind: 'ROTATE', session };
}

export interface SessionPolicy {
  /** How long an access token lives. Short, because it is not revocable. */
  readonly accessTokenSeconds: number;
  /** How long a refresh token lives. */
  readonly refreshTokenSeconds: number;
  /**
   * A ceiling on the whole family, independent of rotation.
   *
   * Without it, a session refreshed daily lives forever — rotation alone only
   * bounds how long a STOLEN token is useful, not how long a login persists.
   */
  readonly familyMaxSeconds: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  // Fifteen minutes. An access token is verified by signature alone and cannot
  // be revoked mid-life, so its lifetime IS the revocation delay.
  accessTokenSeconds: 15 * 60,
  refreshTokenSeconds: 30 * 24 * 60 * 60,
  familyMaxSeconds: 90 * 24 * 60 * 60,
};

/** `now` plus `seconds`, as an ISO instant. Pure — the clock is the caller's. */
export function expiryFrom(now: string, seconds: number): string {
  const base = Date.parse(now);
  if (Number.isNaN(base)) throw new RangeError(`Invalid instant: ${now}`);
  return new Date(base + seconds * 1000).toISOString();
}

/**
 * Whether a family has outlived its ceiling, regardless of rotation.
 *
 * Checked at refresh time rather than by a sweep, so it needs no scheduled job
 * to be correct — a job that stops running would otherwise silently extend
 * every session indefinitely.
 */
export function familyExpired(
  familyStartedAt: string,
  now: string,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
): boolean {
  return Date.parse(now) - Date.parse(familyStartedAt) >= policy.familyMaxSeconds * 1000;
}

/**
 * The claims an access token carries.
 *
 * `tenantId` is in the token, and the API asserts it against the `X-Tenant-Id`
 * header rather than trusting either alone. A token that named no tenant would
 * make the header the only source of truth, and the header is attacker-supplied.
 */
export interface AccessTokenClaims {
  readonly sub: string;
  readonly tenantId: string;
  readonly role: string;
  readonly sessionId: string;
  /** Seconds since the epoch, as JWT requires. */
  readonly exp: number;
  readonly iat: number;
}

export type ClaimViolation =
  | { readonly code: 'EXPIRED' }
  | { readonly code: 'TENANT_MISMATCH'; readonly claimed: string; readonly requested: string }
  | { readonly code: 'MALFORMED'; readonly field: string };

/**
 * Check a decoded token's claims against the tenant the request is for.
 *
 * Signature verification is the caller's job — it needs crypto and a key, and
 * this module stays pure. What is here is the part that is easy to get subtly
 * wrong: the tenant assertion.
 */
export function checkClaims(
  claims: Partial<AccessTokenClaims>,
  requestedTenantId: string,
  now: string,
): ClaimViolation[] {
  const violations: ClaimViolation[] = [];

  for (const field of ['sub', 'tenantId', 'sessionId'] as const) {
    if (typeof claims[field] !== 'string' || claims[field]!.length === 0) {
      violations.push({ code: 'MALFORMED', field });
    }
  }

  if (typeof claims.exp !== 'number') {
    violations.push({ code: 'MALFORMED', field: 'exp' });
  } else if (claims.exp * 1000 <= Date.parse(now)) {
    violations.push({ code: 'EXPIRED' });
  }

  // The header names a tenant and so does the token. They must agree: trusting
  // the header alone lets anyone with a valid token for tenant A read tenant B
  // by changing one header value.
  if (typeof claims.tenantId === 'string' && claims.tenantId !== requestedTenantId) {
    violations.push({
      code: 'TENANT_MISMATCH',
      claimed: claims.tenantId,
      requested: requestedTenantId,
    });
  }

  return violations;
}
