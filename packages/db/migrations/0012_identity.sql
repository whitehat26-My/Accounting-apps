-- =============================================================================
-- 0012_identity
--
-- M0: users, memberships, roles, sessions, API keys — and `financial_event_log`,
-- which completes ledger invariant #9.
--
-- =============================================================================
-- THE CENTRAL TENSION IN THIS MIGRATION
--
-- Every other table in this schema is tenant-owned and protected by RLS. The
-- identity tables cannot be, and pretending otherwise would be worse than
-- admitting it:
--
--   * A USER IS GLOBAL. One freelance accountant serves N client organisations
--     from one login — that multi-org model is a primary differentiator, not an
--     edge case. A tenant-scoped user table would mean one account per client
--     and a separate password for each.
--
--   * AUTHENTICATION HAPPENS BEFORE THERE IS A TENANT. Looking a user up by
--     email, or a session up by token, necessarily runs with no tenant context
--     — so no `tenant_id = current_tenant_id()` policy can express it.
--
-- The answer is NOT to loosen RLS. It is to give the application role NO direct
-- access to the identity tables at all, and to expose exactly the operations
-- authentication needs as SECURITY DEFINER functions with narrow signatures.
-- The blast radius of the pre-tenant path is then those functions, which are
-- few, short, and reviewable — rather than "the app role can read every user
-- row in the system".
--
-- `packages/db/test/rls.test.ts` asserts the app role genuinely cannot read
-- `app_user` directly, so this claim is checked rather than described.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Users
--
-- `app_user`, not `user`: `user` is a reserved word in PostgreSQL and
-- `SELECT * FROM user` parses as the CURRENT_USER function.
-- -----------------------------------------------------------------------------
CREATE TABLE app_user (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT NOT NULL,
    /* Argon2id. The algorithm and parameters are encoded in the string itself,
       so a future parameter change does not invalidate existing hashes. */
    password_hash  TEXT,
    full_name      TEXT NOT NULL,
    /* Reserved for TOTP. Deferred with the rest of MFA — see the README. */
    mfa_secret     TEXT,
    status         TEXT NOT NULL DEFAULT 'ACTIVE'
                   CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','DISABLED')),
    failed_logins  SMALLINT NOT NULL DEFAULT 0,
    locked_until   TIMESTAMPTZ,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    /* Case-insensitive: nobody remembers how they capitalised their email. */
    UNIQUE (email)
);

CREATE UNIQUE INDEX app_user_email_lower_idx ON app_user (lower(email));

-- -----------------------------------------------------------------------------
-- Roles and permissions — GLOBAL reference data.
--
-- The same eight roles for every tenant, matching
-- docs/architecture/02-core-modules.md §M0. Modelled as rows rather than a code
-- constant so a future custom-role feature has somewhere to live, and so the
-- role→permission matrix is inspectable in the database an auditor is looking
-- at rather than only in a TypeScript file they are not.
-- -----------------------------------------------------------------------------
CREATE TABLE app_role (
    code        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    /* Lower binds tighter. Used to stop someone granting a role above their own. */
    rank        SMALLINT NOT NULL
);

CREATE TABLE app_permission (
    code        TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

CREATE TABLE role_permission (
    role_code       TEXT NOT NULL REFERENCES app_role       (code) ON DELETE CASCADE,
    permission_code TEXT NOT NULL REFERENCES app_permission (code) ON DELETE CASCADE,
    PRIMARY KEY (role_code, permission_code)
);

-- -----------------------------------------------------------------------------
-- Membership — the many-to-many that makes multi-client work.
--
-- Tenant-owned, so RLS applies. But its POLICY has to be different from every
-- other table's: the organisation switcher asks "which tenants may I act for",
-- and that question by definition has no tenant context yet. So the policy
-- admits a row when it belongs to the current tenant OR to the current user.
--
-- Recorded in the reasoned allowlist in `rls.test.ts` rather than by loosening
-- the guard, exactly as `report_definition`'s nullable tenant was.
-- -----------------------------------------------------------------------------
CREATE TABLE membership (
    tenant_id  UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id         UUID NOT NULL DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
    role_code  TEXT NOT NULL REFERENCES app_role (code),
    status     TEXT NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('INVITED','ACTIVE','SUSPENDED')),
    /* An external auditor's access is time-boxed by design. */
    expires_at TIMESTAMPTZ,
    invited_by UUID REFERENCES app_user (id),
    joined_at  TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, user_id)
);

CREATE INDEX membership_user_idx ON membership (user_id) WHERE status = 'ACTIVE';

-- -----------------------------------------------------------------------------
-- Invitations
-- -----------------------------------------------------------------------------
CREATE TABLE invitation (
    tenant_id   UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id          UUID NOT NULL DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL,
    role_code   TEXT NOT NULL REFERENCES app_role (code),
    /* The token itself is never stored — only its digest, so a database leak
       does not hand out working invitations. */
    token_hash  TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ,
    invited_by  UUID REFERENCES app_user (id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (token_hash)
);

-- -----------------------------------------------------------------------------
-- Sessions — refresh tokens with rotation and reuse detection.
--
-- Global, like the user: a session survives switching between organisations, so
-- binding it to one tenant would log an accountant out every time they moved
-- between clients.
--
-- `rotated_to_id` is what makes reuse detection possible. See
-- packages/domain/src/session.ts for why presenting an already-rotated token
-- means the token was stolen, and why the response is to kill the whole family
-- rather than just reject the request.
-- -----------------------------------------------------------------------------
CREATE TABLE user_session (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    /* Digest only, never the token. */
    refresh_token_hash TEXT NOT NULL UNIQUE,
    /* Every token descended from one login shares this. Reuse detection
       revokes the family, not just the presented token. */
    family_id          UUID NOT NULL,
    rotated_to_id      UUID REFERENCES user_session (id),
    device_fingerprint TEXT,
    ip                 INET,
    user_agent         TEXT,
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ,
    revoked_reason     TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX user_session_user_idx   ON user_session (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_session_family_idx ON user_session (family_id);

-- -----------------------------------------------------------------------------
-- API keys — tenant-scoped, unlike a user session.
--
-- A key is issued FOR one organisation. An integration that could silently act
-- across every organisation its creator belongs to is a far larger blast radius
-- than anyone issuing an API key expects.
-- -----------------------------------------------------------------------------
CREATE TABLE api_key (
    tenant_id    UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id           UUID NOT NULL DEFAULT gen_random_uuid(),
    name         TEXT NOT NULL,
    /* Shown once at creation so a user can identify the key later. */
    prefix       TEXT NOT NULL,
    key_hash     TEXT NOT NULL,
    scopes       TEXT[] NOT NULL DEFAULT '{}',
    created_by   UUID REFERENCES app_user (id),
    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (key_hash)
);

-- -----------------------------------------------------------------------------
-- Financial event log — the second half of ledger invariant #9.
--
-- Invariant #9 reads: "No posting into a LOCKED fiscal period without the
-- override permission AND a financial-event log row." The override has been
-- enforced since the ledger core landed; the log row had nowhere to go, so the
-- invariant was only half-tested.
--
-- Distinct from `audit_log`, deliberately. `audit_log` records every mutation
-- and is voluminous. This records the small set of acts that a regulator or an
-- auditor asks about by name — overriding a period lock, locking a period,
-- changing bank details, deleting a draft with a ledger effect. Mixing them
-- means the significant events are invisible among the routine ones.
-- -----------------------------------------------------------------------------
CREATE TABLE financial_event_log (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            BIGSERIAL,
    event_type    TEXT NOT NULL
                  CHECK (event_type IN (
                      'LOCKED_PERIOD_OVERRIDE',
                      'PERIOD_LOCKED',
                      'PERIOD_UNLOCKED',
                      'BANK_DETAILS_CHANGED',
                      'ROLE_CHANGED',
                      'API_KEY_ISSUED',
                      'API_KEY_REVOKED',
                      'RECONCILIATION_COMPLETED',
                      'YEAR_END_CLOSED')),
    actor_user_id UUID,
    /* Why the actor was allowed to do it — the permission that authorised it. */
    permission    TEXT,
    entity_type   TEXT,
    entity_id     UUID,
    /* Free-form context. Kept as JSONB so a new event type does not need a
       migration to record what makes it meaningful. */
    detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id)
);

CREATE INDEX financial_event_log_type_idx
    ON financial_event_log (tenant_id, event_type, occurred_at DESC);

CREATE TRIGGER trg_financial_event_log_append_only
    BEFORE UPDATE OR DELETE ON financial_event_log
    FOR EACH ROW EXECUTE FUNCTION raise_append_only_violation();

-- =============================================================================
-- current_user_id() — the companion to current_tenant_id()
-- =============================================================================
CREATE OR REPLACE FUNCTION current_user_id() RETURNS UUID
LANGUAGE plpgsql STABLE AS $$
DECLARE
    raw TEXT;
BEGIN
    raw := current_setting('app.user_id', true);
    IF raw IS NULL OR raw = '' THEN
        RETURN NULL;
    END IF;
    RETURN raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
END $$;

-- =============================================================================
-- The pre-tenant path: SECURITY DEFINER, narrow, and nothing more.
--
-- Each function returns the minimum the caller needs and nothing else. In
-- particular none of them takes a tenant, because none of them can — they run
-- before a tenant is known.
-- =============================================================================

/*
 * Look a user up for authentication.
 *
 * Returns the password hash, which is exactly why this is the only route to it
 * and why the app role has no direct SELECT on `app_user`. The caller compares
 * the hash; the comparison itself must be constant-time and happen in the
 * application, not here.
 */
CREATE OR REPLACE FUNCTION find_user_for_authentication(p_email TEXT)
RETURNS TABLE (
    id            UUID,
    email         TEXT,
    password_hash TEXT,
    full_name     TEXT,
    status        TEXT,
    failed_logins SMALLINT,
    locked_until  TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT u.id, u.email, u.password_hash, u.full_name, u.status,
           u.failed_logins, u.locked_until
      FROM app_user u
     WHERE lower(u.email) = lower(p_email)
$$;

/* Resolve a session by its token digest, for the refresh path. */
CREATE OR REPLACE FUNCTION find_session_by_token(p_token_hash TEXT)
RETURNS TABLE (
    id            UUID,
    user_id       UUID,
    family_id     UUID,
    rotated_to_id UUID,
    expires_at    TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT s.id, s.user_id, s.family_id, s.rotated_to_id, s.expires_at, s.revoked_at
      FROM user_session s
     WHERE s.refresh_token_hash = p_token_hash
$$;

/*
 * Resolve an API key by its digest.
 *
 * Pre-tenant like the rest of this section, and for a subtle reason: `api_key`
 * IS tenant-owned and RLS'd, but a request presenting a key has not yet
 * established which tenant it is for — the key itself is what names it. Reading
 * it under RLS with no tenant set returns nothing, so the lookup has to come
 * through here.
 *
 * Returns the tenant rather than accepting one, which is the property that
 * makes it safe: a caller cannot use this to read a key belonging to a tenant
 * they named.
 */
CREATE OR REPLACE FUNCTION find_api_key(p_key_hash TEXT)
RETURNS TABLE (
    id         UUID,
    tenant_id  UUID,
    created_by UUID,
    scopes     TEXT[],
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT k.id, k.tenant_id, k.created_by, k.scopes, k.expires_at, k.revoked_at
      FROM api_key k
     WHERE k.key_hash = p_key_hash
$$;

/* Record that a key was used, for the "last used" column an admin looks at. */
CREATE OR REPLACE FUNCTION touch_api_key(p_id UUID) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE api_key SET last_used_at = now() WHERE id = p_id;
$$;

/* The organisations a user may act for. The org-switcher query. */
CREATE OR REPLACE FUNCTION memberships_for_user(p_user_id UUID)
RETURNS TABLE (
    tenant_id   UUID,
    tenant_name TEXT,
    role_code   TEXT,
    status      TEXT,
    expires_at  TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT m.tenant_id, o.name, m.role_code, m.status, m.expires_at
      FROM membership m
      JOIN organisation o ON o.id = m.tenant_id
     WHERE m.user_id = p_user_id
       AND m.status = 'ACTIVE'
       AND (m.expires_at IS NULL OR m.expires_at > now())
     ORDER BY o.name
$$;

/*
 * The permissions a user holds in one organisation.
 *
 * Returns an empty set — never an error — when the user is not a member. The
 * caller then denies, and cannot distinguish "you have no permissions here"
 * from "that organisation does not exist", which is the same 404-not-403 rule
 * the rest of the system follows.
 */
CREATE OR REPLACE FUNCTION permissions_for_user(p_user_id UUID, p_tenant_id UUID)
RETURNS TABLE (permission_code TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT rp.permission_code
      FROM membership m
      JOIN role_permission rp ON rp.role_code = m.role_code
     WHERE m.user_id = p_user_id
       AND m.tenant_id = p_tenant_id
       AND m.status = 'ACTIVE'
       AND (m.expires_at IS NULL OR m.expires_at > now())
$$;

-- =============================================================================
-- Seed: roles and permissions
-- =============================================================================
INSERT INTO app_role (code, name, description, rank) VALUES
    ('OWNER',            'Owner',            'Full control, including billing and deleting the organisation', 0),
    ('ADMIN',            'Admin',            'Full operational control; cannot delete the organisation',      1),
    ('ACCOUNTANT',       'Accountant',       'Full ledger access including period locks and year-end close',   2),
    ('APPROVER',         'Approver',         'Approves bills and payments; cannot originate them',             3),
    ('BOOKKEEPER',       'Bookkeeper',       'Day-to-day entry and reconciliation; no period control',         4),
    ('SALES',            'Sales',            'Quotes, invoices and customers only',                            5),
    ('READ_ONLY',        'Read-only',        'Sees everything, changes nothing',                               6),
    ('EXTERNAL_AUDITOR', 'External Auditor', 'Time-boxed read-only access; all activity logged',               7);

INSERT INTO app_permission (code, description) VALUES
    ('invoice.read',      'View sales invoices'),
    ('invoice.create',    'Issue sales invoices'),
    ('creditnote.create', 'Issue credit notes'),
    ('receipt.create',    'Record customer receipts'),
    ('bill.read',         'View supplier bills'),
    ('bill.create',       'Enter supplier bills'),
    ('bill.approve',      'Approve bills for payment'),
    ('payment.create',    'Pay suppliers'),
    ('debitnote.create',  'Issue debit notes'),
    ('journal.read',      'View the general ledger'),
    ('journal.post',      'Post manual journal entries'),
    ('period.lock',       'Lock and unlock fiscal periods'),
    ('period.override',   'Post into a locked period'),
    ('bank.read',         'View bank accounts and statements'),
    ('bank.import',       'Import bank statements'),
    ('bank.reconcile',    'Match and reconcile bank transactions'),
    ('report.read',       'Run financial statements'),
    ('contact.read',      'View customers and suppliers'),
    ('contact.write',     'Create and edit customers and suppliers'),
    ('tax.read',          'View tax settings and returns'),
    ('tax.write',         'Change tax codes and rates'),
    ('einvoice.submit',   'Submit e-invoices to MyInvois'),
    ('user.read',         'View members of the organisation'),
    ('user.manage',       'Invite, remove and re-role members'),
    ('apikey.manage',     'Issue and revoke API keys'),
    ('org.manage',        'Change organisation settings'),
    ('org.delete',        'Delete the organisation');

/*
 * The role→permission matrix.
 *
 * Two things are deliberate and worth stating:
 *
 *   * APPROVER CANNOT CREATE A BILL, and BOOKKEEPER cannot approve one. That
 *     separation is the whole point of having both roles — an approval workflow
 *     where the same person can raise and approve is not a control, it is
 *     paperwork. This matrix is what makes the M3 approval workflow meaningful
 *     when it is built.
 *
 *   * `period.override` belongs to nobody but OWNER and ACCOUNTANT. Posting
 *     into a locked period is the act most likely to be asked about in an
 *     audit, and it writes a `financial_event_log` row every time.
 */
INSERT INTO role_permission (role_code, permission_code)
SELECT 'OWNER', code FROM app_permission;

INSERT INTO role_permission (role_code, permission_code)
SELECT 'ADMIN', code FROM app_permission WHERE code <> 'org.delete';

INSERT INTO role_permission (role_code, permission_code)
SELECT 'ACCOUNTANT', code FROM app_permission
 WHERE code NOT IN ('org.delete', 'org.manage', 'user.manage', 'apikey.manage');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('APPROVER', 'invoice.read'), ('APPROVER', 'bill.read'),
    ('APPROVER', 'bill.approve'), ('APPROVER', 'journal.read'),
    ('APPROVER', 'report.read'),  ('APPROVER', 'contact.read'),
    ('APPROVER', 'bank.read');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('BOOKKEEPER', 'invoice.read'),   ('BOOKKEEPER', 'invoice.create'),
    ('BOOKKEEPER', 'creditnote.create'), ('BOOKKEEPER', 'receipt.create'),
    ('BOOKKEEPER', 'bill.read'),      ('BOOKKEEPER', 'bill.create'),
    ('BOOKKEEPER', 'payment.create'), ('BOOKKEEPER', 'debitnote.create'),
    ('BOOKKEEPER', 'journal.read'),   ('BOOKKEEPER', 'bank.read'),
    ('BOOKKEEPER', 'bank.import'),    ('BOOKKEEPER', 'bank.reconcile'),
    ('BOOKKEEPER', 'report.read'),    ('BOOKKEEPER', 'contact.read'),
    ('BOOKKEEPER', 'contact.write'),  ('BOOKKEEPER', 'einvoice.submit'),
    ('BOOKKEEPER', 'tax.read');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('SALES', 'invoice.read'), ('SALES', 'invoice.create'),
    ('SALES', 'contact.read'), ('SALES', 'contact.write');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('READ_ONLY', 'invoice.read'), ('READ_ONLY', 'bill.read'),
    ('READ_ONLY', 'journal.read'), ('READ_ONLY', 'report.read'),
    ('READ_ONLY', 'contact.read'), ('READ_ONLY', 'bank.read'),
    ('READ_ONLY', 'tax.read');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('EXTERNAL_AUDITOR', 'invoice.read'), ('EXTERNAL_AUDITOR', 'bill.read'),
    ('EXTERNAL_AUDITOR', 'journal.read'), ('EXTERNAL_AUDITOR', 'report.read'),
    ('EXTERNAL_AUDITOR', 'contact.read'), ('EXTERNAL_AUDITOR', 'bank.read'),
    ('EXTERNAL_AUDITOR', 'tax.read');

-- =============================================================================
-- RLS and grants
-- =============================================================================
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY['invitation', 'api_key', 'financial_event_log'];
BEGIN
    FOREACH t IN ARRAY tenant_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                 USING      (tenant_id = current_tenant_id())
                 WITH CHECK (tenant_id = current_tenant_id())', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO emil_app', t);
    END LOOP;

    REVOKE UPDATE, DELETE ON financial_event_log FROM emil_app;
END $$;

/*
 * Membership's policy is the exception, and the reason is the org switcher: a
 * user has to be able to discover which tenants they may act for, and that
 * question has no tenant context by definition.
 *
 * Note this admits ONLY the caller's own membership rows outside a tenant
 * context — never another user's — so it widens visibility by exactly the row
 * the switcher needs and nothing more.
 */
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON membership
    USING      (tenant_id = current_tenant_id() OR user_id = current_user_id())
    WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON membership TO emil_app;

/* Role and permission definitions are global reference data, read-only. */
GRANT SELECT ON app_role, app_permission, role_permission TO emil_app;

/*
 * THE IDENTITY TABLES GET NO GRANT AT ALL.
 *
 * Not a policy the app role satisfies narrowly — no access whatsoever. Every
 * legitimate pre-tenant operation goes through one of the SECURITY DEFINER
 * functions below, each of which returns a fixed, minimal column set.
 *
 * `rls.test.ts` asserts a direct SELECT on `app_user` is refused, so this is a
 * checked property rather than a comment.
 */
GRANT EXECUTE ON FUNCTION find_user_for_authentication(TEXT)  TO emil_app;
GRANT EXECUTE ON FUNCTION find_session_by_token(TEXT)          TO emil_app;
GRANT EXECUTE ON FUNCTION memberships_for_user(UUID)           TO emil_app;
GRANT EXECUTE ON FUNCTION permissions_for_user(UUID, UUID)     TO emil_app;
GRANT EXECUTE ON FUNCTION find_api_key(TEXT)                   TO emil_app;
GRANT EXECUTE ON FUNCTION touch_api_key(UUID)                  TO emil_app;

/*
 * Writes to the identity tables also go through SECURITY DEFINER functions, so
 * the app role still needs no table grant. Registration, session creation and
 * rotation are the three that must work before a tenant exists.
 */
CREATE OR REPLACE FUNCTION create_user(
    p_email TEXT, p_password_hash TEXT, p_full_name TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO app_user (email, password_hash, full_name)
    VALUES (p_email, p_password_hash, p_full_name)
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION create_session(
    p_user_id UUID, p_token_hash TEXT, p_family_id UUID, p_expires_at TIMESTAMPTZ,
    p_ip TEXT, p_user_agent TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO user_session (user_id, refresh_token_hash, family_id, expires_at, ip, user_agent)
    VALUES (p_user_id, p_token_hash, p_family_id, p_expires_at, p_ip::inet, p_user_agent)
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION rotate_session(p_old_id UUID, p_new_id UUID) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE user_session SET rotated_to_id = p_new_id WHERE id = p_old_id;
$$;

/*
 * Revoke an entire token family.
 *
 * Called when a rotated token is presented a second time. See
 * packages/domain/src/session.ts: that can only happen if a token was captured,
 * and there is no way to tell the thief from the victim — so both are logged
 * out and the real user re-authenticates.
 */
CREATE OR REPLACE FUNCTION revoke_session_family(p_family_id UUID, p_reason TEXT) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE user_session
       SET revoked_at = now(), revoked_reason = p_reason
     WHERE family_id = p_family_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION revoke_session(p_id UUID, p_reason TEXT) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE user_session SET revoked_at = now(), revoked_reason = p_reason
     WHERE id = p_id AND revoked_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION record_login_outcome(p_user_id UUID, p_succeeded BOOLEAN) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF p_succeeded THEN
        UPDATE app_user
           SET last_login_at = now(), failed_logins = 0, locked_until = NULL
         WHERE id = p_user_id;
    ELSE
        UPDATE app_user
           SET failed_logins = failed_logins + 1,
               /* Ten wrong passwords locks the account for fifteen minutes.
                  Slows credential stuffing without giving anyone a trivial way
                  to lock a known email out permanently. */
               locked_until = CASE WHEN failed_logins + 1 >= 10
                                   THEN now() + INTERVAL '15 minutes' ELSE locked_until END
         WHERE id = p_user_id;
    END IF;
END $$;

GRANT EXECUTE ON FUNCTION create_user(TEXT, TEXT, TEXT)                          TO emil_app;
GRANT EXECUTE ON FUNCTION create_session(UUID, TEXT, UUID, TIMESTAMPTZ, TEXT, TEXT) TO emil_app;
GRANT EXECUTE ON FUNCTION rotate_session(UUID, UUID)                             TO emil_app;
GRANT EXECUTE ON FUNCTION revoke_session_family(UUID, TEXT)                      TO emil_app;
GRANT EXECUTE ON FUNCTION revoke_session(UUID, TEXT)                             TO emil_app;
GRANT EXECUTE ON FUNCTION record_login_outcome(UUID, BOOLEAN)                    TO emil_app;

GRANT USAGE, SELECT ON SEQUENCE financial_event_log_id_seq TO emil_app;
