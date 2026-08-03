-- =============================================================================
-- 0017_period_close
--
-- Month-end close: make `CLOSED` mean something, and give the chart of accounts
-- the same protection every other reference change already has.
--
-- -----------------------------------------------------------------------------
-- `CLOSED` HAS BEEN A DECLARED STATE THAT DID NOTHING SINCE 0001.
--
-- `fiscal_period.status` has allowed OPEN, CLOSED and LOCKED from the beginning
-- (0001:110), and `assert_period_open()` (0001:455-479) checks for exactly one
-- of them:
--
--     IF v_status = 'LOCKED' AND app.allow_locked_period <> 'on' THEN RAISE
--
-- A period marked CLOSED therefore accepted postings exactly as if it were
-- OPEN. That is the worst available behaviour for a state named "closed": a
-- bookkeeper who closes January, reports on it, and sends the numbers to a
-- client would find later entries still landing in it — silently, and after the
-- figures had already gone out.
--
-- There was also no way to set the state at all. `locked_by` and `locked_at`
-- have existed as columns with nothing to write them, because there is no
-- lock/unlock service and no route. So the feature was three-quarters present
-- and zero-quarters working.
--
-- The two states now differ in how hard they are to get out of, not in whether
-- they hold:
--
--   OPEN    postings allowed.
--   CLOSED  postings REFUSED. Reopen with `period.lock`. The routine
--           month-end close, reversible by the person who did it.
--   LOCKED  postings refused unless the caller holds `period.override`, which
--           writes a LOCKED_PERIOD_OVERRIDE financial event on every posting
--           that uses it. The hard close, for a period whose numbers have been
--           filed.
--
-- CLOSED deliberately has NO override path. If a period needs an entry after
-- being closed, reopening it is a visible act that leaves a
-- PERIOD_UNLOCKED event; an override that quietly writes into a closed period
-- is how a reported figure changes after it was reported.
-- -----------------------------------------------------------------------------
-- =============================================================================

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

    IF v_status = 'CLOSED' THEN
        RAISE EXCEPTION
            'Fiscal period is CLOSED; reopen it before posting entry %', NEW.entry_no
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_status = 'LOCKED'
       AND COALESCE(current_setting('app.allow_locked_period', true), 'off') <> 'on' THEN
        RAISE EXCEPTION
            'Fiscal period is LOCKED; posting entry % requires the period.override permission',
            NEW.entry_no
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- Changing the chart of accounts under posted history
--
-- 04-security-compliance.md:95 lists "chart of accounts change on an account
-- with a non-zero balance" among the events an auditor asks about by name. The
-- event type was never added to the enum, so there was nothing to write.
--
-- It matters because an account's TYPE decides which statement it appears on.
-- Reclassifying one that already carries posted journal lines does not move a
-- number — it moves it from the profit and loss to the balance sheet, silently,
-- for every period ever reported. `account.ts` refuses that outright; this
-- event records the changes that ARE allowed on an account with history.
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
            -- Renaming, re-coding or archiving an account that already carries
            -- posted history. The type cannot be changed at all — see
            -- account.ts — so this records the changes that remain possible.
            'CHART_OF_ACCOUNTS_CHANGED'));

/*
 * A period cannot be closed while the year it belongs to is already closed, and
 * a period's dates cannot move once it holds posted entries.
 *
 * Both are enforced in `period.ts` rather than here: they need to count journal
 * entries and to produce a message a user can act on, and a CHECK constraint
 * can do neither. The trigger above is the one that must be in the database,
 * because it is the one an application bug could otherwise talk its way past.
 */
