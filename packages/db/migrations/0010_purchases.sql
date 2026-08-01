-- =============================================================================
-- 0010_purchases
--
-- M3: bills, supplier payments and debit notes — the mirror of sales.
--
-- `buildPurchaseJournal()` has existed and been tested since the tax engine
-- landed, including the SST cost-vs-recoverable branch. Nothing has ever called
-- it. This migration is what lets something call it.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Bills
--
-- BILL NUMBERING IS DELIBERATELY NOT GAPLESS, and `bill_no` is deliberately NOT
-- unique per tenant.
--
-- `bill_no` is the SUPPLIER's document number. Two suppliers both numbering
-- their invoices INV-001 is completely normal, and a tenant-wide unique index
-- would reject the second one. Making a supplier's number tenant-unique is the
-- most common AP modelling mistake there is.
--
-- Our own gapless identifier is `internal_ref`, allocated through
-- allocate_document_number('BILL') exactly like an invoice number.
-- -----------------------------------------------------------------------------
CREATE TABLE bill (
    tenant_id             UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                    UUID NOT NULL DEFAULT gen_random_uuid(),
    /* Ours: gapless, auditable. */
    internal_ref          TEXT NOT NULL,
    /* Theirs: whatever the supplier printed on it. */
    bill_no               TEXT NOT NULL,
    supplier_id           UUID NOT NULL,
    bill_date             DATE NOT NULL,
    due_date              DATE NOT NULL,
    tax_point_date        DATE NOT NULL,
    currency              CHAR(3) NOT NULL DEFAULT 'MYR',
    fx_rate               NUMERIC(19,8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
    amounts_tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
    subtotal              NUMERIC(19,4) NOT NULL DEFAULT 0,
    tax_total             NUMERIC(19,4) NOT NULL DEFAULT 0,
    total                 NUMERIC(19,4) NOT NULL DEFAULT 0,
    amount_paid           NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
    amount_credited       NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (amount_credited >= 0),
    amount_due            NUMERIC(19,4)
                          GENERATED ALWAYS AS (total - amount_paid - amount_credited) STORED,
    status                TEXT NOT NULL DEFAULT 'DRAFT',
    journal_entry_id      UUID,
    reference             TEXT,
    idempotency_key       TEXT,
    entered_by            UUID,
    entered_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, internal_ref),
    /* Per SUPPLIER, never per tenant. */
    UNIQUE      (tenant_id, supplier_id, bill_no),
    UNIQUE      (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, supplier_id)      REFERENCES contact       (tenant_id, id),
    FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entry (tenant_id, id),

    CONSTRAINT bill_status_valid
        CHECK (status IN ('DRAFT','ENTERED','PART_PAID','PAID','CREDITED','VOIDED')),
    CONSTRAINT bill_due_after_date
        CHECK (due_date >= bill_date),
    CONSTRAINT bill_entered_has_journal
        CHECK (status = 'DRAFT' OR journal_entry_id IS NOT NULL OR total = 0),
    CONSTRAINT bill_not_over_settled
        CHECK (amount_paid + amount_credited <= total)
);

CREATE INDEX bill_supplier_idx ON bill (tenant_id, supplier_id);
CREATE INDEX bill_open_idx     ON bill (tenant_id, due_date)
    WHERE status IN ('ENTERED','PART_PAID');

CREATE TABLE bill_line (
    tenant_id             UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                    UUID NOT NULL DEFAULT gen_random_uuid(),
    bill_id               UUID NOT NULL,
    line_no               SMALLINT NOT NULL,
    item_id               UUID,
    description           TEXT NOT NULL,
    quantity              NUMERIC(19,4) NOT NULL CHECK (quantity > 0),
    unit_price            NUMERIC(19,4) NOT NULL CHECK (unit_price >= 0),
    discount_basis_points INTEGER NOT NULL DEFAULT 0
                          CHECK (discount_basis_points BETWEEN 0 AND 10000),
    /* Expense or asset account. */
    account_id            UUID NOT NULL,
    tax_code_id           UUID NOT NULL,
    taxable_amount        NUMERIC(19,4) NOT NULL,
    tax_amount            NUMERIC(19,4) NOT NULL,
    line_total            NUMERIC(19,4) NOT NULL,

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, bill_id, line_no),
    FOREIGN KEY (tenant_id, bill_id)     REFERENCES bill     (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, account_id)  REFERENCES account  (tenant_id, id),
    FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_code (tenant_id, id),
    FOREIGN KEY (tenant_id, item_id)     REFERENCES item     (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- payment_allocation: an EXCLUSIVE ARC, not a polymorphic key.
--
-- The table was invoice-only in three separate places — the target_type CHECK,
-- a hard FK to invoice, and the over-allocation trigger reading FROM invoice.
-- A polymorphic `target_id` would have removed all three by giving up
-- referential integrity, which is the wrong trade in a schema whose whole
-- discipline is making bad states unrepresentable.
--
-- Instead: two nullable columns, each with a real foreign key, and a CHECK that
-- exactly one is set. The database still refuses to point at a row that does
-- not exist.
-- -----------------------------------------------------------------------------
ALTER TABLE payment_allocation RENAME COLUMN target_id TO invoice_id;
ALTER TABLE payment_allocation ALTER COLUMN invoice_id DROP NOT NULL;
ALTER TABLE payment_allocation ADD COLUMN bill_id UUID;
ALTER TABLE payment_allocation
    ADD FOREIGN KEY (tenant_id, bill_id) REFERENCES bill (tenant_id, id);

-- The old uniqueness guard and lookup index both lead with target_type, so
-- dropping the column would cascade them away silently. Drop them by name
-- first, so the migration states what it is removing rather than relying on a
-- side effect.
--
-- The constraint name is the live catalogue's, not a guess: PostgreSQL
-- truncates auto-generated names to 63 bytes, which lands mid-word here
-- ("...target__key", not "...target_id_key").
ALTER TABLE payment_allocation
    DROP CONSTRAINT payment_allocation_tenant_id_payment_id_target_type_target__key;
DROP INDEX payment_allocation_target_idx;

-- target_type is now redundant: the arc says which it is.
ALTER TABLE payment_allocation DROP COLUMN target_type;

ALTER TABLE payment_allocation
    ADD CONSTRAINT payment_allocation_exclusive_arc
        CHECK (num_nonnulls(invoice_id, bill_id) = 1);

CREATE INDEX payment_allocation_invoice_idx ON payment_allocation (tenant_id, invoice_id)
    WHERE invoice_id IS NOT NULL;
CREATE INDEX payment_allocation_bill_idx    ON payment_allocation (tenant_id, bill_id)
    WHERE bill_id IS NOT NULL;

-- The uniqueness guard has to follow the arc too — one allocation per payment
-- per target, whichever arm the target sits in.
CREATE UNIQUE INDEX payment_allocation_unique_invoice
    ON payment_allocation (tenant_id, payment_id, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX payment_allocation_unique_bill
    ON payment_allocation (tenant_id, payment_id, bill_id) WHERE bill_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Over-settlement guard, now aware of both arms.
--
-- Same reasoning as before: two concurrent settlements could each read
-- amount_due, each conclude their allocation fits, and both commit.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_invoice_not_over_allocated() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_allocated NUMERIC(19,4);
    v_total     NUMERIC(19,4);
    v_paid      NUMERIC(19,4);
    v_credited  NUMERIC(19,4);
    v_no        TEXT;
BEGIN
    IF NEW.invoice_id IS NOT NULL THEN
        SELECT COALESCE(SUM(a.amount), 0) INTO v_allocated
          FROM payment_allocation a
         WHERE a.tenant_id = NEW.tenant_id AND a.invoice_id = NEW.invoice_id;

        SELECT total, amount_credited, invoice_no INTO v_total, v_credited, v_no
          FROM invoice
         WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id
           FOR UPDATE;

        IF v_allocated + COALESCE(v_credited, 0) > v_total THEN
            RAISE EXCEPTION
                'Invoice % would be over-allocated: % applied plus % credited against a total of %',
                v_no, v_allocated, v_credited, v_total
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        SELECT COALESCE(SUM(a.amount), 0) INTO v_allocated
          FROM payment_allocation a
         WHERE a.tenant_id = NEW.tenant_id AND a.bill_id = NEW.bill_id;

        SELECT total, amount_credited, internal_ref INTO v_total, v_credited, v_no
          FROM bill
         WHERE tenant_id = NEW.tenant_id AND id = NEW.bill_id
           FOR UPDATE;

        IF v_allocated + COALESCE(v_credited, 0) > v_total THEN
            RAISE EXCEPTION
                'Bill % would be over-allocated: % applied plus % credited against a total of %',
                v_no, v_allocated, v_credited, v_total
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- An entered bill is evidence of a supplier's claim. Same immutability rule as
-- an issued invoice; corrections are debit notes.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_entered_bill_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'DRAFT' THEN
            RAISE EXCEPTION
                'Bill % has been entered and cannot be deleted. Raise a debit note instead.',
                OLD.internal_ref
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status <> 'DRAFT' THEN
        IF NEW.internal_ref     IS DISTINCT FROM OLD.internal_ref
        OR NEW.bill_no          IS DISTINCT FROM OLD.bill_no
        OR NEW.supplier_id      IS DISTINCT FROM OLD.supplier_id
        OR NEW.bill_date        IS DISTINCT FROM OLD.bill_date
        OR NEW.tax_point_date   IS DISTINCT FROM OLD.tax_point_date
        OR NEW.subtotal         IS DISTINCT FROM OLD.subtotal
        OR NEW.tax_total        IS DISTINCT FROM OLD.tax_total
        OR NEW.total            IS DISTINCT FROM OLD.total
        OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
            RAISE EXCEPTION
                'Bill % is entered; amounts are immutable. Raise a debit note instead.',
                OLD.internal_ref
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_bill_immutable
    BEFORE UPDATE OR DELETE ON bill
    FOR EACH ROW EXECUTE FUNCTION forbid_entered_bill_mutation();

CREATE OR REPLACE FUNCTION forbid_entered_bill_line_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_status TEXT;
    v_row    bill_line;
BEGIN
    v_row := COALESCE(NEW, OLD);

    SELECT status INTO v_status
      FROM bill WHERE tenant_id = v_row.tenant_id AND id = v_row.bill_id;

    IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Lines of an entered bill are immutable (bill %)', v_row.bill_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN v_row;
END $$;

CREATE TRIGGER trg_bill_line_immutable
    BEFORE UPDATE OR DELETE ON bill_line
    FOR EACH ROW EXECUTE FUNCTION forbid_entered_bill_line_mutation();

-- -----------------------------------------------------------------------------
-- Debit notes — the correction path for a bill, mirroring credit notes.
-- -----------------------------------------------------------------------------
CREATE TABLE debit_note (
    tenant_id        UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id               UUID NOT NULL DEFAULT gen_random_uuid(),
    debit_note_no    TEXT NOT NULL,
    supplier_id      UUID NOT NULL,
    bill_id          UUID,
    debit_date       DATE NOT NULL,
    tax_point_date   DATE NOT NULL,
    reason           TEXT NOT NULL
                     CHECK (reason IN ('RETURN','OVERCHARGE','DISCOUNT',
                                       'CANCELLATION','BAD_DEBT','OTHER')),
    reason_detail    TEXT,
    currency         CHAR(3) NOT NULL DEFAULT 'MYR',
    subtotal         NUMERIC(19,4) NOT NULL DEFAULT 0,
    tax_total        NUMERIC(19,4) NOT NULL DEFAULT 0,
    total            NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (total >= 0),
    allocated_amount NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (allocated_amount >= 0),
    status           TEXT NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT','ISSUED','VOIDED')),
    journal_entry_id UUID,
    idempotency_key  TEXT,
    issued_by        UUID,
    issued_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, debit_note_no),
    UNIQUE      (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, supplier_id)      REFERENCES contact       (tenant_id, id),
    FOREIGN KEY (tenant_id, bill_id)          REFERENCES bill          (tenant_id, id),
    FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entry (tenant_id, id),
    CHECK (allocated_amount <= total),
    CHECK (status <> 'ISSUED' OR journal_entry_id IS NOT NULL OR total = 0)
);

CREATE TABLE debit_note_line (
    tenant_id             UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                    UUID NOT NULL DEFAULT gen_random_uuid(),
    debit_note_id         UUID NOT NULL,
    line_no               SMALLINT NOT NULL,
    description           TEXT NOT NULL,
    quantity              NUMERIC(19,4) NOT NULL CHECK (quantity > 0),
    unit_price            NUMERIC(19,4) NOT NULL CHECK (unit_price >= 0),
    discount_basis_points INTEGER NOT NULL DEFAULT 0
                          CHECK (discount_basis_points BETWEEN 0 AND 10000),
    account_id            UUID NOT NULL,
    tax_code_id           UUID NOT NULL,
    taxable_amount        NUMERIC(19,4) NOT NULL,
    tax_amount            NUMERIC(19,4) NOT NULL,
    line_total            NUMERIC(19,4) NOT NULL,

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, debit_note_id, line_no),
    FOREIGN KEY (tenant_id, debit_note_id) REFERENCES debit_note (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, account_id)    REFERENCES account    (tenant_id, id),
    FOREIGN KEY (tenant_id, tax_code_id)   REFERENCES tax_code   (tenant_id, id)
);

CREATE TABLE debit_note_allocation (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    debit_note_id UUID NOT NULL,
    bill_id       UUID NOT NULL,
    amount        NUMERIC(19,4) NOT NULL CHECK (amount > 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, debit_note_id, bill_id),
    FOREIGN KEY (tenant_id, debit_note_id) REFERENCES debit_note (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, bill_id)       REFERENCES bill       (tenant_id, id)
);

-- Debit notes get their own immutability function rather than reusing the
-- credit-note one: that function names OLD.credit_note_no in its error
-- message, a column debit_note does not have, so it would fail at runtime on
-- the very path it is meant to guard.
CREATE OR REPLACE FUNCTION forbid_issued_debit_note_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'DRAFT' THEN
            RAISE EXCEPTION
                'Debit note % has been issued and cannot be deleted.', OLD.debit_note_no
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status <> 'DRAFT' THEN
        IF NEW.debit_note_no    IS DISTINCT FROM OLD.debit_note_no
        OR NEW.supplier_id      IS DISTINCT FROM OLD.supplier_id
        OR NEW.bill_id          IS DISTINCT FROM OLD.bill_id
        OR NEW.debit_date       IS DISTINCT FROM OLD.debit_date
        OR NEW.tax_point_date   IS DISTINCT FROM OLD.tax_point_date
        OR NEW.subtotal         IS DISTINCT FROM OLD.subtotal
        OR NEW.tax_total        IS DISTINCT FROM OLD.tax_total
        OR NEW.total            IS DISTINCT FROM OLD.total
        OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
            RAISE EXCEPTION
                'Debit note % is issued; only its allocation may change.',
                OLD.debit_note_no
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_debit_note_immutable
    BEFORE UPDATE OR DELETE ON debit_note
    FOR EACH ROW EXECUTE FUNCTION forbid_issued_debit_note_mutation();

CREATE OR REPLACE FUNCTION forbid_issued_debit_note_line_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_status TEXT;
    v_row    debit_note_line;
BEGIN
    v_row := COALESCE(NEW, OLD);

    SELECT status INTO v_status
      FROM debit_note WHERE tenant_id = v_row.tenant_id AND id = v_row.debit_note_id;

    IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Lines of an issued debit note are immutable (note %)',
            v_row.debit_note_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN v_row;
END $$;

CREATE TRIGGER trg_debit_note_line_immutable
    BEFORE UPDATE OR DELETE ON debit_note_line
    FOR EACH ROW EXECUTE FUNCTION forbid_issued_debit_note_line_mutation();

-- -----------------------------------------------------------------------------
-- Posting roles: AP revaluation, and withholding.
-- -----------------------------------------------------------------------------
ALTER TABLE posting_account_map DROP CONSTRAINT posting_account_map_role_check;
ALTER TABLE posting_account_map
    ADD CONSTRAINT posting_account_map_role_check
        CHECK (role IN ('AR','AP','SST_PAYABLE','SST_CLAIMABLE',
                        'ROUNDING','FX_GAIN_LOSS','RETAINED_EARNINGS',
                        'UNDEPOSITED_FUNDS','SUSPENSE',
                        'AR_REVALUATION','UNREALISED_FX',
                        -- Closing-rate adjustment to payables. Presented on the
                        -- same SOFP line as AP, mirroring AR_REVALUATION.
                        'AP_REVALUATION',
                        -- Withholding deducted from a payment and owed to LHDN
                        -- until remitted.
                        'WHT_PAYABLE'));

-- -----------------------------------------------------------------------------
-- Withholding tax rates.
--
-- ⚠️ SEEDED EMPTY, DELIBERATELY. Malaysian withholding rates vary by payment
-- type (royalties, technical fees, interest, contract payments) and by double
-- taxation treaty. They must be verified against LHDN before use — a
-- plausible-looking wrong rate is worse than an explicit gap, and nothing here
-- computes a withholding until a rate is supplied.
--
-- Effective-dated for the same reason SST rates are: a payment made in 2024
-- must reprint at the 2024 rate forever.
-- -----------------------------------------------------------------------------
CREATE TABLE wht_rate (
    tenant_id         UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    /* e.g. ROYALTY, TECHNICAL_FEE, INTEREST, CONTRACT. Free text: the
       categories are statutory and will change. */
    payment_type      TEXT NOT NULL,
    /* ISO country of the recipient, or NULL for the non-treaty default. */
    country_code      CHAR(2),
    rate_basis_points INTEGER NOT NULL CHECK (rate_basis_points >= 0),
    valid_from        DATE NOT NULL,
    valid_to          DATE,
    legislation_ref   TEXT,

    PRIMARY KEY (tenant_id, id),
    CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX wht_rate_lookup_idx
    ON wht_rate (tenant_id, payment_type, country_code, valid_from DESC);

-- Withholding is a payment-time event, so it gets its own evidence table
-- rather than overloading tax_transaction, which is keyed on a document's tax
-- point and whose direction vocabulary (OUTPUT/INPUT) does not describe it.
CREATE TABLE withholding_transaction (
    tenant_id         UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    payment_id        UUID NOT NULL,
    contact_id        UUID NOT NULL,
    payment_type      TEXT NOT NULL,
    country_code      CHAR(2),
    rate_basis_points INTEGER NOT NULL,
    gross_amount      NUMERIC(19,4) NOT NULL,
    withheld_amount   NUMERIC(19,4) NOT NULL,
    payment_date      DATE NOT NULL,
    remitted_at       DATE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, payment_id) REFERENCES payment (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id)
);

CREATE TRIGGER trg_withholding_transaction_append_only
    BEFORE UPDATE OR DELETE ON withholding_transaction
    FOR EACH ROW EXECUTE FUNCTION raise_append_only_violation();

-- =============================================================================
-- RLS
-- =============================================================================
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'bill', 'bill_line', 'debit_note', 'debit_note_line', 'debit_note_allocation',
        'wht_rate', 'withholding_transaction'
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

    REVOKE UPDATE, DELETE ON withholding_transaction FROM emil_app;
END $$;

-- -----------------------------------------------------------------------------
-- Revaluation now covers both sides of the balance sheet.
--
-- A period-end revaluation is ONE event, so it stays one `revaluation_run`
-- posting one journal entry and one reversal — the CHECK that a posted run has
-- both an entry and its reversal is worth keeping intact.
--
-- But the two sides cannot share a line: receivables and payables adjustments
-- land in DIFFERENT balance-sheet accounts (AR_REVALUATION, AP_REVALUATION) so
-- each presents next to the control account it adjusts. Netting a payables
-- adjustment into the receivables line would show it inside trade receivables,
-- which is exactly the misstatement AP_REVALUATION exists to prevent.
--
-- So `side` joins the key. The default backfills existing rows, all of which
-- are receivables — the only thing revaluation covered until now.
-- -----------------------------------------------------------------------------
ALTER TABLE revaluation_line
    ADD COLUMN side TEXT NOT NULL DEFAULT 'RECEIVABLE'
        CHECK (side IN ('RECEIVABLE','PAYABLE'));

ALTER TABLE revaluation_line DROP CONSTRAINT revaluation_line_tenant_id_run_id_currency_key;
ALTER TABLE revaluation_line ADD  CONSTRAINT revaluation_line_unique_side
    UNIQUE (tenant_id, run_id, currency, side);

-- Payables present alongside receivables on the SOFP.
INSERT INTO report_template_line_map (line_id, match_type, match_value, priority)
VALUES ('sofp-ap', 'TAG', 'ap_revaluation', 10);
