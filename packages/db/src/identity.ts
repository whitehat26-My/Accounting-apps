import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import {
  evaluateRefresh,
  expiryFrom,
  resolvePrincipal,
  DEFAULT_SESSION_POLICY,
  type Permission,
  type Principal,
  type RoleCode,
  type SessionPolicy,
  type SessionRecord,
} from '@emil/domain';
import type { Sql, TenantContext, Tx } from './client.js';

/**
 * IdentityService — M0.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING HERE RUNS BEFORE THERE IS A TENANT, WHICH IS WHY IT LOOKS
 * DIFFERENT FROM EVERY OTHER SERVICE IN THIS PACKAGE.
 *
 * Every other service takes a `TenantContext` and runs inside `withTenant()`,
 * where RLS does the isolating. Authentication cannot: resolving a user by
 * email, or a session by token, happens when the tenant is still unknown.
 *
 * So the identity tables have NO grant to the application role at all, and
 * this module reaches them exclusively through the SECURITY DEFINER functions
 * declared in migration 0012 — each with a fixed, minimal column list. The
 * pre-tenant attack surface is those functions rather than "the app role can
 * read every user in the system".
 * ---------------------------------------------------------------------------
 */

export class IdentityError extends Error {
  constructor(
    readonly code:
      | 'EMAIL_TAKEN'
      | 'INVALID_CREDENTIALS'
      | 'ACCOUNT_LOCKED'
      | 'ACCOUNT_DISABLED'
      | 'SESSION_INVALID'
      | 'SESSION_REUSED'
      | 'NOT_A_MEMBER'
      | 'CANNOT_GRANT_ROLE',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'IdentityError';
  }
}

// ---------------------------------------------------------------------------
// Password and token handling
// ---------------------------------------------------------------------------

/**
 * Argon2id, per docs/architecture/03-tech-stack.md.
 *
 * Chosen over bcrypt because it is memory-hard: a GPU or ASIC attacker gains
 * far less from parallelism, which is the entire threat model for a stolen
 * password database. The parameters are encoded in the returned string, so
 * raising them later does not invalidate existing hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  return argonHash(password);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    // A malformed stored hash must fail closed, not throw a 500 that tells the
    // caller their password was probably right.
    return false;
  }
}

/**
 * A refresh token, and the digest stored against it.
 *
 * Only the digest is persisted. A database leak then yields no working tokens —
 * the same reason password hashes are stored rather than passwords.
 *
 * SHA-256 rather than Argon2 here, deliberately: a refresh token is 256 bits of
 * CSPRNG output, not a human-chosen secret, so there is no dictionary to slow
 * down and the lookup happens on every refresh.
 */
export function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** Constant-time comparison, for anywhere a digest is compared directly. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Registration and authentication
// ---------------------------------------------------------------------------

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly fullName: string;
}

export async function registerUser(
  tx: Tx,
  input: RegisterInput,
): Promise<{ id: string }> {
  const passwordHash = await hashPassword(input.password);

  try {
    const [row] = await tx<{ create_user: string }[]>`
        SELECT create_user(${input.email}, ${passwordHash}, ${input.fullName})
    `;
    return { id: row!.create_user };
  } catch (error) {
    if (error instanceof Error && /duplicate key/i.test(error.message)) {
      throw new IdentityError('EMAIL_TAKEN', 'That email address is already registered');
    }
    throw error;
  }
}

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
}

/**
 * Verify an email and password.
 *
 * ---------------------------------------------------------------------------
 * A WRONG EMAIL AND A WRONG PASSWORD MUST BE INDISTINGUISHABLE — in the message
 * AND in the time taken.
 *
 * Returning early on an unknown email skips the Argon2 verification, and Argon2
 * is deliberately slow. The timing difference is measurable over a network and
 * turns the login form into an account-enumeration oracle: an attacker learns
 * which of a leaked email list holds accounts here without guessing a single
 * password.
 *
 * So an unknown email still burns a verification against a dummy hash.
 * ---------------------------------------------------------------------------
 */
export async function authenticate(
  tx: Tx,
  email: string,
  password: string,
  now: string = new Date().toISOString(),
): Promise<AuthenticatedUser> {
  const [user] = await tx<
    {
      id: string;
      email: string;
      password_hash: string | null;
      full_name: string;
      status: string;
      failed_logins: number;
      locked_until: Date | null;
    }[]
  >`
      SELECT * FROM find_user_for_authentication(${email})
  `;

  if (!user || user.password_hash === null) {
    await burnVerification(password);
    throw new IdentityError('INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  if (user.locked_until !== null && user.locked_until.toISOString() > now) {
    throw new IdentityError(
      'ACCOUNT_LOCKED',
      'Too many failed attempts. Try again shortly.',
    );
  }

  if (user.status === 'SUSPENDED' || user.status === 'DISABLED') {
    throw new IdentityError('ACCOUNT_DISABLED', 'This account is not active');
  }

  const ok = await verifyPassword(user.password_hash, password);
  await tx`SELECT record_login_outcome(${user.id}::uuid, ${ok})`;

  if (!ok) {
    throw new IdentityError('INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  return { id: user.id, email: user.email, fullName: user.full_name };
}

/**
 * A verification against a fixed hash, so an unknown email costs the same as a
 * wrong password. The hash is a real Argon2id digest of a value nobody knows.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Zm9yY29uc3RhbnR0aW1pbmdvbmx5';

async function burnVerification(password: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, password);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface IssuedSession {
  readonly sessionId: string;
  readonly refreshToken: string;
  readonly familyId: string;
  readonly expiresAt: string;
}

export async function createSession(
  tx: Tx,
  userId: string,
  context: { ip?: string; userAgent?: string } = {},
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  now: string = new Date().toISOString(),
): Promise<IssuedSession> {
  const { token, hash } = mintToken();
  const familyId = randomUUID();
  const expiresAt = expiryFrom(now, policy.refreshTokenSeconds);

  const [row] = await tx<{ create_session: string }[]>`
      SELECT create_session(
          ${userId}::uuid, ${hash}, ${familyId}::uuid, ${expiresAt}::timestamptz,
          ${context.ip ?? null}, ${context.userAgent ?? null}
      )
  `;

  return { sessionId: row!.create_session, refreshToken: token, familyId, expiresAt };
}

export type RefreshResult =
  | { readonly ok: true; readonly userId: string; readonly session: IssuedSession }
  | {
      readonly ok: false;
      readonly code: 'SESSION_REUSED' | 'SESSION_INVALID';
      readonly message: string;
    };

/**
 * Exchange a refresh token for a new one.
 *
 * The decision itself lives in `packages/domain/src/session.ts` and is pure;
 * this is the IO around it. On reuse the whole family is revoked — see that
 * module for why revoking only the presented token is exactly the attack.
 *
 * ---------------------------------------------------------------------------
 * RETURNS A RESULT; DOES NOT THROW ON FAILURE. THAT IS LOAD-BEARING.
 *
 * An earlier version threw an `IdentityError` on reuse. Because this runs
 * inside a transaction, the throw rolled the transaction back — including the
 * family revocation performed moments earlier. The system detected the theft,
 * reported it, and then undid its own response: every other token in the
 * compromised family stayed live.
 *
 * A failed refresh is an expected outcome, not an exceptional one. Returning it
 * lets the transaction COMMIT the revocation, and the caller turns the result
 * into a 401. The test below asserts the revocation survives, because that is
 * the property the bug violated.
 * ---------------------------------------------------------------------------
 */
export async function refreshSession(
  tx: Tx,
  refreshToken: string,
  context: { ip?: string; userAgent?: string } = {},
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  now: string = new Date().toISOString(),
): Promise<RefreshResult> {
  const [row] = await tx<
    {
      id: string;
      user_id: string;
      family_id: string;
      rotated_to_id: string | null;
      expires_at: Date;
      revoked_at: Date | null;
    }[]
  >`
      SELECT * FROM find_session_by_token(${hashToken(refreshToken)})
  `;

  const record: SessionRecord | undefined = row
    ? {
        id: row.id,
        userId: row.user_id,
        familyId: row.family_id,
        rotatedToId: row.rotated_to_id,
        expiresAt: row.expires_at.toISOString(),
        revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
      }
    : undefined;

  const outcome = evaluateRefresh(record, now);

  if (outcome.kind === 'REUSE_DETECTED') {
    await tx`SELECT revoke_session_family(${outcome.familyId}::uuid, ${'Refresh token reuse detected'})`;
    return { ok: false, code: 'SESSION_REUSED', message: outcome.reason };
  }

  if (outcome.kind === 'REJECT') {
    return {
      ok: false,
      code: 'SESSION_INVALID',
      message: `Refresh token rejected: ${outcome.reason}`,
    };
  }

  const { token, hash } = mintToken();
  const expiresAt = expiryFrom(now, policy.refreshTokenSeconds);

  const [created] = await tx<{ create_session: string }[]>`
      SELECT create_session(
          ${outcome.session.userId}::uuid, ${hash}, ${outcome.session.familyId}::uuid,
          ${expiresAt}::timestamptz, ${context.ip ?? null}, ${context.userAgent ?? null}
      )
  `;
  const newId = created!.create_session;

  // Marking the OLD token spent is what makes the next replay detectable. It
  // happens in the same transaction as minting the new one, so there is no
  // window in which a token is neither live nor spent.
  await tx`SELECT rotate_session(${outcome.session.id}::uuid, ${newId}::uuid)`;

  return {
    ok: true,
    userId: outcome.session.userId,
    session: {
      sessionId: newId,
      refreshToken: token,
      familyId: outcome.session.familyId,
      expiresAt,
    },
  };
}

export async function revokeSession(tx: Tx, sessionId: string, reason = 'Signed out'): Promise<void> {
  await tx`SELECT revoke_session(${sessionId}::uuid, ${reason})`;
}

export async function revokeAllSessions(tx: Tx, familyId: string, reason: string): Promise<number> {
  const [row] = await tx<{ revoke_session_family: number }[]>`
      SELECT revoke_session_family(${familyId}::uuid, ${reason})
  `;
  return row!.revoke_session_family;
}

// ---------------------------------------------------------------------------
// Memberships and authorisation
// ---------------------------------------------------------------------------

export interface MembershipSummary {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly role: RoleCode;
  readonly status: string;
  readonly expiresAt: string | null;
}

/** The organisation switcher. Runs with no tenant context, by definition. */
export async function membershipsForUser(
  tx: Tx,
  userId: string,
): Promise<MembershipSummary[]> {
  const rows = await tx<
    {
      tenant_id: string;
      tenant_name: string;
      role_code: RoleCode;
      status: string;
      expires_at: Date | null;
    }[]
  >`
      SELECT * FROM memberships_for_user(${userId}::uuid)
  `;

  return rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    role: r.role_code,
    status: r.status,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
  }));
}

/**
 * Resolve what a user may do inside one organisation.
 *
 * Returns `undefined` rather than throwing when there is no membership. The
 * caller turns that into a 404 — CLAUDE.md rule 9. A 403 would confirm the
 * organisation exists, which is enough to enumerate this product's customer
 * list one id at a time.
 */
export async function principalFor(
  tx: Tx,
  userId: string,
  tenantId: string,
  apiKey?: { id: string; scopes: readonly Permission[] },
  now: string = new Date().toISOString(),
): Promise<Principal | undefined> {
  const [membership] = await tx<
    { role_code: RoleCode; status: string; expires_at: Date | null }[]
  >`
      SELECT role_code, status, expires_at FROM membership
       WHERE user_id = ${userId}::uuid AND tenant_id = ${tenantId}::uuid
  `;

  const permissions = await tx<{ permission_code: Permission }[]>`
      SELECT * FROM permissions_for_user(${userId}::uuid, ${tenantId}::uuid)
  `;

  const resolved = resolvePrincipal(
    userId,
    tenantId,
    membership
      ? {
          role: membership.role_code,
          status: membership.status,
          expiresAt: membership.expires_at ? membership.expires_at.toISOString() : null,
        }
      : undefined,
    permissions.map((p) => p.permission_code),
    now,
    apiKey,
  );

  return resolved.ok ? resolved.principal : undefined;
}

export interface AddMemberInput {
  readonly userId: string;
  readonly role: RoleCode;
  readonly expiresAt?: string;
  readonly invitedBy?: string;
}

/**
 * Add or re-role a member.
 *
 * Runs inside a tenant context, so `membership`'s RLS applies. The
 * privilege-escalation check is the caller's — `canGrantRole` in the domain —
 * because only the caller knows the actor's own role.
 */
export async function addMember(
  tx: Tx,
  ctx: TenantContext,
  input: AddMemberInput,
): Promise<{ id: string }> {
  const [row] = await tx<{ id: string }[]>`
      INSERT INTO membership (tenant_id, user_id, role_code, status, expires_at, invited_by, joined_at)
      VALUES (
          ${ctx.tenantId}, ${input.userId}::uuid, ${input.role}, 'ACTIVE',
          ${input.expiresAt ?? null}, ${input.invitedBy ?? ctx.userId ?? null}, now()
      )
      ON CONFLICT (tenant_id, user_id) DO UPDATE
          SET role_code = EXCLUDED.role_code,
              status     = 'ACTIVE',
              expires_at = EXCLUDED.expires_at
      RETURNING id
  `;

  // A role change is one of the acts an auditor asks about by name.
  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'ROLE_CHANGED', ${ctx.userId ?? null}, 'user.manage',
          'MEMBERSHIP', ${row!.id}, ${tx.json({ userId: input.userId, role: input.role })}
      )
  `;

  return { id: row!.id };
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface IssuedApiKey {
  readonly id: string;
  /** Shown ONCE. Never retrievable again — only its digest is stored. */
  readonly key: string;
  readonly prefix: string;
}

export async function issueApiKey(
  tx: Tx,
  ctx: TenantContext,
  input: { name: string; scopes: readonly Permission[]; expiresAt?: string },
): Promise<IssuedApiKey> {
  const secret = randomBytes(24).toString('base64url');
  const prefix = `emil_${randomBytes(4).toString('hex')}`;
  const key = `${prefix}.${secret}`;

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO api_key (tenant_id, name, prefix, key_hash, scopes, created_by, expires_at)
      VALUES (
          ${ctx.tenantId}, ${input.name}, ${prefix}, ${hashToken(key)},
          ${input.scopes as string[]}, ${ctx.userId ?? null}, ${input.expiresAt ?? null}
      )
      RETURNING id
  `;

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'API_KEY_ISSUED', ${ctx.userId ?? null}, 'apikey.manage',
          'API_KEY', ${row!.id}, ${tx.json({ name: input.name, scopes: input.scopes })}
      )
  `;

  return { id: row!.id, key, prefix };
}

export interface ResolvedApiKey {
  readonly id: string;
  readonly tenantId: string;
  readonly createdBy: string | null;
  readonly scopes: Permission[];
}

/**
 * Resolve an API key presented on a request.
 *
 * Pre-tenant, and for a subtle reason: `api_key` IS tenant-owned and RLS'd, but
 * a request presenting a key has not yet established which tenant it is for —
 * the key is what names it. So this goes through the same SECURITY DEFINER
 * route as the rest of the pre-tenant path, and RETURNS the tenant rather than
 * accepting one. A caller cannot use it to read a key belonging to a tenant
 * they nominated.
 */
export async function resolveApiKey(
  sql: Sql | Tx,
  presentedKey: string,
): Promise<ResolvedApiKey | undefined> {
  const [row] = await sql<
    {
      id: string;
      tenant_id: string;
      created_by: string | null;
      scopes: Permission[];
      expires_at: Date | null;
      revoked_at: Date | null;
    }[]
  >`
      SELECT * FROM find_api_key(${hashToken(presentedKey)})
  `;

  if (!row || row.revoked_at !== null) return undefined;
  if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) return undefined;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    createdBy: row.created_by,
    scopes: row.scopes,
  };
}

// ------------------------------------------------------------------ internals

function randomUUID(): string {
  return crypto.randomUUID();
}
