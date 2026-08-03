-- =============================================================================
-- 0028_serials
--
-- Serial number tracking: which unit went where.
--
-- -----------------------------------------------------------------------------
-- WHY THIS RIDES ON THE MOVEMENT LOG INSTEAD OF BESIDE IT.
--
-- A computer shop's disputes turn on identity: the warranty claim, the RMA,
-- the customer insisting the laptop in their hands is the one on the invoice.
-- `stock_unit` answers with a document trail — each unit points at the
-- MOVEMENT that brought it in and the movement that took it out, and through
-- them at the bill and the invoice. Nothing is asserted twice: the movement
-- already knows its document, so the unit does not repeat it.
--
-- Valuation is deliberately untouched. The pool stays weighted-average; a
-- serial says WHICH machine, never WHAT IT COST. Per-serial cost would be
-- specific identification — a different valuation method smuggled in through
-- a tracking feature, and one that invites costing games (sell the "expensive"
-- unit on paper, the cheap one in fact).
-- -----------------------------------------------------------------------------

ALTER TABLE item ADD COLUMN is_serialised BOOLEAN NOT NULL DEFAULT FALSE;

-- Serials without quantities would be identity with no stock to identify.
ALTER TABLE item ADD CONSTRAINT item_serialised_is_tracked
    CHECK (NOT is_serialised OR is_tracked);

COMMENT ON COLUMN item.is_serialised IS
    'Every unit carries a serial number. Receipts and issues must name their '
    'serials, and quantities must be whole units. Requires is_tracked.';

-- -----------------------------------------------------------------------------
-- The units
-- -----------------------------------------------------------------------------
CREATE TABLE stock_unit (
    tenant_id            UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                   UUID NOT NULL DEFAULT gen_random_uuid(),
    item_id              UUID NOT NULL,
    serial_no            TEXT NOT NULL CHECK (length(btrim(serial_no)) > 0),
    status               TEXT NOT NULL DEFAULT 'IN_STOCK'
                         CHECK (status IN ('IN_STOCK','SOLD','WRITTEN_OFF')),
    /* The movement that brought this unit in. Every unit has one — a unit
       cannot exist without having arrived. */
    received_movement_id UUID NOT NULL,
    /* The movement that took it out: an invoice issue or a count write-off.
       NULL exactly while the unit is on the shelf; the CHECK ties the two so a
       row cannot claim to be sold and still present, or gone with no story. */
    issued_movement_id   UUID,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, item_id)              REFERENCES item           (tenant_id, id),
    FOREIGN KEY (tenant_id, received_movement_id) REFERENCES stock_movement (tenant_id, id),
    FOREIGN KEY (tenant_id, issued_movement_id)   REFERENCES stock_movement (tenant_id, id),

    /* Unique per ITEM, not per tenant: serial formats are the manufacturer's,
       and an SSD and a keyboard from different makers can legitimately carry
       the same string. Within one item, a repeat is a data error. */
    UNIQUE (tenant_id, item_id, serial_no),

    CONSTRAINT stock_unit_status_matches_issue CHECK (
        (status = 'IN_STOCK' AND issued_movement_id IS NULL)
        OR (status IN ('SOLD','WRITTEN_OFF') AND issued_movement_id IS NOT NULL)
    )
);

/* The till's question: "which units of this item can I sell right now". */
CREATE INDEX stock_unit_available_idx
    ON stock_unit (tenant_id, item_id)
    WHERE status = 'IN_STOCK';

/* The warranty question arrives with a serial and NO item — the customer
   brings a device, not a catalogue entry. */
CREATE INDEX stock_unit_serial_idx ON stock_unit (tenant_id, serial_no);

-- -----------------------------------------------------------------------------
-- RLS + audit, the standard treatment (rule 3, 0016)
-- -----------------------------------------------------------------------------
ALTER TABLE stock_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_unit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_unit
    USING      (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON stock_unit TO emil_app;
-- No DELETE: a unit that existed is history. Write-offs change status.

CREATE TRIGGER trg_audit_stock_unit
    AFTER INSERT OR UPDATE OR DELETE ON stock_unit
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('tenant_id');
