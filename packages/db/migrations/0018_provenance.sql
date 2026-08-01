-- =============================================================================
-- 0018_provenance
--
-- Every value that was blocked on an outside source must carry that source.
--
-- -----------------------------------------------------------------------------
-- THE PROBLEM THIS SOLVES IS NOT "THE VALUES ARE MISSING". IT IS "NOBODY CAN
-- TELL A VERIFIED VALUE FROM A GUESSED ONE ONCE IT IS IN THE TABLE."
--
-- Five things in this system ship deliberately empty because they must be
-- confirmed against a primary source: withholding rates (LHDN), the DuitNow
-- merchant account template (PayNet), the MyInvois wire format (LHDN's SDK),
-- payment gateway credentials, and per-bank statement layouts. Each currently
-- fails loudly when unset, which is right and is not enough.
--
-- The moment somebody has a real figure, they will type it in. From then on the
-- table cannot say whether it came from a published ruling or from a plausible
-- guess someone made under time pressure — and a wrong withholding rate is a
-- liability the payer carries, not the software.
--
-- So the citation becomes part of the row, enforced by the database:
--
--   * `wht_rate.legislation_ref` becomes NOT NULL. A rate with no ruling behind
--     it cannot be stored at all.
--   * A non-empty DuitNow merchant template cannot be stored without saying
--     where it was confirmed.
--   * A saved bank import profile records which real statement it was derived
--     from.
--
-- These are CHECK constraints rather than a convention in the service layer
-- because a convention is exactly what gets skipped at 6pm on a filing deadline.
-- -----------------------------------------------------------------------------
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Withholding rates
--
-- The table has shipped empty since 0010 and `legislation_ref` has been there,
-- nullable, the whole time. Malaysian withholding depends on the payment type
-- AND on any applicable double taxation agreement, so "10% for royalties" is
-- meaningless without saying which instrument says so and for which country.
-- -----------------------------------------------------------------------------
ALTER TABLE wht_rate
    ALTER COLUMN legislation_ref SET NOT NULL,
    ADD COLUMN verified_by UUID,
    ADD COLUMN verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* A citation that is one word is not a citation. Long enough to name a
       ruling and a section; short enough that it is not being used as a notes
       field. */
    ADD CONSTRAINT wht_rate_legislation_ref_meaningful
        CHECK (length(btrim(legislation_ref)) BETWEEN 8 AND 300);

COMMENT ON COLUMN wht_rate.legislation_ref IS
    'The primary source this rate came from — e.g. "LHDN Public Ruling 11/2018 s4.2" '
    'or "MY-SG DTA Article 12(2)". NOT NULL by design: a rate whose origin nobody '
    'recorded cannot be re-verified when the law changes, and the payer carries the '
    'liability for getting it wrong.';

-- -----------------------------------------------------------------------------
-- The DuitNow merchant account template
--
-- packages/domain/src/duitnow-qr.ts is blunt about why this one matters more
-- than the others: a guessed tax rate produces a wrong number on a return, and
-- a guessed merchant template produces a QR that SCANS SUCCESSFULLY AND PAYS
-- THE WRONG PARTY. The payer holds a completed transaction and the merchant
-- holds nothing.
--
-- The template may be empty — that is the shipping state, and `buildDuitNowQr`
-- refuses to build anything from it. It may not be non-empty and unattributed.
-- -----------------------------------------------------------------------------
ALTER TABLE payment_gateway_config
    ADD COLUMN merchant_template_source      TEXT,
    ADD COLUMN merchant_template_verified_by UUID,
    ADD COLUMN merchant_template_verified_at TIMESTAMPTZ,
    ADD CONSTRAINT payment_gateway_config_template_attributed
        CHECK (
            jsonb_array_length(merchant_template) = 0
            OR (merchant_template_source IS NOT NULL
                AND length(btrim(merchant_template_source)) >= 8)
        );

COMMENT ON COLUMN payment_gateway_config.merchant_template_source IS
    'Where the EMVCo merchant account template was confirmed — e.g. "PayNet merchant '
    'onboarding pack, ref DN-2026-0043". Required as soon as the template is '
    'non-empty. See packages/domain/src/duitnow-qr.ts.';

-- -----------------------------------------------------------------------------
-- Bank statement layouts
--
-- 0011 says it already: guessing a CSV's dialect is right most of the time and
-- silent when wrong — "a description column read as an amount imports a
-- plausible statement with wrong numbers, and the user finds out at year end".
--
-- A profile is therefore derived from a REAL statement, and the row says which
-- one. Not the file itself: a statement is customer data and does not belong in
-- a configuration table.
-- -----------------------------------------------------------------------------
ALTER TABLE import_profile
    ADD COLUMN source_reference TEXT,
    ADD COLUMN verified_by      UUID,
    ADD COLUMN verified_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* Nullable, unlike the two above. A tenant mapping their own bank's export
       is describing a file they are looking at, not asserting a statutory fact,
       and demanding a citation for that would be ceremony. Recorded when given. */
    ADD CONSTRAINT import_profile_source_meaningful
        CHECK (source_reference IS NULL OR length(btrim(source_reference)) >= 4);

COMMENT ON COLUMN import_profile.source_reference IS
    'Which real statement this column map was derived from — e.g. "Maybank current '
    'account CSV export, July 2026". Advisory: it is what lets the next person '
    'confirm the mapping still matches what the bank produces.';

-- -----------------------------------------------------------------------------
-- Recording the act, not just the row
--
-- Seeding a statutory rate or a merchant template is exactly the kind of change
-- an auditor asks about by name, and neither had an event type.
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
            -- A withholding rate entering or leaving service. It decides how
            -- much of a supplier's money is retained and remitted to LHDN.
            'STATUTORY_RATE_CHANGED'));
