-- =============================================================================
-- 0020_cash_flow
--
-- The classification a cash flow statement needs and a chart of accounts
-- cannot supply.
--
-- packages/domain/src/cash-flow.ts derives the statement from actual movements
-- on the cash accounts, decomposed by the contra side of each entry. That part
-- is arithmetic and needs no configuration. What it cannot derive is whether a
-- given contra account represents OPERATING, INVESTING or FINANCING activity:
--
--   * an ASSET might be a receivable (operating) or a delivery van (investing)
--   * a LIABILITY might be a trade payable (operating) or a term loan
--     (financing)
--
-- `account.type` does not distinguish them, and defaulting either one into
-- operating — the usual shortcut — misstates the single figure a lender reads
-- first. So the decision is DATA, recorded per account, with the person and
-- moment that recorded it, and the statement reports whatever has not been
-- decided instead of guessing.
--
-- Income, expense and equity accounts need no row here: their type IS
-- conclusive, and the domain resolves them without configuration. A row is only
-- needed where a judgement was actually made.
-- =============================================================================

CREATE TABLE cash_flow_classification (
    tenant_id      UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    account_id     UUID NOT NULL,
    classification TEXT NOT NULL
                   CHECK (classification IN ('OPERATING','INVESTING','FINANCING')),
    /* Why this account was classified this way. Optional, and worth having:
       the next person to look at a term loan classified as operating deserves
       to find the reasoning rather than reverse-engineer it. */
    note           TEXT CHECK (note IS NULL OR length(note) <= 500),
    decided_by     UUID NOT NULL,
    decided_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, account_id),
    FOREIGN KEY (tenant_id, account_id) REFERENCES account (tenant_id, id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- Cash and cash equivalents — the pool the statement measures
--
-- Two independent sources, deliberately, and the view unions them:
--
--   * `bank_account.gl_account_id` — a GL account backing a real bank, cash or
--     e-wallet account IS cash, by construction. Nothing to configure.
--   * the `cash_and_bank` tag — how the global statement templates already
--     address cash (0009_reporting.sql), and the escape hatch for petty cash or
--     a cash-equivalent deposit that has no bank_account row.
--
-- CREDIT_CARD is excluded. A card is a liability the business owes, not cash it
-- holds, and folding one into the cash pool understates borrowings and turns
-- drawing on the card into an operating inflow.
--
-- `security_invoker = true` is load-bearing: a view runs as its OWNER by
-- default, which would bypass the RLS on both underlying tables and expose
-- every tenant's cash accounts to every tenant.
-- -----------------------------------------------------------------------------
CREATE VIEW cash_account AS
    SELECT b.tenant_id, b.gl_account_id AS account_id
      FROM bank_account b
     WHERE b.account_type IN ('BANK','CASH','EWALLET')
    UNION
    SELECT t.tenant_id, t.account_id
      FROM account_tag t
     WHERE t.tag = 'cash_and_bank';

ALTER VIEW cash_account SET (security_invoker = true);

GRANT SELECT ON cash_account TO emil_app;

-- -----------------------------------------------------------------------------
-- Changing a classification changes every cash flow statement ever printed
--
-- Which makes it exactly the kind of configuration change an auditor asks about
-- by name: the same treatment `GATEWAY_CONFIG_CHANGED` and
-- `STATUTORY_RATE_CHANGED` get.
--
-- The list is restated in full because the CHECK is replaced wholesale. It must
-- be read from the LIVE constraint before editing, never copied from an older
-- migration — doing the latter once silently dropped 0013's BILL_APPROVED and
-- BILL_REJECTED, and the approval suite is what caught it.
-- -----------------------------------------------------------------------------
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
            'GATEWAY_CONFIG_CHANGED',
            'GATEWAY_SETTLEMENT_POSTED',
            'BILL_APPROVED',
            'BILL_REJECTED',
            'CHART_OF_ACCOUNTS_CHANGED',
            'STATUTORY_RATE_CHANGED',
            'TAX_RETURN_SUBMITTED',
            'TAX_RETURN_AMENDED',
            'CASH_FLOW_CLASSIFICATION_CHANGED'));

-- No new permission. The general ledger detail report is `journal.read`, which
-- already exists and already means exactly this; classifying an account is
-- `org.manage`, the same permission that governs the chart of accounts it
-- annotates. Minting a permission for each new route is how a role matrix stops
-- describing anything.

-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE cash_flow_classification ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_flow_classification FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON cash_flow_classification
    USING      (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON cash_flow_classification TO emil_app;

-- 0016 installs the audit trigger by sweep, but that sweep has already run.
CREATE TRIGGER trg_audit_cash_flow_classification
    AFTER INSERT OR UPDATE OR DELETE ON cash_flow_classification
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('tenant_id');
