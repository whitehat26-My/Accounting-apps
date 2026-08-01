-- =============================================================================
-- 0007_revaluation
--
-- Unrealised foreign exchange revaluation at reporting date.
--
-- See packages/domain/src/revaluation.ts for the two design decisions this
-- schema follows: the revaluation REVERSES on the following day, and it posts
-- to a dedicated account rather than to the AR control account. The second one
-- is why ledger invariant #6 continues to hold across a reporting date.
-- =============================================================================

-- Two new structural roles.
ALTER TABLE posting_account_map DROP CONSTRAINT posting_account_map_role_check;
ALTER TABLE posting_account_map
    ADD CONSTRAINT posting_account_map_role_check
        CHECK (role IN ('AR','AP','SST_PAYABLE','SST_CLAIMABLE',
                        'ROUNDING','FX_GAIN_LOSS','RETAINED_EARNINGS',
                        'UNDEPOSITED_FUNDS','SUSPENSE',
                        -- Carries the closing-rate adjustment to receivables.
                        -- Presented on the same SOFP line as AR.
                        'AR_REVALUATION',
                        -- P&L account for the unrealised gain or loss.
                        'UNREALISED_FX'));

-- -----------------------------------------------------------------------------
-- One run per period. The header records what was posted; the lines record how
-- it was arrived at, per currency, which is what an auditor asks for.
-- -----------------------------------------------------------------------------
CREATE TABLE revaluation_run (
    tenant_id         UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    fiscal_period_id  UUID NOT NULL,
    as_of_date        DATE NOT NULL,
    base_currency     CHAR(3) NOT NULL,
    total_difference  NUMERIC(19,4) NOT NULL,
    /* NULL when no rate moved — there was nothing to post. */
    journal_entry_id  UUID,
    reversal_entry_id UUID,
    status            TEXT NOT NULL DEFAULT 'POSTED'
                      CHECK (status IN ('POSTED','NO_ADJUSTMENT')),
    idempotency_key   TEXT,
    run_by            UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    /* One revaluation per period. Re-running returns the existing result. */
    UNIQUE      (tenant_id, fiscal_period_id),
    UNIQUE      (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, fiscal_period_id)  REFERENCES fiscal_period (tenant_id, id),
    FOREIGN KEY (tenant_id, journal_entry_id)  REFERENCES journal_entry (tenant_id, id),
    FOREIGN KEY (tenant_id, reversal_entry_id) REFERENCES journal_entry (tenant_id, id),
    /* A posted run has both an entry and its reversal, or neither. */
    CHECK ((journal_entry_id IS NULL) = (reversal_entry_id IS NULL)),
    CHECK (status <> 'NO_ADJUSTMENT' OR journal_entry_id IS NULL)
);

CREATE TABLE revaluation_line (
    tenant_id      UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    run_id         UUID NOT NULL,
    currency       CHAR(3) NOT NULL,
    item_count     INTEGER NOT NULL,
    outstanding    NUMERIC(19,4) NOT NULL,
    carrying_base  NUMERIC(19,4) NOT NULL,
    closing_rate   NUMERIC(19,8) NOT NULL CHECK (closing_rate > 0),
    closing_base   NUMERIC(19,4) NOT NULL,
    difference     NUMERIC(19,4) NOT NULL,

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, run_id, currency),
    FOREIGN KEY (tenant_id, run_id) REFERENCES revaluation_run (tenant_id, id) ON DELETE CASCADE
);

-- A completed run is evidence of what the accounts said at a reporting date.
CREATE TRIGGER trg_revaluation_run_append_only
    BEFORE UPDATE OR DELETE ON revaluation_run
    FOR EACH ROW EXECUTE FUNCTION raise_append_only_violation();

CREATE TRIGGER trg_revaluation_line_append_only
    BEFORE UPDATE OR DELETE ON revaluation_line
    FOR EACH ROW EXECUTE FUNCTION raise_append_only_violation();

-- =============================================================================
-- RLS
-- =============================================================================
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY['revaluation_run', 'revaluation_line'];
BEGIN
    FOREACH t IN ARRAY tenant_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                 USING      (tenant_id = current_tenant_id())
                 WITH CHECK (tenant_id = current_tenant_id())', t);
        EXECUTE format('GRANT SELECT, INSERT ON %I TO emil_app', t);
    END LOOP;
END $$;
