/*
 * Who may open an account on this server.
 *
 * ---------------------------------------------------------------------------
 * REGISTRATION USED TO BE OPEN TO THE WHOLE INTERNET.
 *
 * `POST /v1/auth/register` and `POST /v1/organisations` are both public, which
 * is exactly right for a shop PC behind Tailscale and exactly wrong for a
 * hosted instance with a domain name: anybody who found the URL could create
 * an account and a tenant, and the operator would learn about it from the
 * table sizes.
 *
 * So an invite: the operator mints a token on the server and gives it to a
 * company they have agreed to take on. `SIGNUP_MODE=open` restores the old
 * behaviour for the shop-PC case, where the network IS the gate.
 * ---------------------------------------------------------------------------
 *
 * NOT TENANT-OWNED, WHICH IS RARE HERE AND CORRECT.
 *
 * Almost every table in this schema carries `tenant_id` as the first column of
 * its primary key, under RLS. An invite cannot: it exists BEFORE the tenant it
 * will create, so there is no tenant to scope it to. It sits with `app_user`
 * and `user_session` on the small list of tables that are properties of the
 * INSTALLATION rather than of any one organisation.
 */

CREATE TABLE signup_invite (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    /*
     * The DIGEST, never the token — the same discipline as `user_session`
     * (0012). A database leak yields no usable invites.
     *
     * SHA-256 rather than Argon2 for the same reason refresh tokens use it:
     * this is 256 bits of CSPRNG output, not a human-chosen secret, so there
     * is no dictionary to slow an attacker down.
     */
    token_hash  TEXT NOT NULL UNIQUE,

    /*
     * Optionally bound to one address. Bound, the invite only works for the
     * person it was sent to; unbound, it works for whoever holds it — useful
     * when the operator does not yet know which of a company's staff will
     * actually sign up.
     */
    email       TEXT,

    /** Free text for the operator: which company, agreed by whom. */
    note        TEXT,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,

    /* Single use. Set in the same transaction as the user insert, so two
       concurrent registrations cannot both spend one invite. */
    used_at     TIMESTAMPTZ,
    used_by     UUID REFERENCES app_user (id) ON DELETE SET NULL,

    CONSTRAINT signup_invite_used_together CHECK (
        (used_at IS NULL AND used_by IS NULL) OR used_at IS NOT NULL
    ),
    CONSTRAINT signup_invite_expires_after_creation CHECK (expires_at > created_at)
);

COMMENT ON TABLE signup_invite IS
    'Permission to open an account on this installation. Not tenant-owned: an '
    'invite predates the tenant it creates. See 0051.';

/*
 * Looked up by digest on every registration attempt in invite mode; the UNIQUE
 * on `token_hash` already provides that index. This one is for the operator
 * listing what is outstanding.
 */
CREATE INDEX signup_invite_open_idx ON signup_invite (expires_at)
    WHERE used_at IS NULL;

/*
 * `emil_app` needs SELECT and UPDATE — it verifies and spends invites during
 * registration. INSERT is deliberately withheld: minting is an OPERATOR act,
 * run on the server as the migrating role, and the internet-facing API having
 * no way to create an invite means a bug in it cannot mint one either.
 */
GRANT SELECT, UPDATE ON signup_invite TO emil_app;

/*
 * "Is this installation empty?" — through a definer function, like every other
 * pre-tenant read.
 *
 * ---------------------------------------------------------------------------
 * `emil_app` HAS NO GRANT ON `app_user` AT ALL, AND THAT STAYS TRUE.
 *
 * 0012 gives the app role no access whatsoever to the identity tables; every
 * legitimate pre-tenant operation goes through a SECURITY DEFINER function
 * returning a fixed, minimal column set, and `rls.test.ts` asserts a direct
 * SELECT on `app_user` is refused. A plain `SELECT 1 FROM app_user` in the
 * registration path would have passed every test that runs as a superuser and
 * failed in production, on the first request, for every user.
 *
 * This returns one BOOLEAN and nothing else — not a count, not an id. Whether
 * the installation has any users is the only fact the bootstrap exception
 * needs, and it is not a fact worth protecting: anybody can learn it by
 * trying to register.
 * ---------------------------------------------------------------------------
 */
CREATE OR REPLACE FUNCTION installation_has_users()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM app_user)
$$;

REVOKE ALL ON FUNCTION installation_has_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION installation_has_users() TO emil_app;

/*
 * An organisation inviting its OWN next member.
 *
 * ---------------------------------------------------------------------------
 * WITHOUT THIS, EVERY HIRE GOES THROUGH THE SERVER OPERATOR.
 *
 * `POST /v1/auth/members` refuses an email with no account — "ask them to
 * register first". Under invite-only sign-up that person cannot register, so a
 * shop owner hiring a cashier would have to telephone whoever runs the server
 * for a code. That is not a system anybody would keep using.
 *
 * So a definer function, and NOT a table grant. `emil_app` still has no INSERT
 * on `signup_invite`: it can create an invitation only through this, which
 * takes a digest and an expiry and returns nothing but the row id. Arbitrary
 * inserts — a backdated invite, one that never expires, one already marked
 * used — remain impossible for the API even with a bug in it.
 *
 * The 90-day ceiling is enforced here rather than in the caller for the same
 * reason: it is a property of what may exist, not of who asked.
 * ---------------------------------------------------------------------------
 */
CREATE OR REPLACE FUNCTION create_signup_invite(
    p_token_hash TEXT,
    p_email      TEXT,
    p_note       TEXT,
    p_days       INT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
        RAISE EXCEPTION 'An invitation lasts between 1 and 90 days';
    END IF;

    INSERT INTO signup_invite (token_hash, email, note, expires_at)
    VALUES (p_token_hash, lower(btrim(p_email)), p_note, now() + make_interval(days => p_days))
    RETURNING id INTO v_id;

    RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION create_signup_invite(TEXT, TEXT, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_signup_invite(TEXT, TEXT, TEXT, INT) TO emil_app;
