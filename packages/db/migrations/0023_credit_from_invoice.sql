-- =============================================================================
-- 0023_credit_from_invoice
--
-- A credit note reverses a supply that already happened, and until now this
-- system computed it as though the supply were happening today.
--
-- -----------------------------------------------------------------------------
-- THE DEFECT, WHICH IS NOT SUBTLE ONCE YOU SEE IT.
--
-- `issueCreditNote` sets `taxPointDate = input.taxPointDate ?? input.creditDate`
-- and hands that to `computeDocument`, where it selects the tax rate version.
-- So a credit note issued today against an invoice from 2023 is computed at
-- TODAY's rate.
--
-- Malaysia raised the service tax from 6% to 8% on 1 March 2024. So:
--
--     Invoice, June 2023:   RM 1,000 + 6% =  RM 1,060   ← what was charged
--     Credit note, today:   RM 1,000 + 8% =  RM 1,080   ← what this computed
--
-- And then the over-credit guard compares RM 1,080 against RM 1,060, finds the
-- credit larger, and REFUSES THE WHOLE THING with `CREDIT_EXCEEDS_INVOICE`.
-- Measured, not theorised: the probe that produced those exact figures is now
-- an integration test.
--
-- So the behaviour was not "quietly credits 2% too much". It was: YOU CANNOT
-- CREDIT ANY INVOICE ISSUED BEFORE THE RATE CHANGE, and the error message
-- blames the amount rather than the rate, so nobody could work out why.
-- -----------------------------------------------------------------------------
--
-- -----------------------------------------------------------------------------
-- THE FIX IS TWO DATES, BECAUSE THERE ARE TWO QUESTIONS.
--
--   * WHICH RATE APPLIES — decided by the tax point of the ORIGINAL SUPPLY.
--     You reverse the tax that was charged, at the rate it was charged at.
--
--   * WHICH RETURN IT REDUCES — decided by the credit note's OWN date. A credit
--     issued in April reduces April's return; applying it to March would mean
--     amending a return already filed. `packages/domain/src/tax-return.ts`
--     depends on this and says so.
--
-- One column was doing both jobs, and the two answers differ whenever a rate
-- changes between the supply and its correction. `original_tax_point_date`
-- carries the first; `tax_point_date` keeps carrying the second, unchanged, so
-- the SST return is unaffected.
-- -----------------------------------------------------------------------------

/* The supply being corrected, for RATE SELECTION only.
   NULL means "same as this document's tax point", which is the right answer for
   a standalone credit that corrects no particular earlier supply. */
ALTER TABLE credit_note ADD COLUMN original_tax_point_date DATE;
ALTER TABLE debit_note  ADD COLUMN original_tax_point_date DATE;

COMMENT ON COLUMN credit_note.original_tax_point_date IS
    'Tax point of the supply being corrected. Selects the RATE VERSION. '
    'Distinct from tax_point_date, which decides which SST return this reduces.';

-- -----------------------------------------------------------------------------
-- Which invoice line a credit line reverses
--
-- Needed to answer "how much of this line has already been credited", which is
-- what stops the same invoice being credited twice.
--
-- DERIVED, never stored. A `credited_quantity` column on `invoice_line` would
-- be a denormalisation of a sum over `credit_note_line`, and denormalised
-- counters drift — usually when a document is voided, which is exactly when
-- somebody is already having a bad day. The sum is over a handful of rows
-- behind an index.
-- -----------------------------------------------------------------------------
ALTER TABLE credit_note_line ADD COLUMN source_invoice_line_id UUID;

ALTER TABLE credit_note_line ADD CONSTRAINT credit_note_line_source_fk
    FOREIGN KEY (tenant_id, source_invoice_line_id)
    REFERENCES invoice_line (tenant_id, id);

CREATE INDEX credit_note_line_source_idx
    ON credit_note_line (tenant_id, source_invoice_line_id)
    WHERE source_invoice_line_id IS NOT NULL;

/*
 * A line derived from an invoice line must belong to a credit note that names
 * that invoice. Without this, a credit note against invoice A could carry a
 * line claiming to reverse a line of invoice B — and the over-credit check,
 * which walks from the invoice to its credit notes, would never see it.
 *
 * Enforced by trigger rather than by CHECK because it spans three tables.
 */
CREATE OR REPLACE FUNCTION assert_credit_line_matches_invoice() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_credit_invoice UUID;
    v_line_invoice   UUID;
BEGIN
    IF NEW.source_invoice_line_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT invoice_id INTO v_credit_invoice
      FROM credit_note
     WHERE tenant_id = NEW.tenant_id AND id = NEW.credit_note_id;

    SELECT invoice_id INTO v_line_invoice
      FROM invoice_line
     WHERE tenant_id = NEW.tenant_id AND id = NEW.source_invoice_line_id;

    IF v_credit_invoice IS DISTINCT FROM v_line_invoice THEN
        RAISE EXCEPTION
            'Credit line claims to reverse a line of invoice %, but its credit note '
            'is against invoice %', v_line_invoice, v_credit_invoice
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER trg_credit_line_matches_invoice
    AFTER INSERT OR UPDATE ON credit_note_line
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_credit_line_matches_invoice();

/* DEFERRABLE INITIALLY DEFERRED because the service writes the credit note
   header and its lines in one transaction, and the header's `invoice_id` is set
   in the same statement batch. An immediate trigger would fire before the row
   it needs to read is visible. Same reasoning as the balanced-entry trigger in
   0001. */
