-- =============================================================================
-- 0032_weekly_digest
--
-- The weekly digest: "anything off?" computed once per completed week.
--
-- -----------------------------------------------------------------------------
-- A DIGEST IS A STATEMENT MADE ON A DATE, SO IT IS STORED, NOT RECOMPUTED.
--
-- The report the owner reads on Monday must still read the same in November —
-- including its comparisons, which shift as history accumulates. So the worker
-- computes each completed week ONCE and stores the result; the API serves the
-- stored row. Recomputing on read would quietly rewrite last month's flags
-- every time the trailing average moved.
--
-- The job runs daily rather than weekly because the scheduler speaks
-- intervals, not calendars: each run asks "is the last completed week
-- stored?" and the UNIQUE constraint makes the answer idempotent. A worker
-- down over the weekend catches up on Tuesday with no special case.
--
-- Delivery is the settlement register's §4.4 story: stored now, shown in the
-- app; emailed when an email transport exists. Same rows either way.
-- -----------------------------------------------------------------------------

CREATE TABLE weekly_digest (
    tenant_id  UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id         UUID NOT NULL DEFAULT gen_random_uuid(),
    week_start DATE NOT NULL,
    week_end   DATE NOT NULL,
    /* The full WeeklyDigest as computed — figures as decimal strings, flags
       with their message text. The document IS the deliverable. */
    payload    JSONB NOT NULL,
    /* Denormalised so "which weeks had warnings" is an index scan, not a
       JSONB unpack. */
    warn_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),

    /* One digest per week, forever — this is what makes the daily job
       idempotent and the report immutable. */
    UNIQUE (tenant_id, week_start),

    CONSTRAINT weekly_digest_span CHECK (week_end = week_start + 6)
);

CREATE INDEX weekly_digest_recent_idx ON weekly_digest (tenant_id, week_start DESC);

-- -----------------------------------------------------------------------------
-- The daily job (self-skipping until a week completes)
-- -----------------------------------------------------------------------------
INSERT INTO scheduled_job (name, description, interval_seconds) VALUES
    ('weekly-digest',
     'Compile the last completed Mon-Sun week — takings, sales, gross profit, '
     || 'expenses — compare against the trailing month and store the digest '
     || 'with anomaly flags. Idempotent per week.',
     86400);

-- -----------------------------------------------------------------------------
-- RLS + audit (rule 3, 0016)
-- -----------------------------------------------------------------------------
ALTER TABLE weekly_digest ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_digest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON weekly_digest
    USING      (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON weekly_digest TO emil_app;
CREATE TRIGGER trg_audit_weekly_digest
    AFTER INSERT OR UPDATE OR DELETE ON weekly_digest
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('tenant_id');
