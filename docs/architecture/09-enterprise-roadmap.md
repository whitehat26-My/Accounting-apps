# Competing with AutoCount: what is built, and what each remaining thing waits on

**Audience:** whoever picks up the desktop app, LHDN e-Invoice submission, or
DuitNow payment at the till.

**The short version.** The desktop shell is built (§1). The other three
milestones are each **one external thing** away from being a small change —
LHDN's SDK, a certificate, PayNet's merchant spec — and the code that surrounds
each of them is already written and tested. This document names the seam for
each so nobody rebuilds what exists or, worse, guesses at what is missing.

> **Why guessing is the failure mode this document exists to prevent.**
> `CLAUDE.md`: *"Do not guess a tax rate, a registration threshold, or an
> e-Invoice field requirement — a plausible-looking wrong rate is worse than an
> explicit gap."* Two of the three below submit to a tax authority or move a
> customer's money. A wrong field that is **accepted** is not recoverable.

---

## 1. The desktop application — BUILT

`apps/desktop` is a Tauri v2 shell. `cargo check` passes and the probe logic has
five unit tests.

**It bundles no application code, deliberately.** The window points at the shop
server the deployment already runs, and that single decision removes four
problems rather than solving them:

| | Why pointing at the server wins |
| --- | --- |
| Secure context | `http://localhost` is one. `crypto.randomUUID` generates the `Idempotency-Key` on every financial write and is **absent** on a plain-HTTP LAN origin — a bug that already reached a real till here. |
| CORS | `apps/api` has none, on purpose. Same origin keeps it that way. |
| Build modes | The static export is welded to the demo backend (`NEXT_PUBLIC_DEMO=1`). Bundling the real app would need a third build nobody exercises. |
| One set of books | Cashier PC, owner's phone and tablet read one database. A per-till bundle would quietly end that, and nothing would announce it until two devices disagreed. |

What the Rust actually does — narrow on purpose:

- reads `%APPDATA%\com.emil.accounting\settings.json` for the server address,
  defaulting to `http://localhost:8080`;
- **probes before loading.** Opening the URL first and reacting to failure shows
  a browser error page, which tells a cashier nothing they can act on;
- shows a bundled connection screen when the server is unreachable — the
  alternative is a blank white window and a queue at the counter;
- a single-instance guard. Not cosmetic: the session lives in `localStorage`, and
  two windows share one refresh token. Rotation treats a replayed refresh token
  as theft and **revokes the whole family**, so a second window signs the cashier
  out mid-sale.

**The remote origin gets no IPC.** Commands are invoked only from the bundled
connection page. Once the window navigates to the server it is ordinary web
content with no path to the filesystem or the OS — the right blast radius for a
page served over a shop LAN.

### Building it

Windows only — this repository's CI container cannot produce a `.exe`.

```bash
pnpm install
pnpm --filter @emil/desktop tauri build      # → NSIS + MSI in src-tauri/target/release/bundle
```

### Two notes for whoever runs it first

- **`apps/api` binds `0.0.0.0`, hardcoded** (`apps/api/src/main.ts`). On a desktop
  install that publishes the API to the whole LAN. That is correct for the shop
  server; if the till is ever a *separate* machine running its own stack, this
  wants to become configurable.
- The probe treats an `https://` address as "the port answered" and nothing more,
  because nothing in the shell speaks TLS. That is deliberate and harmless: the
  till talks to the shop server over plain HTTP on the LAN and **must never route
  through Tailscale** (`HYBRID-SHOP-DEPLOYMENT.md` §2.3).

---

## 2. Windows code signing — the procedure, not code

Without a certificate, SmartScreen shows "Windows protected your PC" on every
install. Nothing in this repository can fix that; a certificate is a purchase.

**OV vs EV.** An OV (organisation-validated) certificate signs the binary but
starts with no SmartScreen reputation, which accrues as installs succeed. An EV
certificate historically carried reputation immediately. **Both the price and
the reputation behaviour change — verify current terms with the vendor rather
than trusting this paragraph.**

**Azure Trusted Signing** is the option worth pricing first for a shop this size:
it removes the hardware token that otherwise has to stay plugged into whatever
machine builds releases, which is a poor fit for CI.

**Always timestamp.** `signtool sign /tn <TSA URL> …`. Without a timestamp, every
signature stops validating the day the certificate expires — *including on copies
already installed in shops*. This is the step people skip and discover two years
later.

Where it plugs in: `.github/workflows/desktop-release.yml` has the step stubbed
with `if: false` and a comment. It is left unconfigured on purpose — placeholder
secrets would fail the build for anyone who forks this before buying a
certificate.

---

## 3. LHDN MyInvois — everything up to the wire is built

### What exists

| Piece | Where |
| --- | --- |
| `EInvoiceDocument` — a **neutral intermediate, deliberately not the wire format** | `packages/domain/src/einvoice.ts` |
| `validateForSubmission` — 14 violation codes: TINs, MSIC, address completeness, classification codes, arithmetic reconciliation, FX, adjustment references | same |
| Submission state machine — `QUEUED → SUBMITTED → VALID \| INVALID`, cancellation window | same |
| `buildInvoiceDocument`, `buildCreditNoteDocument` | `packages/db/src/einvoice.ts` |
| `einvoice_payload` — append-only, SHA-256 over canonical JSON, one row per attempt | `0005_einvoice.sql` |
| Retry with backoff, `dueForAttempt` with `FOR UPDATE SKIP LOCKED` | `packages/db/src/einvoice.ts` |
| 10 API routes, `einvoice.submit` permission | `apps/api/src/modules/einvoice.controller.ts` |
| Outbox handler for `invoice.issued` / `creditnote.issued` | `apps/worker/src/handlers/einvoice.ts` |

The neutral intermediate is the load-bearing design decision. From its own
header: *"If the wire format turns out to differ from what a serialiser assumes,
only the serialiser changes — the field-completeness rules, the state machine and
the tests all survive."*

### What is absent, and the seam it plugs into

Absent: a UBL 2.1 serialiser, the OAuth2 `client_credentials` flow, any HTTP call
to LHDN, and document signing. `MyInvoisGateway` is declared as a **port with no
implementation** — its comment says writing a speculative client *"would produce
code that looks finished and is probably wrong — worse than an obvious gap,
because it invites trust."*

The `einvoice-retry` job today counts what is due, applies backoff, and returns
`{ submitted: 0, adapter: 'NONE' }` with a log line naming the blocker. It does
**not** mark anything submitted. That is the correct behaviour: marking documents
`SUBMITTED` without sending them would be a lie told to a compliance dashboard.

**The adapter's shape when credentials arrive:**

1. Implement `MyInvoisGateway` (`submit` / `getStatus` / `cancel`).
2. Write the serialiser over `EInvoiceDocument` — **from LHDN's published SDK
   reference, field by field**, not from inference.
3. Add its call to `einvoiceRetry`. Nothing else in that job changes.
4. Report results back through the existing `POST /v1/einvoice/submissions/:id/events`
   route, authenticating as a service principal. Not by writing to the database:
   that route enforces the state machine and the compliance log.

### Sub-gaps found while mapping, worth fixing with the adapter

- **`unitOfMeasure` is never populated** by either builder, though
  `invoice_line.uom_code` exists and the API renderer handles the field.
- **`einvoice_classification_code` and `einvoice_uom_code` ship empty**, so the
  code-list membership check is currently a **no-op** — any non-empty string
  passes. Presence is still enforced. Both are seeded from LHDN's published list.
- **`tin_pattern` defaults to `NULL`** — no pattern is seeded anywhere. The only
  regex in the repo is in tests.
- **The 72-hour cancellation window is an unconfirmed placeholder.**
- `buildDebitNoteDocument` and the four self-billed builders do not exist.
- No consolidated B2C invoice builder; `consolidationDueDays` is stored and never
  read.

### ⚠️ This may already be a live compliance gap

`SETTLEMENT-REGISTER.md` §5.5 records that at roughly RM 50–60k/month the shop's
turnover *appears* to fall in a MyInvois phase that began 1 January 2026 —
meaning this is possibly a present obligation, not a future one. **Confirm the
applicable phase with LHDN or a tax agent.** The register records the question,
not the answer, and neither does this document.

---

## 4. DuitNow QR at the till — one wire, gated on PayNet

### Everything except the merchant template is built

- **`packages/domain/src/duitnow-qr.ts`** — a real EMVCo merchant-presented-mode
  encoder: TLV with two-digit lengths, CRC-16/CCITT-FALSE pinned by the published
  `0x29B1` check vector, point-of-initiation hardcoded **dynamic** so an invoice
  QR cannot be re-scanned. It carries a bug postmortem worth reading: the amount
  formatter counts *decimal places*, and `-2` instead of `2` turns RM 1,080.00
  into a QR that charges RM 1,100.00.
- **`packages/domain/src/qr.ts`** — a hand-written ISO/IEC 18004 encoder, byte
  mode, EC level M, versions 1–10, full Reed–Solomon and all eight masks scored.
  Already in production: every invoice, receipt and warranty card carries the
  verify-digest QR it renders (`apps/api/src/pdf/render.ts`).
- **`loadGatewayConfig()`** already returns `merchantTemplate`, `merchantName`,
  `merchantCity` and `merchantCategoryCode` — **exactly the shape `DuitNowQrInput`
  wants**. `paymentReference()` already produces the reconciliation-safe reference.

### The single missing wire

`buildDuitNowQr` has **zero production callers**. Nothing joins the config to the
encoder to the renderer — and joining them is gated on PayNet, not on code.

`buildDuitNowQr` **throws `NO_MERCHANT_TEMPLATE`** rather than defaulting, because
which of tags 26–51 carries DuitNow, the AID/GUID and the merchant-id format are
PayNet-specific. Register §3.4: *"A guessed template produces a QR that scans
cleanly and pays the wrong party."*

### When the template arrives

The POS already has a `DUITNOW` tender button that today only picks a deposit
account (`apps/web/src/app/(app)/pos/page.tsx`). The change is:

1. An API route returning the QR payload for a sale, from `loadGatewayConfig()` +
   `buildDuitNowQr` + `encodeQr`.
2. A React component rendering the matrix at checkout, and the same matrix on the
   printed receipt beside the existing verify QR.
3. **The component must surface `NO_MERCHANT_TEMPLATE` as "QR payment not
   configured"** — never render the sandbox template. `EMIL_ENABLE_SANDBOX_VALUES`
   loads a template whose merchant id reads `SANDBOX-NOT-A-REAL-MERCHANT`; it
   produces a structurally valid, CRC-correct QR that **pays nobody**, and a payer
   discovers that at the till rather than before. The flag is already refused when
   `NODE_ENV=production`, and `readiness.ts` reports the tenant as `SANDBOX`.

---

## 5. Summary — what unblocks what

| Milestone | Status | Waiting on |
| --- | --- | --- |
| Desktop shell | **Built**, `cargo check` + 5 tests green | A Windows machine to run `tauri build` |
| Auto-updater | **Configured**; workflow written | `tauri signer generate`, then the keys as CI secrets |
| Code signing | Procedure documented | Buying a certificate, or Azure Trusted Signing |
| MyInvois submission | Everything up to the wire built and tested | **LHDN SDK docs + sandbox client id/secret** |
| DuitNow QR | Encoder, renderer and config all built | **PayNet's merchant specification** |

Three of those five are a purchase or an email away. None of them is a rewrite —
which is the whole return on having built the neutral intermediate, the port, and
the refusing encoder rather than plausible guesses.
