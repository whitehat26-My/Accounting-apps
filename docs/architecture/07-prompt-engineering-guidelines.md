# 7. Prompt Engineering Guidelines for Building Emil with Claude

How to ask for code so that what comes back is correct, consistent with the rest of the system, and testable. These guidelines are written for this codebase specifically — the templates reference the modules, invariants, and conventions defined in documents 1–6.

---

## 7.1 The core principle

**A vague prompt produces a plausible answer. A financial system needs a correct one.**

The difference between the two is almost entirely how much *domain context and constraint* you supply. When you ask for "a bank reconciliation function", any competent model will produce something reasonable — and it will quietly invent its own tolerance thresholds, its own tie-breaking rules, and its own idea of what a match means. Those inventions will be defensible in isolation and wrong for your product.

The fix is not longer prompts. It is prompts that specify **the decision points you care about** and explicitly hand over the ones you don't.

---

## 7.2 The universal prompt skeleton

Use this shape for any feature request. Sections 1, 3, 4 and 6 are mandatory; the rest are situational.

```
1. CONTEXT      — which module, which document in docs/architecture/, what already exists
2. TASK         — one sentence, one deliverable
3. CONSTRAINTS  — invariants, conventions, and what must NOT change
4. INPUT/OUTPUT — exact types and signatures
5. EDGE CASES   — the ones you already know about
6. ACCEPTANCE   — how you will judge the result; the tests it must pass
7. NON-GOALS    — what to leave alone (prevents helpful-but-unwanted refactors)
```

### A concrete before/after

**Weak:**
> Write the invoice creation logic for my accounting app.

You will get a `createInvoice` function with an ORM you don't use, floats for money, no tenant scoping, no tax engine call, and no ledger posting.

**Strong:**
> **Context:** Module M2 (Sales & AR) in the Emil codebase. `packages/domain` already has `Money`, `TaxEngine.compute()`, and `LedgerService.post()`. The SQL schema for `invoice` / `invoice_line` exists in `packages/db/migrations`.
>
> **Task:** Implement `InvoiceService.issue()` — the transition from `DRAFT` to `ISSUED`.
>
> **Constraints:**
> - Single database transaction: allocate invoice number → update invoice status → compute tax → post journal entry → insert outbox event for e-invoice submission → write audit log.
> - Money is `Money` (integer minor units), never `number`.
> - Invoice number via `NumberSequence` + `pg_advisory_xact_lock` — gapless (see `06-data-model.md` §6.6).
> - Journal posting goes exclusively through `LedgerService.post()`. Do not write `journal_line` directly.
> - Must be idempotent on `Idempotency-Key`.
> - Must fail if the target fiscal period is `LOCKED` unless the caller has `period.override`.
>
> **Input:** `IssueInvoiceCommand { tenantId, invoiceId, userId, idempotencyKey }`
> **Output:** `Result<IssuedInvoice, IssueInvoiceError>` — typed error union, no thrown exceptions for expected failures.
>
> **Edge cases:** already issued (idempotent no-op) · zero-amount invoice · customer missing a TIN (allow issue, flag e-invoice as blocked) · foreign currency (fetch rate for the invoice date, store on the lines) · line-level rounding producing a 1-sen difference (post to the rounding account).
>
> **Acceptance:** Vitest integration test against a real PostgreSQL proving debits = credits, AR control agrees with the invoice total, and a duplicate call with the same idempotency key produces exactly one journal entry.
>
> **Non-goals:** Do not modify `LedgerService`, the tax engine, or the database schema. If you believe a change is needed there, say so instead of making it.

The second prompt is longer, but almost all of that length is context you write once and reuse.

---

## 7.3 Meta-prompt templates by task type

### A. Domain logic (ledger, tax, matching, FX)

```
Implement <function> in packages/domain (pure — no IO, no database, no framework imports).

Domain rules:
  <the accounting rule, stated as an accountant would state it>

Signature:
  <exact TypeScript signature>

Invariants that must hold (from docs/architecture/06-data-model.md §6.9):
  <the relevant numbered invariants>

Deliver: implementation + exhaustive unit tests including property-based tests
with fast-check for the invariants above.

Do not import anything from apps/, do not touch the database, do not use `number`
for monetary values.
```

**Why "pure, no IO" is worth repeating every time:** it is the constraint most likely to be silently dropped, and it is the one that makes the domain layer testable at millions of cases per second.

### B. API endpoint

```
Add <METHOD> <path> to the <module> NestJS module.

Auth:        permission "<permission.string>"
Request:     <Zod schema, .strict()>
Response:    <Zod schema>
Errors:      <status → error code → when>
Idempotency: <required / not applicable>
Side effects: <what it writes, what it enqueues>

Follow the existing controller/service/repository layering in apps/api/src/modules/<module>.
Register the OpenAPI decorators. Add a supertest integration test covering the happy path,
each error case, and a cross-tenant access attempt that must return 404 (not 403 — do not
confirm the existence of another tenant's record).
```

That last parenthetical is the kind of detail worth encoding permanently: 403 on a cross-tenant ID leaks that the record exists.

### C. Database migration

```
Write a SQL migration for <change>.

Rules:
- Forward-only. Expand/contract — never a breaking change in a single step.
- Every new tenant-owned table: tenant_id as the FIRST column of the PK, RLS ENABLED
  and FORCED, a tenant_isolation policy with both USING and WITH CHECK.
- Money columns: NUMERIC(19,4). Accounting dates: DATE. System timestamps: TIMESTAMPTZ.
- Indexes for the actual query patterns, which are: <list them>.
- If the table will exceed ~50M rows, note a partitioning strategy in a comment.

Also state: is this migration safe to run while the previous app version is live?
If not, split it into expand and contract steps.
```

### D. Frontend feature

```
Build <screen/component> in apps/web.

Data:        <API endpoints, TanStack Query keys, invalidation targets>
State:       server state via TanStack Query; local UI state via Zustand
Forms:       React Hook Form + the shared Zod schema from packages/contracts
Components:  shadcn/ui primitives from packages/ui — do not introduce a new UI dependency
Money:       format via the shared formatter (RM 1,234.56); never do arithmetic on
             a JS number for currency
Dates:       DD/MM/YYYY display, Asia/Kuala_Lumpur
States:      loading (skeleton), empty, error, and the optimistic-update rollback path
A11y:        keyboard navigable, labelled inputs, focus management on dialogs

Add a Playwright test for the primary happy path.
```

### E. Bug in financial logic

```
Bug: <symptom>
Expected: <accounting-correct behaviour, with the journal entries you expect>
Actual:   <what happens, with the journal entries you got>
Repro:    <exact steps or failing test>

Before proposing a fix:
1. Write a failing test that reproduces this.
2. Explain the root cause.
3. Tell me whether existing posted data is affected and, if so, what the correction
   entry should look like — remember the ledger is append-only, so a data fix is a
   reversing entry, not an UPDATE.

Then fix it.
```

Step 3 is the one that distinguishes an accounting bug from an ordinary one. The code fix is often the easy half.

---

## 7.4 Worked example: the bank reconciliation matching algorithm

This is the hardest algorithm in the MVP and the best illustration of how much specification a good result needs.

### ❌ What not to ask

> Write a bank reconciliation matching algorithm.

### ✅ The prompt to use

> **Context**
> Module M4 (Banking & Reconciliation), Emil Accounting Apps. Malaysian SME users import bank statements as CSV/MT940; there is no live feed. Relevant schema in `docs/architecture/02-core-modules.md` §M4: `BankTransaction`, `ReconciliationMatch`, `BankRule`. Candidate records to match against are `Payment`, `Invoice`, `Bill`, `JournalEntry`, and inter-account transfers.
>
> **Task**
> Implement `MatchingEngine.suggest(bankTxn, candidates, context): MatchSuggestion[]` in `packages/domain`. **Suggestions only — this function never writes and never auto-confirms.** A separate service applies a confirmed match.
>
> **Scoring model**
> Return a ranked list, each with a `confidence` in 0–100 and a **human-readable `reason`** ("Amount and date match INV-1042; reference '1042' found in the bank narrative"). The reason string is a product requirement: users will not trust a match they cannot explain to their auditor.
>
> Weighted signals:
> | Signal | Weight | Rule |
> | --- | --- | --- |
> | Exact amount | 40 | Exact match on absolute value |
> | Amount within tolerance | 0–30 | Linear decay to ±RM 0.50 or 0.5%, whichever is greater (bank charges, FX rounding) |
> | Date proximity | 0–20 | Same day 20 → decays to 0 at 14 days; bank date is normally on or after the document date, so penalise a bank date *before* the document date more heavily |
> | Reference match | 25 | Invoice/bill number found in the narrative — normalise case, strip `INV`/`INV-`/`#`/spaces before comparing |
> | Contact name match | 15 | Fuzzy (Jaro-Winkler ≥ 0.85) against contact name, trading name, and known bank-narrative aliases |
> | Learned alias | 10 | This narrative pattern was matched to this contact before (from `ReconciliationMatch` history) |
> | Direction agreement | required | Debit ↔ payable, credit ↔ receivable. A direction mismatch is disqualifying, not a penalty. |
>
> Cap at 100. Return only suggestions ≥ 40. Sort descending, tie-break by smallest date difference, then smallest amount difference, then oldest document.
>
> **Grouping cases — all four are required**
> 1. **One-to-one** — one bank line ↔ one document
> 2. **One-to-many** — one bank line settling several invoices (customer pays 3 invoices in one transfer). Search combinations summing to the bank amount; **cap the search at 6 candidate documents and 200 combinations, and return partial results with a flag rather than timing out.**
> 3. **Many-to-one** — several bank lines settling one invoice (instalments)
> 4. **Transfer** — an outflow on account A mirrored by an inflow on account B within 3 days for the same amount. Detect as a single transfer event, never as two unrelated transactions.
>
> **Malaysian narrative specifics**
> Extract references from real formats: `IBG TRANSFER FR ABC SDN BHD`, `DUITNOW QR PYMT`, `FPX PAYMENT INV1042`, `CHQ 123456`, `MEPS IBFT`. Strip these prefixes before fuzzy-matching the contact name. Handle `SDN BHD` / `SDN. BHD.` / `S/B` and `BHD` / `BERHAD` as equivalent when comparing names.
>
> **Explicit non-goals**
> - No auto-confirmation. Confidence 100 still requires a user click in MVP. (Auto-apply arrives later, behind a feature flag and per-tenant opt-in.)
> - No writes, no database access, no IO. Candidates are passed in.
> - No ML model. Deterministic, explainable scoring — a user must be able to understand why a match was suggested.
>
> **Acceptance tests**
> 1. Exact amount + same day + reference in narrative → confidence ≥ 95
> 2. Amount off by RM 0.30, 2 days later, contact name matches → suggested with a moderate score and a reason naming both signals
> 3. Direction mismatch → **not** suggested at any score
> 4. Three invoices summing exactly to one bank credit → one-to-many suggestion listing all three
> 5. Matching outflow and inflow across two accounts, 1 day apart → single transfer suggestion
> 6. 500 bank lines × 2,000 candidates completes in < 3 s (see the performance target in `01-system-architecture.md` §1.6)
> 7. Every returned suggestion has a non-empty, human-readable `reason`
>
> Deliver the implementation plus a table-driven test suite covering all seven, using a Malaysian fixture set (RM amounts, `DD/MM/YYYY` dates, real-shaped bank narratives).

### Why this prompt works

| Property | Effect |
| --- | --- |
| Names the module and the docs | The result fits the codebase instead of inventing a parallel structure |
| Specifies the *scoring weights* | The single highest-leverage detail — otherwise the model picks numbers and you inherit them without knowing |
| Demands a `reason` string | Turns an opaque score into an auditable product feature |
| States non-goals | Prevents an unrequested auto-apply feature and unrequested database writes |
| Bounds the combinatorial search | Stops a one-to-many search from becoming an accidental performance incident |
| Gives Malaysian narrative examples | The details a generic implementation cannot guess |
| Gives acceptance tests upfront | Converts "does this look right?" into "does it pass?" |

---

## 7.5 Ten rules that apply to every prompt in this project

1. **Never say "money" without saying how.** Always: `Money` value object, integer minor units, `NUMERIC(19,4)` in the database, never a JS `number`.
2. **Always state the tenant boundary.** "This runs inside a transaction with `app.tenant_id` set" — or, for domain code, "tenant scoping is the caller's responsibility, do not re-derive it."
3. **Ask for the failing test first** when fixing anything financial.
4. **Give the accounting rule, not the code you imagine.** "A part payment reduces the invoice's outstanding balance and posts Dr Bank / Cr AR for the amount received" beats "update the amount_paid field."
5. **Specify the error model.** Typed result unions for expected failures, exceptions for programmer errors. Say which you want.
6. **Demand idempotency explicitly on any write path.** It will not be added by default.
7. **State the non-goals.** The most common failure mode is an unrequested refactor of code you did not want touched.
8. **Ask for the migration and the code separately.** Schema changes deserve their own review.
9. **Request Malaysian test fixtures.** RM amounts, `DD/MM/YYYY` dates, `SDN BHD` names, SST rates, TIN-shaped identifiers. Generic fixtures hide localisation bugs until a customer finds them.
10. **When the answer looks right, ask "what did you assume?"** For financial logic this is a genuinely high-yield follow-up — it surfaces the invented tolerance thresholds, rounding choices, and tie-break rules that were never specified. Cheap to ask, expensive to discover in production.

---

## 7.6 A reusable project preamble

Put this in `CLAUDE.md` at the repo root so it is applied automatically to every session, rather than re-pasted into every prompt.

```markdown
# Emil Accounting Apps — working agreements

Multi-tenant SaaS accounting for Malaysian SMEs. Base currency MYR (RM).
Architecture: docs/architecture/. Read the relevant document before implementing.

## Non-negotiable rules
1. The ledger is append-only. Posted journal entries are never updated or deleted.
   Corrections are reversing entries.
2. Money is `Money` (integer minor units) in code, NUMERIC(19,4) in PostgreSQL.
   Never a JS number. Never a float.
3. Every tenant-owned table has tenant_id as the first PK column, with RLS
   enabled AND forced, and a policy with both USING and WITH CHECK.
4. All journal writes go through LedgerService.post(). Nothing else writes
   journal_entry, journal_line, or account_period_balance.
5. Every financial write path is idempotent on an Idempotency-Key.
6. packages/domain is pure — no IO, no database, no framework imports.
7. Tax rates, thresholds, and statutory values are effective-dated data,
   never hardcoded constants.
8. Dates: DD/MM/YYYY display, Asia/Kuala_Lumpur, DATE (not TIMESTAMPTZ)
   for accounting dates.

## Stack
TypeScript · NestJS · Next.js · PostgreSQL 16 · `postgres.js` · Redis/BullMQ ·
Zod · TanStack Query · shadcn/ui · Vitest · fast-check

## Definition of done
Typechecks · unit tests · integration test against real PostgreSQL ·
ledger invariants still hold (docs/architecture/06-data-model.md §6.9) ·
audit log written for the mutation · OpenAPI updated.

## When uncertain
Malaysian tax, SST, or e-Invoice rules: say so and flag it for verification
against LHDN/RMCD rather than guessing a rate or a threshold.
```

---

## 7.7 Sequencing a large feature across prompts

Do not ask for a module in one prompt. Split along the natural review boundaries — each step is separately reviewable, and a mistake in step 2 is caught before step 5 depends on it.

```
1. "Design the data model for <module>. DDL + entity relationships + the invariants
    that must hold. No application code yet."
       → review the schema before anything is built on it

2. "Write the SQL migration for that schema, with RLS policies and indexes."
       → review the migration separately

3. "Implement the domain logic in packages/domain — pure functions, no IO —
    plus property-based tests for the invariants from step 1."
       → this is where correctness is won

4. "Implement the service layer wiring domain logic to the repository, inside
    transactions, with idempotency and audit logging."

5. "Add the REST endpoints with Zod validation, RBAC guards, and OpenAPI docs."

6. "Build the UI for <primary workflow>."

7. "Write the Playwright end-to-end test for the whole flow."
```

Steps 1 and 3 deserve the most scrutiny. Everything after them is mechanical by comparison — and if the schema and the domain logic are right, the rest of the module is a straightforward exercise.
