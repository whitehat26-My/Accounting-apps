-- =============================================================================
-- 0003_receipts
--
-- Settlement: payments and their allocation against invoices.
--
-- Allocation is a separate table, not a column on the payment, because the
-- relationship is genuinely many-to-many. One DuitNow transfer settles three
-- invoices; one invoice is settled by three instalments. A `payment.invoice_id`
-- column models neither.
-- =============================================================================

CREATE TABLE payment (
    tenant_id          UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                 UUID NOT NULL DEFAULT gen_random_uuid(),
    payment_no         TEXT NOT NULL,
    contact_id         UUID NOT NULL,
    direction          TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
    payment_date       DATE NOT NULL,
    method             TEXT NOT NULL
                       CHECK (method IN ('FPX','DUITNOW','CARD','CHEQUE','CASH','TRANSFER','OTHER')),
    /* The GL account the money landed in: bank, cash or undeposited funds. */
    deposit_account_id UUID NOT NULL,
    currency           CHAR(3) NOT NULL DEFAULT 'MYR',
    amount             NUMERIC(19,4) NOT NULL CHECK (amount > 0),
    /* Received but not yet applied to a document — a customer credit. */
    unallocated_amount NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (unallocated_amount >= 0),
    reference          TEXT,
    gateway_txn_id     TEXT,
    journal_entry_id   UUID NOT NULL,
    idempotency_key    TEXT,
    recorded_by        UUID,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, payment_no),
    UNIQUE      (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, contact_id)         REFERENCES contact       (tenant_id, id),
    FOREIGN KEY (tenant_id, deposit_account_id) REFERENCES account       (tenant_id, id),
    FOREIGN KEY (tenant_id, journal_entry_id)   REFERENCES journal_entry (tenant_id, id),
    CHECK (unallocated_amount <= amount)
);

CREATE INDEX payment_contact_idx ON payment (tenant_id, contact_id);
CREATE INDEX payment_date_idx    ON payment (tenant_id, payment_date);

CREATE TABLE payment_allocation (
    tenant_id   UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id          UUID NOT NULL DEFAULT gen_random_uuid(),
    payment_id  UUID NOT NULL,
    /* INVOICE today; CREDIT_NOTE and PREPAYMENT follow the same shape. */
    target_type TEXT NOT NULL DEFAULT 'INVOICE' CHECK (target_type IN ('INVOICE')),
    target_id   UUID NOT NULL,
    amount      NUMERIC(19,4) NOT NULL CHECK (amount > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, payment_id, target_type, target_id),
    FOREIGN KEY (tenant_id, payment_id) REFERENCES payment (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, target_id)  REFERENCES invoice (tenant_id, id)
);

CREATE INDEX payment_allocation_target_idx
    ON payment_allocation (tenant_id, target_type, target_id);

-- -----------------------------------------------------------------------------
-- A recorded payment is evidence of money that moved. Like a posted journal
-- entry, it is corrected by reversal, never by edit.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_payment_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Payment % cannot be deleted. Reverse it instead.', OLD.payment_no
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.amount           IS DISTINCT FROM OLD.amount
    OR NEW.payment_date     IS DISTINCT FROM OLD.payment_date
    OR NEW.contact_id       IS DISTINCT FROM OLD.contact_id
    OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
    OR NEW.payment_no       IS DISTINCT FROM OLD.payment_no THEN
        RAISE EXCEPTION
            'Payment % is immutable. Reverse it instead.', OLD.payment_no
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_payment_immutable
    BEFORE UPDATE OR DELETE ON payment
    FOR EACH ROW EXECUTE FUNCTION forbid_payment_mutation();

-- -----------------------------------------------------------------------------
-- Invariant guard: an invoice can never be over-settled.
--
-- The application checks this too, but a concurrent pair of receipts could
-- each read amount_due, each decide their allocation fits, and both commit.
-- This constraint is what actually prevents it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_invoice_not_over_allocated() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_allocated NUMERIC(19,4);
    v_total     NUMERIC(19,4);
    v_no        TEXT;
BEGIN
    SELECT COALESCE(SUM(a.amount), 0)
      INTO v_allocated
      FROM payment_allocation a
     WHERE a.tenant_id = NEW.tenant_id
       AND a.target_type = 'INVOICE'
       AND a.target_id = NEW.target_id;

    SELECT total, invoice_no INTO v_total, v_no
      FROM invoice
     WHERE tenant_id = NEW.tenant_id AND id = NEW.target_id
       FOR UPDATE;   -- serialises concurrent allocations against one invoice

    IF v_allocated > v_total THEN
        RAISE EXCEPTION
            'Invoice % would be over-allocated: % applied against a total of %',
            v_no, v_allocated, v_total
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER trg_invoice_not_over_allocated
    AFTER INSERT OR UPDATE ON payment_allocation
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_invoice_not_over_allocated();

-- =============================================================================
-- RLS
-- =============================================================================
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY['payment', 'payment_allocation'];
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
