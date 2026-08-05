-- =============================================================================
-- 0042 — Bank feeds: the socket a bank connection plugs into
--
-- Malaysian banks do not offer an open account-data API that a five-person
-- shop can simply call; a live feed needs a bank or aggregator agreement,
-- which is a contract, not code. What CAN be built today — and is, here — is
-- everything on this side of that boundary:
--
--   * a connection record per bank account, with a provider name, a sync
--     cursor, and a status the shop controls;
--   * a PUSH surface: this application's own API accepts transactions in
--     JSON, authenticated by the existing scoped API keys (0012), so anything
--     the shop trusts — a script, an integration, eventually a bank's own
--     webhook — can deliver lines without a human at the keyboard;
--   * a SANDBOX provider that exercises the entire pull loop end to end, so
--     the day an agreement exists the work left is one adapter, not a system.
--
-- Feed lines land in the SAME `bank_transaction` table as CSV imports, under
-- a `bank_statement` row with source = 'FEED' — a value 0011 defined on day
-- one and nothing wrote until now. Same dedupe hash, same DB-enforced unique
-- index, same downstream: rules, matching, reconciliation, the invariant.
-- A feed is another way for lines to ARRIVE, not another kind of line.
-- =============================================================================

CREATE TABLE bank_feed_connection (
    tenant_id       UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id              UUID NOT NULL DEFAULT gen_random_uuid(),
    bank_account_id UUID NOT NULL,

    /*
     * SANDBOX  — the built-in fake bank; proves the pull loop, seeds demo data.
     * API_PUSH — lines arrive via this app's own API with a scoped key.
     * A real bank or aggregator adapter appends its name here when an
     * agreement exists. Restate the LIVE list when extending (0014's rule).
     */
    provider        TEXT NOT NULL CHECK (provider IN ('SANDBOX', 'API_PUSH')),

    status          TEXT NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE', 'PAUSED', 'REVOKED')),
    /*
     * Where the provider's sync position lives — an opaque string owned by
     * the adapter (a timestamp, a page token, whatever the provider speaks).
     * NULL means "never synced"; push feeds never use it.
     */
    sync_cursor     TEXT,
    last_synced_at  TIMESTAMPTZ,
    last_error      TEXT,

    created_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ,

    PRIMARY KEY (tenant_id, id),
    /*
     * One LIVE feed per bank account. Partial, so a revoked connection stays
     * on the record (it is history — an auditor asks "what fed this account
     * in March?") while a replacement can be connected.
     */
    FOREIGN KEY (tenant_id, bank_account_id) REFERENCES bank_account (tenant_id, id),
    CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX bank_feed_one_live_per_account
    ON bank_feed_connection (tenant_id, bank_account_id)
    WHERE status <> 'REVOKED';

-- ---------------------------------------------------------------------------
-- RLS + audit (rule 3, 0016)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['bank_feed_connection'] LOOP
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
-- Events. Connection lifecycle is the auditable act — "who wired an outside
-- system into the books" is a question with a name on the answer. Individual
-- syncs are not events; their record is the bank_statement rows they create.
-- Restated from the LIVE constraint in 0039 (0014's rule: never from a stale
-- copy).
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
            'PAY_RUN_REVERSED',
            'BANK_FEED_CONNECTED',
            'BANK_FEED_REVOKED'
        ));

-- No new permission: connecting or feeding a bank account is the same act of
-- trust as importing its statement, so `bank.import` governs both, and
-- `bank.read` sees the connection list. API keys narrow through the same
-- scopes (0012) — a push key carries ['bank.import'] and nothing else.
