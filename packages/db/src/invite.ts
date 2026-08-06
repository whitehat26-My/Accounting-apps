import type { Sql, Tx } from './client.js';
import { hashToken, mintToken } from './identity.js';

/**
 * Invites to open an account on this installation — see migration 0051.
 *
 * ---------------------------------------------------------------------------
 * MINTING IS AN OPERATOR ACT, NOT AN API ONE.
 *
 * `createInvite` takes the raw `Sql` and is reached from a CLI run on the
 * server, never from a route. `emil_app` — the role the internet-facing API
 * connects as — holds SELECT and UPDATE on `signup_invite` and deliberately
 * NOT INSERT, so a bug in the API cannot mint an invite even if somebody added
 * a route for it by mistake. The database enforces the boundary the design
 * intends, rather than the design merely describing it.
 * ---------------------------------------------------------------------------
 */

export interface MintedInvite {
  /** Shown ONCE. Only the digest is stored; a lost token is re-minted. */
  readonly token: string;
  readonly expiresAt: string;
  readonly email: string | null;
}

export async function createInvite(
  sql: Sql,
  options: { readonly email?: string; readonly note?: string; readonly days?: number } = {},
): Promise<MintedInvite> {
  const { token, hash } = mintToken();
  const days = options.days ?? 14;

  const [row] = await sql<{ expires_at: Date }[]>`
      INSERT INTO signup_invite (token_hash, email, note, expires_at)
      VALUES (
        ${hash},
        ${options.email?.trim().toLowerCase() ?? null},
        ${options.note ?? null},
        now() + ${`${days} days`}::interval
      )
      RETURNING expires_at
  `;

  return {
    token,
    expiresAt: row!.expires_at.toISOString(),
    email: options.email?.trim().toLowerCase() ?? null,
  };
}

export type InviteRefusal =
  | 'INVITE_REQUIRED'
  | 'INVITE_UNKNOWN'
  | 'INVITE_EXPIRED'
  | 'INVITE_USED'
  | 'INVITE_WRONG_EMAIL';

export type InviteCheck =
  | { readonly ok: true; readonly inviteId: string }
  | { readonly ok: false; readonly reason: InviteRefusal };

/**
 * Claim an invite for one registration.
 *
 * ---------------------------------------------------------------------------
 * THE UPDATE IS THE CHECK.
 *
 * Reading the row, deciding it is usable, and then marking it used is a
 * check-then-act race: two registrations arriving together both read an unused
 * invite and both proceed. `UPDATE … WHERE used_at IS NULL … RETURNING` makes
 * the database settle it — exactly one statement can match, so exactly one
 * caller gets a row back.
 *
 * Called INSIDE the registration transaction, so a registration that fails
 * afterwards rolls the claim back with it. An invite is not spent by an
 * attempt that did not produce an account.
 * ---------------------------------------------------------------------------
 */
export async function claimInvite(
  tx: Tx,
  token: string | undefined,
  email: string,
): Promise<InviteCheck> {
  if (!token) return { ok: false, reason: 'INVITE_REQUIRED' };

  /*
   * Read first, only to tell the four refusals apart. The read cannot be
   * trusted to decide anything — the UPDATE below does that — but "this
   * invite expired last week" is a far more useful answer than "no", and the
   * person holding an expired invite is not an attacker.
   */
  const [found] = await tx<
    { id: string; email: string | null; expired: boolean; used: boolean }[]
  >`
      SELECT id, email,
             (expires_at <= now()) AS expired,
             (used_at IS NOT NULL) AS used
        FROM signup_invite
       WHERE token_hash = ${hashToken(token)}
  `;

  if (!found) return { ok: false, reason: 'INVITE_UNKNOWN' };
  if (found.used) return { ok: false, reason: 'INVITE_USED' };
  if (found.expired) return { ok: false, reason: 'INVITE_EXPIRED' };
  if (found.email !== null && found.email !== email.trim().toLowerCase()) {
    return { ok: false, reason: 'INVITE_WRONG_EMAIL' };
  }

  const [claimed] = await tx<{ id: string }[]>`
      UPDATE signup_invite
         SET used_at = now()
       WHERE token_hash = ${hashToken(token)}
         AND used_at IS NULL
         AND expires_at > now()
      RETURNING id
  `;
  // Lost the race with a concurrent registration. USED rather than UNKNOWN:
  // the invite existed a moment ago and somebody else spent it.
  if (!claimed) return { ok: false, reason: 'INVITE_USED' };

  return { ok: true, inviteId: claimed.id };
}

/** Record who ended up using it, once the user row exists. */
export async function attributeInvite(
  tx: Tx,
  inviteId: string,
  userId: string,
): Promise<void> {
  await tx`UPDATE signup_invite SET used_by = ${userId} WHERE id = ${inviteId}`;
}

/** What the operator has outstanding. Never returns a token — none is stored. */
export async function listOpenInvites(sql: Sql): Promise<
  { id: string; email: string | null; note: string | null; expiresAt: string }[]
> {
  const rows = await sql<
    { id: string; email: string | null; note: string | null; expires_at: Date }[]
  >`
      SELECT id, email, note, expires_at
        FROM signup_invite
       WHERE used_at IS NULL AND expires_at > now()
       ORDER BY expires_at
  `;
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    note: r.note,
    expiresAt: r.expires_at.toISOString(),
  }));
}

export function describeInviteRefusal(reason: InviteRefusal): string {
  switch (reason) {
    case 'INVITE_REQUIRED':
      return 'This server does not accept open sign-ups. You need an invitation to create an account.';
    case 'INVITE_UNKNOWN':
      return 'That invitation code is not one we issued. Check it was copied in full.';
    case 'INVITE_EXPIRED':
      return 'That invitation has expired. Ask for a new one.';
    case 'INVITE_USED':
      return 'That invitation has already been used.';
    case 'INVITE_WRONG_EMAIL':
      return 'That invitation was issued for a different email address.';
  }
}

/**
 * Is this installation still empty?
 *
 * The bootstrap exception: the FIRST account on a server with no users is the
 * operator's own, and requiring an invite for it would mean running a CLI
 * before you can use the machine you just deployed — a cliff protecting
 * nothing, since there is nothing on the server yet to protect.
 *
 * Through `installation_has_users()`, not a direct SELECT: `emil_app` has NO
 * grant on `app_user` (0012), so `SELECT 1 FROM app_user` would pass every
 * test that runs as a superuser and fail in production on the first request.
 * The function is SECURITY DEFINER and returns one boolean.
 */
export async function isFirstUser(tx: Tx): Promise<boolean> {
  const [row] = await tx<{ installation_has_users: boolean }[]>`
      SELECT installation_has_users()
  `;
  return !row!.installation_has_users;
}

/**
 * An organisation inviting its own next member.
 *
 * Goes through `create_signup_invite`, a SECURITY DEFINER function, because
 * `emil_app` has no INSERT on the table — so the API can create an invitation
 * of exactly this shape and no other. A backdated one, an eternal one, or one
 * already marked used stays impossible from the application side.
 *
 * Bound to the email by construction: an owner is inviting a NAMED person to
 * work for them, not minting a code to hand around.
 */
export async function inviteMember(
  tx: Tx,
  input: { readonly email: string; readonly note?: string; readonly days?: number },
): Promise<MintedInvite> {
  const { token, hash } = mintToken();
  const email = input.email.trim().toLowerCase();

  await tx`
      SELECT create_signup_invite(
        ${hash}, ${email}, ${input.note ?? null}, ${input.days ?? 14}
      )
  `;

  const [row] = await tx<{ expires_at: Date }[]>`
      SELECT expires_at FROM signup_invite WHERE token_hash = ${hash}
  `;
  return { token, expiresAt: row!.expires_at.toISOString(), email };
}
