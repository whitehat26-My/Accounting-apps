# Emil Accounting Apps — working agreements

Multi-tenant SaaS accounting for Malaysian SMEs and freelance accountants.
Base currency **MYR (RM)**. Architecture lives in `docs/architecture/` — read the relevant
document before implementing anything in that area.

## Non-negotiable rules

1. **The ledger is append-only.** Posted journal entries are never updated or deleted.
   Corrections are reversing entries that reference the original — via
   `reversePostedEntry()`, which writes `journal_entry.reversal_of_id`. Enforced by DB trigger.
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
apps/web            Next.js 15 shop UI — login, onboarding, POS, repairs, stock, takings
apps/worker         Outbox relay + scheduled jobs. PostgreSQL-backed, NOT BullMQ — see below
packages/contracts  Shared Zod primitives + the OpenAPI generator
packages/domain     Money, ledger aggregates, TaxEngine — pure, zero IO
packages/db         Raw SQL migrations, RLS policies, repository services
```

**Planned, and deliberately not yet created** — do not assume these are present:

```
packages/ui         Shared component library (apps/web hand-rolls five primitives; adopt one when that file outgrows itself)
infra               Terraform
```

`apps/web` holds NO arithmetic: amounts are strings end to end, display formatting lives in
`src/lib/display.ts`, and the moment a screen needs parseFloat the calculation belongs on the
server. Its Playwright journey (`pnpm --filter @emil/web test:e2e`) drives the real API and a
real PostgreSQL through register → onboard → item → cash sale → takings.

**Everything outstanding is in `docs/SETTLEMENT-REGISTER.md`, categorised BUILT /
DEFERRED-BY-DECISION / BLOCKED-ON-EXTERNAL / NOT-STARTED, with the exact unblocker named for
each blocked item.** Read it before concluding something is missing by oversight — several
things are absent on purpose, and the register says which and why. Add to it when you find a
gap; a gap that lives only in a conversation is indistinguishable, six months later, from one
nobody noticed.

**The OpenAPI spec is GENERATED, and the "OpenAPI spec updated" line below is now enforced
rather than aspirational.** It is not a second source of truth: `apps/api/src/openapi/scan.ts`
reflects over the same Nest metadata the router dispatches on and the same `@Requires`
metadata `AuthGuard` reads, so a path or a permission in the document cannot disagree with
the application. `@Doc({ request: () => schema })` attaches the schema the handler ACTUALLY
validates with — pass the object, never a copy of it. A conformance test compares the
document against Fastify's own router and fails on any route that is served-but-undocumented
or documented-but-unserved, and on any route taking a body with no schema. Served at
`GET /openapi.json`, unauthenticated.

Request shapes that a client needs still live beside their controllers; `packages/contracts`
holds the shared primitives (`decimal`, `isoDate`, `uuid`, …) so one constraint cannot mean
two things on two routes.

**The worker drains the outbox with PostgreSQL, not Redis.** The stack line above names
BullMQ, and it is deferred rather than adopted. The outbox exists to eliminate a dual
write — the job and the ledger effect commit together only while the job lives in the same
database as the effect — so pushing to Redis from the writing transaction would reintroduce
exactly the inconsistency the pattern prevents. `SELECT … FOR UPDATE SKIP LOCKED` is the
right primitive, and a second datastore introduced for one nightly job is operational
burden with no offsetting gain. BullMQ earns its place when something needs cross-process
rate limiting or fan-out beyond one poller.

**The worker connects as `emil_worker`, not `emil_app`.** It holds EXECUTE on the
SECURITY DEFINER functions that read the outbox across every tenant; the internet-facing
API cannot call them. Migrations must be applied by a role that bypasses RLS or those
functions silently return nothing — migration 0021 asserts this rather than assuming it.

## Definition of done

Typechecks · unit tests · integration test against real PostgreSQL ·
ledger invariants still hold (`docs/architecture/06-data-model.md` §6.9) ·
audit log row written for the mutation · OpenAPI spec updated.

## When uncertain about Malaysian rules

Say so and flag it for verification against LHDN, RMCD, SSM, BNM or PayNet primary
sources. Do not guess a tax rate, a registration threshold, or an e-Invoice field
requirement — a plausible-looking wrong rate is worse than an explicit gap.
