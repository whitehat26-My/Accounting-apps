-- =============================================================================
-- 0002_sales_tax
--
-- M8 (contacts & items), M5 (tax codes with effective-dated rates) and the
-- sales half of M2 (invoices).
--
-- Same conventions as 0001: tenant_id first in every PK, composite FKs, RLS
-- enabled and FORCED with USING + WITH CHECK, money NUMERIC(19,4), accounting
-- dates DATE.
-- =============================================================================

-- Needed for the EXCLUDE constraint on tax_rate_version, which mixes equality
-- on uuid columns with range overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- Posting account map
--
-- Which account plays which structural role for this tenant. Keeps the posting
-- logic free of hardcoded account codes, so a tenant can rename or renumber
-- their chart of accounts without breaking the ledger.
-- -----------------------------------------------------------------------------
CREATE TABLE posting_account_map (
    tenant_id  UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    role       TEXT NOT NULL
               CHECK (role IN ('AR','AP','SST_PAYABLE','SST_CLAIMABLE',
                               'ROUNDING','FX_GAIN_LOSS','RETAINED_EARNINGS',
                               'UNDEPOSITED_FUNDS','SUSPENSE')),
    account_id UUID NOT NULL,

    PRIMARY KEY (tenant_id, role),
    FOREIGN KEY (tenant_id, account_id) REFERENCES account (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Contacts
--
-- The Malaysian identity block is first-class, not a custom-field bag. TIN and
-- the secondary identifier are MyInvois submission requirements, so they must
-- be capturable at contact creation — warning the user then, rather than at
-- invoice-issue time when they are trying to get paid.
-- -----------------------------------------------------------------------------
CREATE TABLE contact (
    tenant_id            UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                   UUID NOT NULL DEFAULT gen_random_uuid(),
    name                 TEXT NOT NULL,
    is_customer          BOOLEAN NOT NULL DEFAULT FALSE,
    is_supplier          BOOLEAN NOT NULL DEFAULT FALSE,

    -- Malaysian identity
    tin                  TEXT,
    id_type              TEXT CHECK (id_type IN ('BRN','NRIC','PASSPORT','ARMY')),
    id_value             TEXT,
    sst_no               TEXT,
    msic_code            TEXT,

    email                TEXT,
    phone                TEXT,
    default_currency     CHAR(3) NOT NULL DEFAULT 'MYR',
    payment_terms_days   SMALLINT NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
    default_account_id   UUID,
    default_tax_code_id  UUID,
    credit_limit         NUMERIC(19,4),
    /* FALSE = this buyer accepts consolidated B2C e-invoicing. */
    requires_einvoice    BOOLEAN NOT NULL DEFAULT TRUE,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, default_account_id) REFERENCES account (tenant_id, id),
    CHECK (is_customer OR is_supplier)
);

CREATE INDEX contact_name_idx ON contact (tenant_id, name);

CREATE TABLE contact_address (
    tenant_id    UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id           UUID NOT NULL DEFAULT gen_random_uuid(),
    contact_id   UUID NOT NULL,
    address_type TEXT NOT NULL DEFAULT 'BILLING'
                 CHECK (address_type IN ('BILLING','SHIPPING')),
    -- Structured, not a free-text blob: MyInvois needs the parts separately.
    line1        TEXT NOT NULL,
    line2        TEXT,
    city         TEXT,
    postcode     TEXT,
    state_code   TEXT,
    country_code CHAR(2) NOT NULL DEFAULT 'MY',

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- Items
-- -----------------------------------------------------------------------------
CREATE TABLE item (
    tenant_id             UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                    UUID NOT NULL DEFAULT gen_random_uuid(),
    code                  TEXT NOT NULL,
    name                  TEXT NOT NULL,
    item_type             TEXT NOT NULL DEFAULT 'SERVICE'
                          CHECK (item_type IN ('GOODS','SERVICE')),
    unit_of_measure       TEXT NOT NULL DEFAULT 'UNIT',
    sale_unit_price       NUMERIC(19,4),
    sale_account_id       UUID,
    sale_tax_code_id      UUID,
    purchase_unit_price   NUMERIC(19,4),
    purchase_account_id   UUID,
    purchase_tax_code_id  UUID,
    /* MyInvois line classification code. Defaulted per item so a user is not
       asked to look one up on every invoice line. */
    classification_code   TEXT,
    is_active             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, code),
    FOREIGN KEY (tenant_id, sale_account_id)     REFERENCES account (tenant_id, id),
    FOREIGN KEY (tenant_id, purchase_account_id) REFERENCES account (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Tax codes and their effective-dated rates
--
-- The rate lives in a separate versioned table with a validity window. A rate
-- change is an INSERT, never an UPDATE — a 2024 invoice must reprint at the
-- 2024 rate forever.
-- -----------------------------------------------------------------------------
CREATE TABLE tax_code (
    tenant_id       UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    code            TEXT NOT NULL,
    name            TEXT NOT NULL,
    regime          TEXT NOT NULL
                    CHECK (regime IN ('SST_SALES','SST_SERVICE','WHT','NONE')),
    -- COST is the SST default: input tax is absorbed, not reclaimed. See
    -- packages/domain/src/tax.ts for why this is not a VAT.
    input_treatment TEXT NOT NULL DEFAULT 'COST'
                    CHECK (input_treatment IN ('COST','RECOVERABLE')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, code)
);

CREATE TABLE tax_rate_version (
    tenant_id         UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    tax_code_id       UUID NOT NULL,
    /* Basis points: 1bp = 0.01%. 8% = 800. Exact, never a float. */
    rate_basis_points INTEGER NOT NULL CHECK (rate_basis_points >= 0),
    valid_from        DATE NOT NULL,
    valid_to          DATE,
    legislation_ref   TEXT,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_code (tenant_id, id) ON DELETE CASCADE,
    CHECK (valid_to IS NULL OR valid_to >= valid_from),
    -- Two rates in force on the same day for the same code is not a data
    -- quality issue, it is an ambiguous tax computation. Forbid it outright.
    EXCLUDE USING gist (
        tenant_id WITH =,
        tax_code_id WITH =,
        daterange(valid_from, COALESCE(valid_to, 'infinity'::date), '[]') WITH &&
    )
);

CREATE TABLE tax_exemption (
    tenant_id      UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    contact_id     UUID NOT NULL,
    certificate_no TEXT NOT NULL,
    valid_from     DATE NOT NULL,
    valid_to       DATE,
    /* Empty array = the certificate covers every tax code. */
    tax_code_ids   UUID[] NOT NULL DEFAULT '{}',

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- Tax transactions — the immutable evidence the SST return is built from.
--
-- The return is NOT recomputed from current rates at filing time; it is summed
-- from these rows. That is what makes a filed return reproducible three years
-- later after the rate has changed twice.
-- -----------------------------------------------------------------------------
CREATE TABLE tax_transaction (
    tenant_id            UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                   UUID NOT NULL DEFAULT gen_random_uuid(),
    source_document_type TEXT NOT NULL,
    source_document_id   UUID NOT NULL,
    source_line_id       UUID,
    tax_code_id          UUID NOT NULL,
    rate_basis_points    INTEGER NOT NULL,
    taxable_amount       NUMERIC(19,4) NOT NULL,
    tax_amount           NUMERIC(19,4) NOT NULL,
    tax_point_date       DATE NOT NULL,
    direction            TEXT NOT NULL CHECK (direction IN ('OUTPUT','INPUT')),
    exemption_reason     TEXT,
    certificate_no       TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_code (tenant_id, id)
);

CREATE INDEX tax_transaction_period_idx
    ON tax_transaction (tenant_id, direction, tax_point_date);

CREATE TRIGGER trg_tax_transaction_append_only
    BEFORE UPDATE OR DELETE ON tax_transaction
    FOR EACH ROW EXECUTE FUNCTION raise_append_only_violation();

-- -----------------------------------------------------------------------------
-- Invoices
-- -----------------------------------------------------------------------------
CREATE TABLE invoice (
    tenant_id           UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                  UUID NOT NULL DEFAULT gen_random_uuid(),
    invoice_no          TEXT NOT NULL,
    contact_id          UUID NOT NULL,
    issue_date          DATE NOT NULL,
    due_date            DATE NOT NULL,
    /* Usually the issue date, but they diverge for some supply types, and the
       tax point is what selects the rate. */
    tax_point_date      DATE NOT NULL,
    currency            CHAR(3) NOT NULL DEFAULT 'MYR',
    fx_rate             NUMERIC(19,8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
    amounts_tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,
    subtotal            NUMERIC(19,4) NOT NULL DEFAULT 0,
    tax_total           NUMERIC(19,4) NOT NULL DEFAULT 0,
    rounding_adjustment NUMERIC(19,4) NOT NULL DEFAULT 0,
    total               NUMERIC(19,4) NOT NULL DEFAULT 0,
    amount_paid         NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
    /* Derived, so the subledger can never disagree with itself. */
    amount_due          NUMERIC(19,4) GENERATED ALWAYS AS (total - amount_paid) STORED,
    status              TEXT NOT NULL DEFAULT 'DRAFT',
    journal_entry_id    UUID,
    reference           TEXT,
    terms               TEXT,
    idempotency_key     TEXT,
    issued_by           UUID,
    issued_at           TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, invoice_no),
    UNIQUE      (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, contact_id)       REFERENCES contact (tenant_id, id),
    FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entry (tenant_id, id),
    -- Named explicitly, not left to PostgreSQL's positional auto-naming
    -- (invoice_check1, invoice_check2, ...). A later migration has to drop
    -- these by name, and positional names silently shift when a constraint is
    -- added above them.
    CONSTRAINT invoice_status_valid
        CHECK (status IN ('DRAFT','ISSUED','PART_PAID','PAID','VOIDED')),
    CONSTRAINT invoice_due_after_issue
        CHECK (due_date >= issue_date),
    -- Every issued invoice carries its journal entry, EXCEPT a zero-total one,
    -- which has no debits or credits to post. See hasLedgerEffect() in
    -- packages/domain/src/document.ts.
    CONSTRAINT invoice_issued_has_journal
        CHECK (status = 'DRAFT' OR journal_entry_id IS NOT NULL OR total = 0),
    CONSTRAINT invoice_not_over_settled
        CHECK (amount_paid <= total)
);

CREATE INDEX invoice_contact_idx ON invoice (tenant_id, contact_id);
CREATE INDEX invoice_status_idx  ON invoice (tenant_id, status)
    WHERE status IN ('ISSUED','PART_PAID');
CREATE INDEX invoice_due_idx     ON invoice (tenant_id, due_date)
    WHERE status IN ('ISSUED','PART_PAID');

CREATE TABLE invoice_line (
    tenant_id            UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                   UUID NOT NULL DEFAULT gen_random_uuid(),
    invoice_id           UUID NOT NULL,
    line_no              SMALLINT NOT NULL,
    item_id              UUID,
    description          TEXT NOT NULL,
    quantity             NUMERIC(19,4) NOT NULL CHECK (quantity > 0),
    unit_price           NUMERIC(19,4) NOT NULL CHECK (unit_price >= 0),
    discount_basis_points INTEGER NOT NULL DEFAULT 0
                         CHECK (discount_basis_points BETWEEN 0 AND 10000),
    account_id           UUID NOT NULL,
    tax_code_id          UUID NOT NULL,
    taxable_amount       NUMERIC(19,4) NOT NULL,
    tax_amount           NUMERIC(19,4) NOT NULL,
    line_total           NUMERIC(19,4) NOT NULL,
    classification_code  TEXT,

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, invoice_id, line_no),
    FOREIGN KEY (tenant_id, invoice_id)  REFERENCES invoice  (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, account_id)  REFERENCES account  (tenant_id, id),
    FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_code (tenant_id, id),
    FOREIGN KEY (tenant_id, item_id)     REFERENCES item     (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- An issued invoice is evidence given to a customer. Amounts are frozen; only
-- settlement state may move. Corrections are credit notes, mirroring the way
-- ledger corrections are reversing entries.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_issued_invoice_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'DRAFT' THEN
            RAISE EXCEPTION
                'Invoice % has been issued and cannot be deleted. Raise a credit note instead.',
                OLD.invoice_no
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status <> 'DRAFT' THEN
        IF NEW.invoice_no     IS DISTINCT FROM OLD.invoice_no
        OR NEW.contact_id     IS DISTINCT FROM OLD.contact_id
        OR NEW.issue_date     IS DISTINCT FROM OLD.issue_date
        OR NEW.tax_point_date IS DISTINCT FROM OLD.tax_point_date
        OR NEW.subtotal       IS DISTINCT FROM OLD.subtotal
        OR NEW.tax_total      IS DISTINCT FROM OLD.tax_total
        OR NEW.total          IS DISTINCT FROM OLD.total
        OR NEW.currency       IS DISTINCT FROM OLD.currency
        OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
            RAISE EXCEPTION
                'Invoice % is issued; amounts are immutable. Raise a credit note instead.',
                OLD.invoice_no
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_invoice_immutable
    BEFORE UPDATE OR DELETE ON invoice
    FOR EACH ROW EXECUTE FUNCTION forbid_issued_invoice_mutation();

CREATE OR REPLACE FUNCTION forbid_issued_invoice_line_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_status TEXT;
    v_row    invoice_line;
BEGIN
    v_row := COALESCE(NEW, OLD);

    SELECT status INTO v_status
      FROM invoice
     WHERE tenant_id = v_row.tenant_id AND id = v_row.invoice_id;

    IF v_status IS NOT NULL AND v_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Lines of an issued invoice are immutable (invoice %)', v_row.invoice_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN v_row;
END $$;

CREATE TRIGGER trg_invoice_line_immutable
    BEFORE UPDATE OR DELETE ON invoice_line
    FOR EACH ROW EXECUTE FUNCTION forbid_issued_invoice_line_mutation();

-- =============================================================================
-- RLS for everything added above
-- =============================================================================
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'posting_account_map', 'contact', 'contact_address', 'item',
        'tax_code', 'tax_rate_version', 'tax_exemption', 'tax_transaction',
        'invoice', 'invoice_line'
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

    -- Append-only, like audit_log.
    REVOKE UPDATE, DELETE ON tax_transaction FROM emil_app;
END $$;
