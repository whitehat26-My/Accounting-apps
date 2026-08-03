-- =============================================================================
-- 0013_bill_approval
--
-- Bill approval: threshold routing and separation of duties.
--
-- Deferred out of M3 on purpose and built now, because it could not be built
-- before. Threshold routing without users points at bare UUIDs, and separation
-- of duties cannot be enforced by a system with no concept of two people.
--
-- =============================================================================
-- APPROVAL GATES PAYMENT, NOT RECOGNITION.
--
-- Note what this migration does NOT do: it does not add a status that holds a
-- bill out of the ledger.
--
-- If the goods arrived and the supplier has invoiced, the obligation EXISTS.
-- Accrual accounting recognises it when it is incurred, not when someone
-- internal authorises payment. A bill held out of the ledger pending approval
-- understates payables and expenses — and does so worst at period end, which is
-- exactly when unapproved bills pile up.
--
-- So a bill still posts on entry. What approval controls is whether money may
-- LEAVE: `paySupplier()` refuses a bill whose approval is outstanding. This is
-- internal control over cash, not a lever over the general ledger.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Routing rules
--
-- Bands may overlap on purpose: "over RM 1,000 needs an Accountant" and "over
-- RM 10,000 ALSO needs an Owner" is two rules, and a large bill picks up both.
-- -----------------------------------------------------------------------------
CREATE TABLE approval_rule (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    /* Inclusive lower bound. */
    min_amount    NUMERIC(19,4) NOT NULL CHECK (min_amount >= 0),
    /* Inclusive upper bound; NULL means unbounded. */
    max_amount    NUMERIC(19,4) CHECK (max_amount >= 0),
    required_role TEXT NOT NULL REFERENCES app_role (code),
    /* 1-based. Two rules over one band, sequences 1 and 2, mean two approvers. */
    sequence      SMALLINT NOT NULL CHECK (sequence >= 1),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, name),
    CHECK (max_amount IS NULL OR max_amount >= min_amount)
);

CREATE INDEX approval_rule_active_idx
    ON approval_rule (tenant_id, sequence) WHERE is_active;

-- -----------------------------------------------------------------------------
-- One request per bill that needs approval.
--
-- `required_steps` is a SNAPSHOT of the rules that applied when the bill was
-- entered, not a reference to them.
--
-- That matters: raising a threshold later must not make a past approval look
-- unnecessary, and lowering one must not make a past approval look
-- insufficient. An auditor asking "who was required to approve this, and did
-- they" needs the answer that was true at the time, and a live join to
-- `approval_rule` cannot give it.
-- -----------------------------------------------------------------------------
CREATE TABLE approval_request (
    tenant_id      UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    bill_id        UUID NOT NULL,
    /* [{ sequence, requiredRole, ruleId }, ...] as at the moment of entry. */
    required_steps JSONB NOT NULL,
    /* The amount the routing was decided on, for the same reason. */
    amount         NUMERIC(19,4) NOT NULL,
    status         TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
    /* Never permitted to approve their own request. */
    requested_by   UUID,
    requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at     TIMESTAMPTZ,

    PRIMARY KEY (tenant_id, id),
    /* One request per bill. A second would let a rejected bill be re-routed
       quietly rather than corrected with a debit note. */
    UNIQUE      (tenant_id, bill_id),
    FOREIGN KEY (tenant_id, bill_id) REFERENCES bill (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX approval_request_pending_idx
    ON approval_request (tenant_id, requested_at) WHERE status = 'PENDING';

-- -----------------------------------------------------------------------------
-- Decisions — APPEND-ONLY.
--
-- A decision is a person's statement about a payment. Editing one afterwards
-- would make the approval trail worthless, which is the same reasoning that
-- makes the ledger and the audit log append-only. A mistaken approval is
-- corrected by rejecting the bill or by a debit note, never by rewriting who
-- said what.
-- -----------------------------------------------------------------------------
CREATE TABLE approval_decision (
    tenant_id        UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id               UUID NOT NULL DEFAULT gen_random_uuid(),
    request_id       UUID NOT NULL,
    sequence         SMALLINT NOT NULL CHECK (sequence >= 1),
    decision         TEXT NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
    decided_by       UUID NOT NULL REFERENCES app_user (id),
    /* The role held AT THE MOMENT OF DECIDING, recorded rather than looked up
       later — a promotion afterwards must not retroactively validate a
       decision, nor a demotion invalidate one. */
    role_at_decision TEXT NOT NULL REFERENCES app_role (code),
    comment          TEXT,
    decided_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    /* One decision per step. */
    UNIQUE      (tenant_id, request_id, sequence),
    /* And one decision per PERSON per request: "a second approver" means a
       second person, and at a small company one user often holds both roles.
       Enforced here as well as in the domain, because this is the control the
       whole feature exists to provide. */
    UNIQUE      (tenant_id, request_id, decided_by),
    FOREIGN KEY (tenant_id, request_id) REFERENCES approval_request (tenant_id, id) ON DELETE CASCADE
);

CREATE TRIGGER trg_approval_decision_append_only
    BEFORE UPDATE OR DELETE ON approval_decision
    FOR EACH ROW EXECUTE FUNCTION raise_append_only_violation();

/*
 * The requester can never approve their own bill.
 *
 * In the database as well as the domain. This is THE control — an approval
 * workflow where the person who raised the bill can authorise it records a
 * click and controls nothing — and a control that lives only in application
 * code is one a future service, a script or a bulk import can walk around.
 */
CREATE OR REPLACE FUNCTION forbid_self_approval() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_requested_by UUID;
BEGIN
    SELECT requested_by INTO v_requested_by
      FROM approval_request
     WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;

    IF v_requested_by IS NOT NULL AND v_requested_by = NEW.decided_by THEN
        RAISE EXCEPTION
            'A bill cannot be approved by the person who entered it (user %).', NEW.decided_by
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_forbid_self_approval
    BEFORE INSERT ON approval_decision
    FOR EACH ROW EXECUTE FUNCTION forbid_self_approval();

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY['approval_rule', 'approval_request', 'approval_decision'];
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

    REVOKE UPDATE, DELETE ON approval_decision FROM emil_app;
END $$;

-- An approval decision is one of the acts an auditor asks about by name.
ALTER TABLE financial_event_log DROP CONSTRAINT financial_event_log_event_type_check;
ALTER TABLE financial_event_log
    ADD CONSTRAINT financial_event_log_event_type_check
        CHECK (event_type IN (
            'LOCKED_PERIOD_OVERRIDE',
            'PERIOD_LOCKED',
            'PERIOD_UNLOCKED',
            'BANK_DETAILS_CHANGED',
            'ROLE_CHANGED',
            'API_KEY_ISSUED',
            'API_KEY_REVOKED',
            'RECONCILIATION_COMPLETED',
            'YEAR_END_CLOSED',
            'BILL_APPROVED',
            'BILL_REJECTED'));
