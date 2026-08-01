-- =============================================================================
-- 0004_credit_notes
--
-- The correction path for issued invoices.
--
-- The immutability triggers in 0002 refuse to edit an issued invoice. That is
-- only a defensible rule if a proper correction mechanism exists — this is it,
-- mirroring the ledger's own rule that a posted entry is corrected by a
-- reversing entry rather than an edit.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- An invoice can now be settled two ways: paid, or credited. `amount_due` has
-- to account for both.
--
-- Forward-only, per the working agreements. `amount_due` is a generated column
-- and therefore carries no data of its own, so dropping and recreating it loses
-- nothing — every value is recomputed from columns that remain.
-- -----------------------------------------------------------------------------
ALTER TABLE invoice
    ADD COLUMN amount_credited NUMERIC(19,4) NOT NULL DEFAULT 0
        CHECK (amount_credited >= 0);

ALTER TABLE invoice DROP COLUMN amount_due;

ALTER TABLE invoice
    ADD COLUMN amount_due NUMERIC(19,4)
        GENERATED ALWAYS AS (total - amount_paid - amount_credited) STORED;

-- The old constraint only knew about payments.
ALTER TABLE invoice DROP CONSTRAINT invoice_not_over_settled;
ALTER TABLE invoice
    ADD CONSTRAINT invoice_not_over_settled
        CHECK (amount_paid + amount_credited <= total);

-- Settlement state now includes fully-credited invoices.
ALTER TABLE invoice DROP CONSTRAINT invoice_status_valid;
ALTER TABLE invoice
    ADD CONSTRAINT invoice_status_valid
        CHECK (status IN ('DRAFT','ISSUED','PART_PAID','PAID','CREDITED','VOIDED'));

-- -----------------------------------------------------------------------------
-- Credit notes
-- -----------------------------------------------------------------------------
CREATE TABLE credit_note (
    tenant_id             UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                    UUID NOT NULL DEFAULT gen_random_uuid(),
    credit_note_no        TEXT NOT NULL,
    contact_id            UUID NOT NULL,
    /* The invoice being corrected. NULL for a standalone customer credit. */
    invoice_id            UUID,
    credit_date           DATE NOT NULL,
    tax_point_date        DATE NOT NULL,
    reason                TEXT NOT NULL
                          CHECK (reason IN ('RETURN','OVERCHARGE','DISCOUNT',
                                            'CANCELLATION','BAD_DEBT','OTHER')),
    reason_detail         TEXT,
    currency              CHAR(3) NOT NULL DEFAULT 'MYR',
    amounts_tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
    subtotal              NUMERIC(19,4) NOT NULL DEFAULT 0,
    tax_total             NUMERIC(19,4) NOT NULL DEFAULT 0,
    total                 NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (total >= 0),
    allocated_amount      NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (allocated_amount >= 0),
    status                TEXT NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT','ISSUED','VOIDED')),
    journal_entry_id      UUID,
    idempotency_key       TEXT,
    issued_by             UUID,
    issued_at             TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, credit_note_no),
    UNIQUE      (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, contact_id)       REFERENCES contact       (tenant_id, id),
    FOREIGN KEY (tenant_id, invoice_id)       REFERENCES invoice       (tenant_id, id),
    FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entry (tenant_id, id),
    CHECK (allocated_amount <= total),
    CHECK (status <> 'ISSUED' OR journal_entry_id IS NOT NULL OR total = 0)
);

CREATE INDEX credit_note_contact_idx ON credit_note (tenant_id, contact_id);
CREATE INDEX credit_note_invoice_idx ON credit_note (tenant_id, invoice_id);

CREATE TABLE credit_note_line (
    tenant_id             UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                    UUID NOT NULL DEFAULT gen_random_uuid(),
    credit_note_id        UUID NOT NULL,
    line_no               SMALLINT NOT NULL,
    item_id               UUID,
    description           TEXT NOT NULL,
    /* Positive, like an invoice line. Direction lives in the journal, not in
       the sign of the amount — see packages/domain/src/credit-note.ts. */
    quantity              NUMERIC(19,4) NOT NULL CHECK (quantity > 0),
    unit_price            NUMERIC(19,4) NOT NULL CHECK (unit_price >= 0),
    discount_basis_points INTEGER NOT NULL DEFAULT 0
                          CHECK (discount_basis_points BETWEEN 0 AND 10000),
    account_id            UUID NOT NULL,
    tax_code_id           UUID NOT NULL,
    taxable_amount        NUMERIC(19,4) NOT NULL,
    tax_amount            NUMERIC(19,4) NOT NULL,
    line_total            NUMERIC(19,4) NOT NULL,
    classification_code   TEXT,

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, credit_note_id, line_no),
    FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_note (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, account_id)     REFERENCES account     (tenant_id, id),
    FOREIGN KEY (tenant_id, tax_code_id)    REFERENCES tax_code    (tenant_id, id),
    FOREIGN KEY (tenant_id, item_id)        REFERENCES item        (tenant_id, id)
);

CREATE TABLE credit_note_allocation (
    tenant_id      UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    credit_note_id UUID NOT NULL,
    invoice_id     UUID NOT NULL,
    amount         NUMERIC(19,4) NOT NULL CHECK (amount > 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, credit_note_id, invoice_id),
    FOREIGN KEY (tenant_id, credit_note_id) REFERENCES credit_note (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, invoice_id)     REFERENCES invoice     (tenant_id, id)
);

CREATE INDEX credit_note_allocation_invoice_idx
    ON credit_note_allocation (tenant_id, invoice_id);

-- -----------------------------------------------------------------------------
-- Issued credit notes are immutable, exactly like issued invoices.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_issued_credit_note_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'DRAFT' THEN
            RAISE EXCEPTION
                'Credit note % has been issued and cannot be deleted.', OLD.credit_note_no
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status <> 'DRAFT' THEN
        IF NEW.credit_note_no   IS DISTINCT FROM OLD.credit_note_no
        OR NEW.contact_id       IS DISTINCT FROM OLD.contact_id
        OR NEW.credit_date      IS DISTINCT FROM OLD.credit_date
        OR NEW.tax_point_date   IS DISTINCT FROM OLD.tax_point_date
        OR NEW.subtotal         IS DISTINCT FROM OLD.subtotal
        OR NEW.tax_total        IS DISTINCT FROM OLD.tax_total
        OR NEW.total            IS DISTINCT FROM OLD.total
        OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
            RAISE EXCEPTION
                'Credit note % is issued and immutable.', OLD.credit_note_no
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_credit_note_immutable
    BEFORE UPDATE OR DELETE ON credit_note
    FOR EACH ROW EXECUTE FUNCTION forbid_issued_credit_note_mutation();

CREATE OR REPLACE FUNCTION forbid_issued_credit_note_line_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_status TEXT;
    v_row    credit_note_line;
BEGIN
    v_row := COALESCE(NEW, OLD);

    SELECT status INTO v_status
      FROM credit_note
     WHERE tenant_id = v_row.tenant_id AND id = v_row.credit_note_id;

    IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
        RAISE EXCEPTION
            'Lines of an issued credit note are immutable (credit note %)', v_row.credit_note_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN v_row;
END $$;

CREATE TRIGGER trg_credit_note_line_immutable
    BEFORE UPDATE OR DELETE ON credit_note_line
    FOR EACH ROW EXECUTE FUNCTION forbid_issued_credit_note_line_mutation();

-- -----------------------------------------------------------------------------
-- An invoice cannot be over-credited, for the same concurrency reason
-- payments cannot over-settle: two credit notes could each read amount_due and
-- each conclude they fit.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_invoice_not_over_credited() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_credited NUMERIC(19,4);
    v_paid     NUMERIC(19,4);
    v_total    NUMERIC(19,4);
    v_no       TEXT;
BEGIN
    SELECT COALESCE(SUM(a.amount), 0)
      INTO v_credited
      FROM credit_note_allocation a
     WHERE a.tenant_id = NEW.tenant_id AND a.invoice_id = NEW.invoice_id;

    SELECT total, amount_paid, invoice_no
      INTO v_total, v_paid, v_no
      FROM invoice
     WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id
       FOR UPDATE;

    IF v_credited + v_paid > v_total THEN
        RAISE EXCEPTION
            'Invoice % would be over-settled: % credited + % paid against a total of %',
            v_no, v_credited, v_paid, v_total
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER trg_invoice_not_over_credited
    AFTER INSERT OR UPDATE ON credit_note_allocation
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_invoice_not_over_credited();

-- =============================================================================
-- RLS
-- =============================================================================
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY['credit_note', 'credit_note_line', 'credit_note_allocation'];
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
END $$;
