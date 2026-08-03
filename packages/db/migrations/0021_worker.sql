-- =============================================================================
-- 0021_worker
--
-- The transactional outbox has had eight writers and no reader since 0001.
--
-- `postJournalEntry` writes `outbox_event` in the same transaction as the
-- ledger effect — invoice.issued, payment.received, creditnote.issued,
-- bill.entered, payment.sent, debitnote.issued, bank.entry.created,
-- gateway.settled — and nothing has ever consumed one. Two consequences, and
-- the second is the serious one:
--
--   1. The table grows forever, every row PENDING.
--   2. THE WORK THOSE EVENTS PROMISED HAS NEVER HAPPENED. Most concretely:
--      issuing an invoice does not queue it for MyInvois. `queueSubmission`
--      exists and is correct, and its only caller is a manual API route — so
--      an invoice issued through `POST /v1/invoices` sits outside the e-Invoice
--      queue until somebody remembers to push it there by hand. For a
--      mandated submission regime that is not a missing feature, it is a
--      compliance failure with no symptom.
--
-- This migration gives the outbox a reader.
--
-- -----------------------------------------------------------------------------
-- WHY POSTGRESQL AND NOT BULLMQ, WHICH THE STACK NAMES
--
-- The outbox exists to eliminate a dual write. Its whole premise is that the
-- job and the ledger effect commit or fail TOGETHER, which is only true while
-- the job lives in the same database as the effect. A relay that pushed to
-- Redis from inside the writing transaction would reintroduce exactly the
-- inconsistency the pattern was adopted to prevent, and one that pushed after
-- commit can lose jobs when it dies in between.
--
-- So whatever else queues work, the OUTBOX must be drained by something reading
-- PostgreSQL. `FOR UPDATE SKIP LOCKED` is precisely the primitive for it, has
-- been since 9.5, and gives concurrent workers a correct claim with no
-- coordination.
--
-- Redis and BullMQ are deferred rather than rejected. They earn their place
-- when there is work that genuinely needs a distributed queue — cross-process
-- rate limiting against LHDN, fan-out at a scale one poller cannot serve. A
-- second datastore introduced for one nightly job is operational burden and
-- another thing to be down, and the same reasoning that kept Testcontainers out
-- of the test harness applies: infrastructure nobody can run is infrastructure
-- that does not work.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A PRECONDITION THAT WAS ALREADY LOAD-BEARING AND HAS NEVER BEEN WRITTEN DOWN
--
-- `outbox_event` has RLS ENABLED and FORCED, and FORCE applies to the table
-- OWNER too. A SECURITY DEFINER function is therefore only able to read across
-- tenants because the role that owns it bypasses RLS — which is true when
-- migrations are applied by a superuser, and is how every environment this has
-- ever run in happens to be configured.
--
-- Apply these migrations as an ordinary owner instead and NOTHING RAISES. The
-- definer functions simply return zero rows: the relay claims nothing, the
-- outbox fills up, invoices never reach the e-Invoice queue, and every health
-- check reports an idle queue because from the relay's point of view there is
-- no work. A silent no-op in the component whose entire job is making sure
-- deferred work is not silently dropped.
--
-- `find_payment_link_by_digest` (0014) already depends on exactly this and
-- would fail the same way — a public payment page that resolves no links. So
-- the assumption is asserted here, once, for all of them. Failing the deploy
-- is the correct outcome: the alternative is a system that starts cleanly and
-- does not work.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_bypasses BOOLEAN;
BEGIN
    SELECT rolsuper OR rolbypassrls INTO v_bypasses
      FROM pg_roles WHERE rolname = current_user;

    IF NOT COALESCE(v_bypasses, FALSE) THEN
        RAISE EXCEPTION
            'Migrations must be applied by a role that bypasses row-level security '
            '(SUPERUSER or BYPASSRLS); current_user % does not. The SECURITY DEFINER '
            'functions that read across tenants — the outbox relay, the scheduler, '
            'and find_payment_link_by_digest — would silently return no rows.',
            current_user
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- What the outbox was missing to be drainable
-- -----------------------------------------------------------------------------
ALTER TABLE outbox_event ADD COLUMN last_error TEXT;

/* Why it is where it is, for the dead-letter queue view. `attempts` already
   exists; without the message, a FAILED row says only that something went
   wrong eight times. */

-- The claim query orders by `available_at` across ALL tenants, so the partial
-- index from 0001 is exactly right and is left alone.

-- -----------------------------------------------------------------------------
-- The worker role
--
-- The claim functions below are SECURITY DEFINER and therefore see every
-- tenant's rows — that is what a relay is. Handing that to `emil_app`, the role
-- the internet-facing API connects as, would undo the RLS boundary the whole
-- schema is built on: one SQL-injectable path or one confused handler and the
-- outbox becomes a cross-tenant read.
--
-- So the escape hatch gets its own role. `emil_worker` INHERITS `emil_app` —
-- it still needs ordinary tenant-scoped access to do the work an event asks
-- for, and it is still subject to RLS for that, because `emil_app` is a grant
-- holder and not the table owner. What it has in addition is EXECUTE on these
-- three functions, and nothing else.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emil_worker') THEN
        CREATE ROLE emil_worker NOLOGIN;
    END IF;
END $$;

GRANT emil_app TO emil_worker;

-- -----------------------------------------------------------------------------
-- Claim
--
-- A LEASE, not a delete-on-read. The claim pushes `available_at` forward and
-- increments `attempts` in the same statement, so:
--
--   * a worker that dies mid-dispatch releases the event when the lease
--     expires, rather than stranding it PENDING and invisible forever;
--   * an event that crashes the process on every attempt still counts its
--     attempts and eventually reaches FAILED, instead of poisoning the queue
--     in a loop that no counter ever escapes.
--
-- `SKIP LOCKED` inside the sub-select is what makes N workers safe with no
-- coordination: each skips rows another has locked rather than blocking behind
-- them, which is the difference between scaling out and serialising.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_outbox_batch(
    p_limit         INTEGER,
    p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
    tenant_id      UUID,
    id             UUID,
    event_type     TEXT,
    aggregate_type TEXT,
    aggregate_id   UUID,
    payload        JSONB,
    attempts       SMALLINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION 'Outbox batch size must be between 1 and 1000; got %', p_limit;
    END IF;

    RETURN QUERY
    UPDATE outbox_event o
       SET attempts     = o.attempts + 1,
           available_at = now() + make_interval(secs => p_lease_seconds)
      FROM (
          SELECT c.tenant_id AS t, c.id AS i
            FROM outbox_event c
           WHERE c.status = 'PENDING'
             AND c.available_at <= now()
           ORDER BY c.available_at
           LIMIT p_limit
             FOR UPDATE SKIP LOCKED
      ) claimed
     WHERE o.tenant_id = claimed.t AND o.id = claimed.i
    RETURNING o.tenant_id, o.id, o.event_type, o.aggregate_type,
              o.aggregate_id, o.payload, o.attempts;
END $$;

REVOKE ALL ON FUNCTION claim_outbox_batch(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_outbox_batch(INTEGER, INTEGER) TO emil_worker;

-- -----------------------------------------------------------------------------
-- Settle
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION complete_outbox_event(p_tenant_id UUID, p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_updated INTEGER;
BEGIN
    UPDATE outbox_event
       SET status = 'DISPATCHED', dispatched_at = now(), last_error = NULL
     WHERE tenant_id = p_tenant_id AND id = p_id AND status = 'PENDING';

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated = 1;
END $$;

/*
 * Give up, or back off and try again.
 *
 * The backoff is exponential in the attempt count and computed here rather
 * than passed in, so every caller — worker, test, a future second consumer —
 * gets the same policy and it cannot drift between them.
 */
CREATE OR REPLACE FUNCTION fail_outbox_event(
    p_tenant_id    UUID,
    p_id           UUID,
    p_error        TEXT,
    p_max_attempts INTEGER DEFAULT 8
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_attempts SMALLINT;
    v_delay    INTEGER;
BEGIN
    SELECT attempts INTO v_attempts
      FROM outbox_event
     WHERE tenant_id = p_tenant_id AND id = p_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'UNKNOWN';
    END IF;

    IF v_attempts >= p_max_attempts THEN
        -- Dead-lettered. Never deleted: an event that could not be dispatched
        -- is the evidence for why something downstream never happened, and
        -- `GET /v1/system/queues` is where somebody finds it.
        UPDATE outbox_event
           SET status = 'FAILED', last_error = left(p_error, 2000)
         WHERE tenant_id = p_tenant_id AND id = p_id;
        RETURN 'FAILED';
    END IF;

    -- 2^attempts seconds, capped at an hour. Jittered by up to 10% so a
    -- provider outage that fails a thousand events at once does not produce a
    -- thundering herd retrying in lockstep.
    v_delay := least(power(2, v_attempts)::INTEGER, 3600);

    UPDATE outbox_event
       SET available_at = now() + make_interval(
               secs => v_delay + (v_delay * 0.1 * random())
           ),
           last_error   = left(p_error, 2000)
     WHERE tenant_id = p_tenant_id AND id = p_id;

    RETURN 'RETRY';
END $$;

REVOKE ALL ON FUNCTION complete_outbox_event(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_outbox_event(UUID, UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_outbox_event(UUID, UUID) TO emil_worker;
GRANT EXECUTE ON FUNCTION fail_outbox_event(UUID, UUID, TEXT, INTEGER) TO emil_worker;

-- -----------------------------------------------------------------------------
-- Which organisations exist
--
-- The scheduled jobs ask questions of EVERY tenant: has any rollup drifted,
-- does any tenant have submissions due. They therefore need the list, and
-- `organisation` is RLS-forced like everything else — so a worker with no
-- tenant context set sees NOTHING.
--
-- That failure is silent and total, and it is worth describing because the
-- first version of the worker had it: `SELECT id FROM organisation` returned
-- zero rows, every job reported a clean run over zero tenants, and the
-- rollup-drift canary asserted healthy while looking at nothing at all. A
-- canary that cannot see the mine reports no gas.
--
-- ONE function rather than one per job, deliberately. It returns identifiers
-- and nothing else; the jobs then do their actual work inside `withTenant`,
-- RLS-bound exactly like a request. So the privileged surface is a list of
-- UUIDs, and every row of tenant data a job touches is still filtered by
-- policy. An `outbox_summary_across_tenants()` would have been fewer queries
-- and a wider hole.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION all_tenant_ids()
RETURNS SETOF UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT id FROM organisation ORDER BY created_at
$$;

REVOKE ALL ON FUNCTION all_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION all_tenant_ids() TO emil_worker;

-- -----------------------------------------------------------------------------
-- Scheduled jobs
--
-- GLOBAL, with no tenant_id, and that is the point: these run ACROSS tenants.
-- The nightly rollup-drift canary asks "has any tenant's cache diverged from
-- its journal", and a per-tenant schedule would mean the answer depends on
-- whether that tenant happened to have a row.
--
-- Recorded in the reasoned exemption list in `rls.test.ts`, which additionally
-- asserts an exempt table really has no tenant_id — so this cannot quietly
-- become tenant data later without failing the build.
--
-- The lease column is what makes two workers safe. Without it, both wake at
-- midnight, both see the job due, and the canary runs twice — which for a
-- read-only check is merely wasteful and for anything that posts would be a
-- duplicate journal entry.
-- -----------------------------------------------------------------------------
CREATE TABLE scheduled_job (
    name             TEXT PRIMARY KEY,
    description      TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 10),
    is_enabled       BOOLEAN NOT NULL DEFAULT TRUE,

    next_run_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* Held by the worker currently running it. NULL means nobody. */
    leased_until     TIMESTAMPTZ,

    last_run_at      TIMESTAMPTZ,
    last_status      TEXT CHECK (last_status IN ('OK','ERROR')),
    last_error       TEXT,
    last_duration_ms INTEGER,
    run_count        INTEGER NOT NULL DEFAULT 0,
    failure_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX scheduled_job_due_idx ON scheduled_job (next_run_at) WHERE is_enabled;

GRANT SELECT ON scheduled_job TO emil_app;
GRANT SELECT, UPDATE ON scheduled_job TO emil_worker;

/*
 * Claim due jobs. Same lease discipline as the outbox, same reason.
 *
 * `leased_until` is checked as well as `next_run_at`, so a job whose previous
 * run is still in flight is not started again by a second worker — and a job
 * whose worker died is picked up once the lease expires rather than never.
 */
CREATE OR REPLACE FUNCTION claim_due_jobs(p_lease_seconds INTEGER DEFAULT 900)
RETURNS TABLE (name TEXT, interval_seconds INTEGER, run_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    UPDATE scheduled_job j
       SET leased_until = now() + make_interval(secs => p_lease_seconds)
      FROM (
          SELECT c.name AS n
            FROM scheduled_job c
           WHERE c.is_enabled
             AND c.next_run_at <= now()
             AND (c.leased_until IS NULL OR c.leased_until <= now())
           ORDER BY c.next_run_at
             FOR UPDATE SKIP LOCKED
      ) claimed
     WHERE j.name = claimed.n
    RETURNING j.name, j.interval_seconds, j.run_count;
END $$;

CREATE OR REPLACE FUNCTION finish_job(
    p_name        TEXT,
    p_ok          BOOLEAN,
    p_error       TEXT,
    p_duration_ms INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE scheduled_job
       SET leased_until     = NULL,
           -- From NOW rather than from the previous due time. A job that ran
           -- late should not immediately be due again, and a worker restarted
           -- after a long outage should not fire a backlog of the same job.
           next_run_at      = now() + make_interval(secs => interval_seconds),
           last_run_at      = now(),
           last_status      = CASE WHEN p_ok THEN 'OK' ELSE 'ERROR' END,
           last_error       = CASE WHEN p_ok THEN NULL ELSE left(p_error, 2000) END,
           last_duration_ms = p_duration_ms,
           run_count        = run_count + 1,
           failure_count    = failure_count + CASE WHEN p_ok THEN 0 ELSE 1 END
     WHERE name = p_name;
END $$;

REVOKE ALL ON FUNCTION claim_due_jobs(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION finish_job(TEXT, BOOLEAN, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_due_jobs(INTEGER) TO emil_worker;
GRANT EXECUTE ON FUNCTION finish_job(TEXT, BOOLEAN, TEXT, INTEGER) TO emil_worker;

-- -----------------------------------------------------------------------------
-- The jobs themselves
--
-- Seeded as rows rather than compiled in, so an operator can disable one
-- without a deploy — the thing you want at 03:00 when a job is misbehaving.
-- A handler that no row names simply never runs, and a row that names no
-- handler is reported as unroutable rather than silently skipped.
-- -----------------------------------------------------------------------------
INSERT INTO scheduled_job (name, description, interval_seconds) VALUES
    ('rollup-drift',
     'Recompute account_period_balance from journal_line and alarm on drift. '
     || 'packages/db/src/ledger.ts has described this as a nightly job since M1 '
     || 'and nothing has ever run it.',
     86400),
    ('einvoice-retry',
     'Advance e-Invoice submissions whose next attempt is due. Refuses to '
     || 'invent progress when no MyInvois adapter is registered.',
     300),
    ('outbox-sweep',
     'Report outbox events that have dead-lettered, so a compliance gap has a '
     || 'symptom instead of being invisible.',
     3600);

-- -----------------------------------------------------------------------------
-- Reading queue health is an operational question, not an accounting one
-- -----------------------------------------------------------------------------
INSERT INTO app_permission (code, description) VALUES
    ('system.read', 'View background queue and scheduled job health');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('OWNER', 'system.read'),
    ('ADMIN', 'system.read');
