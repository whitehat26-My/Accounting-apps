-- =============================================================================
-- 0005_einvoice
--
-- LHDN e-Invoice (MyInvois) submission tracking — M6.
--
-- Kept in its own tables, referenced by document id rather than by foreign key
-- into a single document type, because this is the module most likely to
-- change under us and the most likely to be extracted into its own service.
--
-- ⚠️ Status values, error codes and the cancellation window are all data, not
-- constants. Confirm against LHDN's SDK before production use.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The supplier's own address.
--
-- MyInvois requires a full structured address for BOTH parties, and the buyer
-- side already had one via contact_address. The supplier side did not — the
-- organisation record carried identity (TIN, BRN, MSIC) but no address at all.
-- Caught by the submission validator rather than by review.
--
-- Structured, not a free-text blob: LHDN wants the parts separately.
-- -----------------------------------------------------------------------------
ALTER TABLE organisation
    ADD COLUMN address_line1 TEXT,
    ADD COLUMN address_line2 TEXT,
    ADD COLUMN city          TEXT,
    ADD COLUMN postcode      TEXT,
    ADD COLUMN state_code    TEXT,
    ADD COLUMN country_code  CHAR(2) NOT NULL DEFAULT 'MY';

-- -----------------------------------------------------------------------------
-- Reference data, refreshed from LHDN rather than hardcoded.
-- -----------------------------------------------------------------------------
CREATE TABLE einvoice_classification_code (
    code        TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Global reference data, readable by every tenant. No RLS: there is nothing
-- tenant-specific here, and every tenant needs the same list.
GRANT SELECT ON einvoice_classification_code TO emil_app;

-- -----------------------------------------------------------------------------
-- e-Invoice configuration, per tenant.
--
-- The cancellation window lives here rather than in code because it is a
-- statutory value with a history of changing — working agreement 7.
-- -----------------------------------------------------------------------------
CREATE TABLE einvoice_config (
    tenant_id               UUID PRIMARY KEY REFERENCES organisation (id) ON DELETE RESTRICT,
    is_enabled              BOOLEAN NOT NULL DEFAULT FALSE,
    /* Hours after validation during which the supplier may cancel. */
    cancellation_window_hours INTEGER NOT NULL DEFAULT 72
                            CHECK (cancellation_window_hours > 0),
    /* Fast-fail convenience only; LHDN's TIN lookup is authoritative. */
    tin_pattern             TEXT,
    /* Days after month end by which consolidated B2C invoices must be sent. */
    consolidation_due_days  INTEGER NOT NULL DEFAULT 7
                            CHECK (consolidation_due_days > 0),
    environment             TEXT NOT NULL DEFAULT 'SANDBOX'
                            CHECK (environment IN ('SANDBOX','PRODUCTION')),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Submissions
-- -----------------------------------------------------------------------------
CREATE TABLE einvoice_submission (
    tenant_id       UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    document_type   TEXT NOT NULL
                    CHECK (document_type IN (
                        'INVOICE','CREDIT_NOTE','DEBIT_NOTE','REFUND_NOTE',
                        'SELF_BILLED_INVOICE','SELF_BILLED_CREDIT_NOTE',
                        'SELF_BILLED_DEBIT_NOTE','SELF_BILLED_REFUND_NOTE')),
    /* The source document. Not a foreign key: it points at invoice OR
       credit_note, and a polymorphic FK is not expressible. The service layer
       is the only writer, and it always resolves the row first. */
    document_id     UUID NOT NULL,
    document_no     TEXT NOT NULL,

    status          TEXT NOT NULL DEFAULT 'QUEUED'
                    CHECK (status IN ('QUEUED','SUBMITTED','VALID','INVALID',
                                      'REJECTION_REQUESTED','CANCELLED')),

    /* Assigned by LHDN. */
    submission_uid  TEXT,
    lhdn_uuid       TEXT,
    long_id         TEXT,
    qr_url          TEXT,

    submitted_at    TIMESTAMPTZ,
    validated_at    TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,

    error_code      TEXT,
    error_detail    JSONB,
    attempt_count   SMALLINT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    /* One live submission per source document. */
    UNIQUE      (tenant_id, document_type, document_id),
    CHECK (status <> 'VALID' OR (lhdn_uuid IS NOT NULL AND validated_at IS NOT NULL))
);

CREATE INDEX einvoice_submission_status_idx
    ON einvoice_submission (tenant_id, status);
CREATE INDEX einvoice_submission_retry_idx
    ON einvoice_submission (next_attempt_at)
    WHERE status IN ('QUEUED','SUBMITTED');

-- -----------------------------------------------------------------------------
-- The payload exactly as sent.
--
-- When LHDN's records and ours disagree three years from now, this is the
-- evidence. Append-only, hashed, never regenerated — a payload rebuilt from
-- current data is not what was submitted.
-- -----------------------------------------------------------------------------
CREATE TABLE einvoice_payload (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    submission_id UUID NOT NULL,
    attempt_no    SMALLINT NOT NULL,
    document      JSONB NOT NULL,
    payload_hash  BYTEA NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, submission_id, attempt_no),
    FOREIGN KEY (tenant_id, submission_id) REFERENCES einvoice_submission (tenant_id, id) ON DELETE CASCADE
);

CREATE TRIGGER trg_einvoice_payload_append_only
    BEFORE UPDATE OR DELETE ON einvoice_payload
    FOR EACH ROW EXECUTE FUNCTION raise_append_only_violation();

-- -----------------------------------------------------------------------------
-- Every state change, with its actor. The compliance log an auditor reads.
-- -----------------------------------------------------------------------------
CREATE TABLE einvoice_status_event (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            BIGSERIAL,
    submission_id UUID NOT NULL,
    event_type    TEXT NOT NULL,
    from_status   TEXT,
    to_status     TEXT NOT NULL,
    actor         TEXT NOT NULL CHECK (actor IN ('SUPPLIER','BUYER','LHDN','SYSTEM')),
    reason        TEXT,
    raw_response  JSONB,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, submission_id) REFERENCES einvoice_submission (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX einvoice_status_event_submission_idx
    ON einvoice_status_event (tenant_id, submission_id, occurred_at);

CREATE TRIGGER trg_einvoice_status_event_append_only
    BEFORE UPDATE OR DELETE ON einvoice_status_event
    FOR EACH ROW EXECUTE FUNCTION raise_append_only_violation();

-- -----------------------------------------------------------------------------
-- A validated submission's identifiers are LHDN's, not ours. Once recorded
-- they are evidence and cannot be rewritten.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_validated_submission_rewrite() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.lhdn_uuid IS NOT NULL AND NEW.lhdn_uuid IS DISTINCT FROM OLD.lhdn_uuid THEN
        RAISE EXCEPTION
            'The LHDN UUID for document % is assigned by LHDN and cannot be changed',
            OLD.document_no
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.validated_at IS NOT NULL AND NEW.validated_at IS DISTINCT FROM OLD.validated_at THEN
        RAISE EXCEPTION
            'The validation timestamp for document % cannot be changed', OLD.document_no
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END $$;

CREATE TRIGGER trg_einvoice_submission_identifiers_immutable
    BEFORE UPDATE ON einvoice_submission
    FOR EACH ROW EXECUTE FUNCTION forbid_validated_submission_rewrite();

-- =============================================================================
-- RLS
-- =============================================================================
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'einvoice_config', 'einvoice_submission', 'einvoice_payload', 'einvoice_status_event'
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

    REVOKE UPDATE, DELETE ON einvoice_payload      FROM emil_app;
    REVOKE UPDATE, DELETE ON einvoice_status_event FROM emil_app;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO emil_app;
