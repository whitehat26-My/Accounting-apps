-- =============================================================================
-- 0039 — Payroll runs: employees, monthly pay runs, and the ledger posting
--
-- Until now payroll was a calculator: the four statutory engines (0037, 0038)
-- answered for one wage at a time, and the user retyped year-to-date figures
-- every month — which is precisely the bookkeeping a shop pays a firm to keep.
-- This migration gives the figures somewhere to live, so last month's confirmed
-- run IS this month's accumulated X, Y and K in the MTD formula.
--
-- -----------------------------------------------------------------------------
-- THE RUN IS A SNAPSHOT, NOT A VIEW.
--
-- `pay_run_line` copies both the employee's identity and every computed figure
-- at confirmation time. A payslip regenerated in two years must show what was
-- actually paid, not what the employee record says by then — same reasoning as
-- the invoice PDF reading stored data. The employee row is the living record;
-- the line is the historical one; neither pretends to be the other.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Employees.
--
-- The minimum the statutes need, and no more. Age is NOT a column: EPF Part E,
-- SOCSO Category 2 and EIS exclusion all switch at 60, so age is computed from
-- date_of_birth at each contribution month — a stored age is wrong within a
-- year. The ytd_* columns are the TP3 case: a mid-year hire arrives with
-- accumulated pay from a previous employer, and the MTD formula must know it.
-- ---------------------------------------------------------------------------
CREATE TABLE employee (
    tenant_id       UUID NOT NULL REFERENCES organisation (id),
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    employee_no     TEXT,
    full_name       TEXT NOT NULL CHECK (length(full_name) BETWEEN 1 AND 120),
    -- NRIC or passport, as on `contact`. Optional: a payslip is useful without
    -- it, but the CP39 detail record has columns for it, so it is worth having.
    id_type         TEXT CHECK (id_type IN ('NRIC', 'PASSPORT')),
    id_value        TEXT,
    -- LHDN Tax Identification Number — the CP39 detail record's first field.
    tin             TEXT,
    date_of_birth   DATE NOT NULL,
    citizenship     TEXT NOT NULL CHECK (citizenship IN ('CITIZEN', 'PERMANENT_RESIDENT', 'NON_CITIZEN')),

    -- Who they are for income tax. No defaults on category: guessing "single"
    -- over-deducts a married sole earner by RM4,000 of relief a year.
    tax_resident    BOOLEAN NOT NULL,
    tax_category    SMALLINT NOT NULL CHECK (tax_category IN (1, 2, 3)),
    -- C, not the number of children: a child in tertiary education counts as
    -- four, a disabled child in tertiary education as eight (spec p.27).
    qualifying_children SMALLINT NOT NULL DEFAULT 0 CHECK (qualifying_children BETWEEN 0 AND 40),
    disabled        BOOLEAN NOT NULL DEFAULT FALSE,
    disabled_spouse BOOLEAN NOT NULL DEFAULT FALSE,

    -- The three rare statutory flags, modelled rather than assumed away.
    epf_elected_before_1998    BOOLEAN NOT NULL DEFAULT FALSE,
    on_invalidity_pension      BOOLEAN NOT NULL DEFAULT FALSE,
    had_eis_contribution_before_57 BOOLEAN NOT NULL DEFAULT FALSE,

    monthly_wage    NUMERIC(19,4) NOT NULL CHECK (monthly_wage >= 0),
    job_title       TEXT,
    hired_on        DATE NOT NULL,
    left_on         DATE CHECK (left_on IS NULL OR left_on >= hired_on),

    -- What a previous employer already paid and deducted THIS year (Form TP3).
    -- ytd_year says which year the figures belong to, so stale carry-over from
    -- a previous calendar year is ignored rather than silently applied.
    ytd_year         SMALLINT,
    ytd_gross_before NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (ytd_gross_before >= 0),
    ytd_epf_before   NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (ytd_epf_before >= 0),
    ytd_mtd_before   NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (ytd_mtd_before >= 0),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- A month's pay run.
--
-- DRAFT is a proposal and can be regenerated freely; CONFIRMED has a journal
-- entry behind it and is immutable; REVERSED means the journal was reversed
-- through `reversePostedEntry()` (rule 1 — corrections are reversing entries)
-- and the month may be run again.
-- ---------------------------------------------------------------------------
CREATE TABLE pay_run (
    tenant_id       UUID NOT NULL REFERENCES organisation (id),
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    run_no          TEXT NOT NULL,
    -- Always the FIRST of the month. The day carries no information and letting
    -- it vary would make "one run per month" unenforceable.
    pay_month       DATE NOT NULL CHECK (EXTRACT(DAY FROM pay_month) = 1),
    status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED', 'REVERSED')),
    journal_entry_id UUID,
    confirmed_by    UUID,
    confirmed_at    TIMESTAMPTZ,
    created_idempotency_key TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, run_no),
    UNIQUE      (tenant_id, created_idempotency_key),
    FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entry (tenant_id, id),
    -- A confirmed run must carry its journal; anything else must not.
    CHECK ((status = 'CONFIRMED') = (journal_entry_id IS NOT NULL) OR status = 'REVERSED')
);

-- One CONFIRMED run per month. Partial, so a reversed month can be re-run and
-- drafts can be regenerated without fighting the constraint.
CREATE UNIQUE INDEX pay_run_one_confirmed_per_month
    ON pay_run (tenant_id, pay_month)
 WHERE status = 'CONFIRMED';

-- ---------------------------------------------------------------------------
-- One employee's month, frozen.
-- ---------------------------------------------------------------------------
CREATE TABLE pay_run_line (
    tenant_id       UUID NOT NULL REFERENCES organisation (id),
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    pay_run_id      UUID NOT NULL,
    employee_id     UUID NOT NULL,

    -- Identity as at the run, for payslips and CP39 reprints. The employee row
    -- may change or the person may leave; this line must not follow.
    full_name       TEXT NOT NULL,
    employee_no     TEXT,
    tin             TEXT,
    id_type         TEXT,
    id_value        TEXT,

    wage            NUMERIC(19,4) NOT NULL CHECK (wage >= 0),
    bonus           NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (bonus >= 0),
    gross           NUMERIC(19,4) NOT NULL CHECK (gross >= 0),

    -- Which schedule applied — the payslip prints these, and an auditor asks.
    epf_part        TEXT NOT NULL CHECK (epf_part IN ('A', 'C', 'E', 'F')),
    socso_category  SMALLINT NOT NULL CHECK (socso_category IN (1, 2)),
    eis_applies     BOOLEAN NOT NULL,
    non_resident    BOOLEAN NOT NULL DEFAULT FALSE,

    epf_employee    NUMERIC(19,4) NOT NULL CHECK (epf_employee >= 0),
    epf_employer    NUMERIC(19,4) NOT NULL CHECK (epf_employer >= 0),
    -- SOCSO's employee side is TWO deductions collected together, and PERKESO's
    -- statement splits them. Stored apart because they are apart in the schedule.
    socso_employee_invalidity NUMERIC(19,4) NOT NULL CHECK (socso_employee_invalidity >= 0),
    socso_employee_skbbk      NUMERIC(19,4) NOT NULL CHECK (socso_employee_skbbk >= 0),
    socso_employer  NUMERIC(19,4) NOT NULL CHECK (socso_employer >= 0),
    eis_employee    NUMERIC(19,4) NOT NULL CHECK (eis_employee >= 0),
    eis_employer    NUMERIC(19,4) NOT NULL CHECK (eis_employer >= 0),
    pcb             NUMERIC(19,4) NOT NULL CHECK (pcb >= 0),
    pcb_on_bonus    NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (pcb_on_bonus >= 0),
    chargeable_income NUMERIC(19,4) NOT NULL,

    total_deducted  NUMERIC(19,4) NOT NULL CHECK (total_deducted >= 0),
    net_pay         NUMERIC(19,4) NOT NULL,

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, pay_run_id, employee_id),
    FOREIGN KEY (tenant_id, pay_run_id)
        REFERENCES pay_run (tenant_id, id) ON DELETE CASCADE,
    -- RESTRICT on purpose: an employee who has ever been paid cannot be
    -- deleted, only marked as left. The history is the point.
    FOREIGN KEY (tenant_id, employee_id)
        REFERENCES employee (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX pay_run_line_by_employee ON pay_run_line (tenant_id, employee_id);

-- ---------------------------------------------------------------------------
-- RLS + audit (rule 3, 0016)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['employee', 'pay_run', 'pay_run_line'] LOOP
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

-- ---------------------------------------------------------------------------
-- Where the money posts. Restated from the LIVE constraint in 0026 — never
-- from an older migration; restating from a stale copy once silently dropped
-- a role (see 0014's note).
--
-- Wages and the employer's statutory share are separate expenses because they
-- answer different questions: "what do I pay my staff" and "what does
-- employing them cost on top". Each payable gets its own account because each
-- is owed to a different authority, and a bank payment to PERKESO must clear
-- PERKESO's balance, not a blended one.
-- ---------------------------------------------------------------------------
ALTER TABLE posting_account_map DROP CONSTRAINT posting_account_map_role_check;
ALTER TABLE posting_account_map
    ADD CONSTRAINT posting_account_map_role_check
        CHECK (role IN ('AR','AP','SST_PAYABLE','SST_CLAIMABLE',
                        'ROUNDING','FX_GAIN_LOSS','RETAINED_EARNINGS',
                        'UNDEPOSITED_FUNDS','SUSPENSE',
                        'AR_REVALUATION','UNREALISED_FX','AP_REVALUATION',
                        'WHT_PAYABLE',
                        'GATEWAY_FEE',
                        'INVENTORY','COGS',
                        'STOCK_SHRINKAGE',
                        'WAGES_EXPENSE','EMPLOYER_STATUTORY_EXPENSE',
                        'EPF_PAYABLE','SOCSO_PAYABLE','EIS_PAYABLE',
                        'PCB_PAYABLE','NET_WAGES_PAYABLE'));

-- ---------------------------------------------------------------------------
-- Events. Same restate-from-live rule (0026 is the live list).
-- ---------------------------------------------------------------------------
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
            'YEAR_END_REOPENED',
            'GATEWAY_CONFIG_CHANGED',
            'GATEWAY_SETTLEMENT_POSTED',
            'BILL_APPROVED',
            'BILL_REJECTED',
            'CHART_OF_ACCOUNTS_CHANGED',
            'STATUTORY_RATE_CHANGED',
            'TAX_RETURN_SUBMITTED',
            'TAX_RETURN_AMENDED',
            'CASH_FLOW_CLASSIFICATION_CHANGED',
            'STOCK_COUNTED',
            'PAY_RUN_CONFIRMED',
            'PAY_RUN_REVERSED'
        ));

-- ---------------------------------------------------------------------------
-- The LHDN employer number (E number) — the first field of every CP39 record.
-- Nullable: the run works without it, and the CP39 export refuses loudly,
-- naming where to set it, rather than emitting a file LHDN will reject.
-- ---------------------------------------------------------------------------
ALTER TABLE organisation ADD COLUMN lhdn_employer_no TEXT;

-- ---------------------------------------------------------------------------
-- Confirming a run moves money; keeping the staff register does not — but the
-- register holds every salary, so both sit behind their own permission rather
-- than borrowing one. `payroll.read` (0037) remains the view-only permission.
-- ---------------------------------------------------------------------------
INSERT INTO app_permission (code, description) VALUES
    ('payroll.manage', 'Keep staff records and confirm pay runs')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('OWNER', 'payroll.manage'),
    ('ADMIN', 'payroll.manage'),
    ('ACCOUNTANT', 'payroll.manage')
ON CONFLICT DO NOTHING;
