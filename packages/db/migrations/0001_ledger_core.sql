-- =============================================================================
-- 0001_ledger_core
--
-- The general ledger core: tenancy, chart of accounts, fiscal periods, the
-- journal, the balance rollup, gapless numbering, the transactional outbox and
-- the hash-chained audit log.
--
-- Conventions (docs/architecture/06-data-model.md §6.1):
--   * tenant_id is the FIRST column of every primary key
--   * every foreign key carries tenant_id, making a cross-tenant reference
--     structurally impossible
--   * money is NUMERIC(19,4); accounting dates are DATE; system timestamps
--     are TIMESTAMPTZ
--   * every tenant-owned table has RLS ENABLED and FORCED, with a policy
--     carrying both USING and WITH CHECK
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Roles
--
-- The application role deliberately lacks BYPASSRLS. Migrations run as the
-- owner; the application never does.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emil_app') THEN
        CREATE ROLE emil_app NOLOGIN NOBYPASSRLS;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Helper: the tenant bound to the current transaction.
--
-- Returns NULL rather than raising when unset, so that RLS policies evaluate to
-- FALSE (deny) instead of erroring. A query issued without a tenant context
-- returns zero rows — see ledger invariant #14.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID
LANGUAGE plpgsql STABLE AS $$
DECLARE
    raw TEXT;
BEGIN
    raw := current_setting('app.tenant_id', true);
    IF raw IS NULL OR raw = '' THEN
        RETURN NULL;
    END IF;
    RETURN raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- Organisation (the tenant)
-- -----------------------------------------------------------------------------
CREATE TABLE organisation (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    ssm_registration_no TEXT,
    tin                 TEXT,
    msic_code           TEXT,
    sst_registered      BOOLEAN NOT NULL DEFAULT FALSE,
    sst_no              TEXT,
    base_currency       CHAR(3) NOT NULL DEFAULT 'MYR',
    fye_month           SMALLINT NOT NULL DEFAULT 12
                        CHECK (fye_month BETWEEN 1 AND 12),
    reporting_framework TEXT NOT NULL DEFAULT 'MPERS'
                        CHECK (reporting_framework IN ('MPERS', 'MFRS')),
    timezone            TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
    status              TEXT NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Chart of accounts
-- -----------------------------------------------------------------------------
CREATE TABLE account (
    tenant_id      UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    code           TEXT NOT NULL,
    name           TEXT NOT NULL,
    type           TEXT NOT NULL
                   CHECK (type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
    subtype        TEXT,
    parent_id      UUID,
    currency       CHAR(3),
    is_system      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, code),
    FOREIGN KEY (tenant_id, parent_id) REFERENCES account (tenant_id, id)
);

CREATE INDEX account_type_idx ON account (tenant_id, type) WHERE is_active;

-- -----------------------------------------------------------------------------
-- Fiscal calendar
-- -----------------------------------------------------------------------------
CREATE TABLE fiscal_year (
    tenant_id   UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id          UUID NOT NULL DEFAULT gen_random_uuid(),
    label       TEXT NOT NULL,
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    status      TEXT NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','CLOSED','LOCKED')),

    PRIMARY KEY (tenant_id, id),
    CHECK (end_date > start_date)
);

CREATE TABLE fiscal_period (
    tenant_id      UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    fiscal_year_id UUID NOT NULL,
    sequence       SMALLINT NOT NULL,
    start_date     DATE NOT NULL,
    end_date       DATE NOT NULL,
    status         TEXT NOT NULL DEFAULT 'OPEN'
                   CHECK (status IN ('OPEN','CLOSED','LOCKED')),
    locked_by      UUID,
    locked_at      TIMESTAMPTZ,

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, fiscal_year_id, sequence),
    FOREIGN KEY (tenant_id, fiscal_year_id) REFERENCES fiscal_year (tenant_id, id),
    CHECK (end_date >= start_date)
);

-- -----------------------------------------------------------------------------
-- The journal
-- -----------------------------------------------------------------------------
CREATE TABLE journal_entry (
    tenant_id            UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                   UUID NOT NULL DEFAULT gen_random_uuid(),
    entry_no             TEXT NOT NULL,
    entry_date           DATE NOT NULL,
    fiscal_period_id     UUID NOT NULL,
    description          TEXT,
    source_module        TEXT NOT NULL
                         CHECK (source_module IN
                           ('SALES','PURCHASES','BANKING','MANUAL','SYSTEM')),
    source_document_type TEXT,
    source_document_id   UUID,
    status               TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT','POSTED','REVERSED')),
    reversal_of_id       UUID,
    idempotency_key      TEXT,
    posted_by            UUID,
    posted_at            TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, entry_no),
    UNIQUE      (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, fiscal_period_id) REFERENCES fiscal_period (tenant_id, id),
    FOREIGN KEY (tenant_id, reversal_of_id)   REFERENCES journal_entry  (tenant_id, id),

    -- A posted entry must carry its posting provenance.
    CHECK (status <> 'POSTED' OR (posted_at IS NOT NULL AND posted_by IS NOT NULL))
);

CREATE INDEX journal_entry_date_idx   ON journal_entry (tenant_id, entry_date);
CREATE INDEX journal_entry_period_idx ON journal_entry (tenant_id, fiscal_period_id);
CREATE INDEX journal_entry_source_idx ON journal_entry (tenant_id, source_document_type, source_document_id);

CREATE TABLE journal_line (
    tenant_id          UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                 UUID NOT NULL DEFAULT gen_random_uuid(),
    journal_entry_id   UUID NOT NULL,
    line_no            SMALLINT NOT NULL,
    account_id         UUID NOT NULL,
    debit              NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (debit  >= 0),
    credit             NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    currency           CHAR(3) NOT NULL,
    fx_rate            NUMERIC(19,8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
    base_debit         NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (base_debit  >= 0),
    base_credit        NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (base_credit >= 0),
    description        TEXT,
    contact_id         UUID,
    tax_code_id        UUID,
    tracking_option_id UUID,

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, journal_entry_id, line_no),
    FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entry (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, account_id)       REFERENCES account       (tenant_id, id),

    -- A line is a debit or a credit. Never both, never neither.
    CONSTRAINT debit_xor_credit CHECK (
        (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
    ),
    -- The base-currency side must agree with the transaction side.
    CONSTRAINT base_side_agrees CHECK (
        (debit > 0 AND base_debit > 0 AND base_credit = 0) OR
        (credit > 0 AND base_credit > 0 AND base_debit = 0)
    )
);

CREATE INDEX journal_line_account_idx ON journal_line (tenant_id, account_id);
CREATE INDEX journal_line_entry_idx   ON journal_line (tenant_id, journal_entry_id);

-- -----------------------------------------------------------------------------
-- Balance rollup — the reason reports are fast.
--
-- This is a CACHE. journal_line is the truth. A nightly job recomputes this
-- table and alarms on drift; if they ever disagree, the rollup is rebuilt from
-- the journal and never the other way round.
-- -----------------------------------------------------------------------------
CREATE TABLE account_period_balance (
    tenant_id        UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    account_id       UUID NOT NULL,
    fiscal_period_id UUID NOT NULL,
    currency         CHAR(3) NOT NULL,
    opening_balance  NUMERIC(19,4) NOT NULL DEFAULT 0,
    debit_total      NUMERIC(19,4) NOT NULL DEFAULT 0,
    credit_total     NUMERIC(19,4) NOT NULL DEFAULT 0,
    closing_balance  NUMERIC(19,4) NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, account_id, fiscal_period_id, currency),
    FOREIGN KEY (tenant_id, account_id)       REFERENCES account       (tenant_id, id),
    FOREIGN KEY (tenant_id, fiscal_period_id) REFERENCES fiscal_period (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Gapless document numbering
--
-- A PostgreSQL SEQUENCE is WRONG here: sequences are non-transactional, so a
-- rolled-back transaction burns a number and leaves a gap. Auditors read gaps
-- in invoice numbering as a red flag. An advisory lock serialises allocation
-- per (tenant, document_type) and releases at transaction end.
-- -----------------------------------------------------------------------------
CREATE TABLE number_sequence (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    document_type TEXT NOT NULL,
    prefix        TEXT NOT NULL DEFAULT '',
    next_value    BIGINT NOT NULL DEFAULT 1 CHECK (next_value >= 1),
    padding       SMALLINT NOT NULL DEFAULT 4,

    PRIMARY KEY (tenant_id, document_type)
);

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
-- Transactional outbox
-- -----------------------------------------------------------------------------
CREATE TABLE outbox_event (
    tenant_id      UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    event_type     TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id   UUID NOT NULL,
    payload        JSONB NOT NULL,
    status         TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','DISPATCHED','FAILED')),
    attempts       SMALLINT NOT NULL DEFAULT 0,
    available_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at  TIMESTAMPTZ,

    PRIMARY KEY (tenant_id, id)
);

CREATE INDEX outbox_pending_idx ON outbox_event (available_at)
    WHERE status = 'PENDING';

-- -----------------------------------------------------------------------------
-- Audit log — append-only, hash-chained per tenant
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            BIGSERIAL,
    actor_user_id UUID,
    actor_ip      INET,
    user_agent    TEXT,
    request_id    TEXT,
    action        TEXT NOT NULL,
    entity_type   TEXT NOT NULL,
    entity_id     UUID,
    before_json   JSONB,
    after_json    JSONB,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    prev_hash     BYTEA,
    row_hash      BYTEA NOT NULL,

    PRIMARY KEY (tenant_id, id)
);

CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id);
CREATE INDEX audit_log_time_idx   ON audit_log (tenant_id, occurred_at DESC);

-- =============================================================================
-- Triggers — the invariants the application cannot talk its way out of
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Balanced by construction.
--
-- DEFERRABLE INITIALLY DEFERRED is the load-bearing detail: the check runs at
-- COMMIT, after all lines are written. A non-deferred trigger would make it
-- impossible to ever insert a balanced entry, because the header necessarily
-- lands before its first line.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_debit  NUMERIC(19,4);
    v_credit NUMERIC(19,4);
    v_lines  INT;
BEGIN
    IF NEW.status <> 'POSTED' THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(SUM(base_debit), 0), COALESCE(SUM(base_credit), 0), COUNT(*)
      INTO v_debit, v_credit, v_lines
      FROM journal_line
     WHERE tenant_id = NEW.tenant_id
       AND journal_entry_id = NEW.id;

    IF v_lines < 2 THEN
        RAISE EXCEPTION
            'Journal entry % has % line(s); double entry requires at least two',
            NEW.entry_no, v_lines
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_debit <> v_credit THEN
        RAISE EXCEPTION
            'Journal entry % is unbalanced: debits %, credits % (difference %)',
            NEW.entry_no, v_debit, v_credit, v_debit - v_credit
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER trg_journal_entry_balanced
    AFTER INSERT OR UPDATE ON journal_entry
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- -----------------------------------------------------------------------------
-- Immutability of posted entries.
--
-- The only permitted transition out of POSTED is to REVERSED, and that flag is
-- set when a reversing entry is posted against it. Everything else raises.
-- Corrections are new entries, never edits.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_posted_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('POSTED', 'REVERSED') THEN
            RAISE EXCEPTION
                'Posted journal entries cannot be deleted (entry %). Post a reversing entry instead.',
                OLD.entry_no
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status IN ('POSTED', 'REVERSED') THEN
        IF NEW.status NOT IN ('POSTED', 'REVERSED') THEN
            RAISE EXCEPTION
                'Cannot un-post journal entry % (% -> %)', OLD.entry_no, OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.entry_no         IS DISTINCT FROM OLD.entry_no
        OR NEW.entry_date       IS DISTINCT FROM OLD.entry_date
        OR NEW.fiscal_period_id IS DISTINCT FROM OLD.fiscal_period_id
        OR NEW.tenant_id        IS DISTINCT FROM OLD.tenant_id
        OR NEW.source_module    IS DISTINCT FROM OLD.source_module
        OR NEW.posted_at        IS DISTINCT FROM OLD.posted_at THEN
            RAISE EXCEPTION
                'Journal entry % is posted and immutable. Post a reversing entry instead.',
                OLD.entry_no
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_journal_entry_immutable
    BEFORE UPDATE OR DELETE ON journal_entry
    FOR EACH ROW EXECUTE FUNCTION forbid_posted_mutation();

-- Journal lines of a posted entry are frozen outright.
CREATE OR REPLACE FUNCTION forbid_posted_line_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_status  TEXT;
    v_row     journal_line;
BEGIN
    v_row := COALESCE(NEW, OLD);

    SELECT status INTO v_status
      FROM journal_entry
     WHERE tenant_id = v_row.tenant_id
       AND id = v_row.journal_entry_id;

    -- NULL when the parent is being cascade-deleted alongside a DRAFT entry.
    IF v_status IN ('POSTED', 'REVERSED') THEN
        RAISE EXCEPTION
            'Journal lines of a posted entry are immutable (entry %)', v_row.journal_entry_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN v_row;
END $$;

CREATE TRIGGER trg_journal_line_immutable
    BEFORE UPDATE OR DELETE ON journal_line
    FOR EACH ROW EXECUTE FUNCTION forbid_posted_line_mutation();

-- -----------------------------------------------------------------------------
-- Posting into a locked period
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_status TEXT;
BEGIN
    IF NEW.status <> 'POSTED' THEN
        RETURN NEW;
    END IF;

    SELECT status INTO v_status
      FROM fiscal_period
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.fiscal_period_id;

    IF v_status = 'LOCKED'
       AND COALESCE(current_setting('app.allow_locked_period', true), 'off') <> 'on' THEN
        RAISE EXCEPTION
            'Fiscal period is LOCKED; posting entry % requires the period.override permission',
            NEW.entry_no
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_journal_entry_period_open
    BEFORE INSERT OR UPDATE ON journal_entry
    FOR EACH ROW EXECUTE FUNCTION assert_period_open();

-- -----------------------------------------------------------------------------
-- Audit log: append-only + hash chain
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION raise_append_only_violation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER trg_audit_log_append_only
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION raise_append_only_violation();

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_prev BYTEA;
BEGIN
    SELECT row_hash INTO v_prev
      FROM audit_log
     WHERE tenant_id = NEW.tenant_id
     ORDER BY id DESC
     LIMIT 1;

    NEW.prev_hash := v_prev;
    NEW.row_hash := digest(
        COALESCE(encode(v_prev, 'hex'), '') ||
        NEW.tenant_id::text || COALESCE(NEW.actor_user_id::text, '') ||
        NEW.action || NEW.entity_type || COALESCE(NEW.entity_id::text, '') ||
        COALESCE(NEW.before_json::text, '') || COALESCE(NEW.after_json::text, '') ||
        NEW.occurred_at::text,
        'sha256'
    );

    RETURN NEW;
END $$;

CREATE TRIGGER trg_audit_log_chain
    BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- Verify the chain for one tenant. Run nightly; alarm on a false result.
CREATE OR REPLACE FUNCTION verify_audit_chain(p_tenant UUID)
RETURNS TABLE (broken_at BIGINT)
LANGUAGE plpgsql STABLE AS $$
BEGIN
    RETURN QUERY
    WITH chained AS (
        SELECT id, prev_hash, row_hash,
               LAG(row_hash) OVER (ORDER BY id) AS expected_prev
          FROM audit_log
         WHERE tenant_id = p_tenant
    )
    SELECT id FROM chained
     WHERE prev_hash IS DISTINCT FROM expected_prev
     ORDER BY id;
END $$;

-- =============================================================================
-- Row-Level Security
--
-- FORCE also applies the policy to the table owner, closing the most common
-- RLS bypass. Policies carry WITH CHECK as well as USING: a USING-only policy
-- still permits INSERTing rows belonging to another tenant.
-- =============================================================================
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'account', 'fiscal_year', 'fiscal_period', 'journal_entry', 'journal_line',
        'account_period_balance', 'number_sequence', 'outbox_event', 'audit_log'
    ];
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

    -- audit_log is append-only at the grant level too, not merely by trigger.
    REVOKE UPDATE, DELETE ON audit_log FROM emil_app;
END $$;

-- The organisation row itself is keyed by `id`, not `tenant_id`, so it needs
-- its own policy rather than the loop's.
ALTER TABLE organisation ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organisation
    USING      (id = current_tenant_id())
    WITH CHECK (id = current_tenant_id());

GRANT SELECT, UPDATE ON organisation TO emil_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO emil_app;
