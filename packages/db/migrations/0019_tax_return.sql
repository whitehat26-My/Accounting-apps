-- =============================================================================
-- 0019_tax_return
--
-- M5's deliverable: the SST return.
--
-- -----------------------------------------------------------------------------
-- THE TAX ENGINE EXISTED TO PRODUCE THIS AND NEVER DID.
--
-- `computeTax()` has decided the tax on every line since M5, and invoices,
-- bills, credit notes and debit notes have all written `tax_transaction` rows.
-- Nothing aggregated them into the thing a registered business must actually
-- file. There was no `tax_return` table, no service, no route — the engine's
-- entire purpose was a return nobody could produce.
-- -----------------------------------------------------------------------------
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Registration
--
-- Sales tax and service tax are SEPARATE REGIMES with separate registration and
-- separate returns. A business may be registered for one, the other, or both,
-- so this is keyed per regime rather than being a flag on `organisation`.
--
-- ⚠️ `cadence_months` and `first_period_start` decide which periods must be
-- filed, and both are assigned by RMCD rather than chosen. They therefore carry
-- provenance on the same terms as a withholding rate: the row records where the
-- cycle was confirmed, and cannot be stored without it. Getting the cadence
-- wrong does not produce a wrong figure — it produces a return filed for the
-- wrong period, or a period never filed at all, and a gap in a filing history
-- is what draws an assessment.
-- -----------------------------------------------------------------------------
CREATE TABLE sst_registration (
    tenant_id          UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                 UUID NOT NULL DEFAULT gen_random_uuid(),
    regime             TEXT NOT NULL CHECK (regime IN ('SST_SALES', 'SST_SERVICE')),
    registration_no    TEXT NOT NULL,
    /* Whole months. Commonly described as two for Malaysian SST, and assigned
       per registration — which is why it is stored rather than assumed. */
    cadence_months     SMALLINT NOT NULL CHECK (cadence_months BETWEEN 1 AND 12),
    first_period_start DATE NOT NULL,
    source_reference   TEXT NOT NULL,
    verified_by        UUID,
    verified_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, regime),
    CONSTRAINT sst_registration_source_meaningful
        CHECK (length(btrim(source_reference)) BETWEEN 8 AND 300)
);

COMMENT ON COLUMN sst_registration.source_reference IS
    'Where the taxable period cycle was confirmed — e.g. "RMCD registration letter '
    'dated 2026-01-15, ref SST-W10-2026-0042". Required: a cadence nobody can trace '
    'produces returns filed for the wrong periods.';

-- -----------------------------------------------------------------------------
-- The return
--
-- -----------------------------------------------------------------------------
-- THE MOST IMPORTANT LINE IN THIS FILE IS THE `net_tax_payable` CHECK.
--
-- SST is not a VAT. A registered business does NOT offset tax paid on purchases
-- against tax charged: input tax is a cost, absorbed into the expense, and the
-- full output tax is remitted.
--
-- Somebody will eventually try to deduct it, because every GST and VAT system
-- in the world works the other way and the instinct is very strong. The result
-- would under-declare by exactly the input tax — a figure that looks entirely
-- plausible on the form and reconciles against a P&L built the same wrong way,
-- while being a shortfall the business is liable for.
--
-- So the arithmetic is a database CHECK rather than only a rule in
-- `packages/domain/src/tax-return.ts`. `input_tax_absorbed` is stored for
-- checking against the accounts and appears in no constraint that could let it
-- reach the amount payable.
-- -----------------------------------------------------------------------------
CREATE TABLE tax_return (
    tenant_id              UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                     UUID NOT NULL DEFAULT gen_random_uuid(),
    regime                 TEXT NOT NULL CHECK (regime IN ('SST_SALES', 'SST_SERVICE')),
    period_start           DATE NOT NULL,
    period_end             DATE NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'DRAFT'
                           CHECK (status IN ('DRAFT', 'SUBMITTED', 'SUPERSEDED')),
    currency               CHAR(3) NOT NULL DEFAULT 'MYR',

    taxable_supplies       NUMERIC(19,4) NOT NULL,
    output_tax_charged     NUMERIC(19,4) NOT NULL CHECK (output_tax_charged >= 0),
    output_tax_adjustments NUMERIC(19,4) NOT NULL CHECK (output_tax_adjustments >= 0),
    net_tax_payable        NUMERIC(19,4) NOT NULL,
    /* Reported, never deducted. Deliberately absent from every constraint that
       touches net_tax_payable. */
    input_tax_absorbed     NUMERIC(19,4) NOT NULL DEFAULT 0,
    exempt_supplies        NUMERIC(19,4) NOT NULL DEFAULT 0,
    document_count         INTEGER NOT NULL DEFAULT 0,

    /* An amendment does not edit the original; it supersedes it. */
    supersedes_id          UUID,
    submitted_at           TIMESTAMPTZ,
    submitted_by           UUID,
    idempotency_key        TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, supersedes_id) REFERENCES tax_return (tenant_id, id),

    CHECK (period_end >= period_start),
    -- SST is not a VAT. See above.
    CHECK (net_tax_payable = output_tax_charged - output_tax_adjustments),
    CHECK (status <> 'SUBMITTED' OR (submitted_at IS NOT NULL AND submitted_by IS NOT NULL))
);

/*
 * One live return per regime per period.
 *
 * Partial, because a superseded return must stay: it is what was filed, and an
 * amendment is only explicable next to the thing it amends.
 */
CREATE UNIQUE INDEX tax_return_live_period_idx
    ON tax_return (tenant_id, regime, period_start, period_end)
 WHERE status <> 'SUPERSEDED';

CREATE INDEX tax_return_period_idx ON tax_return (tenant_id, regime, period_start DESC);

-- -----------------------------------------------------------------------------
-- A submitted return is not edited
--
-- The same discipline as the ledger, for the same reason: it is a statement
-- made to a tax authority on a date, and what was said then does not change
-- because the underlying data moved afterwards. Correcting it means filing an
-- amendment that supersedes it, and both remain.
--
-- The one permitted transition is SUBMITTED → SUPERSEDED, which is what an
-- amendment does to its predecessor.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_submitted_return_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status <> 'SUBMITTED' THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Tax return % has been submitted and cannot be deleted', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.status = 'SUPERSEDED'
       AND (NEW.tenant_id, NEW.regime, NEW.period_start, NEW.period_end,
            NEW.net_tax_payable, NEW.output_tax_charged, NEW.submitted_at)
           IS NOT DISTINCT FROM
           (OLD.tenant_id, OLD.regime, OLD.period_start, OLD.period_end,
            OLD.net_tax_payable, OLD.output_tax_charged, OLD.submitted_at)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'Tax return % has been submitted; file an amendment rather than editing it', OLD.id
        USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER trg_tax_return_submitted_immutable
    BEFORE UPDATE OR DELETE ON tax_return
    FOR EACH ROW EXECUTE FUNCTION forbid_submitted_return_mutation();

-- -----------------------------------------------------------------------------
-- Filing is an event an auditor asks about by name
-- -----------------------------------------------------------------------------
ALTER TABLE financial_event_log DROP CONSTRAINT financial_event_log_event_type_check;
ALTER TABLE financial_event_log
    ADD CONSTRAINT financial_event_log_event_type_check
        CHECK (event_type IN (
            'LOCKED_PERIOD_OVERRIDE',
            'PERIOD_LOCKED',
            'PERIOD_UNLOCKED',
            'BANK_DETAILS_CHANGED',
            'ROLE_CHANGED',
            'API_KEY_ISSUED',
            'API_KEY_REVOKED',
            'RECONCILIATION_COMPLETED',
            'YEAR_END_CLOSED',
            'GATEWAY_CONFIG_CHANGED',
            'GATEWAY_SETTLEMENT_POSTED',
            'BILL_APPROVED',
            'BILL_REJECTED',
            'CHART_OF_ACCOUNTS_CHANGED',
            'STATUTORY_RATE_CHANGED',
            'TAX_RETURN_SUBMITTED',
            'TAX_RETURN_AMENDED'));

-- =============================================================================
-- RLS
-- =============================================================================
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['sst_registration', 'tax_return'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                 USING      (tenant_id = current_tenant_id())
                 WITH CHECK (tenant_id = current_tenant_id())', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO emil_app', t);

        -- Audited like every other tenant table. Migration 0016 installs these
        -- by sweep, but that sweep already ran; a table created later must ask.
        EXECUTE format(
            'CREATE TRIGGER trg_audit_%1$s
                 AFTER INSERT OR UPDATE OR DELETE ON %1$I
                 FOR EACH ROW EXECUTE FUNCTION audit_row_change(%2$L)', t, 'tenant_id');
    END LOOP;

    -- A filed return is evidence. Deleting one is not an operation.
    REVOKE DELETE ON tax_return FROM emil_app;
END $$;
