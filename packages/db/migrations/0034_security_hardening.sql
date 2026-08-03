-- =============================================================================
-- 0034 — Security hardening
--
-- Four fixes from the security audit, all at the database boundary:
--
--   * The 90-day session-family ceiling was defined in the domain but never
--     enforced, because the service had no way to read the family's start
--     time. This adds the definer function that exposes it.
--   * The account lockout could be held indefinitely: `failed_logins` reset
--     only on success, so one wrong password every 15 minutes re-armed the
--     lock forever. It now clears a lapsed lock and starts a fresh streak.
--   * Every SECURITY DEFINER function is REVOKEd from PUBLIC. Migrations
--     0014/0015/0016/0021 already did this; 0012 and 0033 only GRANTed, so
--     their identity functions (password lookup, session minting) were
--     PUBLIC-executable — a latent full-takeover the day a third DB role is
--     added.
--   * Every SECURITY DEFINER function gets `pg_temp` LAST in its search_path.
--     Omitting it lets a caller who can create a temp table shadow a real one
--     (e.g. a fake `app_user`) and have a superuser-owned function read it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- The session family's start, so `familyExpired()` can finally be enforced.
--
-- A family is every session descended from one login; its start is the
-- earliest `created_at` under the shared `family_id`. Identity tables carry no
-- grant to emil_app, so this is read through a definer function like every
-- other identity access.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION session_family_started_at(p_family_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT MIN(created_at) FROM user_session WHERE family_id = p_family_id;
$$;

-- ---------------------------------------------------------------------------
-- Lockout that cannot be held indefinitely.
--
-- The change is the CASE on failure: when the previous lock has already
-- lapsed, the streak resets to a single failure and the lock clears, so an
-- attacker sending one wrong password per window can no longer keep a known
-- account locked. Re-locking now needs a fresh run of ten failures inside one
-- window — which the per-address rate limit throttles. Success still clears
-- everything.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_login_outcome(p_user_id UUID, p_succeeded BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_succeeded THEN
        UPDATE app_user
           SET last_login_at = now(), failed_logins = 0, locked_until = NULL
         WHERE id = p_user_id;
    ELSE
        UPDATE app_user
           SET failed_logins = CASE
                   WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
                   ELSE failed_logins + 1
               END,
               locked_until = CASE
                   -- A lapsed lock clears; the attacker does not get to re-arm
                   -- it on the strength of a stale counter.
                   WHEN locked_until IS NOT NULL AND locked_until <= now() THEN NULL
                   WHEN failed_logins + 1 >= 10 THEN now() + INTERVAL '15 minutes'
                   ELSE locked_until
               END
         WHERE id = p_user_id;
    END IF;
END $$;

REVOKE ALL ON FUNCTION session_family_started_at(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_family_started_at(UUID) TO emil_app;

-- ---------------------------------------------------------------------------
-- Close PUBLIC execute and pin pg_temp across EVERY SECURITY DEFINER function.
--
-- Applied by loop over `pg_proc` rather than by listing ~20 signatures: the
-- set is exactly "definer functions in public", the two operations are
-- idempotent, and a function added later that forgets either is caught the
-- next time this style of migration runs. The explicit GRANTs to
-- emil_app / emil_worker are untouched — only the implicit PUBLIC grant goes.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
        EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fn);
    END LOOP;
END $$;
