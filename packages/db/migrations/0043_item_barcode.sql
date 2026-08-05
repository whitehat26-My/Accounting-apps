-- =============================================================================
-- 0043 — The barcode on the shelf
--
-- A keyboard-wedge scanner is the cheapest hardware upgrade a till can get:
-- it types the code and presses Enter. All the software has to do is hold the
-- code and answer an exact-match lookup fast. Nullable, because services and
-- odd-lot items have no barcode and never will.
--
-- Partial unique rather than plain unique: many items legitimately have NO
-- barcode, and PostgreSQL treats NULLs as distinct anyway — the partial index
-- just says so out loud, and keeps the index small.
-- =============================================================================

ALTER TABLE item ADD COLUMN barcode TEXT;

CREATE UNIQUE INDEX item_barcode_unique
    ON item (tenant_id, barcode)
    WHERE barcode IS NOT NULL;
