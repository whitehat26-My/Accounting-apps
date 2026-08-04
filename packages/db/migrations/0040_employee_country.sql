-- =============================================================================
-- 0040 — Employee country code, for the CP39 detail record
--
-- Exhibit 4's detail record carries a two-letter country code. For a Malaysian
-- or PR it is always MY; for a foreign worker it is their passport's country,
-- which 0039 gave nowhere to record. A separate migration rather than an
-- amendment because 0039 is already pushed, and pushed migrations are
-- append-only — an edited migration is two different schemas wearing one name.
-- =============================================================================
ALTER TABLE employee ADD COLUMN country_code TEXT NOT NULL DEFAULT 'MY'
    CHECK (country_code ~ '^[A-Z]{2}$');
