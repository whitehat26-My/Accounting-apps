-- =============================================================================
-- 0009_reporting
--
-- M7: statement layouts as data.
--
-- Two structural decisions, both explained in packages/domain/src/report.ts:
--
--  * Lines claim accounts by TAG, account id, or account type — never by code
--    range. `account.code` is TEXT, so a '4000-4999' range is a string
--    comparison and '10000' < '4000'. A tenant migrating from AutoCount or SQL
--    Account with a five-digit chart would have accounts silently swallowed.
--
--  * Templates are GLOBAL reference data with no tenant_id, exactly like
--    einvoice_classification_code. The spec suggested a nullable tenant_id for
--    system definitions, but that breaks the rule that tenant_id is NOT NULL
--    and first in the PK — and worse, `tenant_id = current_tenant_id()`
--    evaluates to NULL for a NULL tenant_id, so RLS would deny every read and
--    nobody could see the system layouts at all.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Account tags.
--
-- How a global template addresses a tenant's chart of accounts without knowing
-- its ids or its numbering. The AR control account and the AR revaluation
-- account both carry 'trade_receivables', so they present on one statement
-- line with zero per-tenant configuration — which is what makes the
-- invariant-#6-preserving design in revaluation.ts present correctly.
-- -----------------------------------------------------------------------------
CREATE TABLE account_tag (
    tenant_id  UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    account_id UUID NOT NULL,
    tag        TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, account_id, tag),
    FOREIGN KEY (tenant_id, account_id) REFERENCES account (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX account_tag_lookup_idx ON account_tag (tenant_id, tag);

-- -----------------------------------------------------------------------------
-- Statement templates — global, read-only to tenants.
-- -----------------------------------------------------------------------------
CREATE TABLE report_template (
    id          TEXT PRIMARY KEY,
    report_type TEXT NOT NULL CHECK (report_type IN ('TRIAL_BALANCE','SOPL','SOFP')),
    framework   TEXT NOT NULL CHECK (framework IN ('MPERS','MFRS')),
    name        TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,

    UNIQUE (report_type, framework, version)
);

CREATE TABLE report_template_line (
    id               TEXT PRIMARY KEY,
    template_id      TEXT NOT NULL REFERENCES report_template (id) ON DELETE CASCADE,
    sequence         INTEGER NOT NULL,
    label            TEXT NOT NULL,
    level            SMALLINT NOT NULL DEFAULT 0,
    line_type        TEXT NOT NULL
                     CHECK (line_type IN ('HEADER','DETAIL','SUBTOTAL','TOTAL','CALC')),
    /* The SUBTOTAL/TOTAL this line rolls into. Display order is `sequence`
       and is independent, so a total still prints below its children. */
    parent_line_id   TEXT REFERENCES report_template_line (id) ON DELETE SET NULL,
    calc_key         TEXT CHECK (calc_key IN
                       ('CURRENT_YEAR_EARNINGS','RETAINED_EARNINGS_BROUGHT_FORWARD')),
    sign_convention  TEXT NOT NULL DEFAULT 'NATURAL'
                     CHECK (sign_convention IN ('NATURAL','INVERTED')),

    UNIQUE (template_id, sequence),
    CHECK (line_type <> 'CALC' OR calc_key IS NOT NULL)
);

CREATE TABLE report_template_line_map (
    id             BIGSERIAL PRIMARY KEY,
    line_id        TEXT NOT NULL REFERENCES report_template_line (id) ON DELETE CASCADE,
    match_type     TEXT NOT NULL CHECK (match_type IN ('ACCOUNT_ID','TAG','ACCOUNT_TYPE')),
    match_value    TEXT NOT NULL,
    priority       INTEGER NOT NULL DEFAULT 1,

    UNIQUE (line_id, match_type, match_value)
);

GRANT SELECT ON report_template, report_template_line, report_template_line_map TO emil_app;

-- -----------------------------------------------------------------------------
-- The rollup is aggregated by period range for every statement, but its PK is
-- (tenant_id, account_id, fiscal_period_id, currency) — the wrong prefix for
-- that. A covering index makes the balance sheet an index-only scan.
-- -----------------------------------------------------------------------------
CREATE INDEX account_period_balance_period_idx
    ON account_period_balance (tenant_id, fiscal_period_id, account_id)
    INCLUDE (debit_total, credit_total, net_movement);

-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE account_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_tag FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON account_tag
    USING      (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON account_tag TO emil_app;

-- =============================================================================
-- The MPERS system templates.
--
-- Deliberately shallow. A deeper chart (current vs non-current, cost of sales
-- vs operating expenses) needs `account.subtype` populated, which it is not —
-- that is a separate piece of work, and inventing a classification here would
-- put a number on a statement that nothing verifies.
-- =============================================================================
INSERT INTO report_template (id, report_type, framework, name) VALUES
    ('mpers-sopl-v1', 'SOPL', 'MPERS', 'Statement of Profit or Loss'),
    ('mpers-sofp-v1', 'SOFP', 'MPERS', 'Statement of Financial Position');

-- --- SOPL --------------------------------------------------------------------
INSERT INTO report_template_line
    (id, template_id, sequence, label, level, line_type, parent_line_id, calc_key, sign_convention)
VALUES
    ('sopl-total',    'mpers-sopl-v1', 100, 'Profit for the period', 0, 'TOTAL',  NULL, NULL, 'INVERTED'),
    ('sopl-revenue',  'mpers-sopl-v1',  10, 'Revenue',               1, 'DETAIL', 'sopl-total', NULL, 'INVERTED'),
    ('sopl-expenses', 'mpers-sopl-v1',  20, 'Expenses',              1, 'DETAIL', 'sopl-total', NULL, 'INVERTED');

INSERT INTO report_template_line_map (line_id, match_type, match_value, priority) VALUES
    ('sopl-revenue',  'ACCOUNT_TYPE', 'INCOME',  1),
    ('sopl-expenses', 'ACCOUNT_TYPE', 'EXPENSE', 1);

-- --- SOFP --------------------------------------------------------------------
INSERT INTO report_template_line
    (id, template_id, sequence, label, level, line_type, parent_line_id, calc_key, sign_convention)
VALUES
    ('sofp-h-assets',  'mpers-sofp-v1',  10, 'ASSETS',                        0, 'HEADER', NULL, NULL, 'NATURAL'),
    ('sofp-cash',      'mpers-sofp-v1',  20, 'Cash and bank balances',        1, 'DETAIL', 'sofp-t-assets', NULL, 'NATURAL'),
    ('sofp-ar',        'mpers-sofp-v1',  30, 'Trade and other receivables',   1, 'DETAIL', 'sofp-t-assets', NULL, 'NATURAL'),
    ('sofp-other-ast', 'mpers-sofp-v1',  40, 'Other assets',                  1, 'DETAIL', 'sofp-t-assets', NULL, 'NATURAL'),
    ('sofp-t-assets',  'mpers-sofp-v1',  50, 'Total assets',                  0, 'TOTAL',  NULL, NULL, 'NATURAL'),

    ('sofp-h-eqliab',  'mpers-sofp-v1',  60, 'EQUITY AND LIABILITIES',        0, 'HEADER', NULL, NULL, 'NATURAL'),
    ('sofp-ap',        'mpers-sofp-v1',  70, 'Trade and other payables',      1, 'DETAIL', 'sofp-t-eqliab', NULL, 'INVERTED'),
    ('sofp-equity',    'mpers-sofp-v1',  80, 'Share capital and reserves',    1, 'DETAIL', 'sofp-t-eqliab', NULL, 'INVERTED'),
    ('sofp-cye',       'mpers-sofp-v1',  90, 'Current year earnings',         1, 'CALC',   'sofp-t-eqliab', 'CURRENT_YEAR_EARNINGS', 'INVERTED'),
    ('sofp-t-eqliab',  'mpers-sofp-v1', 100, 'Total equity and liabilities',  0, 'TOTAL',  NULL, NULL, 'INVERTED');

INSERT INTO report_template_line_map (line_id, match_type, match_value, priority) VALUES
    -- Tags first, so a tenant's own numbering is irrelevant.
    ('sofp-cash',      'TAG',          'cash_and_bank',      10),
    ('sofp-ar',        'TAG',          'trade_receivables',  10),
    ('sofp-ap',        'TAG',          'trade_payables',     10),
    -- Then the completeness net, so an account created after onboarding still
    -- lands somewhere rather than vanishing from the statement.
    ('sofp-other-ast', 'ACCOUNT_TYPE', 'ASSET',      1),
    ('sofp-ap',        'ACCOUNT_TYPE', 'LIABILITY',  1),
    ('sofp-equity',    'ACCOUNT_TYPE', 'EQUITY',     1);
