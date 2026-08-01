# Emil Accounting Apps

Multi-tenant SaaS accounting for Malaysian SMEs and freelance accountants.
Base currency **MYR (RM)**. Positioned as a Xero-class product, built Malaysia-first.

> **Status:** Ledger core, tax engine, invoicing, receipts, credit notes, the MyInvois
> submission lifecycle, multi-currency settlement with period-end revaluation on both
> sides of the balance sheet, the financial statements (trial balance, SOPL, SOFP), and
> purchases/AP — bills, supplier payments, debit notes, ageing and the withholding
> mechanism — and banking: statement import, the reconciliation matching engine, and
> reconciliation sessions — and M0: users, the multi-organisation model, roles and
> permissions, refresh-token rotation with reuse detection, API keys, and a NestJS
> HTTP API over the whole thing. Implemented and tested.
>
> **All fourteen ledger invariants now have tests behind them.**
> The full architecture specification lives in [`docs/architecture/`](docs/architecture/).

## Quick start

```bash
pnpm install
./scripts/pg-dev.sh start          # local PostgreSQL 16 on :55432
export DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres
export JWT_SECRET=any-32-character-string-for-local-dev
pnpm typecheck && pnpm test        # 666 tests
```

| Package | Contents |
| --- | --- |
| `packages/domain` | Pure core — `Money`, journal validation and reversal, the SST tax engine, document/posting construction, allocation, credit and debit notes, the e-Invoice document model and state machine, FX conversion with realised and unrealised gain/loss, the statement engine, ageing, withholding, statement parsing and the bank matching engine. Zero IO, zero framework imports. |
| `packages/db` | Schema, RLS policies, integrity triggers, the write paths (`postJournalEntry()`, `issueInvoice()`, `recordReceipt()`, `issueCreditNote()`, `enterBill()`, `paySupplier()`, `issueDebitNote()`, `runRevaluation()`, `importStatement()`, `confirmMatch()`), identity and sessions, and the MyInvois submission lifecycle. |
| `apps/api` | NestJS on Fastify. The middleware chain from `docs/architecture/01-system-architecture.md` §1.3: request context → rate limit → authentication → tenant resolution → RBAC → idempotency → handler. Controllers translate and authorise; they contain no business logic. |

**What's proven, not just asserted.** 389 domain tests, 252 integration tests against a real
PostgreSQL, and 25 end-to-end tests through the real HTTP application.

Property-based tests (fast-check) cover ledger invariants 1, 2 and 4, plus: tax lines always sum to
the document total under either rounding policy, the tax summary always reconciles to document
totals, every generated document produces either a valid balanced journal or no journal at all, and
auto-allocation never applies more than was received or more than is owed, a credit note is
always the exact mirror of the invoice it corrects — line for line, and netting every account back
to zero — a debit note is likewise the exact mirror of the bill it corrects, a foreign-currency
settlement balances at any pair of rates, a two-sided revaluation balances whatever either side
does, withholding's net and withheld always sum back to the gross exactly, every ageing bucket
total sums to the report total, a set of books and a statement that genuinely agree always
reconcile to zero however the outstanding items fall, and statement parsing never throws on any
input at all.

The database tests are the load-bearing ones — RLS tenant isolation, the deferred balanced-entry
trigger, posted-entry / issued-invoice / recorded-payment immutability, gapless numbering surviving
rollback, AR control agreeing with the invoice subledger through partial settlement (invariant 6),
rollup/journal agreement, effective-dated rates resolving at the tax point, over-settlement refused
at the database level whether by payment or by credit, credit notes netting output tax down for the
SST return, e-Invoice documents assembled from the ledger reconciling to their own lines, AR
clearing to exactly zero when a foreign invoice is settled at a moved rate (invariant 13),
a period-end revaluation reversing so cleanly that the later realised gain is measured from the
original rate rather than double-counted, AP control agreeing with the bill subledger through
partial payment and debit notes (invariant 7), the same supplier invoice number accepted from two
suppliers and refused twice from one, an allocation refused unless it names exactly one of a bill or
an invoice, aged receivables at a PAST date tying to the AR control account at that date, a
supplier payment and a customer receipt at identical rates producing equal-and-opposite realised FX,
input tax absorbed as a cost rather than booked as an asset, withholding discharging the payable at
the gross while only the net leaves the bank, the balance sheet balancing after invoices, receipts,
credit notes, bills, supplier payments, FX settlement and revaluation (invariant 3), the bank GL
account equalling opening plus reconciled transactions once nothing is outstanding on either side
(invariant 8), a re-imported overlapping statement skipping exactly the rows already held while
keeping two genuinely identical same-day withdrawals, an imported bank line refusing to have its
amount edited, an unmatch leaving both decisions visible rather than deleting one, a period refusing
to be signed off while a variance remains, a view without `security_invoker` being caught before it
can leak across tenants, and NUMERIC never degrading to a float. None of that can be verified
against a mock.

**Not implemented, deliberately:** Malaysian withholding tax RATES. The mechanism is built and
tested — resolution with treaty precedence, the gross/net split, the `Dr AP / Cr Bank / Cr WHT
Payable` posting, and append-only evidence — but `wht_rate` ships EMPTY and a payment that asks to
withhold without a configured rate fails loudly. Rates depend on payment type and on any applicable
double taxation agreement and must be verified against LHDN; a plausible-looking wrong rate is worse
than an explicit gap, because the payer carries the liability for under-withholding.

**Not implemented, deliberately:** SSO, MFA and OAuth2 clients. `app_user.mfa_secret` exists and
the role set already distinguishes the cases MFA should be mandatory for, but a TOTP flow nobody has
enrolled in is untested security machinery, which is worse than none. Rate limiting is in-memory
rather than Redis-backed for the same reason — correct for one instance, stated as such, and behind
an interface a Redis implementation drops into. Neither is the login protection: that is the
per-account lockout in `record_login_outcome`, which survives a restart and cannot be evaded by
changing source address.

**Not implemented, deliberately:** live bank feeds. `BankFeedProvider` is a port with no adapter.
Malaysia has no broad open banking, so CSV import is the product rather than a fallback, and a
client written against an aggregator nobody has integrated would look finished and be wrong.

**Not implemented, deliberately:** the MyInvois HTTP client. `MyInvoisGateway` is declared as a port
in the domain layer; the adapter is written against LHDN's published SDK and tested against their
sandbox. A speculative client built against unverifiable endpoint paths would look finished and
probably be wrong — worse than an obvious gap, because it invites trust.

## What makes this different from a localised Xero

Malaysian compliance is not a locale setting; it reaches into the write path of the ledger:

- **LHDN e-Invoice (MyInvois)** — a full submission lifecycle with government UUIDs, validation results, and a bounded cancellation window, not a checkbox
- **SST modelled correctly** — sales tax and service tax are two distinct regimes, and neither is a VAT. Most products retrofit a GST engine and get the P&L wrong.
- **Import-first bank reconciliation** — no mature open banking in Malaysia, so real CSV/MT940 handling for real Malaysian banks is the product, not a fallback
- **FPX and DuitNow collections** — the rails Malaysian customers actually pay with
- **MPERS and MFRS statement layouts** as data, so SOPL/SOFP presentation matches the tenant's reporting framework

## Documentation

| Document | Contents |
| --- | --- |
| [00 · Overview](docs/architecture/00-overview.md) | Principles, MVP scope boundary, document map |
| [01 · System Architecture](docs/architecture/01-system-architecture.md) | Topology, request lifecycle, multi-tenancy, performance — with diagrams |
| [02 · Core Modules](docs/architecture/02-core-modules.md) | M0–M9: purpose, features, data models, build order |
| [03 · Technology Stack](docs/architecture/03-tech-stack.md) | Frontend, backend, database, infrastructure — with justifications |
| [04 · Security & Compliance](docs/architecture/04-security-compliance.md) | Encryption, RBAC, audit logging, PDPA, business continuity |
| [05 · Malaysian Localisation](docs/architecture/05-malaysia-localization.md) | MyInvois, SST, payment rails, formats, competitive positioning |
| [06 · Data Model](docs/architecture/06-data-model.md) | Ledger core DDL, RLS, immutability triggers, invariants |
| [07 · Prompt Engineering](docs/architecture/07-prompt-engineering-guidelines.md) | Meta-prompts for building these modules with Claude |

## Architecture at a glance

**Modular monolith** (`emil-api`, `emil-worker`, `emil-web`) on **PostgreSQL 16** with row-level-security multi-tenancy.
**TypeScript** end to end — NestJS + Next.js + `postgres.js` + Redis/BullMQ, on AWS `ap-southeast-5` (Malaysia).

Microservices were considered and rejected for the MVP: issuing an invoice must atomically touch the number sequence, the AR subledger, the tax engine, the general ledger and the e-invoice outbox. That belongs in one transaction, not a saga. Extraction seams are documented for when scale demands them.

## The rules that everything else follows

1. **The ledger is append-only.** Posted journal entries are never updated or deleted — corrections are reversing entries, enforced by database trigger.
2. **Money is never a float.** `NUMERIC(19,4)` in PostgreSQL, integer minor units in code.
3. **The database enforces tenant isolation**, not the application. RLS with `FORCE`, `tenant_id` first in every primary key.
4. **Every mutation is attributable** via a hash-chained, append-only audit log.
5. **Reports read from rollups**, never from raw journal scans.
6. **Statutory values are effective-dated data**, never hardcoded constants.

## MVP scope

**In:** identity & tenancy · general ledger · sales/AR · purchases/AP · banking & reconciliation · SST · MyInvois · reporting (Trial Balance, SOPL, SOFP, cash flow, ageing) · audit.

**Deferred:** payroll (EPF/SOCSO/EIS/PCB) · inventory costing · fixed assets · job costing · budgeting · consolidation · native mobile.

---

⚠️ Malaysian tax rates, e-Invoice thresholds and API contracts change frequently. Every statutory figure in these documents must be re-verified against LHDN, RMCD, SSM, BNM and PayNet primary sources before implementation.
