-- =============================================================================
-- 0025_year_end_close
--
-- M1's last missing piece, and a status column that has been decorative since
-- the first migration.
--
-- -----------------------------------------------------------------------------
-- `fiscal_year.status` NEVER DID ANYTHING.
--
-- 0017 fixed exactly this bug one level down: `fiscal_period.status` accepted
-- the value CLOSED and `assert_period_open()` only checked for LOCKED, so a
-- closed period took postings as though it were open. The same function still
-- does not look at the YEAR at all.
--
-- So a fiscal year marked CLOSED accepts postings for as long as any of its
-- periods is open — which is every year, because nothing closes periods
-- automatically. "Closed" meant nothing, and the figures a business had already
-- filed could still move underneath them.
--
-- The year now binds, with the same two-state discipline periods got:
--
--   OPEN    postings allowed.
--   CLOSED  postings REFUSED. Reopening is a visible act that reverses the
--           closing entry — see `reopenFiscalYear`.
--   LOCKED  refused unless the caller holds `period.override`, which writes a
--           LOCKED_PERIOD_OVERRIDE event on every posting that uses it.
--
-- The year is checked BEFORE the period, because it is the coarser statement
-- and its message is the more useful one: "the year is closed" tells a user
-- what to do, where "period 7 is open but the year is closed" invites them to
-- go looking for a period problem that does not exist.
-- -----------------------------------------------------------------------------
--
-- -----------------------------------------------------------------------------
-- THE CLOSING ENTRY, AND WHY IT IS POSTED BEFORE THE YEAR IS CLOSED.
--
-- 0017 established that CLOSED has NO override path — an entry into a closed
-- period requires visibly reopening it. That rule is worth keeping, so the
-- year-end close does not invent an exception to it. Instead it does the two
-- things in the only order that needs no exception:
--
--   1. post the closing entry, while the year is still open;
--   2. mark the year CLOSED.
--
-- Which also means the closing entry is the LAST thing posted into the year, by
-- construction rather than by convention.
-- -----------------------------------------------------------------------------

ALTER TABLE fiscal_year ADD COLUMN closed_by         UUID;
ALTER TABLE fiscal_year ADD COLUMN closed_at         TIMESTAMPTZ;
/* The entry that zeroed the year's income and expense accounts. Reopening
   reverses THIS entry specifically, rather than searching for one that looks
   like it. */
ALTER TABLE fiscal_year ADD COLUMN closing_entry_id  UUID;

/* Rule 5: every financial write path is idempotent on an Idempotency-Key.
   Held on the YEAR rather than inferred from the journal entry, because a
   retried close must be answerable even in the case where no entry was posted
   at all — a year with no trading is closed without one, and a retry of that
   close has nothing in `journal_entry` to recognise itself by. */
ALTER TABLE fiscal_year ADD COLUMN close_idempotency_key TEXT;

ALTER TABLE fiscal_year ADD CONSTRAINT fiscal_year_closing_entry_fk
    FOREIGN KEY (tenant_id, closing_entry_id) REFERENCES journal_entry (tenant_id, id);

/* A closed year must say who closed it and when. The same provenance rule
   `journal_entry` carries for POSTED, for the same reason: an act with nobody
   attached to it is the one an auditor cannot follow up. */
ALTER TABLE fiscal_year ADD CONSTRAINT fiscal_year_close_provenance
    CHECK (status = 'OPEN' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL));

-- -----------------------------------------------------------------------------
-- The trigger, now looking at both levels
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_period_status TEXT;
    v_year_status   TEXT;
    v_year_label    TEXT;
BEGIN
    IF NEW.status <> 'POSTED' THEN
        RETURN NEW;
    END IF;

    SELECT p.status, y.status, y.label
      INTO v_period_status, v_year_status, v_year_label
      FROM fiscal_period p
      JOIN fiscal_year y ON y.tenant_id = p.tenant_id AND y.id = p.fiscal_year_id
     WHERE p.tenant_id = NEW.tenant_id
       AND p.id = NEW.fiscal_period_id;

    -- The year first: it is the coarser statement and the more useful message.
    IF v_year_status = 'CLOSED' THEN
        RAISE EXCEPTION
            'Fiscal year % is CLOSED; reopen it before posting entry %',
            v_year_label, NEW.entry_no
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_year_status = 'LOCKED'
       AND COALESCE(current_setting('app.allow_locked_period', true), 'off') <> 'on' THEN
        RAISE EXCEPTION
            'Fiscal year % is LOCKED; posting entry % requires the period.override permission',
            v_year_label, NEW.entry_no
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_period_status = 'CLOSED' THEN
        RAISE EXCEPTION
            'Fiscal period is CLOSED; reopen it before posting entry %', NEW.entry_no
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_period_status = 'LOCKED'
       AND COALESCE(current_setting('app.allow_locked_period', true), 'off') <> 'on' THEN
        RAISE EXCEPTION
            'Fiscal period is LOCKED; posting entry % requires the period.override permission',
            NEW.entry_no
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- Reopening a year is an event an auditor asks about by name
--
-- The list is restated in full because the CHECK is replaced wholesale, and it
-- must be read from the LIVE constraint rather than copied from an older
-- migration — doing the latter once silently dropped 0013's BILL_APPROVED.
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
            'YEAR_END_REOPENED',
            'GATEWAY_CONFIG_CHANGED',
            'GATEWAY_SETTLEMENT_POSTED',
            'BILL_APPROVED',
            'BILL_REJECTED',
            'CHART_OF_ACCOUNTS_CHANGED',
            'STATUTORY_RATE_CHANGED',
            'TAX_RETURN_SUBMITTED',
            'TAX_RETURN_AMENDED',
            'CASH_FLOW_CLASSIFICATION_CHANGED'));
