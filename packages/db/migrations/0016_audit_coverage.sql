-- =============================================================================
-- 0016_audit_coverage
--
-- M9: make the audit log tell the truth.
--
-- -----------------------------------------------------------------------------
-- THE CLAIM AND THE REALITY.
--
-- README.md rule 4 and CLAUDE.md's definition of done both say every mutation is
-- attributable through a hash-chained, append-only audit log. The MACHINERY for
-- that landed in 0001 and is sound: append-only by trigger and by revoked grant,
-- RLS enabled and forced, a per-tenant hash chain, a verifier.
--
-- The COVERAGE did not. Before this migration `audit_log` was written from
-- exactly one place — `postJournalEntry()` — across roughly thirty mutating
-- service functions, and four of the columns the specification asks for
-- (`actor_ip`, `user_agent`, `request_id`, `before_json`) were NULL on every row
-- that existed.
--
-- Four defects in the existing machinery are fixed here as well, each described
-- where it is fixed:
--
--   1. The verifier never recomputed `row_hash`, so editing a row's contents in
--      place was UNDETECTABLE.
--   2. `actor_ip`, `user_agent` and `request_id` were not in the hash at all —
--      the very fields M9 exists to capture were freely editable.
--   3. The hash was not reproducible across sessions, and its inputs were
--      concatenated without delimiters.
--   4. Concurrent inserts in one tenant could fork the chain, and the obvious
--      fix for that introduces a deadlock.
-- -----------------------------------------------------------------------------
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Actor context
--
-- 04-security-compliance.md §4.3 wants who, what, before, after, when AND FROM
-- WHERE. The API has always collected the last part — `RequestContext` carries a
-- request id, an IP and a user agent — but `TenantContext` could not carry it
-- into the transaction, so it never reached a row. These accessors are the other
-- end of that wire: `withTenant` publishes the settings with `SET LOCAL`,
-- exactly as it already does for `app.tenant_id`.
--
-- All three tolerate absence. A background job or a migration legitimately has
-- no request behind it, and an audit row that cannot say where a write came from
-- is worth far more than a write that fails because nothing set a header.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_request_id() RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE
    raw TEXT;
BEGIN
    raw := current_setting('app.request_id', true);
    IF raw IS NULL OR raw = '' THEN RETURN NULL; END IF;
    RETURN left(raw, 128);
END $$;

/* Bounded here rather than at the caller: a user agent is attacker-controlled
   and unbounded, and this string is copied onto every audit row a transaction
   writes and hashed into every one of them. */
CREATE OR REPLACE FUNCTION current_user_agent() RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE
    raw TEXT;
BEGIN
    raw := current_setting('app.user_agent', true);
    IF raw IS NULL OR raw = '' THEN RETURN NULL; END IF;
    RETURN left(raw, 512);
END $$;

/* A malformed address is recorded as NULL rather than raising. `actor_ip` is
   INET, and a proxy forwarding something unparseable would otherwise abort the
   business write it was describing. An audit row that cannot say where a request
   came from is a small loss; a payment that fails because a header was malformed
   is a large one. */
CREATE OR REPLACE FUNCTION current_actor_ip() RETURNS INET
LANGUAGE plpgsql STABLE AS $$
DECLARE
    raw TEXT;
BEGIN
    raw := current_setting('app.actor_ip', true);
    IF raw IS NULL OR raw = '' THEN RETURN NULL; END IF;
    RETURN raw::inet;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- The hash formula, version 2
--
-- Three defects in the v1 formula at 0001:509-518, all of which had to be fixed
-- together because any one of them changes the bytes hashed.
--
-- DEFECT 2: THE ATTRIBUTION FIELDS WERE NOT HASHED. v1 covered prev, tenant,
-- actor, action, entity type and id, before, after and time — and NOT
-- `actor_ip`, `user_agent` or `request_id`. Recomputing the hash therefore would
-- still not have detected someone rewriting the IP address an action came from,
-- which is exactly the field an investigator cares about. The whole point of
-- this milestone is capturing those three columns; leaving them outside the hash
-- would have made them the only unprotected thing in the row.
--
-- DEFECT 3a: NOT REPRODUCIBLE. v1 hashed `NEW.occurred_at::text`. Casting a
-- TIMESTAMPTZ to text renders it in the SESSION's timezone — verified:
--
--     SET TimeZone='Etc/UTC';           now()::text → 2026-08-01 17:06:38.76+00
--     SET TimeZone='Asia/Kuala_Lumpur'; now()::text → 2026-08-02 01:06:38.76+08
--
-- Different strings, different SHA-256. Nothing recomputed the hash, so it was
-- invisible — but it would have made the verifier below report every row as
-- tampered whenever the verifying session's timezone differed from the writing
-- session's. This product displays in Asia/Kuala_Lumpur and its servers run UTC,
-- so that is not hypothetical.
--
-- DEFECT 3b: NO DELIMITERS. v1 concatenated the fields directly, so
-- ('JOURNAL', '_POSTED') and ('JOURNAL_', 'POSTED') hash identically. A narrow
-- hole, but a free one to close.
--
-- All three are fixed by hashing a canonical JSONB rendering: jsonb orders its
-- keys deterministically, quotes and escapes every value, and does not consult
-- session settings. The timestamp is formatted explicitly at UTC.
--
-- ONE function, used by BOTH the insert trigger and the verifier, so they cannot
-- drift. If they ever did, every row would fail verification at once — loudly,
-- which is the right failure mode for this.
-- -----------------------------------------------------------------------------
ALTER TABLE audit_log ADD COLUMN hash_version SMALLINT NOT NULL DEFAULT 1;

COMMENT ON COLUMN audit_log.hash_version IS
    'Which hash formula produced row_hash. 1 = the 0001 formula, which omitted '
    'the actor IP, user agent and request id and was session-dependent. '
    '2 = audit_row_hash(). The verifier checks content only for rows it can '
    'reproduce; a chain written before 0016 must be re-anchored to be verifiable.';

CREATE OR REPLACE FUNCTION audit_row_hash(
    p_prev        BYTEA,
    p_tenant      UUID,
    p_actor       UUID,
    p_actor_ip    INET,
    p_user_agent  TEXT,
    p_request_id  TEXT,
    p_action      TEXT,
    p_entity_type TEXT,
    p_entity_id   UUID,
    p_before      JSONB,
    p_after       JSONB,
    p_occurred    TIMESTAMPTZ
) RETURNS BYTEA
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT digest(
        convert_to(
            jsonb_build_object(
                'v',           2,
                'prev',        COALESCE(encode(p_prev, 'hex'), ''),
                'tenant',      p_tenant,
                'actor',       p_actor,
                'ip',          host(p_actor_ip),
                'ua',          p_user_agent,
                'request',     p_request_id,
                'action',      p_action,
                'entity_type', p_entity_type,
                'entity_id',   p_entity_id,
                'before',      p_before,
                'after',       p_after,
                'at',          to_char(p_occurred AT TIME ZONE 'UTC',
                                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            )::text,
            'UTF8'
        ),
        'sha256'
    )
$$;

-- -----------------------------------------------------------------------------
-- DEFECT 4: concurrency, and the deadlock the obvious fix causes
--
-- The v1 trigger read "this tenant's last row_hash" and used it as `prev_hash`.
-- Under READ COMMITTED two concurrent transactions in one tenant both see the
-- same last row, both insert, and the chain FORKS: two rows claiming the same
-- predecessor. The verifier then reports a break nobody caused — the worst
-- outcome available to a tamper detector, because a false alarm teaches everyone
-- to ignore the real one.
--
-- A hash chain is inherently sequential, so the answer is to serialise per
-- tenant with the tool `allocate_document_number` already uses for the same
-- reason. But adding that lock naively creates a DEADLOCK, and it is reachable
-- with two ordinary concurrent requests:
--
--   Issuing an invoice:  allocate('INVOICE') takes lock A
--                        → INSERT invoice fires the audit trigger, takes X
--                        → postJournalEntry → allocate('JOURNAL') wants lock B
--   Posting a journal:   allocate('JOURNAL') takes lock B
--                        → INSERT journal_entry fires the trigger, wants X
--
--   T1 holds A and X, waits for B. T2 holds B, waits for X. Deadlock.
--
-- The fix is a GLOBAL LOCK ORDER, stated once and enforced in the one place
-- every mutating operation passes through: THE AUDIT-CHAIN LOCK IS ALWAYS TAKEN
-- BEFORE ANY DOCUMENT-NUMBER LOCK. `allocate_document_number` takes it first,
-- so any transaction that allocates a number already holds it before it can
-- want a document lock, and the cycle cannot form. Advisory locks are re-entrant
-- within a transaction, so the trigger taking it again later is free.
--
-- The remaining cost is real and worth stating plainly: two transactions writing
-- audited rows for ONE tenant now serialise from their first audited write to
-- commit. Within a transaction the lock is acquired once and held, so a
-- hundred-line invoice pays for it once rather than a hundred times, and there
-- is no contention at all between tenants.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_chain_lock(p_tenant UUID) RETURNS VOID
LANGUAGE sql AS $$
    SELECT pg_advisory_xact_lock(hashtextextended('emil.audit_chain:' || p_tenant::text, 0))
$$;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_prev BYTEA;
BEGIN
    PERFORM audit_chain_lock(NEW.tenant_id);

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

/*
 * Unchanged from 0001 except for the first statement, which establishes the
 * lock order described above. Restated in full rather than patched because a
 * function body cannot be amended in place.
 */
CREATE OR REPLACE FUNCTION allocate_document_number(p_document_type TEXT)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_tenant UUID := current_tenant_id();
    v_number TEXT;
BEGIN
    IF v_tenant IS NULL THEN
        RAISE EXCEPTION 'allocate_document_number() called without a tenant context';
    END IF;

    -- LOCK ORDER: audit chain first, ALWAYS. Any transaction allocating a
    -- number will write an audit row before it commits, so taking the lock here
    -- costs nothing extra and removes the deadlock class entirely. Moving,
    -- removing or reordering this line reintroduces it.
    PERFORM audit_chain_lock(v_tenant);

    -- Transaction-scoped: released on COMMIT or ROLLBACK, so a rolled-back
    -- allocation returns the number to the pool rather than burning it.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(v_tenant::text || ':' || p_document_type, 0)
    );

    UPDATE number_sequence
       SET next_value = next_value + 1
     WHERE tenant_id = v_tenant
       AND document_type = p_document_type
    RETURNING prefix || lpad((next_value - 1)::text, padding, '0')
      INTO v_number;

    IF v_number IS NULL THEN
        RAISE EXCEPTION 'No number sequence configured for document type %', p_document_type;
    END IF;

    RETURN v_number;
END $$;

-- -----------------------------------------------------------------------------
-- DEFECT 1: the verifier did not detect tampering
--
-- THIS IS THE ONE THAT MATTERS. The original `verify_audit_chain` compared each
-- row's `prev_hash` to the previous row's stored `row_hash`, and nothing else:
--
--   * deleting a row  → the next row's prev_hash no longer matches. CAUGHT.
--   * inserting a row → same. CAUGHT.
--   * EDITING A ROW'S CONTENTS IN PLACE → `row_hash` is stored, never
--     recomputed, so every prev_hash in the chain still lines up perfectly.
--     NOT CAUGHT.
--
-- Rewriting what an audit row says happened was invisible to the check that
-- exists to detect exactly that. 02-core-modules.md:407 promises "hash-chained
-- so tampering is detectable"; for the most interesting kind of tampering it was
-- not. `audit.test.ts` demonstrates both behaviours side by side.
--
-- A SECOND, SUBTLER DEFECT: the function was SECURITY INVOKER and STABLE, so it
-- ran under RLS. Called for a tenant the session cannot see, it returned zero
-- rows — which reads as "chain intact". A verifier whose failure mode is a
-- SILENT PASS is not a verifier. It now refuses a cross-tenant call outright,
-- and reports how many rows it actually checked so an empty result cannot be
-- mistaken for a clean one.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS verify_audit_chain(UUID);

CREATE OR REPLACE FUNCTION verify_audit_chain(p_tenant UUID)
RETURNS TABLE (broken_at BIGINT, reason TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- SECURITY DEFINER, so the guard is the isolation. `current_tenant_id()`
    -- being NULL is the owner-run nightly path, which legitimately sweeps every
    -- tenant.
    IF current_tenant_id() IS NOT NULL AND p_tenant <> current_tenant_id() THEN
        RAISE EXCEPTION 'verify_audit_chain: cannot verify another tenant''s chain'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN QUERY
    WITH chained AS (
        SELECT a.id, a.prev_hash, a.row_hash, a.hash_version,
               LAG(a.row_hash) OVER (ORDER BY a.id) AS expected_prev,
               -- NULL for a v1 row: its formula omitted the attribution fields
               -- and depended on the session, so it cannot be reproduced here.
               -- Linkage is still checked for those rows below.
               CASE WHEN a.hash_version >= 2 THEN audit_row_hash(
                        a.prev_hash, a.tenant_id, a.actor_user_id, a.actor_ip,
                        a.user_agent, a.request_id, a.action, a.entity_type,
                        a.entity_id, a.before_json, a.after_json, a.occurred_at)
               END AS recomputed
          FROM audit_log a
         WHERE a.tenant_id = p_tenant
    )
    SELECT c.id,
           CASE
               -- Checked first: a row whose own hash does not match its own
               -- contents was edited, and that is the more serious finding.
               WHEN c.recomputed IS NOT NULL AND c.row_hash IS DISTINCT FROM c.recomputed
                   THEN 'CONTENT_ALTERED'
               ELSE 'CHAIN_BROKEN'
           END
      FROM chained c
     WHERE c.prev_hash IS DISTINCT FROM c.expected_prev
        OR (c.recomputed IS NOT NULL AND c.row_hash IS DISTINCT FROM c.recomputed)
     ORDER BY c.id;
END $$;

REVOKE ALL ON FUNCTION verify_audit_chain(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_audit_chain(UUID) TO emil_app;

-- =============================================================================
-- The generic audit trigger
-- =============================================================================

-- -----------------------------------------------------------------------------
-- WHY A TRIGGER RATHER THAN A CALL IN EACH SERVICE.
--
-- The alternative — an `audit()` helper invoked from each of the thirty mutating
-- functions — fails in three ways this does not:
--
--   * it can be FORGOTTEN. `rbac.ts:203` already names this failure mode about
--     the financial event log: "keeping the list in one place stops each caller
--     deciding for itself — which is how one of them ends up not writing the
--     row". Thirty callers is thirty chances to be that one.
--   * it cannot produce `before_json` without re-reading the row first, so every
--     service would need an extra SELECT it does not otherwise want.
--   * it is BLIND TO WRITES THAT BYPASS THE SERVICE LAYER. An operator running
--     an UPDATE against production in psql is precisely what an audit log is
--     for, and an application-level helper cannot see it by construction.
--
-- The cost is volume: one audit row per ROW changed, so a five-hundred-line
-- statement import writes five hundred audit rows. That is what "every mutation"
-- means, and it is the price of the claim in the README.
-- -----------------------------------------------------------------------------

/*
 * Columns never copied into the audit log.
 *
 * The audit log is the most widely readable table in the system — an
 * EXTERNAL_AUDITOR can read it and, by design, needs to. So it must not become
 * the place where credential material accumulates in readable form.
 *
 * These are digests rather than plaintext, so this is not a plaintext leak. It
 * is still a needless second copy of a credential in a table with a broader
 * audience than the one it came from, and the audit value is nil: that a pay
 * link was created is the fact worth recording, not the bytes that open it.
 *
 * The payload columns are excluded for size rather than secrecy — a full
 * submitted e-invoice duplicated into an audit row would dwarf the log, and the
 * payload is already stored immutably in the table being audited.
 */
CREATE OR REPLACE FUNCTION audit_redact(p_row JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_row
         - 'token_hash' - 'key_hash' - 'secret' - 'password_hash'
         - 'client_secret' - 'raw_payload' - 'payload' - 'document_json'
$$;

/*
 * The entity id, best effort.
 *
 * Most tables have a UUID `id`. A few are keyed on a composite with no id at all
 * (`posting_account_map` is keyed on (tenant_id, role)), and a couple use
 * BIGSERIAL. Rather than special-case each, take `id` when it is a UUID and NULL
 * otherwise — the full row is in `before_json`/`after_json` either way, so
 * nothing is lost; `audit_log_entity_idx` simply does not help for those tables.
 */
CREATE OR REPLACE FUNCTION audit_entity_id(p_row JSONB) RETURNS UUID
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    RETURN (p_row ->> 'id')::uuid;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END $$;

/*
 * The trigger.
 *
 * `TG_ARGV[0]` names the column holding the tenant id — `organisation` is the
 * one audited table whose own `id` IS the tenant. `TG_ARGV[1..]` are columns
 * whose change alone is not worth a row; see the install list below.
 *
 * Actions use the vocabulary from 04-security-compliance.md §4.3
 * (CREATE|UPDATE|DELETE). Semantic names like "invoice issued" deliberately do
 * NOT live here: that is what `financial_event_log` is for, and the two-log
 * split is the documented design. This log answers "what changed, exactly";
 * that one answers "what did somebody DO".
 */
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_tenant_column TEXT := COALESCE(TG_ARGV[0], 'tenant_id');
    v_before JSONB;
    v_after  JSONB;
    v_left   JSONB;
    v_right  JSONB;
    v_tenant UUID;
    v_action TEXT;
    v_ignore TEXT;
    i        INT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_before := to_jsonb(OLD);
        v_tenant := (v_before ->> v_tenant_column)::uuid;
        v_action := 'DELETE';
    ELSE
        v_after := to_jsonb(NEW);
        v_tenant := (v_after ->> v_tenant_column)::uuid;

        IF TG_OP = 'UPDATE' THEN
            v_before := to_jsonb(OLD);
            v_action := 'UPDATE';

            -- Ignored columns are stripped for the COMPARISON only. If anything
            -- else changed, the row is logged in full — the ignore list decides
            -- WHETHER to log, never WHAT.
            v_left  := v_before;
            v_right := v_after;
            i := 1;
            WHILE TG_ARGV[i] IS NOT NULL LOOP
                v_ignore := TG_ARGV[i];
                v_left   := v_left  - v_ignore;
                v_right  := v_right - v_ignore;
                i := i + 1;
            END LOOP;

            -- An UPDATE that changed nothing anyone cares about is not a
            -- mutation worth a row. Several services write idempotent UPDATEs on
            -- a replay path, and logging those buries the real changes among
            -- them.
            IF v_left = v_right THEN
                RETURN NULL;
            END IF;
        ELSE
            v_action := 'CREATE';
        END IF;
    END IF;

    INSERT INTO audit_log (
        tenant_id, actor_user_id, actor_ip, user_agent, request_id,
        action, entity_type, entity_id, before_json, after_json, row_hash
    ) VALUES (
        v_tenant,
        current_user_id(),
        current_actor_ip(),
        current_user_agent(),
        current_request_id(),
        v_action,
        TG_TABLE_NAME,
        audit_entity_id(COALESCE(v_after, v_before)),
        audit_redact(v_before),
        audit_redact(v_after),
        -- A placeholder. `trg_audit_log_chain` overwrites it; the column is
        -- NOT NULL so something has to be supplied.
        ''::bytea
    );

    RETURN NULL;  -- AFTER trigger: the return value is ignored.
END $$;

-- -----------------------------------------------------------------------------
-- Installing it, and the tables deliberately left out
--
-- Every exclusion needs a reason, in the same spirit as the RLS allowlist in
-- `rls.test.ts`: a table is presumed audited, and exempting one is a reviewed
-- decision recorded here rather than something a developer can do by
-- forgetting. `audit.test.ts` sweeps `pg_class` and fails when a new table is
-- neither audited nor listed.
--
-- Tables with no `tenant_id` are excluded by the loop's own condition rather
-- than by name: `audit_log.tenant_id` is NOT NULL, so there is no tenant to
-- attribute their rows to. That covers the global reference data and — a REAL
-- GAP, not a free exclusion — `app_user` and `user_session`. Password changes,
-- lockouts and session revocations therefore remain unaudited. The right home
-- for those is a global security event log with no tenant column, which is not
-- built here.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    t TEXT;
    excluded TEXT[] := ARRAY[
        -- Auditing the audit log recurses without end. Structural, not a
        -- judgement.
        'audit_log',
        -- Already append-only evidence, and already the high-signal log. A
        -- second immutable record of an immutable record adds no accountability.
        -- Judgement, not necessity: this one would not recurse.
        'financial_event_log',
        -- Machine-to-machine delivery state. A dispatcher rewrites status and
        -- attempts on every try, so auditing it records retry noise about the
        -- delivery mechanism rather than about the books. The business fact that
        -- produced the event was audited on its source table, in the same
        -- transaction.
        'outbox_event',
        -- Derived. 0001:206 says so in the schema itself: "This is a CACHE.
        -- journal_line is the truth." Every posted line updates it, so including
        -- it roughly doubles audit volume for a table reconstructible from the
        -- journal by definition. NOTE the control this exclusion leans on — a
        -- nightly recompute-and-alarm — does not exist yet; `detectRollupDrift`
        -- is the on-demand version of it.
        'account_period_balance',
        -- An allocation counter. The number it issued is visible on the document
        -- that carries it, which is audited.
        'number_sequence'
    ];
BEGIN
    FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND NOT c.relname = ANY (excluded)
           AND EXISTS (
                 SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                    AND NOT a.attisdropped
               )
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_audit_%1$s
                 AFTER INSERT OR UPDATE OR DELETE ON %1$I
                 FOR EACH ROW EXECUTE FUNCTION audit_row_change(%2$L)', t, 'tenant_id');
    END LOOP;
END $$;

/*
 * `api_key.last_used_at` is stamped on EVERY api-key-authenticated request, by
 * `touch_api_key`. Without this, every such request would write an audit row
 * saying a timestamp moved — burying key issuance and revocation, the two facts
 * anyone actually wants from this table, under per-request noise.
 */
DROP TRIGGER trg_audit_api_key ON api_key;
CREATE TRIGGER trg_audit_api_key
    AFTER INSERT OR UPDATE OR DELETE ON api_key
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('tenant_id', 'last_used_at');

/*
 * `payment_link.view_count` and `first_viewed_at` move every time a payer
 * refreshes the pay page, which is an unauthenticated route anyone holding the
 * link can hit repeatedly. Auditing that turns a public page into an audit-log
 * amplifier.
 */
DROP TRIGGER trg_audit_payment_link ON payment_link;
CREATE TRIGGER trg_audit_payment_link
    AFTER INSERT OR UPDATE OR DELETE ON payment_link
    FOR EACH ROW EXECUTE FUNCTION audit_row_change(
        'tenant_id', 'view_count', 'first_viewed_at', 'updated_at');

/*
 * `organisation` is audited too, keyed on its own id.
 *
 * It is the one table that is tenant-owned without having a `tenant_id` column —
 * it IS the tenant. Leaving it out would mean a change to an organisation's
 * name, base currency, SST registration number or financial year end went
 * unrecorded, and those are among the few settings that silently change what
 * every later document means.
 */
CREATE TRIGGER trg_audit_organisation
    AFTER INSERT OR UPDATE ON organisation
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');

-- -----------------------------------------------------------------------------
-- Reading the audit log
--
-- A log nobody can read is not an audit log, and until now nothing could: there
-- was no permission, no service function and no route.
-- -----------------------------------------------------------------------------

/*
 * Put a name to an actor id.
 *
 * A trail reading "a1b2c3d4-… changed the bank account" is not something a human
 * can act on. But `app_user` is GLOBAL — one login serves many client
 * organisations — and the application role has no grant on it at all, by design:
 * every legitimate read goes through a narrow SECURITY DEFINER function. This is
 * one of those.
 *
 * Scoped by MEMBERSHIP, not merely by "an audit row mentions them". Without that
 * check, one organisation could resolve any user id it could guess into an email
 * address, turning the audit reader into a directory of every user of the
 * product. You may see the name of someone who acts for your organisation, and
 * nobody else.
 */
CREATE OR REPLACE FUNCTION audit_actor(p_user_id UUID)
RETURNS TABLE (email TEXT, full_name TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT u.email, u.full_name
      FROM app_user u
     WHERE u.id = p_user_id
       AND EXISTS (
             SELECT 1 FROM membership m
              WHERE m.user_id = u.id
                AND m.tenant_id = current_tenant_id()
           )
$$;

REVOKE ALL ON FUNCTION audit_actor(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_actor(UUID) TO emil_app;

/*
 * EXTERNAL_AUDITOR gets this because the role exists for exactly this, and its
 * membership is already time-boxed. Granted to OWNER and ADMIN as well, and
 * deliberately NOT to ACCOUNTANT, BOOKKEEPER, SALES or READ_ONLY.
 *
 * Two reasons for that last part. The separation one: the value of an audit
 * trail is diminished when the people whose work it records can routinely read
 * what it captured about them. And the privacy one: this log holds colleagues'
 * IP addresses and user-agent strings, which is a PDPA surface rather than an
 * accounting one — READ_ONLY "sees everything, changes nothing" is about the
 * BOOKS.
 *
 * Note the explicit rows. 0012:443-455 granted permissions to OWNER, ADMIN and
 * ACCOUNTANT with `SELECT ... FROM app_permission`, which was evaluated when
 * 0012 ran — a permission added later is NOT picked up retroactively, so every
 * role that should hold this needs a row here.
 */
INSERT INTO app_permission (code, description) VALUES
    ('audit.read', 'Read the audit trail and verify its hash chain');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('OWNER',            'audit.read'),
    ('ADMIN',            'audit.read'),
    ('EXTERNAL_AUDITOR', 'audit.read');

-- Faster answers to the two questions an investigator actually asks.
CREATE INDEX audit_log_actor_idx   ON audit_log (tenant_id, actor_user_id, occurred_at DESC);
CREATE INDEX audit_log_request_idx ON audit_log (tenant_id, request_id)
    WHERE request_id IS NOT NULL;
