# 6. Reference Data Model — The Ledger Core

DDL sketches for the tables where correctness is structural. These are illustrative PostgreSQL 16, not final migrations, but the constraints shown are the ones that must survive into production.

---

## 6.1 Conventions

| Rule | Reason |
| --- | --- |
| `tenant_id UUID NOT NULL` is the **first column of every primary key** | Makes a cross-tenant foreign key structurally impossible |
| Every FK includes `tenant_id` | Same |
| Money: `NUMERIC(19,4)` | Exact decimal. Four places because unit prices and FX rates need more precision than the two the statement shows |
| Accounting dates: `DATE` | An invoice date has no timezone. Using `TIMESTAMPTZ` produces off-by-one-day errors at period boundaries |
| System timestamps: `TIMESTAMPTZ` | Stored UTC, rendered `Asia/Kuala_Lumpur` |
| IDs: UUIDv7 | Time-ordered, so index locality is good and they sort chronologically — unlike UUIDv4 |
| Enums: `TEXT` + `CHECK` | Adding a value to a PG enum type in a migration is awkward; a CHECK constraint is easy to evolve |
| Every table: RLS enabled and forced | The isolation boundary |

---

## 6.2 Tenant isolation

```sql
CREATE TABLE organisation (
    id                  UUID PRIMARY KEY,
    name                TEXT NOT NULL,
    ssm_registration_no TEXT,
    tin                 TEXT,
    msic_code           TEXT,
    sst_registered      BOOLEAN NOT NULL DEFAULT FALSE,
    sst_no              TEXT,
    base_currency       CHAR(3) NOT NULL DEFAULT 'MYR',
    fye_month           SMALLINT NOT NULL CHECK (fye_month BETWEEN 1 AND 12),
    reporting_framework TEXT NOT NULL DEFAULT 'MPERS'
                        CHECK (reporting_framework IN ('MPERS', 'MFRS')),
    timezone            TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
    status              TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Applied to EVERY tenant-owned table:
ALTER TABLE journal_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry FORCE  ROW LEVEL SECURITY;   -- also applies to the table owner

CREATE POLICY tenant_isolation ON journal_entry
    USING       (tenant_id = current_setting('app.tenant_id')::uuid)
    WITH CHECK  (tenant_id = current_setting('app.tenant_id')::uuid);
```

`USING` filters reads; `WITH CHECK` blocks writes that would create a row belonging to another tenant. Both are required — a policy with only `USING` lets an attacker *insert* cross-tenant rows even though they cannot read them.

**The middleware contract:**

```sql
BEGIN;
SET LOCAL app.tenant_id = '...';   -- LOCAL: transaction-scoped, cannot leak across pooled connections
-- ... all work ...
COMMIT;
```

**CI guard:** a test that enumerates `information_schema.tables`, asserts RLS is enabled and forced on every tenant-owned table, and asserts a policy exists. A new table without a policy fails the build. Implemented in `packages/db/test/rls.test.ts`.

> ⚠️ **Superusers bypass RLS unconditionally — including `FORCE`.** `FORCE ROW LEVEL SECURITY` closes the *table owner* bypass, but any role with `SUPERUSER` or `BYPASSRLS` ignores policies entirely. The practical consequence is a trap: an integration suite that connects as `postgres` will watch every isolation assertion pass while the policies do nothing at all. This was caught during implementation — the first run of the isolation tests reported zero leaked rows, and only failed once the test client was switched to an unprivileged role, at which point `account` was found leaking 9 cross-tenant rows.
>
> Two rules follow. The application connects as a role with neither attribute. And the test harness asserts its own privileges before running (`packages/db/test/helpers.ts`), failing loudly rather than passing vacuously.

---

## 6.3 Chart of accounts

```sql
CREATE TABLE account (
    tenant_id      UUID NOT NULL,
    id             UUID NOT NULL,
    code           TEXT NOT NULL,
    name           TEXT NOT NULL,
    type           TEXT NOT NULL CHECK (type IN
                     ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
    subtype        TEXT NOT NULL,          -- CURRENT_ASSET, NON_CURRENT_LIABILITY, ...
    parent_id      UUID,
    currency       CHAR(3),                -- NULL = multi-currency capable
    is_system      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    tax_default_id UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, code),
    FOREIGN KEY (tenant_id, parent_id) REFERENCES account (tenant_id, id)
);
```

**System accounts** (`is_system = TRUE`) cannot be deleted or have their type changed: AR control, AP control, SST payable, SST claimable/cost, retained earnings, current year earnings, FX gain/loss, rounding difference, suspense, undeposited funds. Seed them with every chart-of-accounts template.

---

## 6.4 The journal — where immutability is enforced

```sql
CREATE TABLE journal_entry (
    tenant_id            UUID NOT NULL,
    id                   UUID NOT NULL,
    entry_no             TEXT NOT NULL,
    entry_date           DATE NOT NULL,
    fiscal_period_id     UUID NOT NULL,
    description          TEXT,
    source_module        TEXT NOT NULL,   -- SALES | PURCHASES | BANKING | MANUAL | SYSTEM
    source_document_type TEXT,
    source_document_id   UUID,
    status               TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT','POSTED','REVERSED')),
    reversal_of_id       UUID,
    idempotency_key      TEXT,
    posted_by            UUID,
    posted_at            TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, entry_no),
    UNIQUE      (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, fiscal_period_id) REFERENCES fiscal_period (tenant_id, id),
    FOREIGN KEY (tenant_id, reversal_of_id)   REFERENCES journal_entry  (tenant_id, id)
);

CREATE TABLE journal_line (
    tenant_id        UUID NOT NULL,
    id               UUID NOT NULL,
    journal_entry_id UUID NOT NULL,
    line_no          SMALLINT NOT NULL,
    account_id       UUID NOT NULL,
    debit            NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (debit  >= 0),
    credit           NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    currency         CHAR(3) NOT NULL,
    fx_rate          NUMERIC(19,8) NOT NULL DEFAULT 1,
    base_debit       NUMERIC(19,4) NOT NULL DEFAULT 0,
    base_credit      NUMERIC(19,4) NOT NULL DEFAULT 0,
    description      TEXT,
    contact_id       UUID,
    tax_code_id      UUID,
    tracking_option_id UUID,

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entry (tenant_id, id),
    FOREIGN KEY (tenant_id, account_id)       REFERENCES account       (tenant_id, id),

    -- a line is either a debit or a credit, never both, never neither
    CONSTRAINT debit_xor_credit CHECK (
        (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
    )
);

CREATE INDEX ON journal_line (tenant_id, account_id);
CREATE INDEX ON journal_line (tenant_id, journal_entry_id);
```

### Balanced-by-construction

```sql
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS TRIGGER AS $$
DECLARE
    d NUMERIC(19,4);
    c NUMERIC(19,4);
BEGIN
    SELECT COALESCE(SUM(base_debit), 0), COALESCE(SUM(base_credit), 0)
      INTO d, c
      FROM journal_line
     WHERE tenant_id = NEW.tenant_id
       AND journal_entry_id = NEW.id;

    IF NEW.status = 'POSTED' AND d <> c THEN
        RAISE EXCEPTION
          'Journal entry % is unbalanced: debits %, credits %', NEW.entry_no, d, c;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entry_balanced
    AFTER INSERT OR UPDATE ON journal_entry
    DEFERRABLE INITIALLY DEFERRED     -- checked at COMMIT, after all lines are written
    FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();
```

`DEFERRABLE INITIALLY DEFERRED` is the key detail: the check runs at COMMIT, so the header can be inserted before its lines. Without it, you could never insert a balanced entry.

### Immutability

```sql
CREATE OR REPLACE FUNCTION forbid_posted_mutation() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Posted journal entries cannot be deleted (entry %)', OLD.entry_no;
    END IF;
    IF OLD.status = 'POSTED' AND NEW.status NOT IN ('POSTED','REVERSED') THEN
        RAISE EXCEPTION 'Posted journal entries are immutable (entry %)', OLD.entry_no;
    END IF;
    IF OLD.status = 'POSTED' AND (
           NEW.entry_date <> OLD.entry_date
        OR NEW.entry_no   <> OLD.entry_no
        OR NEW.fiscal_period_id <> OLD.fiscal_period_id) THEN
        RAISE EXCEPTION 'Cannot alter a posted entry (entry %)', OLD.entry_no;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_journal_immutable
    BEFORE UPDATE OR DELETE ON journal_entry
    FOR EACH ROW EXECUTE FUNCTION forbid_posted_mutation();

-- journal_line: no UPDATE or DELETE once the parent entry is POSTED (same pattern)
```

**Correction = reversal.** To fix a posted entry, create a new entry with debits and credits swapped, `reversal_of_id` pointing at the original, then post the corrected entry. Both appear in the audit trail — which is exactly what an auditor wants to see.

---

## 6.5 The rollup that makes reports fast

```sql
CREATE TABLE account_period_balance (
    tenant_id        UUID NOT NULL,
    account_id       UUID NOT NULL,
    fiscal_period_id UUID NOT NULL,
    currency         CHAR(3) NOT NULL,
    opening_balance  NUMERIC(19,4) NOT NULL DEFAULT 0,
    debit_total      NUMERIC(19,4) NOT NULL DEFAULT 0,
    credit_total     NUMERIC(19,4) NOT NULL DEFAULT 0,
    closing_balance  NUMERIC(19,4) NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, account_id, fiscal_period_id, currency)
);
```

Updated with an `INSERT … ON CONFLICT DO UPDATE` **inside the posting transaction**. Trial balance becomes a single indexed aggregation over a few hundred rows instead of a scan of millions of journal lines.

**The rollup is a cache; the journal is the truth.** A nightly job recomputes from `journal_line` and alarms on any drift. If they ever disagree, rebuild the rollup — never "fix" the journal to match.

---

## 6.6 Gapless document numbering

```sql
CREATE TABLE number_sequence (
    tenant_id     UUID NOT NULL,
    document_type TEXT NOT NULL,          -- INVOICE | CREDIT_NOTE | BILL | JOURNAL | PAYMENT
    prefix        TEXT NOT NULL DEFAULT '',
    next_value    BIGINT NOT NULL DEFAULT 1,
    padding       SMALLINT NOT NULL DEFAULT 4,
    PRIMARY KEY (tenant_id, document_type)
);
```

```sql
-- Allocation, inside the same transaction as the document insert:
SELECT pg_advisory_xact_lock(hashtextextended(tenant_id::text || document_type, 0));
UPDATE number_sequence
   SET next_value = next_value + 1
 WHERE tenant_id = $1 AND document_type = $2
RETURNING prefix || lpad((next_value - 1)::text, padding, '0');
```

A PostgreSQL `SEQUENCE` is **wrong** here: sequences are non-transactional, so a rolled-back transaction burns a number and leaves a gap. Auditors treat gaps in invoice numbering as a red flag. The advisory lock serialises allocation per tenant per document type and releases at transaction end.

The cost is a short serialisation point per document type. That is acceptable — an SME issues tens of invoices a day, not thousands per second — and if a very large tenant ever makes it a bottleneck, the fix is a per-tenant sequence table shard, not abandoning gaplessness.

---

## 6.7 Transactional outbox

```sql
CREATE TABLE outbox_event (
    tenant_id     UUID NOT NULL,
    id            UUID NOT NULL,
    event_type    TEXT NOT NULL,          -- invoice.issued | einvoice.submit | ...
    aggregate_type TEXT NOT NULL,
    aggregate_id  UUID NOT NULL,
    payload       JSONB NOT NULL,
    status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','DISPATCHED','FAILED')),
    attempts      SMALLINT NOT NULL DEFAULT 0,
    available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, id)
);

CREATE INDEX ON outbox_event (status, available_at) WHERE status = 'PENDING';
```

Written in the same transaction as the business data. A poller (or logical-decoding consumer) moves `PENDING` rows onto the Redis queue with `SELECT … FOR UPDATE SKIP LOCKED`. This guarantees at-least-once delivery, so **every consumer must be idempotent** — key on `(event_type, aggregate_id)` or the provider's event ID.

---

## 6.8 Audit log

```sql
CREATE TABLE audit_log (
    tenant_id      UUID NOT NULL,
    id             BIGSERIAL,
    actor_user_id  UUID,
    actor_ip       INET,
    user_agent     TEXT,
    request_id     TEXT,
    action         TEXT NOT NULL,
    entity_type    TEXT NOT NULL,
    entity_id      UUID,
    before_json    JSONB,
    after_json     JSONB,
    occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    prev_hash      BYTEA,
    row_hash       BYTEA NOT NULL,
    PRIMARY KEY (tenant_id, id)
);

REVOKE UPDATE, DELETE ON audit_log FROM emil_app;   -- INSERT and SELECT only

CREATE TRIGGER trg_audit_append_only
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION raise_append_only_violation();
```

`row_hash = SHA256(prev_hash || canonical_json(row))`, chained per tenant. A nightly verifier walks the chain and alarms on a break; the daily chain head is written to S3 Object Lock as an independent anchor. This does not make tampering impossible for someone with superuser access — it makes it **detectable**, which is the achievable and auditable goal.

---

## 6.9 Ledger invariants — the test suite that protects the product

Encode these as property-based tests (`fast-check`) over generated transaction sets. They are the cheapest insurance the project can buy.

| # | Invariant |
| --- | --- |
| 1 | For every posted entry, `SUM(base_debit) = SUM(base_credit)` |
| 2 | Across all posted entries, total debits = total credits (the trial balance balances) |
| 3 | `SUM(assets) = SUM(liabilities) + SUM(equity)` at every point in time |
| 4 | Reversing every entry returns every account balance to zero |
| 5 | `account_period_balance` always equals the aggregate recomputed from `journal_line` |
| 6 | AR control account balance = sum of outstanding invoice balances (subledger agrees with GL) |
| 7 | AP control account balance = sum of outstanding bill balances |
| 8 | Bank GL account balance = opening + sum of reconciled bank transactions |
| 9 | No posting into a `LOCKED` fiscal period without the override permission and a financial-event log row |
| 10 | Applying the same idempotency key twice produces exactly one posted entry |
| 11 | Document numbering has no gaps within a tenant/document type |
| 12 | Every invoice line's tax equals `TaxEngine.compute()` at that invoice's `tax_point_date` |
| 13 | Multi-currency: settling an invoice at a different rate produces an FX gain/loss line that keeps the entry balanced |
| 14 | No query executed without `app.tenant_id` set returns any tenant row |

Invariant 14 is the one to write first. It is the test that proves the isolation boundary works, and it should run against every table in the schema.

**Coverage so far.** All fourteen are tested.
Invariants 6 and 7 both compare the subledger to the control account in BASE currency at BOOKED
rates (`amount_due * fx_rate`) — summing `amount_due` across currencies adds ringgit to dollars and
reconciles to nothing. Invariant 7 additionally holds through partial payment, debit notes, and a
withholding payment that discharges the payable at the gross while only the net leaves the bank
(`packages/db/test/bill.test.ts`).

Invariant 8 carries a **precondition that has to be stated with it**: bank GL balance = opening +
reconciled transactions holds only when the account is FULLY reconciled — nothing outstanding on
either side. On a real account there is almost always a cheque in the post, so an implementation
that asserts it unconditionally fails constantly and gets switched off. `checkBankInvariant()`
returns `fullyReconciled` alongside the result rather than assuming it.

The two kinds of outstanding item are also kept apart deliberately, because they are not the same
kind of thing: an unpresented cheque is a timing difference the bank will catch up with, while an
unrecorded bank charge is a missing ledger entry. Presented as one pool of "unmatched items", the
second hides behind the first — which is how bank charges go unrecorded for a year.
