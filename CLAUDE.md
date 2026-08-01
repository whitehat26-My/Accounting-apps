# Emil Accounting Apps — working agreements

Multi-tenant SaaS accounting for Malaysian SMEs and freelance accountants.
Base currency **MYR (RM)**. Architecture lives in `docs/architecture/` — read the relevant
document before implementing anything in that area.

## Non-negotiable rules

1. **The ledger is append-only.** Posted journal entries are never updated or deleted.
   Corrections are reversing entries that reference the original. Enforced by DB trigger.
2. **Money is `Money`** (integer minor units) in application code and `NUMERIC(19,4)` in
   PostgreSQL. Never a JavaScript `number`. Never a float. Ever.
3. **Every tenant-owned table** has `tenant_id` as the first column of its primary key,
   with RLS `ENABLED` *and* `FORCED`, and a policy carrying both `USING` and `WITH CHECK`.
4. **All journal writes go through `LedgerService.post()`.** Nothing else writes
   `journal_entry`, `journal_line`, or `account_period_balance`.
5. **Every financial write path is idempotent** on an `Idempotency-Key`.
6. **`packages/domain` is pure** — no IO, no database, no framework imports. Enforced in CI.
7. **Statutory values are effective-dated data**, never hardcoded constants. Tax rates,
   thresholds and filing rules live in versioned tables with validity windows.
8. **Dates:** `DD/MM/YYYY` for display, `Asia/Kuala_Lumpur` timezone, and `DATE`
   (not `TIMESTAMPTZ`) for accounting dates such as invoice date and tax point.
9. **Cross-tenant record access returns 404, not 403** — never confirm that another
   tenant's record exists.

## Stack

TypeScript (strict) · NestJS · Next.js 15 · PostgreSQL 16 · raw SQL via `postgres.js` ·
Redis + BullMQ · Zod · TanStack Query · shadcn/ui + Tailwind ·
Vitest · fast-check · Playwright
(Integration tests run against a real PostgreSQL 16 — `scripts/pg-dev.sh` locally, a GitHub
Actions service container in CI. Not Testcontainers: Docker is not available in every
environment this is developed in, and a harness that cannot start is a harness nobody runs.)

## Repository layout

**What exists today:**

```
apps/api            NestJS on Fastify — auth, RBAC, and the accounting surface
packages/domain     Money, ledger aggregates, TaxEngine — pure, zero IO
packages/db         Raw SQL migrations, RLS policies, repository services
```

**Planned, and deliberately not yet created** — do not assume these are present:

```
apps/web            Next.js
apps/worker         BullMQ processors (nothing currently drains `outbox_event`)
packages/contracts  Zod schemas + generated OpenAPI types
packages/ui         Shared component library
infra               Terraform
```

Zod schemas currently live inline in `apps/api`; there is no generated OpenAPI spec yet, so
the "OpenAPI spec updated" line below is aspirational rather than enforced.

## Definition of done

Typechecks · unit tests · integration test against real PostgreSQL ·
ledger invariants still hold (`docs/architecture/06-data-model.md` §6.9) ·
audit log row written for the mutation · OpenAPI spec updated.

## When uncertain about Malaysian rules

Say so and flag it for verification against LHDN, RMCD, SSM, BNM or PayNet primary
sources. Do not guess a tax rate, a registration threshold, or an e-Invoice field
requirement — a plausible-looking wrong rate is worse than an explicit gap.
