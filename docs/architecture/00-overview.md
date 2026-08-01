# Emil Accounting Apps — Technical Specification (Overview)

**Product:** Emil Accounting Apps — multi-tenant SaaS accounting for Malaysian SMEs and freelance accountants
**Positioning:** Xero-class core accounting, but Malaysia-first (RM base currency, SST, LHDN e-Invoice/MyInvois, FPX/DuitNow, MPERS/MFRS-shaped statements)
**Status:** Architecture specification — pre-implementation
**Audience:** Engineering, product, and the accountants who will validate the ledger behaviour

---

## 1. Why Malaysia-first matters architecturally

Xero, QuickBooks and Zoho all serve Malaysia as a "supported locale" — a tax-rate table and a currency symbol bolted onto a generic engine. The Malaysian compliance surface is not a locale; it is a set of hard requirements that reach into the write path of the ledger:

| Requirement | Architectural consequence |
| --- | --- |
| LHDN e-Invoice (MyInvois) | Every sales document needs an external submission lifecycle, a government-issued UUID, a 72-hour rejection window, and a QR/validation link on the PDF. This is a state machine, not a field. |
| SST (sales tax + service tax, multiple rates, exemptions) | Tax must be a rate-*versioned* data table with effective dates, not an enum. Historic documents must reprint with the rate that applied on their tax point. |
| No mature open banking | Bank reconciliation cannot assume a feed API. CSV/MT940/OFX import and a manual-first matching UX are MVP, feeds are a later adapter. |
| PDPA 2010 (as amended) | Data residency preference for Malaysia/Singapore regions, breach notification, appointed DPO, subject access/erasure workflows that must not break the immutable ledger. |
| MPERS vs MFRS | Chart of accounts templates and statement layouts (SOPL/SOFP) differ by reporting framework. Statement definitions must be data, not hardcoded views. |

Everything in this specification follows from treating those five rows as first-class.

## 2. Non-negotiable engineering principles

1. **The ledger is append-only.** Posted journal entries are never updated or deleted. Corrections are reversing entries. This is the single most important rule in the system, and it is enforced at the database level, not by convention.
2. **Money is never a float.** `NUMERIC(19,4)` in PostgreSQL, an integer-minor-unit `Money` value object in application code, banker's-rounding-free explicit rounding policy per tax jurisdiction.
3. **Every row is tenant-scoped, and the database enforces it.** PostgreSQL Row-Level Security with a session-scoped tenant GUC. Application bugs must not be able to leak cross-tenant data.
4. **Every mutation is attributable.** Append-only, hash-chained audit log covering who, what, before, after, when, from where.
5. **Reports read from rollups, not from raw journal scans.** Trial balance, SOPL and SOFP must be sub-second at 5 million journal lines.
6. **Idempotency everywhere on the write path.** Financial POSTs carry an idempotency key; retries never double-post.

## 3. Document map

| Document | Contents |
| --- | --- |
| [`01-system-architecture.md`](01-system-architecture.md) | Deployment topology, request lifecycle, multi-tenancy, Mermaid diagrams |
| [`02-core-modules.md`](02-core-modules.md) | MVP module breakdown: purpose, features, data models |
| [`03-tech-stack.md`](03-tech-stack.md) | Frontend, backend, database, infrastructure — with justifications and rejected alternatives |
| [`04-security-compliance.md`](04-security-compliance.md) | Encryption, RBAC, audit logging, PDPA, financial controls |
| [`05-malaysia-localization.md`](05-malaysia-localization.md) | MyInvois, SST, payment rails, statutory reporting, bank formats |
| [`06-data-model.md`](06-data-model.md) | Reference schema for the ledger core, with DDL sketches |
| [`07-prompt-engineering-guidelines.md`](07-prompt-engineering-guidelines.md) | Meta-prompts for building these modules with Claude |

## 4. MVP scope boundary

**In scope for MVP (v1.0):**
Identity & tenancy · Chart of Accounts & General Ledger · Sales (Invoicing & AR) · Purchases (Bills & AP) · Banking & Reconciliation · Tax (SST) · MyInvois e-Invoice submission · Reporting (Trial Balance, SOPL, SOFP, Cash Flow indirect, aged AR/AP, GL detail) · Audit & compliance · Notifications.

**Explicitly deferred to v1.1+:**
Payroll (EPF/SOCSO/EIS/PCB is a product in itself) · Inventory costing beyond simple stock-on-hand · Fixed asset depreciation schedules · Project/job costing · Budgeting · Multi-entity consolidation · Practice-management portal for accountant firms · Mobile native apps.

Deferring these is a scoping decision, not an architectural one — the module boundaries in `02-core-modules.md` leave clean seams for each.

## 5. Two decisions worth flagging before you build

**A. Modular monolith, not microservices.** Detailed in `03-tech-stack.md`. Double-entry accounting is a domain where a single ACID transaction spanning invoice + journal + tax + sequence allocation is a feature, not a limitation. Microservices would force distributed transactions (sagas) around the one thing that must never be eventually consistent. Extract services later, at known seams, when scale demands it.

**B. MyInvois is a queue-backed side effect, not a synchronous blocker.** An invoice must be issuable when LHDN's gateway is down. Post the invoice locally, enqueue submission, reconcile status asynchronously, and surface the compliance state in the UI. Building it synchronously will couple your uptime to theirs.

> **Verification note:** Malaysian tax rates, MyInvois rollout thresholds and API contracts change frequently. Every figure in `05-malaysia-localization.md` must be re-verified against LHDN, RMCD and PayNet primary sources before implementation, and rate/threshold data must live in versioned configuration tables so changes never require a deploy.
