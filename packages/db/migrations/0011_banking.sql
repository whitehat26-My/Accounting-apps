-- =============================================================================
-- 0011_banking
--
-- M4: bank accounts, statement import, and reconciliation.
--
-- This is the module that closes ledger invariant #8 — bank GL balance =
-- opening + reconciled transactions — the last invariant in
-- docs/architecture/06-data-model.md §6.9 with no test behind it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Bank accounts
--
-- Each maps to exactly one GL account. That mapping is the join between bank
-- reality and the ledger, and it is UNIQUE in both directions: two bank
-- accounts posting to one GL account would make invariant #8 unprovable, since
-- neither account's transactions could be separated from the other's in the
-- control balance.
-- -----------------------------------------------------------------------------
CREATE TABLE bank_account (
    tenant_id         UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL,
    bank_name         TEXT NOT NULL,
    /* Masked at rest. The full number is never needed to reconcile, and
       storing it turns a statement import into a payment-credential store. */
    account_no_masked TEXT,
    swift             TEXT,
    currency          CHAR(3) NOT NULL DEFAULT 'MYR',
    gl_account_id     UUID NOT NULL,
    account_type      TEXT NOT NULL DEFAULT 'BANK'
                      CHECK (account_type IN ('BANK','CASH','CREDIT_CARD','EWALLET')),
    /* The balance the account held before any imported statement. Set once at
       setup; invariant #8 is measured from it. */
    opening_balance   NUMERIC(19,4) NOT NULL DEFAULT 0,
    opening_date      DATE,
    feed_provider     TEXT,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, gl_account_id),
    FOREIGN KEY (tenant_id, gl_account_id) REFERENCES account (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Import profiles — saved per bank, never sniffed.
--
-- Guessing a CSV's dialect is right most of the time, and silent when wrong: a
-- description column read as an amount imports a plausible statement with
-- wrong numbers, and the user finds out at year end. An explicit profile plus
-- a preview makes a wrong guess fail in front of the person who can fix it.
-- -----------------------------------------------------------------------------
CREATE TABLE import_profile (
    tenant_id         UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL,
    bank_name         TEXT NOT NULL,
    delimiter         TEXT NOT NULL DEFAULT ',',
    skip_rows         SMALLINT NOT NULL DEFAULT 0 CHECK (skip_rows >= 0),
    has_header        BOOLEAN NOT NULL DEFAULT TRUE,
    date_format       TEXT NOT NULL DEFAULT 'DD/MM/YYYY'
                      CHECK (date_format IN ('DD/MM/YYYY','DD-MM-YYYY','YYYY-MM-DD')),
    amount_convention TEXT NOT NULL
                      CHECK (amount_convention IN ('SIGNED','DEBIT_CREDIT')),
    /* Zero-based column indexes: txnDate, description, amount|debit|credit, ... */
    column_map        JSONB NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, name)
);

-- -----------------------------------------------------------------------------
-- Statements and their lines
-- -----------------------------------------------------------------------------
CREATE TABLE bank_statement (
    tenant_id        UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id               UUID NOT NULL DEFAULT gen_random_uuid(),
    bank_account_id  UUID NOT NULL,
    statement_date   DATE NOT NULL,
    period_start     DATE,
    period_end       DATE,
    opening_balance  NUMERIC(19,4),
    closing_balance  NUMERIC(19,4),
    source           TEXT NOT NULL DEFAULT 'CSV'
                     CHECK (source IN ('CSV','MT940','OFX','FEED','MANUAL')),
    import_profile_id UUID,
    file_name        TEXT,
    line_count       INTEGER NOT NULL DEFAULT 0,
    /* Rows skipped because they were already present. Surfaced to the user:
       "imported 40 lines, skipped 12 duplicates" is the message that makes a
       re-import feel safe rather than mysterious. */
    duplicate_count  INTEGER NOT NULL DEFAULT 0,
    idempotency_key  TEXT,
    imported_by      UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, bank_account_id)   REFERENCES bank_account   (tenant_id, id),
    FOREIGN KEY (tenant_id, import_profile_id) REFERENCES import_profile (tenant_id, id),
    CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);

CREATE TABLE bank_transaction (
    tenant_id       UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    bank_account_id UUID NOT NULL,
    statement_id    UUID,
    txn_date        DATE NOT NULL,
    value_date      DATE,
    description     TEXT NOT NULL,
    reference       TEXT,
    /* SIGNED: positive money in, negative money out. One signed column rather
       than a debit/credit pair, because a bank line is a single fact and
       splitting it invites a row with both populated. */
    amount          NUMERIC(19,4) NOT NULL CHECK (amount <> 0),
    running_balance NUMERIC(19,4),
    dedupe_hash     TEXT NOT NULL,
    /* Which occurrence of an otherwise identical row this is. See
       packages/domain/src/statement-import.ts for why: two RM 50 ATM
       withdrawals on the same day with the same narrative are two real
       events, and a hash alone silently drops the second. */
    occurrence      SMALLINT NOT NULL DEFAULT 1 CHECK (occurrence >= 1),
    status          TEXT NOT NULL DEFAULT 'UNRECONCILED'
                    CHECK (status IN ('UNRECONCILED','MATCHED','RECONCILED','EXCLUDED')),
    excluded_reason TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    /* The de-duplication guarantee, enforced by the DATABASE rather than by
       the import service checking first. A concurrent double-submit of the
       same file cannot slip between a check and an insert. */
    UNIQUE      (tenant_id, bank_account_id, dedupe_hash, occurrence),
    FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account   (tenant_id, id),
    FOREIGN KEY (tenant_id, statement_id)    REFERENCES bank_statement (tenant_id, id)
);

CREATE INDEX bank_transaction_account_date_idx
    ON bank_transaction (tenant_id, bank_account_id, txn_date);
CREATE INDEX bank_transaction_open_idx
    ON bank_transaction (tenant_id, bank_account_id, txn_date)
    WHERE status = 'UNRECONCILED';

-- -----------------------------------------------------------------------------
-- Matches — APPEND-ONLY, including the undo.
--
-- From docs/architecture/02-core-modules.md §M4: "A match never rewrites
-- history. Accepting a match creates a ReconciliationMatch row and flips a
-- status; it does not edit the posted journal entry. Unmatching creates a new
-- row with the reversal, so the audit trail shows both decisions."
--
-- So unmatching INSERTS a row pointing at the one it reverses, exactly as a
-- ledger correction is a reversing entry rather than a delete. The effective
-- set of matches is those not referenced by a reversal — see the
-- `active_reconciliation_match` view below, which is the only thing anything
-- should read.
-- -----------------------------------------------------------------------------
CREATE TABLE reconciliation_match (
    tenant_id           UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                  UUID NOT NULL DEFAULT gen_random_uuid(),
    bank_transaction_id UUID NOT NULL,
    matched_type        TEXT NOT NULL
                        CHECK (matched_type IN ('PAYMENT','INVOICE','BILL','JOURNAL','TRANSFER')),
    /* Deliberately NOT a foreign key: the target is one of five tables, and an
       exclusive arc with five arms would be five nullable columns and a
       five-way CHECK for a row that is evidence of a user decision rather
       than a financial position. The ledger effect lives in journal_entry_id,
       which IS a real foreign key. */
    matched_id          UUID NOT NULL,
    /* The entry this match relies on, when there is one. */
    journal_entry_id    UUID,
    amount              NUMERIC(19,4) NOT NULL,
    confidence_score    SMALLINT CHECK (confidence_score BETWEEN 0 AND 100),
    match_method        TEXT NOT NULL DEFAULT 'MANUAL'
                        CHECK (match_method IN ('AUTO','RULE','MANUAL')),
    /* Why this was suggested, captured at the moment of the decision. Kept
       because a reason recomputed later reflects today's rules, not the ones
       the user actually saw. */
    reason              TEXT,
    /* Set on a reversal row; NULL on an original. */
    reverses_match_id   UUID,
    unmatch_reason      TEXT,
    matched_by          UUID,
    matched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, bank_transaction_id) REFERENCES bank_transaction (tenant_id, id),
    FOREIGN KEY (tenant_id, journal_entry_id)    REFERENCES journal_entry    (tenant_id, id),
    FOREIGN KEY (tenant_id, reverses_match_id)   REFERENCES reconciliation_match (tenant_id, id)
);

/* One reversal per match: an undo cannot be applied twice. */
CREATE UNIQUE INDEX reconciliation_match_one_reversal
    ON reconciliation_match (tenant_id, reverses_match_id)
    WHERE reverses_match_id IS NOT NULL;

CREATE INDEX reconciliation_match_txn_idx
    ON reconciliation_match (tenant_id, bank_transaction_id);
CREATE INDEX reconciliation_match_target_idx
    ON reconciliation_match (tenant_id, matched_type, matched_id);

CREATE TRIGGER trg_reconciliation_match_append_only
    BEFORE UPDATE OR DELETE ON reconciliation_match
    FOR EACH ROW EXECUTE FUNCTION raise_append_only_violation();

/*
 * The matches that currently stand.
 *
 * Everything that asks "what is this bank line matched to" reads this, never
 * the base table — which holds decisions, including undone ones.
 */
CREATE VIEW active_reconciliation_match
    /*
     * SECURITY INVOKER IS LOAD-BEARING, NOT DECORATION.
     *
     * A PostgreSQL view executes with the privileges of its OWNER by default,
     * which here is the schema owner — a role that is not subject to the
     * tenant policies. Without this setting the view would happily return
     * every tenant's matches to any caller, and the RLS test would not catch
     * it, because that test walks TABLES.
     *
     * `security_invoker = true` makes the view evaluate under the querying
     * role, so the base table's policy applies exactly as it does to a direct
     * SELECT. Asserted directly in packages/db/test/rls.test.ts.
     */
    WITH (security_invoker = true)
    AS
    SELECT m.*
      FROM reconciliation_match m
     WHERE m.reverses_match_id IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM reconciliation_match r
              WHERE r.tenant_id = m.tenant_id
                AND r.reverses_match_id = m.id
           );

-- -----------------------------------------------------------------------------
-- Bank rules
-- -----------------------------------------------------------------------------
CREATE TABLE bank_rule (
    tenant_id         UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL,
    bank_account_id   UUID,
    priority          INTEGER NOT NULL DEFAULT 100,
    contains          TEXT,
    matches_direction TEXT CHECK (matches_direction IN ('INFLOW','OUTFLOW')),
    min_amount        NUMERIC(19,4) CHECK (min_amount >= 0),
    max_amount        NUMERIC(19,4) CHECK (max_amount >= 0),
    account_id        UUID NOT NULL,
    tax_code_id       UUID,
    contact_id        UUID,
    /* OFF by default, and per rule. A rule that silently posts to the wrong
       account is a rule nobody notices for months. */
    auto_apply        BOOLEAN NOT NULL DEFAULT FALSE,
    hit_count         INTEGER NOT NULL DEFAULT 0,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, name),
    FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account (tenant_id, id),
    FOREIGN KEY (tenant_id, account_id)      REFERENCES account      (tenant_id, id),
    FOREIGN KEY (tenant_id, tax_code_id)     REFERENCES tax_code     (tenant_id, id),
    FOREIGN KEY (tenant_id, contact_id)      REFERENCES contact      (tenant_id, id),
    CHECK (max_amount IS NULL OR min_amount IS NULL OR max_amount >= min_amount)
);

CREATE INDEX bank_rule_priority_idx
    ON bank_rule (tenant_id, priority) WHERE is_active;

-- -----------------------------------------------------------------------------
-- Reconciliation sessions — the evidence a period was reconciled.
-- -----------------------------------------------------------------------------
CREATE TABLE reconciliation_session (
    tenant_id                 UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                        UUID NOT NULL DEFAULT gen_random_uuid(),
    bank_account_id           UUID NOT NULL,
    period_start              DATE NOT NULL,
    period_end                DATE NOT NULL,
    statement_closing_balance NUMERIC(19,4) NOT NULL,
    book_closing_balance      NUMERIC(19,4) NOT NULL,
    /* Adjusted for outstanding items on both sides. Zero to complete. */
    variance                  NUMERIC(19,4) NOT NULL,
    unpresented_total         NUMERIC(19,4) NOT NULL DEFAULT 0,
    unrecorded_total          NUMERIC(19,4) NOT NULL DEFAULT 0,
    status                    TEXT NOT NULL DEFAULT 'IN_PROGRESS'
                              CHECK (status IN ('IN_PROGRESS','COMPLETED','ABANDONED')),
    completed_by              UUID,
    completed_at              TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, bank_account_id, period_end),
    FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account (tenant_id, id),
    CHECK (period_end >= period_start),
    /* A session cannot be completed while it does not reconcile. This is the
       point of the whole module: "reconciled with a RM 12 difference" is not
       reconciled, and a system that lets someone sign it off will accumulate
       those differences until the account is meaningless. */
    CONSTRAINT reconciliation_session_completed_balances
        CHECK (status <> 'COMPLETED' OR variance = 0)
);

/*
 * A completed reconciliation is evidence about a period, so it is frozen once
 * signed off — the same rule an issued invoice and a posted entry follow.
 */
CREATE OR REPLACE FUNCTION forbid_completed_reconciliation_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'COMPLETED' THEN
            RAISE EXCEPTION
                'Reconciliation for the period ending % is completed and cannot be deleted.',
                OLD.period_end
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status = 'COMPLETED' THEN
        RAISE EXCEPTION
            'Reconciliation for the period ending % is completed and is now immutable.',
            OLD.period_end
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_reconciliation_session_immutable_when_complete
    BEFORE UPDATE OR DELETE ON reconciliation_session
    FOR EACH ROW EXECUTE FUNCTION forbid_completed_reconciliation_mutation();

-- =============================================================================
-- Triggers
-- =============================================================================

/*
 * An imported bank line is a record of what the BANK said. Its facts are not
 * ours to edit — only its reconciliation status is.
 *
 * Without this, a user who cannot get an account to reconcile can "fix" the
 * statement instead of finding the error, and the reconciliation then proves
 * nothing at all.
 */
CREATE OR REPLACE FUNCTION forbid_bank_transaction_rewrite() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('MATCHED','RECONCILED') THEN
            RAISE EXCEPTION
                'Bank transaction % is matched and cannot be deleted. Unmatch it first.',
                OLD.id
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF NEW.txn_date        IS DISTINCT FROM OLD.txn_date
    OR NEW.amount          IS DISTINCT FROM OLD.amount
    OR NEW.description     IS DISTINCT FROM OLD.description
    OR NEW.running_balance IS DISTINCT FROM OLD.running_balance
    OR NEW.dedupe_hash     IS DISTINCT FROM OLD.dedupe_hash
    OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id THEN
        RAISE EXCEPTION
            'Bank transaction % records what the bank reported and cannot be edited. '
            'Only its reconciliation status may change.', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_bank_transaction_immutable
    BEFORE UPDATE OR DELETE ON bank_transaction
    FOR EACH ROW EXECUTE FUNCTION forbid_bank_transaction_rewrite();

/*
 * A match cannot claim more than the bank line it settles.
 *
 * Constraint trigger rather than a CHECK, for the same reason the invoice
 * over-allocation guard is one: it has to see the other matches on the same
 * line, and it has to be evaluated after all of a statement's matches are in
 * so a legitimate split across several documents is not rejected mid-way.
 */
CREATE OR REPLACE FUNCTION assert_bank_line_not_over_matched() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_matched NUMERIC(19,4);
    v_amount  NUMERIC(19,4);
BEGIN
    SELECT COALESCE(SUM(m.amount), 0) INTO v_matched
      FROM active_reconciliation_match m
     WHERE m.tenant_id = NEW.tenant_id
       AND m.bank_transaction_id = NEW.bank_transaction_id;

    SELECT amount INTO v_amount
      FROM bank_transaction
     WHERE tenant_id = NEW.tenant_id AND id = NEW.bank_transaction_id
       FOR UPDATE;

    /* Compared on magnitude: an outflow is negative on both sides, and
       comparing signed values would let an outflow be over-matched without
       tripping anything. */
    IF ABS(v_matched) > ABS(v_amount) THEN
        RAISE EXCEPTION
            'Bank line % would be over-matched: % allocated against a line of %',
            NEW.bank_transaction_id, v_matched, v_amount
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER trg_bank_line_not_over_matched
    AFTER INSERT ON reconciliation_match
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_bank_line_not_over_matched();

-- =============================================================================
-- RLS
-- =============================================================================
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'bank_account', 'import_profile', 'bank_statement', 'bank_transaction',
        'reconciliation_match', 'bank_rule', 'reconciliation_session'
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

    REVOKE UPDATE, DELETE ON reconciliation_match FROM emil_app;
END $$;

/* The view inherits the base table's RLS; the grant is still needed. */
GRANT SELECT ON active_reconciliation_match TO emil_app;

-- Bank and cash present together on the SOFP; the tag already exists.
