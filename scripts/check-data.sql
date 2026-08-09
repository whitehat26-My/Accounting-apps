-- =============================================================================
-- "Is my data really in there?"
--
-- Run this after using the system for a while. It answers the one question a
-- screen cannot: whether what you did was WRITTEN DOWN, or only displayed.
--
--   scripts\check-data.ps1          (Windows)
--   psql "$DATABASE_URL" -f scripts/check-data.sql
--
-- -----------------------------------------------------------------------------
-- READ-ONLY, AND NOT MERELY BY CONVENTION.
--
-- The whole transaction is opened READ ONLY below, so PostgreSQL itself refuses
-- any write from this file - a stray UPDATE typed into it later cannot run. A
-- tool whose job is to reassure you about your data must not be able to be the
-- thing that damages it.
--
-- It also runs ACROSS TENANTS on purpose, as the superuser, because it is
-- answering "is the database holding my books" and not "what can this login
-- see". It is for the person who owns the machine.
-- -----------------------------------------------------------------------------
-- =============================================================================

\set ON_ERROR_STOP on
\pset border 2
\pset null '-'

BEGIN TRANSACTION READ ONLY;

\echo ''
\echo '==========================================================================='
\echo '  WHAT IS IN YOUR DATABASE'
\echo '==========================================================================='
\echo ''

-- Counts and the most recent one, per thing a shop actually does. `created_at`
-- is when the row was WRITTEN; the accounting date is separate and reported
-- below, because a back-dated invoice has an old date and a new row.
--
-- Two tables keep their time under a different name and neither is an oversight:
-- `journal_line` has none at all (a line is written with its entry and has no
-- independent life), and `audit_log` uses `occurred_at` because it records WHEN
-- SOMETHING HAPPENED rather than when a row was inserted.
SELECT
    label                             AS "What",
    rows                              AS "How many",
    to_char(newest, 'DD/MM/YYYY HH24:MI') AS "Last one written"
FROM (
    SELECT 'Companies (tenants)' AS label, count(*) AS rows, max(created_at) AS newest, 1 AS ord FROM organisation
    UNION ALL SELECT 'People who can sign in', count(*), max(created_at), 2 FROM app_user
    UNION ALL SELECT 'Items in the catalogue', count(*), max(created_at), 3 FROM item
    UNION ALL SELECT 'Invoices',               count(*), max(created_at), 4 FROM invoice
    UNION ALL SELECT 'Payments',               count(*), max(created_at), 5 FROM payment
    UNION ALL SELECT 'Repair jobs',            count(*), max(created_at), 6 FROM repair_job
    UNION ALL SELECT 'Stock movements',        count(*), max(created_at), 7 FROM stock_movement
    UNION ALL SELECT 'Journal entries',        count(*), max(created_at), 8 FROM journal_entry
    UNION ALL SELECT 'Journal lines',          count(*), NULL::timestamptz,  9 FROM journal_line
    UNION ALL SELECT 'Audit records',          count(*), max(occurred_at), 10 FROM audit_log
) t
ORDER BY ord;

\echo ''
\echo '  Compare these against what you remember doing. If you rang five sales'
\echo '  and see five invoices, it saved them.'
\echo ''
\echo '==========================================================================='
\echo '  IS THE HISTORY BEING KEPT, OR OVERWRITTEN?'
\echo '==========================================================================='
\echo ''

-- Two dates far apart means old entries are still there. Two dates the same
-- means either you started today, or something is replacing rather than adding.
SELECT
    to_char(min(entry_date), 'DD/MM/YYYY') AS "Oldest accounting date",
    to_char(max(entry_date), 'DD/MM/YYYY') AS "Newest accounting date",
    count(*) FILTER (WHERE status = 'POSTED')   AS "Posted (permanent)",
    count(*) FILTER (WHERE status <> 'POSTED')  AS "Not yet posted",
    count(*) FILTER (WHERE reversal_of_id IS NOT NULL) AS "Corrections"
FROM journal_entry;

\echo ''
\echo '  Posted entries are permanent: this system never edits or deletes one.'
\echo '  A correction is a new entry that points at the one it reverses, which'
\echo '  is why "Corrections" can be more than zero and nothing is missing.'
\echo ''
\echo '==========================================================================='
\echo '  DO THE BOOKS BALANCE?'
\echo '==========================================================================='
\echo ''

/*
 * The two numbers must be identical, to the cent.
 *
 * This is a READOUT, not a repair. The database already refuses an unbalanced
 * entry with a deferred constraint trigger, so these cannot drift apart while
 * that trigger exists. Seeing them match is what turns "double-entry
 * bookkeeping" from a claim in a README into something you have looked at.
 *
 * Only POSTED entries: a draft is deliberately allowed to be half-written.
 */
SELECT
    to_char(sum(l.base_debit),  'FM999,999,999,990.00') AS "Total debits (RM)",
    to_char(sum(l.base_credit), 'FM999,999,999,990.00') AS "Total credits (RM)",
    CASE
        WHEN coalesce(sum(l.base_debit), 0) = coalesce(sum(l.base_credit), 0)
        THEN 'BALANCED - every ringgit is accounted for'
        ELSE 'OUT OF BALANCE - stop and report this'
    END AS "Verdict"
FROM journal_line l
JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
WHERE e.status = 'POSTED';

\echo ''
\echo '==========================================================================='
\echo '  WHERE IT LIVES'
\echo '==========================================================================='
\echo ''

SELECT
    current_database()                                  AS "Database",
    pg_size_pretty(pg_database_size(current_database())) AS "Size on disk",
    (SELECT count(*) FROM schema_migration)             AS "Schema version";

COMMIT;

\echo ''
\echo '  The data is in a Docker volume named `pgdata`. It SURVIVES:'
\echo '    - closing the app or the browser'
\echo '    - docker compose down'
\echo '    - docker compose up -d --build   (upgrading)'
\echo '    - restarting Docker Desktop'
\echo '    - switching the PC off and on'
\echo ''
\echo '  ONE ORDINARY COMMAND DESTROYS IT, PERMANENTLY:'
\echo ''
\echo '      docker compose down -v          <-- the -v deletes the volume'
\echo ''
\echo '  That flag is what people are told to add when troubleshooting. There is'
\echo '  no undo and no recycle bin. Take a backup before you ever type it.'
\echo ''
