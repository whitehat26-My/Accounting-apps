/*
 * Three fixes from the API penetration test (docs/security/API-PENTEST-PLAN.md):
 * PE-5 (make an access token revocable), AI-2 (a hand-inserted audit row must
 * not be able to forge its own attribution), and the auditable half of AI-6.
 *
 * All three are database-side because the database is the one place every code
 * path — and every SQL-injection payload — has to go through.
 */

/* ===========================================================================
 * PE-5 — an access token must die when its session is revoked.
 *
 * The 15-minute access token is a signed JWT the guard verifies with no
 * database round-trip, which is fast and was the whole point. The cost surfaced
 * in the pen test: `POST /v1/auth/logout` revokes the refresh-token *family*,
 * but the outstanding access token kept working until it expired — a stolen or
 * leaked token could not be killed for up to fifteen minutes.
 *
 * The token already carries `sessionId`. This function lets the guard ask, in
 * the same transaction it already opens to resolve the principal, "is that
 * session still live?" — so revocation takes effect on the very next request
 * instead of at expiry.
 *
 * WHY `revoked_at IS NULL` IS THE RIGHT TEST, not `rotated_to_id IS NULL`:
 * a normal refresh ROTATES a session — it sets `rotated_to_id` on the old row
 * and never touches `revoked_at` — so an access token minted before a routine
 * rotation stays valid, which is what we want. Only the three events that
 * genuinely end a session set `revoked_at`: sign-out, refresh-token reuse
 * detection, and the 90-day family ceiling. Those, and only those, now
 * invalidate the access token immediately.
 *
 * SECURITY DEFINER for the same reason as every other identity function: the
 * `user_session` table has no grant to `emil_app` at all, and is reached only
 * through narrow definer functions like this one.
 * ------------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION session_is_active(p_session_id UUID) RETURNS BOOLEAN
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM user_session
         WHERE id = p_session_id
           AND revoked_at IS NULL
           AND expires_at > now()
    );
$$;

REVOKE ALL ON FUNCTION session_is_active(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_is_active(UUID) TO emil_app;

/* ===========================================================================
 * AI-2 — a directly-inserted audit row must not be able to lie about who did it.
 *
 * `emil_app` holds INSERT on `audit_log` (the generic per-table trigger needs
 * it). The pen test showed that a hand-written `INSERT INTO audit_log (...)`
 * with an attacker-chosen `actor_user_id` is hashed and chained *correctly* by
 * `audit_log_chain`, so it passes `verify_audit_chain` — the forged row looks
 * exactly as trustworthy as a real one, and can point the finger at any user.
 * This is only reachable from something with SQL as `emil_app` (raw-SQL code or
 * an SQL-injection foothold), but the audit log is precisely the evidence that
 * must survive an attacker who reaches that far.
 *
 * The fix moves attribution from a value the INSERT *supplies* to a value the
 * trigger *derives*: whatever the inserting statement puts in the actor
 * columns, `audit_log_chain` overwrites them from the session GUCs
 * (`current_user_id()` et al.) BEFORE it computes the hash. The GUCs are set by
 * `withTenant`/`setActorContext` from the authenticated principal and cannot be
 * spoofed through the API. So a forged insert can no longer frame another user:
 * the row is attributed to whoever's authenticated transaction the injection
 * actually ran in, and the hash covers that forced attribution.
 *
 * This is invisible to the legitimate writer — the generic trigger
 * `audit_row_change` already populates these columns from the very same GUCs,
 * so overwriting them with identical values changes nothing for real rows and
 * only bites a caller who tried to supply something different.
 * ------------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
DECLARE
    v_prev BYTEA;
BEGIN
    PERFORM audit_chain_lock(NEW.tenant_id);

    -- Attribution is DERIVED, never trusted from the INSERT. Anything the
    -- inserting statement placed in these columns is discarded here, so a
    -- forged row cannot name an actor, an IP, a request or an agent of the
    -- attacker's choosing. The values come from the session context the API
    -- sets for the authenticated principal, and nowhere else.
    NEW.actor_user_id := current_user_id();
    NEW.actor_ip      := current_actor_ip();
    NEW.user_agent    := current_user_agent();
    NEW.request_id    := current_request_id();

    SELECT row_hash INTO v_prev
      FROM audit_log
     WHERE tenant_id = NEW.tenant_id
     ORDER BY id DESC
     LIMIT 1;

    NEW.prev_hash    := v_prev;
    NEW.hash_version := 2;
    NEW.row_hash     := audit_row_hash(
        v_prev, NEW.tenant_id, NEW.actor_user_id, NEW.actor_ip, NEW.user_agent,
        NEW.request_id, NEW.action, NEW.entity_type, NEW.entity_id,
        NEW.before_json, NEW.after_json, NEW.occurred_at
    );

    RETURN NEW;
END $$;

/* ===========================================================================
 * AI-6 (partial) — audit an organisation DELETE where it is possible to.
 *
 * The generic install loop attached the audit trigger to `organisation` for
 * INSERT and UPDATE only. A full account deletion leaving no trace is the gap.
 *
 * The honest scope: an `organisation` row that owns ANY data cannot be deleted
 * at all — `audit_log.tenant_id`, and dozens of other tenant tables, reference
 * it `ON DELETE RESTRICT` — so a DELETE only succeeds for an empty, just-created
 * shell, and even then an AFTER-DELETE audit insert would itself violate that
 * RESTRICT (the audit row references the organisation being removed). So there
 * is no way to write the audit row into `audit_log` for a real deletion, and
 * pretending otherwise with a trigger that always errors would be worse than
 * the gap.
 *
 * What IS enforceable, and is the control that actually matters: make the
 * restriction explicit and total, so a deletion cannot slip through some future
 * path that happens to clear the other references first. A BEFORE DELETE trigger
 * refuses outright and names the reversing path (deactivate, never delete),
 * matching how the ledger refuses a posted-entry delete. The residual
 * identity-events gap (password/lockout/session changes on the tenant-less
 * `app_user`/`user_session`) needs a dedicated security-event log and is scoped
 * in docs/SETTLEMENT-REGISTER.md rather than bolted on here.
 * ------------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION forbid_organisation_delete() RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Organisations are not deleted (org %). Deactivate it instead — a deletion '
        'would leave no audit trail, because the audit log it would be written to '
        'references the organisation being removed.', OLD.id
        USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER trg_organisation_no_delete
    BEFORE DELETE ON organisation
    FOR EACH ROW EXECUTE FUNCTION forbid_organisation_delete();
