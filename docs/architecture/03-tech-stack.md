# 3. Technology Stack Recommendation

Every choice below is justified against the same four criteria: **correctness for money**, **hiring reality in Malaysia**, **operational cost at SME price points**, and **how badly it hurts to change later**.

---

## 3.1 Frontend

| Concern | Choice | Justification |
| --- | --- | --- |
| Framework | **Next.js 15 (App Router) + React 19, TypeScript strict** | SSR/streaming for fast first paint on the marketing and public pay-link pages; SPA behaviour inside the app shell. Route handlers give a BFF layer so the browser never holds a token that talks straight to the core API. Largest hiring pool in KL/Penang by a wide margin. |
| Language | **TypeScript, `strict: true`, `noUncheckedIndexedAccess`** | Shared types with the backend via a generated OpenAPI client — the invoice shape cannot drift between tiers. Non-negotiable for a financial UI. |
| Server state | **TanStack Query** | Accounting UIs are overwhelmingly server-state: cache invalidation, background refetch, optimistic updates with rollback. Redux for server data is a category error. |
| Client state | **Zustand** | Small, unopinionated, for the genuinely client-side slices: active organisation, reconciliation workspace selection, unsaved draft buffers, UI preferences. |
| Forms | **React Hook Form + Zod** | Uncontrolled inputs keep a 200-line invoice grid fast. Zod schemas are shared with the backend so the same validation rules run on both sides — one definition of "an invoice line must have a positive quantity". |
| UI library | **shadcn/ui + Radix primitives + Tailwind CSS** | You own the component source, which matters because accounting UIs need heavy customisation (editable grids, dense tables) that opinionated kits fight. Radix gives WCAG-compliant behaviour for free. |
| Data grid | **TanStack Table + TanStack Virtual** | Headless. A 50,000-row general ledger must virtualise; a bank reconciliation screen needs custom row rendering. |
| Charts | **Recharts** (dashboard) / **ECharts** if drill-down interactivity grows | Adequate, small, React-native API. |
| Money in the UI | **dinero.js** or a thin `Money` wrapper over `decimal.js` | The browser must never do `0.1 + 0.2` on a currency. Format as `RM 1,234.56` via `Intl.NumberFormat('ms-MY', { currency: 'MYR' })`. |
| i18n | **next-intl**, en-MY default, ms-MY and zh-Hans planned | Localisation is a market requirement, and retrofitting i18n into 300 components is painful. Wire it from day one even with one locale. |
| Offline/PWA | **Serwist** service worker, receipt-capture queue | SME users photograph receipts on patchy mobile data. Queue the upload, sync later. |
| Testing | **Vitest** + **React Testing Library** + **Playwright** | Playwright for the flows that must never break: issue invoice, apply payment, reconcile, close period. |

**Rejected:** Angular (smaller local pool, heavier), Vue/Nuxt (fine technically, thinner senior hiring market in MY fintech), plain SPA without SSR (public pay pages need SEO and fast cold loads), Material UI (fighting its opinions on dense financial tables costs more than it saves).

---

## 3.2 Backend

| Concern | Choice | Justification |
| --- | --- | --- |
| Language | **TypeScript on Node.js 22 LTS** | Single language across tiers → shared Zod schemas, shared money types, shared OpenAPI client. For a small team building a large surface area, this compounds. Node's IO-bound profile fits an app whose hot path is database + HTTP calls, not computation. |
| Framework | **NestJS** | Opinionated modularity is exactly what a modular monolith needs: `@Module` boundaries map 1:1 to M0–M9, DI makes the tax engine and matching engine trivially testable in isolation, and built-in interceptors/guards give a clean home for the tenant/RBAC/idempotency middleware chain. |
| API standard | **REST (OpenAPI 3.1) as the contract, tRPC internally between `emil-web` and `emil-api`** | REST because third parties will integrate (banks, POS vendors, accountant tooling), OpenAPI generates both the client and the docs, and REST caches and rate-limits cleanly. tRPC for the first-party BFF hop gives end-to-end type safety without maintaining a second schema. **GraphQL rejected**: unbounded query cost is a real hazard when a malicious or careless query can table-scan a ledger, per-field authorisation on financial data is error-prone, and the flexibility mostly benefits many-consumer scenarios you don't have. |
| ORM / data access | **Raw parameterised SQL via `postgres.js`** | Revised during implementation. The original choice was Drizzle; the schema's composite `(tenant_id, id)` keys, `SET LOCAL app.tenant_id` session binding, deferred constraint triggers and `NUMERIC(19,4)` handling all sit at the edge of what an ORM expresses well, and the generated query is exactly what you want visible when RLS and correctness are at stake. `postgres.js` gives parameterised tagged templates — SQL injection is structurally prevented — with no query the reader cannot see. **Prisma rejected** for weaker raw-SQL ergonomics and historically awkward RLS/session-variable handling. |
| Decimal handling | **`decimal.js` / a `Money` value object**, `NUMERIC(19,4)` in PG | Never `number` for currency. The `Money` type carries currency and forbids cross-currency arithmetic at the type level. |
| Jobs & queues | **BullMQ on Redis** | Mature, good retry/backoff/DLQ semantics, per-queue concurrency, repeatable jobs for recurring invoices and reminders. Paired with a **transactional outbox** table so enqueue is never lost. |
| Auth | **Auth.js / Better Auth for session flows + own JWT issuance**, Argon2id, TOTP MFA | Keeping issuance in-house avoids per-MAU identity-vendor pricing at SME margins; the standards involved are well-trodden. |
| PDF | **Playwright/Chromium → PDF** from an HTML template | Templates are HTML/CSS, so branding is editable without a Java toolchain. Runs in the worker, never in the API. |
| Validation | **Zod** at every boundary | Same schemas the frontend uses. |
| Observability | **OpenTelemetry** → traces/metrics/logs, **Sentry** for errors, structured JSON logs with `tenant_id` + `request_id` on every line | The first question in any financial incident is "which tenant, which document, which request" — instrument for that question specifically. |
| Testing | **Vitest** unit, **Testcontainers** for real-PostgreSQL integration tests, **fast-check** property tests on the ledger | Property tests for double-entry: for any generated set of transactions, debits equal credits, the trial balance balances, and reversing every entry returns all balances to zero. This is the cheapest possible insurance against the class of bug that destroys the product's credibility. |

**Honest alternative:** **Java/Spring Boot** or **.NET 8** would be defensible, and both have stronger built-in decimal semantics and deeper enterprise-finance precedent. Choose one of them if the founding team's depth is there. **Go** is excellent for the worker tier and a reasonable target if you later extract the matching engine or reporting service. The TypeScript recommendation is optimised for a small team's velocity across a very wide feature surface — if the team is 15+ engineers with JVM depth, Spring Boot is the better long-run answer.

---

## 3.3 Database & caching

| Concern | Choice | Justification |
| --- | --- | --- |
| Primary OLTP | **PostgreSQL 16** (managed: AWS RDS/Aurora, or Neon/Supabase to start) | The decisive features: **Row-Level Security** for DB-enforced tenant isolation, `NUMERIC` exact decimals, deferred constraint triggers for balanced-entry enforcement, advisory locks for gapless numbering, partial/BRIN indexes, `tsvector` search, JSONB for OCR payloads and audit diffs, and PITR. MySQL has no comparable RLS story; that alone settles it. |
| Read scaling | **Streaming read replica** for reporting/exports | Isolates heavyweight aggregation from the transactional path. Route via a `@ReadOnly` decorator that swaps the connection, and accept bounded replica lag for reports (it is fine — reports are as-of a date, not as-of a millisecond). |
| Cache / queues / locks | **Redis 7** (managed, e.g. ElastiCache) | Session store, per-tenant reference-data cache (CoA, tax codes, FX), BullMQ backend, distributed locks, rate-limit counters, idempotency-key store. |
| Object storage | **S3-compatible** (AWS S3, or Cloudflare R2 for cheap egress) with SSE-KMS | Attachments, generated PDFs, imported statements, exports. Tenant-prefixed keys, versioning on, lifecycle to cold storage after 2 years, retention to 7+ years. |
| Search | **PostgreSQL full-text first; OpenSearch when it stops being enough** | Do not add a search cluster in the MVP. `tsvector` over contacts + document references handles the actual query pattern ("find invoice INV-1042", "find Tenaga") well past early scale. |
| Analytics (later) | **ClickHouse** or the warehouse of the day | Only when cross-tenant product analytics or heavy customer-facing BI arrives. Not MVP. |
| Migrations | **Hand-written SQL**, forward-only, expand/contract, applied by `packages/db/src/migrate.ts` | Every migration reviewed like production code. A migration that rewrites posted ledger rows requires a written justification in the PR. |
| Backups | Automated daily snapshot + **PITR (5-minute RPO)**, cross-region copy, **restore drill quarterly** | An untested backup is not a backup. Schedule the drill; record the RTO you actually achieve. |

**Partitioning plan (not day one, but design for it):** `journal_line`, `audit_log`, and `bank_transaction` are the tables that grow without bound. Partition by range on date (`RANGE (occurred_at)`) once any exceeds ~50M rows, or by `tenant_id` hash if a few very large tenants dominate. Keeping `tenant_id` first in the primary key keeps both options open.

---

## 3.4 Infrastructure & DevOps

| Concern | Choice | Justification |
| --- | --- | --- |
| Cloud | **AWS, `ap-southeast-5` (Malaysia) primary, `ap-southeast-1` (Singapore) DR** | A Malaysian region is a genuine sales asset for PDPA-conscious buyers and for the government-adjacent conversation around e-Invoice. Latency to KL users is materially better than a US/EU region. Azure Malaysia West is a reasonable alternative if the buyer base skews Microsoft. |
| Compute | **ECS Fargate** (or EKS if the team already runs Kubernetes) | Fargate removes node management for a team that should be writing accounting logic, not tuning kubelets. Separate services for `emil-api`, `emil-web`, `emil-worker`, each with its own autoscaling policy — worker scales on queue depth, API on p95 latency and CPU. |
| Containers | **Docker**, multi-stage builds, distroless runtime image, non-root user | Small attack surface, reproducible builds, identical artefact from CI to production. |
| IaC | **Terraform** with remote state and per-environment workspaces | Environments differ only by `.tfvars`. Manual console changes are a policy violation, and drift detection runs nightly. |
| CI/CD | **GitHub Actions** → build, test, scan, push to ECR, deploy | Pipeline gates: typecheck → lint → unit → integration (Testcontainers) → property tests on the ledger → build → SAST (CodeQL) → dependency audit → container scan (Trivy) → IaC scan (tfsec) → secret scan (gitleaks). A failing ledger property test blocks the merge, no override. |
| Deployment strategy | **Blue/green for `emil-api` and `emil-web`; rolling for workers**; migrations run as a separate gated step | Blue/green gives an instant rollback path. Expand/contract migrations mean the old and new app versions can both run against the same schema during the cutover — mandatory for zero-downtime. |
| Feature flags | **Unleash** (self-hosted) or OpenFeature + a provider | New posting logic ships dark, enables per-tenant, and can be killed without a deploy. |
| Secrets | **AWS Secrets Manager** + KMS, automatic rotation | No secrets in environment variables in the repo, no secrets in the image, no secrets in CI logs. |
| Edge | **Cloudflare** — CDN, WAF, DDoS, bot management | Also the cheapest sensible answer for egress on PDF downloads. |
| Monitoring | **Grafana Cloud / Datadog** dashboards + **Sentry** + **PagerDuty** | SLOs: API availability 99.9%, p95 API latency, queue depth and job age, e-invoice submission success rate, nightly rollup-integrity job result, replica lag. |
| Business-critical alarms | Ledger imbalance detected · rollup drift · e-invoice submission failure rate > 5% · reconciliation variance on a closed period · failed daily backup | These page a human. Ordinary 5xx rate does not, unless sustained. |
| DR targets | **RPO 5 minutes, RTO 4 hours**, cross-region replica, documented and rehearsed runbook | Write the target down, then prove it in a drill; unproven DR is an assumption, not a plan. |

---

## 3.5 Third-party services

| Need | Recommendation | Note |
| --- | --- | --- |
| Payments | **Billplz** or **iPay88** (FPX + DuitNow, local acquiring) plus **Stripe** for international cards | FPX is the dominant Malaysian online payment rail; a foreign-only gateway is a non-starter for local SMEs. |
| e-Invoice | Direct **MyInvois API** integration; a middleware provider (Peppol-accredited) as a fallback | Direct integration is the differentiator. Keep the mapping layer isolated so a provider can be swapped in if LHDN throughput becomes a problem. |
| Email | **AWS SES** (transactional) + **Resend/Postmark** for deliverability-sensitive invoice sends | Invoice emails landing in spam is a support-ticket generator; treat deliverability as a product feature (SPF/DKIM/DMARC, per-tenant sending domains). |
| SMS / WhatsApp | **Twilio** or a local aggregator | WhatsApp reminders materially outperform email for Malaysian SME collections. |
| OCR | **AWS Textract** or **Google Document AI**, with a fallback to manual entry | Always human-confirmed before posting. |
| FX rates | **Bank Negara Malaysia** published rates as the reference source, with a commercial provider as backup | Using BNM rates is defensible to an auditor; using an arbitrary API is not. |
| Error tracking | **Sentry** with PII scrubbing configured before launch | Financial payloads must be redacted in breadcrumbs — configure this on day one, not after the first leak. |

---

## 3.6 Repository layout

```
emil/
├── apps/
│   ├── api/          # NestJS — modules M0–M9
│   ├── web/          # Next.js
│   └── worker/       # BullMQ processors (shares api's domain modules)
├── packages/
│   ├── domain/       # Money, Currency, JournalEntry aggregates, TaxEngine — zero IO, pure
│   ├── contracts/    # Zod schemas + generated OpenAPI types (shared web ↔ api)
│   ├── db/           # SQL migrations, RLS policies, seed data, repository services
│   └── ui/           # shadcn-derived component library
├── infra/            # Terraform
└── docs/architecture/
```

`packages/domain` having **zero IO dependencies** is the load-bearing constraint. The double-entry rules and the tax engine are pure functions over value objects, testable at millions of cases per second with property-based testing, and impossible to accidentally couple to a database session. Guard it with a dependency-cruiser rule in CI.
