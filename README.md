# Emil Accounting Apps

Multi-tenant SaaS accounting for Malaysian SMEs and freelance accountants.
Base currency **MYR (RM)**. Positioned as a Xero-class product, built Malaysia-first.

> **Status:** architecture specification. No application code yet — the specification in
> [`docs/architecture/`](docs/architecture/) is the current deliverable and the input to implementation.

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
**TypeScript** end to end — NestJS + Next.js + Drizzle + Redis/BullMQ, on AWS `ap-southeast-5` (Malaysia).

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
