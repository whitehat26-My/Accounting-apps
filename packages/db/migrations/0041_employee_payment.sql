-- =============================================================================
-- 0041 — How the staff member actually gets paid
--
-- A payslip that states net pay but not how the money reached the person is
-- half a document: the reader cannot tell a transfer that has landed from one
-- that has not, and cannot match the slip against their own bank statement.
--
-- THE LAST FOUR DIGITS, AND NOT THE ACCOUNT NUMBER.
--
-- This application never initiates a payment — the shop transfers from its own
-- online banking, and nothing here needs to address a beneficiary. What the
-- payslip needs is only enough for the reader to RECOGNISE which account, and
-- four digits does that. A full bank account number stored for no functional
-- reason is a liability with no offsetting use, and it is the kind of field
-- that gets collected because a form has a box for it. If some future feature
-- genuinely needs to address a payment, it can argue with this comment then.
--
-- 0039 and 0040 are already pushed, so this is a new file rather than an
-- amendment: pushed migrations are append-only.
-- =============================================================================

ALTER TABLE employee
    ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'BANK_TRANSFER'
        CHECK (payment_method IN ('BANK_TRANSFER', 'CASH', 'CHEQUE')),
    ADD COLUMN bank_name TEXT,
    ADD COLUMN bank_account_last4 TEXT
        CHECK (bank_account_last4 ~ '^[0-9]{4}$');

-- The same three on the run line, because pay_run_line is a SNAPSHOT and how
-- someone was paid in August is a fact about August. Somebody who changes bank
-- in November must not silently rewrite the August payslip they were given.
ALTER TABLE pay_run_line
    ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'BANK_TRANSFER'
        CHECK (payment_method IN ('BANK_TRANSFER', 'CASH', 'CHEQUE')),
    ADD COLUMN bank_name TEXT,
    ADD COLUMN bank_account_last4 TEXT
        CHECK (bank_account_last4 ~ '^[0-9]{4}$');

-- No RLS or audit block here: both tables were enabled, forced and given the
-- generic audit trigger by 0039, and a new column on an audited table is
-- carried by the existing row-level trigger without any change.
