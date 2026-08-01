-- =============================================================================
-- 0008_rollup_net_movement
--
-- Honest names for the balance rollup.
--
-- `account_period_balance` was declared with `opening_balance` and
-- `closing_balance`, but nothing ever WROTE opening_balance — it was only ever
-- read, always as zero, inside the ON CONFLICT expression in
-- postJournalEntry(). So the column called "closing_balance" has in fact always
-- held the period's NET MOVEMENT, and every query that sums it across periods
-- to get a cumulative balance is correct only by accident.
--
-- That accident is a trap with a long fuse. The first feature to populate
-- opening_balance — a year-end rollforward, an opening-balance import — would
-- make every one of those sums double-count, and every balance sheet built on
-- them would silently double. Reporting is about to be built directly on top
-- of this table, so the names are corrected first.
--
-- The arithmetic is unchanged. Cumulative balance remains
-- SUM(net_movement) over the periods up to a date.
--
-- If per-period opening balances are wanted later they should come from a real
-- rollforward step that computes and stores them, not from a column that
-- quietly defaults to zero.
-- =============================================================================

ALTER TABLE account_period_balance DROP COLUMN opening_balance;

ALTER TABLE account_period_balance RENAME COLUMN closing_balance TO net_movement;

COMMENT ON COLUMN account_period_balance.net_movement IS
    'Signed, debit-positive movement for this account within this fiscal period. '
    'Cumulative balance as at a date = SUM(net_movement) over periods ending on or '
    'before that date. This is a cache; journal_line is the truth.';
