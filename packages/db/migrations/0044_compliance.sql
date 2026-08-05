-- =============================================================================
-- 0044 — The compliance calendar: deadlines as DATA, filings as auditable acts
--
-- "Remember the deadlines" is most of what a shop pays a firm's retainer for.
-- This migration makes the deadlines rows (rule 7: statutory values are
-- effective-dated data, never constants in code) and makes "we filed it" an
-- auditable tenant fact.
--
-- PROVENANCE, honestly graded. Every rule carries `verification`:
--   PRIMARY   — stated by a document committed under docs/research/sources/
--               (the LHDN Navigasi HASiL 2026 guide covers CP39, Form E, EA).
--   SECONDARY — the agency's own page, confirmed by excerpt but not yet
--               retrievable through this environment's proxy; the URL to
--               promote it sits in compliance-deadlines-provenance.md.
-- The UI SHOWS the grade. A deadline the system is less than sure of must
-- look less than sure. See the provenance file for the quoted statements.
-- =============================================================================

-- Global reference data, like the statutory contribution schedules: which
-- country-level deadline exists is not a tenant opinion.
CREATE TABLE statutory_deadline_rule (
    code             TEXT NOT NULL,
    label            TEXT NOT NULL,
    description      TEXT NOT NULL,
    /*
     * MONTHLY   — one instance per month, due in the FOLLOWING month.
     * BIMONTHLY — SST's taxable periods (Jan–Feb, Mar–Apr, …), due in the
     *             month after the period ends.
     * ANNUAL    — one instance per year, covering the PREVIOUS year.
     */
    frequency        TEXT NOT NULL CHECK (frequency IN ('MONTHLY', 'BIMONTHLY', 'ANNUAL')),
    /* Day of the due month; NULL = the last day of that month. A 29–31 is
       only safe when due_month pins a month that has it (Form E: 31 March). */
    due_day          SMALLINT CHECK (due_day BETWEEN 1 AND 31),
    /* ANNUAL only: which month of the year it falls due (Form E: 3; EA: 2). */
    due_month        SMALLINT CHECK (due_month BETWEEN 1 AND 12),
    /* PAYROLL: only when staff exist. SST: only when the org holds an SST no. */
    applies_when     TEXT NOT NULL CHECK (applies_when IN ('PAYROLL', 'SST', 'ALWAYS')),
    legislation_ref  TEXT NOT NULL,
    verification     TEXT NOT NULL CHECK (verification IN ('PRIMARY', 'SECONDARY')),
    effective_from   DATE NOT NULL,
    effective_to     DATE,

    PRIMARY KEY (code, effective_from),
    CHECK ((frequency = 'ANNUAL') = (due_month IS NOT NULL))
);

GRANT SELECT ON statutory_deadline_rule TO emil_app;

INSERT INTO statutory_deadline_rule
    (code, label, description, frequency, due_day, due_month, applies_when,
     legislation_ref, verification, effective_from)
VALUES
    ('EPF_CONTRIBUTION', 'EPF contributions',
     'Pay the month''s EPF (KWSP) contributions — both shares. Late payment attracts a charge plus dividend.',
     'MONTHLY', 15, NULL, 'PAYROLL',
     'EPF Act 1991; KWSP employer guidance (mandatory-contribution page)', 'SECONDARY',
     '2026-01-01'),
    ('SOCSO_EIS_CONTRIBUTION', 'SOCSO + EIS contributions',
     'Pay the month''s PERKESO contributions (SOCSO and EIS together). Late payment bears interest at 6% p.a.',
     'MONTHLY', 15, NULL, 'PAYROLL',
     'Employees'' Social Security (General) Regulations 1971 reg. 33; EIS Act 800; PERKESO payment page', 'SECONDARY',
     '2026-01-01'),
    ('PCB_CP39', 'PCB (income tax) — CP39',
     'Remit the month''s PCB deductions to LHDN with the CP39 file this app generates from the confirmed pay run.',
     'MONTHLY', 15, NULL, 'PAYROLL',
     'Income Tax (Deduction from Remuneration) Rules 1994 r.10; LHDN Navigasi HASiL 2026 p.30', 'PRIMARY',
     '2026-01-01'),
    ('SST_RETURN', 'SST-02 return + payment',
     'File the SST-02 for the two-month taxable period and pay the tax declared.',
     'BIMONTHLY', NULL, NULL, 'SST',
     'Sales Tax Act 2018 / Service Tax Act 2018 s.26; RMCD MySST filing guidance', 'SECONDARY',
     '2026-01-01'),
    ('EA_TO_STAFF', 'EA forms to every employee',
     'Hand every person employed during the year their EA (C.P.8A) statement of remuneration.',
     'ANNUAL', NULL, 2, 'PAYROLL',
     'ITA 1967 s.83(1A); LHDN Navigasi HASiL 2026 p.58 (last day of February)', 'PRIMARY',
     '2026-01-01'),
    ('FORM_E', 'Form E + C.P.8D to LHDN',
     'File the employer''s return for last year: Form e-E with the C.P.8D employee details.',
     'ANNUAL', 31, 3, 'PAYROLL',
     'ITA 1967 s.83(1); LHDN Navigasi HASiL 2026 p.53 (on/before 31 March)', 'PRIMARY',
     '2026-01-01');

-- ---------------------------------------------------------------------------
-- The tick: "we filed this one, for this period" — a tenant fact with a name
-- and a timestamp on it, because an auditor's question is exactly that.
-- Unticking is DELETE; the audit trigger keeps the record of both acts.
-- ---------------------------------------------------------------------------
CREATE TABLE compliance_tick (
    tenant_id   UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id          UUID NOT NULL DEFAULT gen_random_uuid(),
    rule_code   TEXT NOT NULL,
    /* '2026-08' for a monthly, '2026-P4' for an SST period, '2025' for annual. */
    period_key  TEXT NOT NULL,
    note        TEXT,
    ticked_by   UUID,
    ticked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, rule_code, period_key)
);

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['compliance_tick'] LOOP
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
-- Permissions. Reading the calendar is bookkeeping visibility; ticking
-- "filed" is asserting a fact about the shop's statutory position, which is
-- the same weight as closing a period — so it sits with the same roles.
-- ---------------------------------------------------------------------------
INSERT INTO app_permission (code, description) VALUES
    ('compliance.read',   'See the statutory deadline calendar and its statuses'),
    ('compliance.manage', 'Mark statutory filings as done (and undo a mistaken tick)');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('OWNER',            'compliance.read'), ('OWNER',      'compliance.manage'),
    ('ADMIN',            'compliance.read'), ('ADMIN',      'compliance.manage'),
    ('ACCOUNTANT',       'compliance.read'), ('ACCOUNTANT', 'compliance.manage'),
    ('APPROVER',         'compliance.read'),
    ('BOOKKEEPER',       'compliance.read'),
    ('EXTERNAL_AUDITOR', 'compliance.read');
