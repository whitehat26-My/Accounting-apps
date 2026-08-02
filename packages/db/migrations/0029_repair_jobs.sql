-- =============================================================================
-- 0029_repair_jobs
--
-- The workshop: intake -> diagnose -> quote -> approve -> repair -> collect.
--
-- -----------------------------------------------------------------------------
-- A JOB IS A WORKFLOW DOCUMENT, NOT A FINANCIAL ONE.
--
-- Nothing here posts to the ledger. A repair job earns its keep as the record
-- of a CUSTOMER'S DEVICE in the shop's custody — what came in, what is wrong
-- with it, what was quoted, who said yes — and the money happens once, at
-- collection, when `collectRepairJob` converts the job's lines to an invoice
-- through the same path every counter sale takes. Stock relief, COGS, SST and
-- the receipt are all the machinery that already exists; the job contributes
-- the story.
--
-- The deliberate simplification (stated in packages/domain/src/repair.ts and
-- the settlement register): parts fitted mid-repair stay on the shelf in the
-- system until collection. WIP accounting is future work for week-scale jobs.
-- -----------------------------------------------------------------------------

CREATE TABLE repair_job (
    tenant_id        UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id               UUID NOT NULL DEFAULT gen_random_uuid(),
    job_no           TEXT NOT NULL,
    contact_id       UUID NOT NULL,
    /* The customer's machine, described as received. `device_serial` is FREE
       TEXT, deliberately not a stock_unit reference: the device being repaired
       is almost never something this shop sold from tracked stock, and when it
       IS, the serial lookup route already answers from the string. */
    device_description TEXT NOT NULL CHECK (length(btrim(device_description)) > 0),
    device_serial    TEXT,
    reported_fault   TEXT NOT NULL CHECK (length(btrim(reported_fault)) > 0),
    diagnosis        TEXT,
    status           TEXT NOT NULL DEFAULT 'RECEIVED'
                     CHECK (status IN ('RECEIVED','QUOTED','APPROVED','DECLINED',
                                       'IN_PROGRESS','READY','COLLECTED','CANCELLED')),
    /* Who said yes, and how it was given — "approved by WhatsApp 14:32" is the
       sentence that settles the dispute about whether the RM 450 was agreed. */
    approval_note    TEXT,
    approved_at      TIMESTAMPTZ,
    /* Why a job ended without being collected. */
    closed_reason    TEXT,
    /* The invoice that collection produced. Terminal-state provenance, the
       same discipline fiscal_year.closing_entry_id carries. */
    invoice_id       UUID,
    received_on      DATE NOT NULL,
    collected_on     DATE,
    /* Rule 5, both ends of the lifecycle: a double-submitted intake form must
       not take the same laptop in twice, and a double-clicked collection must
       not invoice twice. Collection's key also namespaces the invoice's. */
    created_idempotency_key TEXT NOT NULL,
    collect_idempotency_key TEXT,
    /* Whether collection took payment at the counter or invoiced on account.
       Display provenance for the replay path. */
    collected_paid   BOOLEAN,
    created_by       UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, job_no),
    UNIQUE      (tenant_id, created_idempotency_key),
    FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id),
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice (tenant_id, id),

    /* A collected job must cite its invoice; an uncollected one cannot. The
       status and the paperwork are one fact, enforced as one. */
    CONSTRAINT repair_job_collection_provenance CHECK (
        (status = 'COLLECTED') = (invoice_id IS NOT NULL AND collected_on IS NOT NULL)
    ),
    CONSTRAINT repair_job_closed_reason CHECK (
        status NOT IN ('DECLINED','CANCELLED') OR closed_reason IS NOT NULL
    ),
    CONSTRAINT repair_job_approval_provenance CHECK (
        status NOT IN ('APPROVED','IN_PROGRESS','READY','COLLECTED')
        OR approved_at IS NOT NULL
    )
);

CREATE INDEX repair_job_status_idx  ON repair_job (tenant_id, status);
CREATE INDEX repair_job_contact_idx ON repair_job (tenant_id, contact_id);

-- -----------------------------------------------------------------------------
-- Quote lines: what collection will invoice
--
-- The same shape as an invoice line ON PURPOSE — collection converts these
-- mechanically, so a field that cannot survive the conversion cannot be
-- quoted. Prices are quoted prices: what was agreed, not what the catalogue
-- says on collection day. The catalogue seeds the quote; the AGREEMENT is what
-- gets invoiced.
-- -----------------------------------------------------------------------------
CREATE TABLE repair_job_line (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    repair_job_id UUID NOT NULL,
    line_no       SMALLINT NOT NULL,
    item_id       UUID,
    description   TEXT NOT NULL CHECK (length(btrim(description)) > 0),
    quantity      NUMERIC(19,4) NOT NULL CHECK (quantity > 0),
    unit_price    NUMERIC(19,4) NOT NULL CHECK (unit_price >= 0),
    tax_code_id   UUID,
    account_id    UUID,
    /* For a serialised part: which units the repair will consume. Checked at
       COLLECTION (when stock actually moves), not at quote — the exact unit
       fitted is often known only on the bench. */
    serial_numbers TEXT[],
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, repair_job_id, line_no),
    FOREIGN KEY (tenant_id, repair_job_id) REFERENCES repair_job (tenant_id, id)
                ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, item_id)       REFERENCES item     (tenant_id, id),
    FOREIGN KEY (tenant_id, tax_code_id)   REFERENCES tax_code (tenant_id, id),
    FOREIGN KEY (tenant_id, account_id)    REFERENCES account  (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Permissions
--
-- Two, not one: seeing the workshop queue is counter work, but the queue also
-- prices labour — so reading is broad and writing sits with the same roles
-- that can ring a sale.
-- -----------------------------------------------------------------------------
INSERT INTO app_permission (code, description) VALUES
    ('repair.read',  'View repair jobs and their quotes'),
    ('repair.write', 'Take in, quote, progress and collect repair jobs');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('OWNER',      'repair.read'), ('OWNER',      'repair.write'),
    ('ADMIN',      'repair.read'), ('ADMIN',      'repair.write'),
    ('ACCOUNTANT', 'repair.read'), ('ACCOUNTANT', 'repair.write'),
    ('BOOKKEEPER', 'repair.read'), ('BOOKKEEPER', 'repair.write'),
    ('SALES',      'repair.read'), ('SALES',      'repair.write'),
    ('APPROVER',         'repair.read'),
    ('READ_ONLY',        'repair.read'),
    ('EXTERNAL_AUDITOR', 'repair.read');

-- -----------------------------------------------------------------------------
-- RLS + audit (rule 3, 0016)
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['repair_job', 'repair_job_line'] LOOP
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
