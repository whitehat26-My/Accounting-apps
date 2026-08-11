# Reading these books from a separate service

**Audience:** somebody writing a second service — Python, Django, anything —
that connects to the same PostgreSQL database this application owns, to read
from it.

**Status:** the schema described here is what migrations 0001–0033 actually
build; every table name, column type and trigger below was read out of a live
database rather than transcribed from the migration files. The read-only role
in §3 does not exist yet — the SQL to create it is given, and the gap is
recorded in `docs/SETTLEMENT-REGISTER.md`.

---

## 0. Read this section before you write a query

Four things about this database are unusual enough that a service written
against normal assumptions will not merely be wrong, it will be *quietly* wrong.

**A connection that has not announced its tenant sees nothing.** Not an error —
nothing. Empty result sets, from every one of the 81 tenant-owned tables. §2.

**Every money column is `NUMERIC(19,4)` and must reach Python as `Decimal`.**
`psycopg` does this correctly by default. Anything that turns it into a `float`
on the way past — a `pandas` read, an ORM field declared `FloatField`, a
`json.dumps` — has silently introduced rounding into an accounting system. §4.

**Do not write. Anything.** Not a "harmless" flag, not a cached total. The
ledger is append-only by database trigger and the audit log is a hash chain;
a write from outside the application does not just bypass a convention, it can
break a chain that is checked. §5.

**The ledger is the truth; every other table is a projection of it.** If a
figure in `invoice` and a figure in `journal_line` disagree, the journal is
right and something is broken. Report totals from the ledger. §6.

---

## 1. Shape of the thing

101 tables in `public`. They divide cleanly:

| Group | Count | RLS | What it is |
| --- | ---: | --- | --- |
| Tenant-owned | 81 | `ENABLED` + `FORCED` | One organisation's books. Everything you want. |
| Global reference | 20 | none | Shared across tenants: permission codes, e-Invoice code lists, statutory bands, report templates, migration history. |

Every tenant-owned table has `tenant_id` as the **first column of its primary
key** — `(tenant_id, id)`, or a wider natural key like
`account_period_balance (tenant_id, account_id, fiscal_period_id, currency)`.
This is not decoration: it means every index is already tenant-local, so
filtering by tenant is free rather than a scan-and-discard.

The 20 global tables, by name, so you never wonder whether a table is missing a
`tenant_id` by mistake:

```
app_permission  app_role  app_user  role_permission  user_session  signup_invite
einvoice_classification_code  einvoice_uom_code
report_template  report_template_line  report_template_line_map
scheduled_job  schema_migration
statutory_deadline_rule  statutory_eis_band  statutory_epf_band
statutory_epf_rule  statutory_mtd_band  statutory_mtd_relief  statutory_socso_band
```

Note what is *not* in that list: `app_user` is global (a person can belong to
several organisations), but `membership` — which says who belongs to what — is
tenant-owned.

---

## 2. Row-level security, and the silence

Every tenant-owned table carries one policy:

```sql
CREATE POLICY tenant_isolation ON invoice
  USING       (tenant_id = current_tenant_id())
  WITH CHECK  (tenant_id = current_tenant_id());
```

and `current_tenant_id()` is:

```sql
raw := current_setting('app.tenant_id', true);
IF raw IS NULL OR raw = '' THEN RETURN NULL; END IF;
RETURN raw::uuid;
```

`tenant_id = NULL` is never true, so **a connection that has not set
`app.tenant_id` matches no rows at all**. Not one. This is the single most
expensive thing to learn by debugging, because there is no error message, no
warning and no log line — a `SELECT count(*) FROM invoice` returns `0`, and `0`
is a plausible answer for a new organisation.

RLS is `FORCED` as well as `ENABLED`, which matters because `ENABLED` alone is
skipped for the table's owner. Forced, the owner is constrained too. The only
escape is a role with `BYPASSRLS`, and no application role has it.

So every read starts a transaction and announces the tenant:

```python
from contextlib import contextmanager
from uuid import UUID
import psycopg

@contextmanager
def tenant(conn: psycopg.Connection, tenant_id: UUID):
    """Open a transaction scoped to one organisation's books.

    `set_config(..., true) ` is transaction-LOCAL. That is the whole point: the
    setting dies with the transaction, so a pooled connection cannot carry one
    tenant's identity into the next request. Never use `SET app.tenant_id`
    (session-scoped) and never set it outside a transaction — both leak across
    borrowers of the same connection, and the failure looks like one customer
    seeing another customer's invoices.
    """
    with conn.transaction():
        conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
        yield conn
```

Used:

```python
with tenant(conn, org_id) as tx:
    rows = tx.execute("SELECT invoice_no, total FROM invoice WHERE status <> 'DRAFT'").fetchall()
```

Note there is **no `WHERE tenant_id = ...`** in that query. You may add one, and
it costs nothing, but the policy is what enforces it. Writing the filter by hand
and *not* setting the GUC gives you zero rows; setting the GUC and forgetting
the filter is correct. Rely on the policy.

**How to tell the difference between "no data" and "no tenant".** Ask:

```sql
SELECT current_tenant_id();
```

`NULL` means the connection is blind and every query is lying to you by
omission. This is worth asserting at the top of any job.

### Django, specifically

Django's ORM will fight this, because it opens transactions where it likes.
Two workable shapes:

1. **A separate read-only `DATABASES` alias with `ATOMIC_REQUESTS = True`**, plus
   middleware that runs `set_config` as the first statement of every request's
   transaction. Route reader models with a database router.
2. **Skip the ORM for this database.** Use `psycopg` directly behind a thin
   repository layer. Given that everything here is read-only and mostly
   aggregate reporting, the ORM is not buying much, and it removes any risk of
   a `save()` reaching a table it must never touch.

The second is the recommendation. An ORM's value is in managing writes.

---

## 3. Connect as a role that cannot write

Today there are exactly two login roles, created by `scripts/prod-roles.sql`:

| Role | Inherits | For |
| --- | --- | --- |
| `emil_app_login` | `emil_app` | the API |
| `emil_worker_login` | `emil_worker` | the outbox relay |

**Use neither.** `emil_app_login` can write every table your service must not
touch. `emil_worker_login` is worse: it holds `EXECUTE` on the SECURITY DEFINER
functions that read *across every tenant* — `all_tenant_ids`,
`claim_outbox_batch`, `take_audit_anchor` — which exist precisely so that the
internet-facing API cannot call them. Handing that to a reporting service
donates the one privilege the design spends effort withholding.

Create a third role that can only read:

```sql
-- A reader. NOBYPASSRLS is stated rather than assumed: row-level security is
-- the only thing standing between this role and every tenant in the database,
-- and a role that bypasses it would see all of them at once.
CREATE ROLE emil_reader_login LOGIN NOBYPASSRLS PASSWORD :reader_password;

GRANT CONNECT ON DATABASE emil TO emil_reader_login;
GRANT USAGE   ON SCHEMA public TO emil_reader_login;
GRANT SELECT  ON ALL TABLES IN SCHEMA public TO emil_reader_login;

-- Tables added by future migrations, without which the reader breaks on the
-- next deploy rather than at a time anybody is watching.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO emil_reader_login;

-- `set_config` needs no grant. The SECURITY DEFINER functions in §5 are
-- deliberately NOT granted: this role reads one tenant at a time or nothing.
```

Then make writes impossible rather than merely forbidden, by opening the
connection read-only:

```python
conn = psycopg.connect(READER_DSN)
conn.read_only = True   # PostgreSQL refuses any write, whatever the code asks
```

Belt and braces, and the braces are the ones that hold: a `GRANT` can be widened
by a well-meaning migration, but `read_only` is asserted by the client on every
connection and shows up in the code review of the service itself.

---

## 4. Types

| PostgreSQL | Columns | Python | Notes |
| --- | ---: | --- | --- |
| `NUMERIC(19,4)` | 153 | `decimal.Decimal` | **Every money amount.** Never `float`. |
| `NUMERIC(19,8)` | — | `decimal.Decimal` | FX rates only. |
| `UUID` | 333 | `uuid.UUID` | |
| `TEXT` | 332 | `str` | |
| `TIMESTAMPTZ` | 124 | `datetime` (aware) | *When a row was written.* |
| `DATE` | 62 | `date` | *When something happened in the books.* See below. |
| `SMALLINT` / `INTEGER` | 69 | `int` | Also basis points — see below. |
| `JSONB` | 12 | `dict` | |
| `BYTEA` | 9 | `bytes` | Hashes and photo data. |

**`DATE` and `TIMESTAMPTZ` are not interchangeable here, and the distinction is
deliberate.** An invoice date, a tax point, a payment date and a stock movement
date are `DATE`, because an invoice issued on 31/08 is an August invoice in
Kuala Lumpur regardless of what instant that was in UTC — storing it as an
instant means a period boundary can move under you depending on where the
reader is standing. `created_at`, `posted_at`, `occurred_at` are `TIMESTAMPTZ`,
because those are instants.

So: **never `date_trunc` a `TIMESTAMPTZ` to decide which period something falls
in.** Use the `DATE` column, or join to `fiscal_period` (§6).

The application timezone is `Asia/Kuala_Lumpur` and display format is
`DD/MM/YYYY`. Neither is stored — they are presentation, applied at the edge.

**Rates are basis points, not percentages.** `tax_rate_version.rate_basis_points`
and `invoice_line.discount_basis_points` are integers: 600 is 6%, not 600%.
Divide by 10 000, as a `Decimal`.

```python
from decimal import Decimal
rate = Decimal(row["rate_basis_points"]) / Decimal(10_000)
```

**Currency is `CHARACTER(3)`** — fixed width, so it comes back space-padded in
some drivers. `.strip()` before comparing. Base currency is `MYR` throughout;
`journal_line` carries both the transaction amount (`debit`/`credit`) and the
base-currency amount (`base_debit`/`base_credit`). **Report on the base columns.**

---

## 5. What you must not touch, and why it is not merely a rule

### The ledger refuses to be edited

`journal_entry` and `journal_line` carry triggers that are not advisory:

| Table | Trigger | Effect |
| --- | --- | --- |
| `journal_entry` | `trg_journal_entry_immutable` | `DELETE` of a posted entry raises; un-posting raises; a named list of columns is frozen — see below |
| `journal_entry` | `trg_journal_entry_balanced` | debits must equal credits |
| `journal_entry` | `trg_journal_entry_period_open` | no posting into a closed period |
| `journal_line` | `trg_journal_line_immutable` | **any** `UPDATE` or `DELETE` of a line whose entry is POSTED or REVERSED raises |
| `audit_log` | `trg_audit_log_append_only` | `UPDATE`/`DELETE` raises, always |
| `audit_log` | `trg_audit_log_chain` | computes `prev_hash` / `row_hash` on insert |

A correction is a **reversing entry** that points at the original through
`journal_entry.reversal_of_id`. There is no other mechanism for changing what
the books say. If your service ever needs to *change* something, it calls the
API — it does not reach into the tables.

**Be exact about what "immutable" covers, because it is not the whole row.**
Tested against a live database rather than inferred:

- **`journal_line` is absolutely immutable once its entry is posted.** Every
  amount — `debit`, `credit`, `base_debit`, `base_credit`, `account_id` — is
  beyond reach. This is the part that matters, and it holds without exception.
- **`journal_entry` freezes `entry_no`, `entry_date`, `fiscal_period_id`,
  `tenant_id`, `source_module` and `posted_at`**, refuses `DELETE`, and refuses
  any status change out of POSTED/REVERSED.
- **`journal_entry.description` is NOT frozen.** A posted entry's narration can
  be rewritten in place. `UPDATE journal_entry SET description = …` on 84 posted
  entries succeeded when this was tested — so the narration is *tamper-evident*
  rather than *tamper-proof*: `trg_audit_journal_entry` writes the before and
  after into `audit_log`, on the hash chain, where it cannot then be removed.

For a reader none of this changes anything — you are not writing. It is here so
that nobody reads "the ledger is append-only" and concludes a `description` in
a report is as unfalsifiable as the amount beside it. It is not; it is merely
impossible to change without leaving a signed trace. The gap is recorded in
`docs/SETTLEMENT-REGISTER.md`.

### The audit log is a hash chain

`audit_log` has `prev_hash`, `row_hash` and `hash_version`. Each row's hash
covers the previous row's, so the sequence is verifiable end to end
(`verify_audit_chain()`), and anchors are published so that verification works
against a copy taken months ago. An `INSERT` from outside the application —
even a well-intentioned one recording that your service ran — would be computed
by the trigger but attributed to nobody, because the actor context
(`app.user_id`, request id, IP) is set by the application and would be empty.
You would be adding unattributable links to a chain whose value is that every
link is attributable.

Read it freely. Never write it.

### The cross-tenant functions are not for you

28 `SECURITY DEFINER` functions exist. Most are authentication
(`find_user_for_authentication`, `rotate_session`, `create_session`) and are
irrelevant to a reader. A handful — `all_tenant_ids()`, `claim_outbox_batch()`,
`take_audit_anchor()`, `verify_audit_chain()` — read *past* RLS across every
tenant, which is why only `emil_worker` holds `EXECUTE` on them.

If you find yourself wanting `all_tenant_ids()` to loop over organisations,
that is a decision to make deliberately and not by convenience. The safe shape
is to hold the list of tenant UUIDs your service is *authorised* for in your own
configuration, and iterate that — one `set_config` per tenant, one transaction
per tenant. Then a bug in your loop cannot widen your reach.

---

## 6. The map

### The ledger — everything else is a projection of this

```
fiscal_year (tenant_id, id)
  └─ fiscal_period (tenant_id, id) ─ sequence, start_date, end_date, status
                                     status: OPEN | CLOSED | LOCKED

account (tenant_id, id) ─ code, name, type, subtype, parent_id, currency,
                          is_system, is_active
     │                    type: ASSET | LIABILITY | EQUITY | INCOME | EXPENSE
     │
     ├─ journal_line.account_id
     └─ account_period_balance (tenant_id, account_id, fiscal_period_id, currency)
            debit_total, credit_total, net_movement          ← rolled up, NUMERIC(19,4)

journal_entry (tenant_id, id)
    entry_no, entry_date DATE, fiscal_period_id, description,
    source_module, source_document_type, source_document_id,
    status, reversal_of_id, idempotency_key, posted_by, posted_at, created_at
  └─ journal_line (tenant_id, id)
        journal_entry_id, line_no, account_id,
        debit, credit,                    ← transaction currency
        base_debit, base_credit,          ← MYR. REPORT ON THESE.
        currency, fx_rate,
        description, contact_id, tax_code_id, tracking_option_id
```

`source_document_type` / `source_document_id` are the thread back from a journal
entry to whatever caused it — an invoice, a payment, a stock movement. That is
the join to use when you want "show me the entries behind this invoice", and it
is more reliable than the reverse pointer, because it is written by the posting
itself.

A trial balance, correctly:

```sql
SELECT a.code, a.name, a.type,
       SUM(l.base_debit)  AS debits,
       SUM(l.base_credit) AS credits
FROM journal_line l
JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
JOIN account      a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
WHERE e.entry_date BETWEEN %s AND %s
  AND e.status = 'POSTED'
GROUP BY a.code, a.name, a.type
ORDER BY a.code;
```

Two things to copy from that query. **Join on `tenant_id` as well as the id** —
the policy already restricts you to one tenant so it is not a correctness
requirement, but it matches the composite primary key and the planner uses the
index. And **filter `e.status = 'POSTED'`**: drafts are in the same table.

### Sales

```
contact (tenant_id, id) ─ name, is_customer, is_supplier, tin, sst_no, msic_code,
                          payment_terms_days, credit_limit, requires_einvoice
  └─ invoice (tenant_id, id)
        invoice_no, contact_id,
        issue_date DATE, due_date DATE, tax_point_date DATE,
        currency, fx_rate, amounts_tax_inclusive,
        subtotal, tax_total, rounding_adjustment, total,
        amount_paid, amount_credited, amount_due,
        status, journal_entry_id, idempotency_key, issued_by, issued_at
     └─ invoice_line (tenant_id, id)
           invoice_id, line_no, item_id, description, quantity, unit_price,
           discount_basis_points, account_id, tax_code_id,
           taxable_amount, tax_amount, line_total,
           classification_code, uom_code       ← e-Invoice code lists

payment (tenant_id, id)
    payment_no, contact_id, direction, payment_date DATE, method,
    deposit_account_id, currency, amount, unallocated_amount,
    base_amount, realised_fx, journal_entry_id
  └─ payment_allocation (tenant_id, id) ─ payment_id, invoice_id | bill_id, amount
```

`amount_due` is maintained on the invoice, and it is a convenience, not the
source of truth — an ageing report built from `amount_due` is fine for a screen
and wrong for a statutory return. Derive receivables from the ledger.

`payment_allocation` is why a payment cannot simply be joined to an invoice:
one payment may settle several invoices and one invoice may take several
payments. Sum through the allocation.

### Purchases, and the mirror image

`bill` / `bill_line` mirror `invoice` / `invoice_line`. `credit_note` reduces a
sale, `debit_note` reduces a purchase; each has `_line` and `_allocation`
children with the same shape. `withholding_transaction` and `wht_rate` handle
withholding tax.

### Stock

```
item (tenant_id, id) ─ code, name, item_type, barcode,
                       is_tracked, is_serialised, warranty_months,
                       sale_unit_price, sale_account_id, sale_tax_code_id,
                       purchase_unit_price, purchase_account_id, ...
  ├─ item_stock (tenant_id, item_id) ─ quantity_on_hand, stock_value
  ├─ stock_movement (tenant_id, id)
  │     item_id, movement_type, quantity, value_delta,
  │     source_document_type, source_document_id, journal_entry_id,
  │     moved_on DATE, reason, idempotency_key
  └─ stock_unit (tenant_id, id) ─ individual serial numbers
```

Costing is **weighted average**. `item_stock.stock_value` divided by
`quantity_on_hand` is the current average cost; `stock_movement.value_delta` is
what each movement did to that value. Do not recompute cost from
`item.purchase_unit_price` — that is a default for data entry, not a cost.

### Repairs, payroll, banking, tax

- `repair_job` / `repair_job_line` / `repair_job_photo` — the workshop.
  `status` runs RECEIVED → QUOTED → APPROVED → IN_PROGRESS → READY → COLLECTED,
  with DECLINED and CANCELLED as exits.
- `employee`, `pay_run`, `pay_run_line` — payroll. Statutory bands live in the
  global `statutory_*` tables, effective-dated.
- `bank_account`, `bank_statement`, `bank_transaction`, `bank_rule`,
  `reconciliation_session`, `reconciliation_match`.
- `tax_code` + `tax_rate_version` — **rates are effective-dated, never constant.**
  A rate lookup must carry a date:

```sql
SELECT v.rate_basis_points
FROM tax_rate_version v
JOIN tax_code c ON c.tenant_id = v.tenant_id AND c.id = v.tax_code_id
WHERE c.code = %s
  AND v.valid_from <= %s
  AND (v.valid_to IS NULL OR v.valid_to > %s);
```

  Hardcoding 6% in a Python service reintroduces exactly the bug the versioned
  table exists to prevent, and it will not surface until the rate changes —
  which is the worst possible moment to discover it.

### Audit and integrity

```
audit_log (tenant_id, id BIGINT)
    actor_user_id, actor_ip INET, user_agent, request_id,
    action, entity_type, entity_id,
    before_json JSONB, after_json JSONB,
    occurred_at TIMESTAMPTZ,
    prev_hash BYTEA, row_hash BYTEA, hash_version SMALLINT

audit_anchor (tenant_id, id)      ─ published checkpoints on the chain
financial_event_log (tenant_id, id)
document_fingerprint (tenant_id, id)
```

The time column here is `occurred_at`, **not `created_at`** — a detail that has
already cost one debugging session, because most other tables use `created_at`
and the mistake produces a syntax error only if you are lucky.

---

## 7. Keeping up with the schema

`schema_migration` (global, no RLS) records what has been applied. A reader
should check it on start-up and refuse to run against a database newer than it
knows about, rather than discovering a renamed column mid-report:

```python
applied = conn.execute("SELECT max(version) FROM schema_migration").fetchone()[0]
```

Columns get renamed here — `net_movement` was once two differently-named
columns. Nothing about this database is a public API, and the only contract with
an outside reader is this document plus whatever tests that reader writes
against a real schema. Write those tests. `scripts/pg-dev.sh` starts a
PostgreSQL 16 you can migrate and point them at.

---

## 8. The shortest correct reader

```python
"""Everything in §0 through §5, in one file."""
from contextlib import contextmanager
from decimal import Decimal
from uuid import UUID
import psycopg
from psycopg.rows import dict_row


def connect(dsn: str) -> psycopg.Connection:
    conn = psycopg.connect(dsn, row_factory=dict_row)
    conn.read_only = True          # the database refuses writes, not just the code
    return conn


@contextmanager
def tenant(conn: psycopg.Connection, tenant_id: UUID):
    with conn.transaction():
        conn.execute("SELECT set_config('app.tenant_id', %s, true)", (str(tenant_id),))
        # Prove the setting landed. Without this, a typo in the GUC name gives
        # empty results that look exactly like an organisation with no data.
        got = conn.execute("SELECT current_tenant_id() AS t").fetchone()["t"]
        if got != tenant_id:
            raise RuntimeError(f"tenant not set: policies see {got!r}, expected {tenant_id!r}")
        yield conn


def trial_balance(conn, tenant_id: UUID, start, end) -> list[dict]:
    """Straight from the ledger. Returns Decimal, in MYR, from the base columns."""
    with tenant(conn, tenant_id) as tx:
        return tx.execute(
            """
            SELECT a.code, a.name, a.type,
                   SUM(l.base_debit)  AS debits,
                   SUM(l.base_credit) AS credits
            FROM journal_line l
            JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
            JOIN account      a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
            WHERE e.entry_date BETWEEN %s AND %s AND e.status = 'POSTED'
            GROUP BY a.code, a.name, a.type
            ORDER BY a.code
            """,
            (start, end),
        ).fetchall()


def assert_balanced(rows: list[dict]) -> None:
    """Debits equal credits, or the read is wrong — the books are not."""
    debits  = sum((r["debits"]  or Decimal(0) for r in rows), Decimal(0))
    credits = sum((r["credits"] or Decimal(0) for r in rows), Decimal(0))
    if debits != credits:
        raise AssertionError(f"trial balance out by {debits - credits}")
```

That last function is worth keeping. A trial balance that does not balance is
proof that the *query* is wrong — a missed status filter, a join that fanned
out, a period boundary taken from a `TIMESTAMPTZ`. The database's own invariants
guarantee the underlying entries balance, so the assertion only ever fires on
your side, which makes it the cheapest test in the service.

---

## 9. Things this document does not promise

- **That the schema is stable.** It is not versioned for outside consumers.
- **That reading is free.** A reporting query over `journal_line` on a busy
  database competes with the application. Use a read replica when there is one.
- **That the Malaysian statutory content is right for your purpose.** Rates,
  thresholds and e-Invoice field requirements are effective-dated data here on
  purpose; verify anything you act on against LHDN, RMCD, SSM, BNM or PayNet
  primary sources rather than treating this database as authority.
