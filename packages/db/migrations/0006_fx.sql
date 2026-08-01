-- =============================================================================
-- 0006_fx
--
-- Foreign exchange: stored rates, and the settlement data needed to compute a
-- realised gain or loss.
--
-- The invariant this exists to protect (ledger invariant #13): accounts
-- receivable is relieved at the rate it was BOOKED at, never at the settlement
-- rate. The difference is a realised exchange gain or loss. Relieving at the
-- settlement rate instead leaves a residue in the control account for every
-- foreign invoice ever settled.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Exchange rates
--
-- Tenant-scoped rather than global: a business may book at its own contracted
-- rate rather than the published reference rate, and an auditor will ask which
-- rate was used and where it came from. `source` records that.
--
-- Bank Negara Malaysia's published rates are the defensible reference for a
-- Malaysian entity — see docs/architecture/05-malaysia-localization.md §5.5.
-- -----------------------------------------------------------------------------
CREATE TABLE exchange_rate (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    currency_from CHAR(3) NOT NULL,
    currency_to   CHAR(3) NOT NULL,
    rate_date     DATE NOT NULL,
    /* Units of currency_to that one unit of currency_from buys. */
    rate          NUMERIC(19,8) NOT NULL CHECK (rate > 0),
    source        TEXT NOT NULL DEFAULT 'MANUAL',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, currency_from, currency_to, rate_date),
    CHECK (currency_from <> currency_to)
);

CREATE INDEX exchange_rate_lookup_idx
    ON exchange_rate (tenant_id, currency_from, currency_to, rate_date DESC);

-- -----------------------------------------------------------------------------
-- Settlement needs its own rate recorded, distinct from the invoice's.
-- -----------------------------------------------------------------------------
ALTER TABLE payment
    ADD COLUMN fx_rate NUMERIC(19,8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
    /* Base-currency value of the money actually received. */
    ADD COLUMN base_amount NUMERIC(19,4),
    /* Signed: positive is a gain, negative a loss. NULL for a base-currency
       receipt, which cannot produce one. */
    ADD COLUMN realised_fx NUMERIC(19,4);

-- -----------------------------------------------------------------------------
-- Rate lookup: the most recent rate on or before a date.
--
-- Falling back to an earlier rate is deliberate — weekends and public holidays
-- have no published rate, and an invoice dated Sunday must still convert. It
-- never looks FORWARD: using a rate that did not exist yet on the document
-- date would be indefensible to an auditor.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rate_on_or_before(
    p_from CHAR(3),
    p_to   CHAR(3),
    p_date DATE
) RETURNS NUMERIC(19,8)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_tenant UUID := current_tenant_id();
    v_rate   NUMERIC(19,8);
BEGIN
    IF p_from = p_to THEN
        RETURN 1;
    END IF;

    SELECT rate INTO v_rate
      FROM exchange_rate
     WHERE tenant_id = v_tenant
       AND currency_from = p_from
       AND currency_to = p_to
       AND rate_date <= p_date
     ORDER BY rate_date DESC
     LIMIT 1;

    RETURN v_rate;   -- NULL when no rate exists; the caller must decide.
END $$;

-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE exchange_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rate FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exchange_rate
    USING      (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON exchange_rate TO emil_app;
