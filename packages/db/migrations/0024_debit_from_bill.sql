-- =============================================================================
-- 0024_debit_from_bill
--
-- The payables half of 0023, which was left undone and should not have been.
--
-- 0023 fixed credit notes: a correction must compute tax at the rate the
-- ORIGINAL SUPPLY carried, not at today's, or an invoice issued before
-- Malaysia's 2024 6%→8% service-tax change cannot be credited at all. It added
-- `debit_note.original_tax_point_date` in the same statement — and then wired
-- nothing to it.
--
-- So debit notes still had the identical defect:
--
--     const taxPointDate = input.taxPointDate ?? input.debitDate;   ← the rate
--
-- A debit note is the buyer's document reducing what is owed on an entered
-- bill. Correcting a 2023 bill today computed the reversal at 8% against a
-- charge of 6%, which overstates the reduction in the payable and understates
-- the expense — and, exactly as on the sales side, trips the over-correction
-- guard so the document is refused outright.
--
-- A half-applied fix is worse than an unapplied one: the column existing
-- implies the behaviour exists. This finishes it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Which bill line a debit line reverses
--
-- Mirrors `credit_note_line.source_invoice_line_id`, for the same reason: it is
-- what makes "how much of this line has already been reversed" answerable, and
-- therefore what stops the same bill being debited twice.
--
-- Derived on demand, never stored as a counter on `bill_line`. A counter is a
-- denormalisation that drifts, usually when a document is voided.
-- -----------------------------------------------------------------------------
ALTER TABLE debit_note_line ADD COLUMN source_bill_line_id UUID;

ALTER TABLE debit_note_line ADD CONSTRAINT debit_note_line_source_fk
    FOREIGN KEY (tenant_id, source_bill_line_id)
    REFERENCES bill_line (tenant_id, id);

CREATE INDEX debit_note_line_source_idx
    ON debit_note_line (tenant_id, source_bill_line_id)
    WHERE source_bill_line_id IS NOT NULL;

COMMENT ON COLUMN debit_note.original_tax_point_date IS
    'Tax point of the supply being corrected. Selects the RATE VERSION. '
    'Distinct from tax_point_date, which decides which period this falls in.';

/*
 * A line derived from a bill line must belong to a debit note against that
 * bill. Without it, a debit note against bill A could carry a line claiming to
 * reverse a line of bill B — and the over-correction check, which walks from
 * the bill to its debit notes, would never see it.
 *
 * DEFERRABLE INITIALLY DEFERRED for the same reason as its credit-note twin:
 * the service writes the header and its lines in one transaction, so an
 * immediate trigger would fire before the row it must read is visible.
 */
CREATE OR REPLACE FUNCTION assert_debit_line_matches_bill() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_note_bill UUID;
    v_line_bill UUID;
BEGIN
    IF NEW.source_bill_line_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT bill_id INTO v_note_bill
      FROM debit_note
     WHERE tenant_id = NEW.tenant_id AND id = NEW.debit_note_id;

    SELECT bill_id INTO v_line_bill
      FROM bill_line
     WHERE tenant_id = NEW.tenant_id AND id = NEW.source_bill_line_id;

    IF v_note_bill IS DISTINCT FROM v_line_bill THEN
        RAISE EXCEPTION
            'Debit line claims to reverse a line of bill %, but its debit note is '
            'against bill %', v_line_bill, v_note_bill
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER trg_debit_line_matches_bill
    AFTER INSERT OR UPDATE ON debit_note_line
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_debit_line_matches_bill();
