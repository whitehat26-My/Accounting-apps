-- =============================================================================
-- 0036 — Sales quotes
--
-- The document before the invoice. A customer asks what twelve of something
-- would cost; the shop writes it down, sends it, and either wins the work or
-- learns why it did not.
--
-- -----------------------------------------------------------------------------
-- A QUOTE IS NOT AN ACCOUNTING DOCUMENT, AND NOTHING HERE TOUCHES THE LEDGER.
--
-- That is the reason this is its own table rather than an invoice with a
-- `status = 'QUOTE'`. An offer nobody has accepted is not revenue, is not a
-- receivable, and must not appear in the sales ledger, the ageing, or the tax
-- return. Keeping quotes out of `invoice` entirely means there is no state in
-- which a careless query counts one as income — the isolation is structural
-- rather than a WHERE clause every report has to remember.
--
-- The ledger entry happens exactly once, at conversion, through the same
-- `issueInvoice` path a typed invoice uses. A quoted sale and a typed sale are
-- therefore indistinguishable in the books, which is what makes the quote a
-- convenience rather than a second way to bill.
-- -----------------------------------------------------------------------------
-- =============================================================================

CREATE TABLE sales_quote (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    quote_no      TEXT NOT NULL,
    contact_id    UUID NOT NULL,

    status        TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT','SENT','ACCEPTED','DECLINED','EXPIRED','INVOICED')),

    quote_date    DATE NOT NULL,
    /* How long the price holds. NULL means open-ended, which is a real choice
       for a long-standing customer and a bad one for volatile stock — the UI
       defaults it to 30 days rather than leaving it empty. */
    valid_until   DATE,

    currency      TEXT NOT NULL DEFAULT 'MYR',
    reference     TEXT,
    notes         TEXT,
    amounts_are_tax_inclusive BOOLEAN NOT NULL DEFAULT FALSE,

    /* Provenance, the same discipline `repair_job.invoice_id` carries: once
       converted, the quote names the invoice it became. */
    invoice_id    UUID,
    accepted_at   TIMESTAMPTZ,
    declined_at   TIMESTAMPTZ,
    /* Why the shop lost it. The single most useful field on the table for
       anyone asking whether they are losing on price or on lead time. */
    decline_reason TEXT,

    created_by    UUID,
    /* Rule 5 at both ends: a double-submitted form must not raise two quotes,
       and a double-clicked "convert" must not raise two invoices. */
    created_idempotency_key TEXT NOT NULL,
    convert_idempotency_key TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, quote_no),
    UNIQUE      (tenant_id, created_idempotency_key),
    FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id),

    /* A quote that names an invoice must be INVOICED, and one that does not
       must not be. The status and the provenance cannot drift apart. */
    CONSTRAINT sales_quote_invoiced_has_invoice
        CHECK ((status = 'INVOICED') = (invoice_id IS NOT NULL)),
    CONSTRAINT sales_quote_declined_has_reason
        CHECK (status <> 'DECLINED' OR decline_reason IS NOT NULL)
);

CREATE INDEX sales_quote_contact_idx ON sales_quote (tenant_id, contact_id, quote_date DESC);
CREATE INDEX sales_quote_open_idx    ON sales_quote (tenant_id, status, valid_until);

-- -----------------------------------------------------------------------------
-- The lines.
--
-- Shaped to match `IssueInvoiceLine` field for field, so conversion is a
-- mapping rather than a translation. Where the two disagree is where a bug
-- would live.
-- -----------------------------------------------------------------------------
CREATE TABLE sales_quote_line (
    tenant_id      UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    sales_quote_id UUID NOT NULL,
    line_no        SMALLINT NOT NULL CHECK (line_no > 0),

    item_id        UUID,
    description    TEXT NOT NULL CHECK (length(btrim(description)) > 0),
    quantity       NUMERIC(19,4) NOT NULL CHECK (quantity > 0),
    unit_price     NUMERIC(19,4) NOT NULL CHECK (unit_price >= 0),
    account_id     UUID,
    tax_code_id    UUID,
    discount_basis_points INTEGER NOT NULL DEFAULT 0
                   CHECK (discount_basis_points BETWEEN 0 AND 10000),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, sales_quote_id, line_no),
    FOREIGN KEY (tenant_id, sales_quote_id)
        REFERENCES sales_quote (tenant_id, id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- RLS + audit (rule 3, 0016)
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['sales_quote', 'sales_quote_line'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                 USING      (tenant_id = current_tenant_id())
                 WITH CHECK (tenant_id = current_tenant_id())', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO emil_app', t);
        EXECUTE format(
            'CREATE TRIGGER trg_audit_%1$s
                 AFTER INSERT OR UPDATE OR DELETE ON %1$I
                 FOR EACH ROW EXECUTE FUNCTION audit_row_change(%2$L)', t, 'tenant_id');
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- Quoting is a SALES activity, not an accounting one — the person at the
-- counter who knows the prices writes it, and it moves no money.
-- -----------------------------------------------------------------------------
INSERT INTO app_permission (code, description) VALUES
    ('quote.read',  'View sales quotes'),
    ('quote.write', 'Create, send and convert sales quotes')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('OWNER','quote.read'),      ('OWNER','quote.write'),
    ('ADMIN','quote.read'),      ('ADMIN','quote.write'),
    ('ACCOUNTANT','quote.read'), ('ACCOUNTANT','quote.write'),
    ('APPROVER','quote.read'),
    ('BOOKKEEPER','quote.read'),
    ('SALES','quote.read'),      ('SALES','quote.write'),
    ('READ_ONLY','quote.read'),
    ('EXTERNAL_AUDITOR','quote.read')
ON CONFLICT DO NOTHING;
