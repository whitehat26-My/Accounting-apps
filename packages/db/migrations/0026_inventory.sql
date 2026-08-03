-- =============================================================================
-- 0026_inventory
--
-- Perpetual inventory. The first slice of the SHOP half of this product.
--
-- -----------------------------------------------------------------------------
-- WHAT WAS TRUE BEFORE THIS MIGRATION.
--
-- `item` has existed since 0002 and `invoice_line.item_id` / `bill_line.item_id`
-- with it. The catalogue knew WHAT the shop sells and at what price — and had
-- no idea HOW MANY are on the shelf or what they cost. A computer shop's
-- largest asset was invisible to its own balance sheet: buy twenty laptops and
-- the whole spend landed in an expense account the day the bill was entered,
-- profit swung with purchasing rather than with selling, and nobody could
-- answer "how many RM-280 SSDs do we have left" from the system at all.
--
-- Perpetual inventory fixes the accounting and the shelf at once: a purchase
-- of a tracked item is an ASSET (Dr Inventory), and each sale relieves that
-- asset at weighted-average cost (Dr COGS / Cr Inventory) in the same breath
-- as it recognises the revenue. Profit per sale becomes a real number.
-- -----------------------------------------------------------------------------
--
-- -----------------------------------------------------------------------------
-- THE MOVEMENT LOG IS THE TRUTH; `item_stock` IS A CACHE.
--
-- The same shape as journal_entry / account_period_balance, for the same
-- reason. `stock_movement` is append-only (enforced by trigger, like the
-- ledger); `item_stock` carries the running quantity and pool value so a sale
-- does not scan history, and it is the row a transaction LOCKS — two
-- concurrent sales of the last unit must serialise somewhere, and a SELECT FOR
-- UPDATE on the rollup row is that somewhere. A drift detector recomputes the
-- rollup from movements, exactly as `detectRollupDrift` does for the ledger.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- Which items are tracked
--
-- Opt-in per item. A repair labour line, a delivery fee, an extended-warranty
-- SKU — none of these have a shelf. Defaulting every existing item to tracked
-- would invent stock records for services.
-- -----------------------------------------------------------------------------
ALTER TABLE item ADD COLUMN is_tracked BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE item ADD CONSTRAINT item_tracked_is_goods
    CHECK (NOT is_tracked OR item_type = 'GOODS');

COMMENT ON COLUMN item.is_tracked IS
    'Perpetual inventory: purchases go to the INVENTORY asset and sales post '
    'COGS at weighted-average cost. GOODS only — a service has no shelf.';

-- -----------------------------------------------------------------------------
-- Posting roles: where stock value lives and where it goes when sold
-- -----------------------------------------------------------------------------
-- The list is restated from the LIVE constraint (0014), not an older migration.
ALTER TABLE posting_account_map DROP CONSTRAINT posting_account_map_role_check;
ALTER TABLE posting_account_map
    ADD CONSTRAINT posting_account_map_role_check
        CHECK (role IN ('AR','AP','SST_PAYABLE','SST_CLAIMABLE',
                        'ROUNDING','FX_GAIN_LOSS','RETAINED_EARNINGS',
                        'UNDEPOSITED_FUNDS','SUSPENSE',
                        'AR_REVALUATION','UNREALISED_FX','AP_REVALUATION',
                        'WHT_PAYABLE',
                        'GATEWAY_FEE',
                        -- Stock on hand (ASSET) and cost of goods sold
                        -- (EXPENSE). Tenant-level: one inventory account, one
                        -- COGS account. Per-item overrides can come later if a
                        -- shop wants laptops and accessories on separate lines.
                        'INVENTORY','COGS',
                        -- Where a counted shortfall lands. Its own role rather
                        -- than COGS because shrinkage is the number a shop
                        -- owner watches for theft, and burying it in COGS
                        -- hides exactly the thing worth seeing.
                        'STOCK_SHRINKAGE'));

-- -----------------------------------------------------------------------------
-- The movement log
-- -----------------------------------------------------------------------------
CREATE TABLE stock_movement (
    tenant_id            UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                   UUID NOT NULL DEFAULT gen_random_uuid(),
    item_id              UUID NOT NULL,
    movement_type        TEXT NOT NULL
                         CHECK (movement_type IN ('RECEIPT','ISSUE','ADJUSTMENT')),
    /* Signed: positive into stock, negative out. The CHECKs tie the sign to
       the type so a mislabelled row cannot exist. */
    quantity             NUMERIC(19,4) NOT NULL CHECK (quantity <> 0),
    /* What this movement did to the pool value, BASE currency, signed the same
       way as quantity. An issue's value is the proportional weighted-average
       relief computed in the domain — see packages/domain/src/inventory.ts. */
    value_delta          NUMERIC(19,4) NOT NULL,
    /* Where the movement came from: 'BILL', 'INVOICE', 'ADJUSTMENT'. The pair
       makes every unit on the shelf traceable to a document. */
    source_document_type TEXT NOT NULL,
    source_document_id   UUID,
    /* The ledger entry that carried this movement's financial effect, when one
       exists. A bill receipt's effect is inside the bill's own journal. */
    journal_entry_id     UUID,
    moved_on             DATE NOT NULL,
    reason               TEXT,
    /* Rule 5, carried by the movement itself. Bill and invoice movements are
       shielded by their document's idempotency, but a counted adjustment can
       move quantity with ZERO value (writing down free stock) — no journal is
       posted, so the ledger's key cannot guard the retry. This one does. */
    idempotency_key      TEXT,
    created_by           UUID,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, item_id)          REFERENCES item          (tenant_id, id),
    FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entry (tenant_id, id),

    CONSTRAINT stock_movement_sign_matches_type CHECK (
        (movement_type = 'RECEIPT' AND quantity > 0 AND value_delta >= 0)
        OR (movement_type = 'ISSUE' AND quantity < 0 AND value_delta <= 0)
        OR (movement_type = 'ADJUSTMENT')
    )
);

CREATE INDEX stock_movement_item_idx
    ON stock_movement (tenant_id, item_id, created_at);
CREATE UNIQUE INDEX stock_movement_idempotency_idx
    ON stock_movement (tenant_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX stock_movement_source_idx
    ON stock_movement (tenant_id, source_document_type, source_document_id);

-- Append-only, like the ledger. A movement that was wrong is corrected by a
-- counter-movement that says so, never by editing history.
CREATE OR REPLACE FUNCTION forbid_stock_movement_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'Stock movements are append-only. Post an adjustment instead of % on %.',
        TG_OP, OLD.id
        USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER trg_stock_movement_immutable
    BEFORE UPDATE OR DELETE ON stock_movement
    FOR EACH ROW EXECUTE FUNCTION forbid_stock_movement_mutation();

-- -----------------------------------------------------------------------------
-- The rollup / lock row
-- -----------------------------------------------------------------------------
CREATE TABLE item_stock (
    tenant_id       UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    item_id         UUID NOT NULL,
    quantity_on_hand NUMERIC(19,4) NOT NULL DEFAULT 0
                     CHECK (quantity_on_hand >= 0),
    /* Pool value at weighted average, base currency. The >= 0 CHECK is a
       backstop: the domain arithmetic cannot produce a negative pool, so if
       one ever appears the arithmetic was bypassed. */
    stock_value     NUMERIC(19,4) NOT NULL DEFAULT 0
                     CHECK (stock_value >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, item_id),
    FOREIGN KEY (tenant_id, item_id) REFERENCES item (tenant_id, id)
);

-- -----------------------------------------------------------------------------
-- Counted adjustments are events an owner asks about by name
--
-- Restated from the LIVE list in 0025. Shrinkage is the fraud signal in a
-- physical shop; an immutable record of who counted and what moved is the
-- point, and the posted journal alone does not say "this was a count".
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
            'STOCK_COUNTED'));

-- -----------------------------------------------------------------------------
-- Permissions
-- -----------------------------------------------------------------------------
INSERT INTO app_permission (code, description) VALUES
    ('stock.read',   'View stock levels and movement history'),
    ('stock.adjust', 'Post counted stock adjustments and write-offs');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('OWNER',      'stock.read'), ('OWNER',      'stock.adjust'),
    ('ADMIN',      'stock.read'), ('ADMIN',      'stock.adjust'),
    ('ACCOUNTANT', 'stock.read'), ('ACCOUNTANT', 'stock.adjust'),
    -- The bookkeeper sees stock; making stock DISAPPEAR (a write-off) is the
    -- act shrinkage events exist to watch, so it stays with roles that answer
    -- for the numbers.
    ('BOOKKEEPER',       'stock.read'),
    ('SALES',            'stock.read'),
    ('APPROVER',         'stock.read'),
    ('READ_ONLY',        'stock.read'),
    ('EXTERNAL_AUDITOR', 'stock.read');

-- -----------------------------------------------------------------------------
-- RLS — enabled AND forced, policy carries USING and WITH CHECK (rule 3)
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['stock_movement', 'item_stock'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                 USING      (tenant_id = current_tenant_id())
                 WITH CHECK (tenant_id = current_tenant_id())', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO emil_app', t);
    END LOOP;

    -- The movement log takes inserts only; the trigger above enforces the same
    -- thing, but not granting the verb is the cheaper first fence.
    REVOKE UPDATE, DELETE ON stock_movement FROM emil_app;
END $$;

-- Audit coverage: the same trigger 0016's sweep attaches to every
-- tenant-owned table, attached by name because these tables postdate the
-- sweep. `item_stock` is audited even though it is a cache — an UPDATE to it
-- outside a movement is precisely the tampering worth recording.
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['stock_movement', 'item_stock'] LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_audit_%1$s
                 AFTER INSERT OR UPDATE OR DELETE ON %1$I
                 FOR EACH ROW EXECUTE FUNCTION audit_row_change(%2$L)', t, 'tenant_id');
    END LOOP;
END $$;
