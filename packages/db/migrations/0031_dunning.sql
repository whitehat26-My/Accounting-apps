-- =============================================================================
-- 0031_dunning
--
-- Payment follow-up: the three-tier escalation from the collections workflow.
--
-- -----------------------------------------------------------------------------
-- THE REMINDER LOG IS THE FEATURE. THE TRANSPORT IS A DETAIL.
--
-- No email transport exists yet (settlement register §4.4), and the design
-- treats that as a fact rather than a blocker: reminders are QUEUED with
-- their message text fully composed, a human sends them over WhatsApp (which
-- is how a Malaysian SME chases money anyway) and marks them SENT. When an
-- email transport arrives, a worker handler flips the same rows — the log,
-- the escalation state and the API do not change.
--
-- What must never happen is a customer chased for money they already paid:
-- the daily pass CANCELS queued reminders for invoices that have since been
-- settled, before it raises anything new.
-- -----------------------------------------------------------------------------

CREATE TABLE dunning_policy (
    tenant_id      UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    tier           SMALLINT NOT NULL CHECK (tier BETWEEN 1 AND 3),
    days_after_due INTEGER NOT NULL CHECK (days_after_due >= 1),
    tone           TEXT NOT NULL CHECK (tone IN ('FRIENDLY','FIRM','OWNER_ALERT')),
    is_enabled     BOOLEAN NOT NULL DEFAULT TRUE,

    PRIMARY KEY (tenant_id, tier)
);

CREATE TABLE payment_reminder (
    tenant_id   UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id          UUID NOT NULL DEFAULT gen_random_uuid(),
    invoice_id  UUID NOT NULL,
    tier        SMALLINT NOT NULL CHECK (tier BETWEEN 1 AND 3),
    tone        TEXT NOT NULL CHECK (tone IN ('FRIENDLY','FIRM','OWNER_ALERT')),
    /* Composed at queue time from the figures AS THEY WERE. A reminder is a
       statement made on a date; a payment arriving later must not rewrite
       what was (or would have been) sent. */
    message     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'QUEUED'
                CHECK (status IN ('QUEUED','SENT','CANCELLED')),
    /* How it actually went out: WHATSAPP, EMAIL, PHONE, OTHER. Null while
       queued. */
    channel     TEXT,
    queued_on   DATE NOT NULL,
    sent_at     TIMESTAMPTZ,
    sent_by     UUID,
    cancelled_reason TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice (tenant_id, id),

    /* One reminder per rung of the ladder, per invoice, forever. Re-raising a
       tier that was cancelled is a human decision made by queueing manually,
       not something the nightly job should flap on. */
    UNIQUE (tenant_id, invoice_id, tier),

    CONSTRAINT payment_reminder_sent_provenance CHECK (
        status <> 'SENT' OR (sent_at IS NOT NULL AND channel IS NOT NULL)
    ),
    CONSTRAINT payment_reminder_cancel_reason CHECK (
        status <> 'CANCELLED' OR cancelled_reason IS NOT NULL
    )
);

CREATE INDEX payment_reminder_queue_idx
    ON payment_reminder (tenant_id, status)
    WHERE status = 'QUEUED';
CREATE INDEX payment_reminder_invoice_idx
    ON payment_reminder (tenant_id, invoice_id);

-- -----------------------------------------------------------------------------
-- Permission: chasing is an act with a customer on the other end
-- -----------------------------------------------------------------------------
INSERT INTO app_permission (code, description) VALUES
    ('collections.chase',
     'Queue, send and cancel payment reminders, and run the follow-up pass');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('OWNER',      'collections.chase'),
    ('ADMIN',      'collections.chase'),
    ('ACCOUNTANT', 'collections.chase'),
    ('BOOKKEEPER', 'collections.chase');

-- -----------------------------------------------------------------------------
-- The daily job
-- -----------------------------------------------------------------------------
INSERT INTO scheduled_job (name, description, interval_seconds) VALUES
    ('payment-reminders',
     'Cancel queued reminders for invoices since paid, then raise the next '
     || 'escalation tier for every overdue invoice, message text composed and '
     || 'ready to send.',
     86400);

-- -----------------------------------------------------------------------------
-- RLS + audit (rule 3, 0016)
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['dunning_policy', 'payment_reminder'] LOOP
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
