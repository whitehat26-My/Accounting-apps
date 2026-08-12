# The hybrid shop deployment — till on the LAN, owner over Tailscale

**The requirement:** the counter keeps selling SSDs and RAM when the ISP dies,
and the owner watches the books from home without exposing anything to the
internet.

This is the deployment-shaped companion to [`DEPLOY.md`](DEPLOY.md), which covers
the generic VPS and cloud paths. Read the sections there on
[the address printed on documents](DEPLOY.md#the-address-printed-on-your-documents)
and [which address to OPEN the app at](DEPLOY.md#which-address-to-open-the-app-at--not-the-same-question)
— they are load-bearing here and are not repeated.

---

## 0. The fact the whole design rests on

```
   Cashier PC ──Ethernet──┐
                          │        SHOP SERVER (one box)
   Owner's phone ─WiFi────┼──►  ┌──────────────────────────────┐
                          │     │ web  :3000  (published :8080)│
                          │     │ api  :3000  (private network)│
   Owner at home ─────────┘     │ db   :5432  (private network)│
        via Tailscale           │ worker      (private network)│
                                └──────────────────────────────┘
                                              │
                                     ISP ─────┘  ← only for MyInvois,
                                                   e-mail, and the owner's
                                                   trip home. NOT for a sale.
```

**A sale never touches the internet.** The browser talks to the shop server over
Ethernet; the server talks to Postgres over a Docker bridge. Both are inside the
building. When the ISP drops, nothing on that path changes.

So "LAN resilience" is not about *building* offline capability — it is about
making sure nothing **accidentally wanders onto the internet path**, and that the
address the till uses cannot move. Sections 1 and 4 are that work.

---

## 1. Binding — already correct, do not change it

The API binds every interface by default. From `apps/api/src/config.ts`:

```ts
host: text(env['HOST']) ?? '0.0.0.0',
```

and `apps/api/src/main.ts`:

```ts
await app.listen({ port: config.port, host: config.host });
boot.log(`Emil API listening on ${config.host}:${config.port}`);
```

`0.0.0.0` is the default precisely so a container is reachable from outside
itself. **You do not need to configure this**, and `HOST=127.0.0.1` is the
setting that would break the shop — it exists for running the API bare on a
laptop, not in Docker.

### What is actually published to the LAN

`docker-compose.prod.yml` publishes **only the web container**:

```yaml
  web:
    ports:
      - '${WEB_PORT:-8080}:3000'
```

The API and PostgreSQL have no `ports:` block at all — they are reachable only on
the private compose network, by service name (`http://api:3000`). This is the
correct posture and is why the browser calls `/api/*` on the web origin and Next
proxies inward: **one origin, no CORS, and the database is not on the LAN.**

If you want to bind the published port to one NIC rather than every interface —
worth doing if the shop server also has WiFi you would rather it ignore:

```yaml
    ports:
      - '192.168.1.10:8080:3000'     # LAN NIC only
```

---

## 2. A shop-server address that cannot move

Three ways, best first.

### 2.1 DHCP reservation on the router — recommended

Bind the server's MAC to a fixed address in the router's DHCP table. The server
stays on DHCP and always gets the same lease.

Why this beats a static IP on the server: it survives an OS reinstall, it cannot
collide with the DHCP pool (the router owns both), and it is one screen in the
router UI rather than a config file somebody must remember exists.

Pick an address **outside the DHCP pool's dynamic range** — e.g. pool
`192.168.1.100–199`, server at `192.168.1.10`.

### 2.2 Static on the server

Ubuntu (netplan, `/etc/netplan/01-shop.yaml`):

```yaml
network:
  version: 2
  ethernets:
    enp3s0:
      dhcp4: no
      addresses: [192.168.1.10/24]
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]   # for MyInvois/e-mail only — see below
```

```bash
sudo netplan try        # reverts automatically if you lose the connection
sudo netplan apply
```

Windows (PowerShell, as Administrator):

```powershell
New-NetIPAddress -InterfaceAlias 'Ethernet' -IPAddress 192.168.1.10 `
  -PrefixLength 24 -DefaultGateway 192.168.1.1
Set-DnsClientServerAddress -InterfaceAlias 'Ethernet' -ServerAddresses 1.1.1.1,8.8.8.8
```

### 2.3 The till must not need DNS at all

Those nameservers are for the *server's* outbound work (MyInvois, e-mail). The
**cashier PC must never resolve a name to find the till**, because that makes an
ISP DNS server a dependency of selling a stick of RAM.

Two acceptable answers:

**Use the IP.** `http://192.168.1.10:8080`, bookmarked. Nothing to resolve.

**Or a hosts entry** — a friendly name with zero DNS. On the cashier PC:

```
# Windows: C:\Windows\System32\drivers\etc\hosts   (edit as Administrator)
# Linux/macOS: /etc/hosts
192.168.1.10    till
```

Then `http://till:8080` works with the router unplugged from the wall.

**Do not use mDNS/`.local` for the till.** It usually works and is one more
moving part that can fail at the worst moment.

> ### Do NOT route the counter through Tailscale
>
> This is the mistake that turns a resilient setup into a fragile one. Tailscale
> is for the owner at home (§3). If the till's URL is a `100.x` address or a
> MagicDNS name, then a tailnet or DNS hiccup — something that has nothing to do
> with your shop — can stop you selling. **The till uses the LAN address. Always.**

---

## 3. Secure context: the trap that already bit this app once

Browsers grant `localhost` a trustworthy origin over plain HTTP and refuse it to
a bare LAN address, whatever is behind it. Measured, not assumed (see
[`DEPLOY.md`](DEPLOY.md#which-address-to-open-the-app-at--not-the-same-question)):

```
http://localhost:8080     isSecureContext=true    crypto.randomUUID=true   serviceWorker=true
http://192.168.1.10:8080  isSecureContext=false   crypto.randomUUID=false  serviceWorker=false
```

**This already reached a real till.** `crypto.randomUUID` is secure-context-only
and generates the `Idempotency-Key` for every financial write — so the first sale
over a LAN address threw `crypto.randomUUID is not a function`. Nothing caught it
earlier because the dev server, the test build and the Playwright journeys all run
on localhost, and the only insecure context in the whole lifecycle is the shop.

It is fixed and guarded: `apps/web/src/lib/uuid.ts` wraps it, and
`apps/web/test/secure-context.test.ts` is a **source-level** guard that fails the
build if anyone reaches for a secure-context-only API again — because the runtime
that matters cannot be reached from CI.

**What remains true on a bare LAN address:** no service worker, no install-as-app
prompt. Neither is needed for the till (the whole stack is local; there is nothing
for a service worker to cache around), but it is why phones and the owner get a
better experience over Tailscale HTTPS in §4.

| Who | Address | Secure context |
| --- | --- | --- |
| On the shop server itself | `http://localhost:8080` | yes |
| Cashier PC (Ethernet) | `http://till:8080` or the IP | no — and that is fine |
| Staff phone / owner | Tailscale HTTPS (§4) | yes |

---

## 4. Tailscale — the owner watching from home

Tailscale builds a private WireGuard mesh between *your* devices. There is no
public IP, no port forwarding, no open inbound port, and the database is never
addressable from the internet.

### 4.1 On the shop server

```bash
curl -fsSL https://tailscale.com/install.sh | sh

# Headless server: mint a reusable, pre-authorised, TAGGED key in the admin
# console (Settings → Keys) so the node is owned by the tag, not by a person
# whose account leaving would expire it.
sudo tailscale up --authkey=tskey-auth-xxxxx --advertise-tags=tag:shop --ssh

tailscale ip -4          # → 100.x.y.z, the stable tailnet address
tailscale status
```

`--ssh` is optional but genuinely useful: it lets the owner reach a shell for
maintenance without ever opening port 22.

### 4.2 On the owner's laptop and phone

Install Tailscale, sign in to **the same tailnet**, done. From home:

```
http://100.x.y.z:8080          # tailnet IP
http://shop:8080               # MagicDNS, if enabled (Admin → DNS)
```

### 4.3 Real HTTPS with no domain and no certificate work

```bash
# Put a Let's Encrypt cert in front of the app, for tailnet devices only.
sudo tailscale serve --bg 8080

tailscale serve status
# → https://shop.tailnet-name.ts.net  →  http://127.0.0.1:8080
```

This gives the owner and staff phones `https://shop.<tailnet>.ts.net` — a proper
secure origin, so the install prompt and every secure-context API work.

*(`tailscale serve` syntax changed across 1.5x releases; check
`tailscale serve --help` on your version.)*

> **Never run `tailscale funnel`.** `serve` publishes to your tailnet. `funnel`
> publishes to the **entire internet**. They are one word apart and this app is a
> company's books.

### 4.4 `TRUST_PROXY` — the setting Serve forces you to get right

`tailscale serve` is a reverse proxy, so requests now arrive with
`X-Forwarded-For`. That header keys the rate limiter **and** is written to the
audit log as `actor_ip`.

```bash
TRUST_PROXY=1        # Serve alone
TRUST_PROXY=2        # bundled Caddy + web in front
```

**Do not set `TRUST_PROXY=true`.** It trusts every hop, so `X-Forwarded-For`
becomes whatever the client typed — a rate-limit bypass and a forged audit
`actor_ip`. As of migration `0052`, `loadConfig` **refuses** a bare `true` when
`NODE_ENV=production` and demands a hop count or CIDR
(`apps/api/test/deployment-config.test.ts`, pen-test finding AI-5 in
[`security/API-PENTEST-PLAN.md`](security/API-PENTEST-PLAN.md)).

### 4.5 Lock the tailnet down

Tailscale ACLs (Admin → Access controls). Default-deny, then allow only what you
mean:

```jsonc
{
  "tagOwners": { "tag:shop": ["autogroup:admin"] },
  "acls": [
    // The owner's own devices reach the app port. Nothing else, nowhere else.
    { "action": "accept", "src": ["autogroup:member"], "dst": ["tag:shop:8080"] }
  ],
  "ssh": [
    { "action": "check", "src": ["autogroup:member"], "dst": ["tag:shop"], "users": ["root", "autogroup:nonroot"] }
  ]
}
```

Note what is **absent**: no rule mentions `5432`. Postgres is not published by
compose and must not be reachable over the tailnet either. The owner needs the
*dashboard*, not the database.

### 4.6 The tunnel is not the login

Tailscale decides which *devices* can reach the app. It does not decide who may
read the books — the app's own auth still applies, and should:

- `SIGNUP_MODE=invite` so a device on the tailnet cannot self-register a tenant.
- Sign-in, roles and permissions unchanged (a cashier on the tailnet is still a
  cashier).
- Since migration `0052`, signing out kills the access token on its **next**
  request rather than up to 15 minutes later (pen-test PE-5).

### 4.7 Cloudflare Tunnel, honestly

It works, and the trade-off is different in a way that matters for accounting
data. `cloudflared` gives you a **public hostname**; traffic is terminated and
inspected by Cloudflare rather than staying inside a private mesh. If you go this
way, **Cloudflare Access in front is not optional** — without it you have
published a company's books at a guessable hostname.

```bash
cloudflared tunnel login
cloudflared tunnel create emil-shop
cloudflared tunnel route dns emil-shop shop.example.com
cloudflared tunnel run --url http://localhost:8080 emil-shop
```

For one shop and one owner, Tailscale is the better fit: nothing becomes public
at any point, and there is no third party in the path.

---

## 5. What must not reach for the internet mid-sale

The checklist that makes §0's claim true rather than hopeful.

| Concern | Status | Why it holds |
| --- | --- | --- |
| Web fonts | safe | `@fontsource-variable/plus-jakarta-sans` is an npm dependency, bundled and self-hosted. No CDN fetch. |
| The assistant | safe | Optional. With `ANTHROPIC_API_KEY` unset it reports itself unconfigured; everything else works. |
| MyInvois / e-Invoice | safe | Submissions are queued to `outbox_event`, never called inline from the sale. They drain when the link returns. |
| Document QR verify | safe | With `DOCUMENT_SIGNING_KEY` set, a printed QR verifies with this server switched **off** — the signature is in the code. |
| DNS | **your job** | §2.3. Use the IP or a hosts entry. |
| Clock | **your job** | Accounting dates are `DATE` in `Asia/Kuala_Lumpur`. A few days without NTP is harmless; a dead RTC battery is not. Check `timedatectl`. |
| `PUBLIC_BASE_URL` | **your job** | It is printed on paper that outlives this deployment. It must be an address a **customer** can reach — never `localhost`, never a `100.x` tailnet address. See [`DEPLOY.md`](DEPLOY.md#the-address-printed-on-your-documents). |

### The acceptance test — actually pull the cable

Do this before you trust it, with the shop closed. It is a script rather than a
checklist, because the claim it verifies is the one the whole deployment exists
to make and a checklist gets read once:

```bash
scripts/shop/offline-acceptance.sh \
  --api http://localhost:8080/api \
  --email owner@shop.example --password '…'
```

It records the before-state, prompts you to **unplug the WAN**, rings a real cash
sale in RM through the live API, and then checks what must be true locally:

| Check | Why it is there |
| --- | --- |
| API answers, database reachable, clock sane | the run is meaningless otherwise |
| worker is draining the outbox | an unclaimed backlog means no worker — caught in preflight, not as a mystery at the end |
| **sale completes with the WAN down** | the requirement, stated as an assertion |
| stock decremented | the shelf moved, not just a row |
| journal entry posted, and every entry balances | the books are still books |
| outbound work queued in `outbox_event` | queued, not lost — an outage is a delay |
| queue drains after reconnect | and it recovers by itself |

Then it prompts you to plug the cable back in and polls until the queue clears,
printing a PASS/FAIL table and exiting non-zero if anything failed.

`--simulate` runs every assertion except the two physical ones and labels the
output **SIMULATED RUN — no cable was pulled**, so a run that did not actually
test the offline case cannot be mistaken for one that did. Use it to check the
script; never to sign off a shop.

`scripts/shop/lan-check.sh` is the smaller companion: it prints the server's LAN
address, warns if that address came from DHCP without a reservation, confirms the
app answers there rather than only on `localhost`, and prints the `hosts` line to
paste on the cashier PC.

---

## 6. Local → cloud sync, and why the outbox beats BullMQ here

### 6.1 First: check whether you need it

For the requirement as stated — *the owner monitors live sales and reports from
home* — **§4 already solves it completely**. The owner sees the real system with
real data over an encrypted private link. A cloud replica adds a second copy of
the books that can silently disagree with the first, to solve a problem the
tunnel already solved.

Cloud sync answers a **different** question: *what if the shop burns down.* That
is disaster recovery, and the nightly `pg_dump` already in
`docker-compose.prod.yml` (pointed at a OneDrive/Google Drive folder) plus
exported proof packs answers it more simply and more verifiably than a sync
engine. Build the sync engine only if you have a second site, or a genuine need
for cloud-side reporting.

### 6.2 Why not BullMQ for the financial path

You asked specifically for `@nestjs/bullmq`. For queueing **invoices and journal
entries**, it is the wrong tool, and this repo already decided so deliberately
(`CLAUDE.md`: the worker drains the outbox with PostgreSQL, not Redis).

The reason is the dual write:

```
BEGIN;
  INSERT INTO invoice ...;          -- Postgres
  INSERT INTO journal_entry ...;    -- Postgres
COMMIT;                             -- ✅ committed
await syncQueue.add('push', {...}); -- Redis. Separate system. Can fail HERE.
```

Two outcomes, both unacceptable for money:

- **Enqueue fails after commit** → the sale exists locally and will *never* sync.
  Silent. You discover it at year-end when the two copies disagree.
- **Enqueue succeeds, transaction rolls back** → you push a sale that never
  happened.

There is no ordering of those two writes that fixes it, because they are in two
systems with no shared transaction. The outbox pattern exists precisely to
collapse them into one:

```sql
BEGIN;
  INSERT INTO invoice ...;
  INSERT INTO journal_entry ...;
  INSERT INTO outbox_event (event_type, aggregate_type, aggregate_id, payload) ...;
COMMIT;   -- the effect and the intent to sync commit together, or neither does
```

Offline is not a special case here — it is the *normal* case. The row simply sits
in `outbox_event` until something drains it.

This is not a position adopted for the shop deployment; it is written into the
schema. From `packages/db/migrations/0021_worker.sql`, which created the relay:

> **Why PostgreSQL and not BullMQ, which the stack names.** The outbox exists to
> eliminate a dual write. Its whole premise is that the job and the ledger effect
> commit or fail TOGETHER, which is only true while the job lives in the same
> database as the effect. A relay that pushed to Redis from inside the writing
> transaction would reintroduce exactly the inconsistency the pattern was adopted
> to prevent, and one that pushed after commit can lose jobs when it dies in
> between.
>
> Redis and BullMQ are deferred rather than rejected. They earn their place when
> there is work that genuinely needs a distributed queue — cross-process rate
> limiting against LHDN, fan-out at a scale one poller cannot serve. A second
> datastore introduced for one nightly job is operational burden and another
> thing to be down.

That last sentence is the deciding one for a till: the shop server's job is to
not stop selling, and every service running on it is a thing that can stop.

### 6.3 It is already built — here is the actual code

Not a sketch. `postJournalEntry` writes the outbox row **inside the caller's
transaction**, and passing `emitEvent` IS the enqueue — there is no helper to
call and no second event type to invent (`packages/db/src/ledger.ts`):

```ts
export interface PostOptions {
  readonly idempotencyKey: string;
  /** Emitted to the outbox after commit, e.g. 'invoice.issued'. */
  readonly emitEvent?: { readonly type: string; readonly payload: unknown };
  readonly reversalOfId?: string;
}

// ---- 8. Outbox ----------------------------------------------------------
// Written in the SAME transaction as the ledger effect. If the commit fails
// there is no job; if it succeeds the job exists.
if (options.emitEvent) {
  await tx`
      INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id, payload)
      VALUES (
          ${ctx.tenantId}, ${options.emitEvent.type}, 'journal_entry', ${entryId},
          ${tx.json(options.emitEvent.payload as never)}
      )
  `;
}
```

The call site, issuing an invoice (`packages/db/src/invoice.ts`):

```ts
const posted = await postJournalEntry(tx, ctx, validated.value, {
  idempotencyKey: `invoice:${input.idempotencyKey}`,
  emitEvent: {
    type: 'invoice.issued',
    payload: { invoiceId, invoiceNo, total: doc.total.toDecimalString() },
  },
});
```

And the proof that it is one transaction — the controller opens exactly one, and
threads it all the way down (`apps/api/src/modules/accounting.controller.ts`):

```ts
const ctx = this.ctx(request);
return withTenant(this.sql, ctx, (tx) =>
  issueInvoice(tx, ctx, { ...input, idempotencyKey }),
);
```

`withTenant` is `sql.begin(...)`. One `BEGIN`, one `COMMIT`: the invoice row, the
journal entry, its lines and the outbox event all land together or not at all.
**That is the property a Redis enqueue cannot have**, and it is why an ISP outage
is a delay here rather than a hole in the books.

Money in a payload is a decimal string at the money scale — `"1060.0000"`, four
places, never a JSON number. A cloud target parses it as a decimal, never a float.

### The drain, also already built

`claim_outbox_batch` (migration `0021_worker.sql`) is `SECURITY DEFINER`, uses
`SELECT … FOR UPDATE SKIP LOCKED`, and is executable by `emil_worker` and **not**
by the internet-facing `emil_app`. Claiming is a *lease*: it bumps `attempts` and
pushes `available_at` forward in one statement, so a worker that dies mid-handle
releases the event automatically.

`fail_outbox_event` is the retry policy, and it is already what you would write:

```sql
-- 2^attempts seconds, capped at an hour, plus up to 10% jitter so a provider
-- outage that fails a thousand events does not retry them in lockstep.
v_delay := least(power(2, v_attempts)::INTEGER, 3600);
```

After eight attempts the row goes `FAILED` and is **never deleted** — an event
that could not be dispatched is the evidence for why something downstream never
happened. A week-long outage costs a long backoff and nothing else.

### Adding a consumer

The whole change is a `Handler` and one key in the registry. Cloud sync ships as
a worked example, `apps/worker/src/handlers/cloud-sync.ts`, with the target
behind an interface (`apps/worker/src/sync/cloud-target.ts`) so nothing
half-built talks to a second copy of the books:

```ts
const syncToCloud = (target: CloudTarget): Handler =>
  async ({ event, log }) => {
    await target.push({
      tenantId: event.tenantId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,   // the idempotency key, on every event
      payload: event.payload,
    });
    log('synced', { target: target.name, aggregateId: event.aggregateId });
    return handled({ target: target.name, aggregateId: event.aggregateId });
  };
```

Two details that are load-bearing rather than stylistic:

- **`aggregateId` is the idempotency key for every event type.** It is the
  journal entry the event was emitted beside, it is on the row already, and it
  is stable across redeliveries. `invoiceNo` is not: the payload shape differs
  per event type and two tenants can both hold `INV-00001`. The far end must
  upsert on `(tenantId, aggregateId)` — at-least-once is the only guarantee a
  retry loop can give.
- **With no target configured, the handlers are not registered at all**
  (`cloudSyncHandlers(undefined)` returns `{}`). A handler that existed and
  skipped would move those events from *unroutable* — the honest "nothing
  consumes this" — to *skipped*, which reads as "considered and declined" while
  no second copy of the books exists anywhere.

Covered by `apps/worker/test/cloud-sync.test.ts` against real PostgreSQL: a
rollback leaves no outbox row, an unreachable target leaves the event `PENDING`
with `available_at` pushed forward, the queue drains by itself when the target
returns, and a redelivery does not double a payment.

### 6.4 The part that will bite you: the audit log is a hash chain

Do not application-sync `audit_log` or `journal_entry` row by row into a cloud
PostgreSQL. The cloud database runs the *same triggers*: `audit_log_chain`
recomputes `prev_hash`/`row_hash` on insert and — since migration `0052` —
**forces the actor columns from the inserting session's GUCs**. Your synced rows
would come out with different hashes from the originals, and
`verify_audit_chain` on the cloud copy would disagree with the shop. You would
have built a tamper-detection system that reports tampering you did yourself.

If you want a live cloud copy of the ledger, replicate **bytes, not statements**:

- **Logical replication** (`CREATE PUBLICATION` / `CREATE SUBSCRIPTION`) — copies
  row data without re-firing triggers, and tolerates the publisher being offline
  for as long as the WAL retention allows. This is the right tool.
- **Or** ship `pg_dump` + proof packs off-site and verify them with
  `scripts/verify-proof-pack.mjs`, which needs no cloud database at all.

Reserve the outbox-based sync for *derived, non-ledger* data — a reporting
summary, a stock snapshot — where a recomputed hash is not a claim about
tamper-evidence.

### 6.5 If you still want BullMQ — where it genuinely fits

BullMQ earns its place when you need something one Postgres poller cannot give:
cross-process rate limiting, fan-out to many workers, or scheduled retries at a
volume that would make the outbox table hot. Submitting to MyInvois for *many*
tenants under a provider rate limit is a real example.

The rule that keeps it safe: **enqueue from the outbox drain, never from the
writing transaction.** Postgres stays the source of truth; Redis becomes a
delivery mechanism whose loss costs a replay, not a sale.

```ts
// apps/worker/src/queues/sync.module.ts
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    BullModule.forRoot({
      connection: { host: process.env.REDIS_HOST ?? 'redis', port: 6379 },
    }),
    BullModule.registerQueue({
      name: 'cloud-sync',
      defaultJobOptions: {
        attempts: 10,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1_000,   // keep a short tail for debugging
        removeOnFail: false,       // a failed financial job is evidence
      },
    }),
  ],
})
export class SyncQueueModule {}
```

```ts
// apps/worker/src/queues/sync.processor.ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('cloud-sync', { concurrency: 4, limiter: { max: 30, duration: 1_000 } })
export class SyncProcessor extends WorkerHost {
  async process(job: Job<{ outboxId: string; aggregateId: string; payload: unknown }>) {
    // Idempotent on aggregateId: BullMQ guarantees at-least-once, not exactly-once.
    await pushToCloud(job.data.aggregateId, job.data.payload);
    // Only now is the outbox row retired — Postgres remains the source of truth,
    // so a Redis flush costs a replay rather than a lost sale.
    await completeOutboxEvent(job.data.outboxId);
  }
}
```

Note the ordering in `process()`: the outbox row is retired **after** the push
succeeds. Redis can be wiped at any moment and the worst outcome is that
already-pushed events are pushed again — which the idempotent cloud endpoint
absorbs. That is the property the naive design in §6.2 does not have.

Adding this means running Redis on the shop PC: one more service to keep alive on
a machine whose whole job is to not stop selling. Weigh that against a `SELECT …
FOR UPDATE SKIP LOCKED` against a database that is already running.

---

## 7. Summary — what to actually do

1. **Leave the binding alone.** `0.0.0.0` is already the default; only `web` is
   published; the database is not on the LAN.
2. **DHCP-reserve the shop server** at `192.168.1.10`, and put a `hosts` entry on
   the cashier PC so `http://till:8080` needs no DNS. `scripts/shop/lan-check.sh`
   tells you the address, whether it can move, and whether the app answers on it.
3. **Never point the till at Tailscale.** LAN address only.
4. **Tailscale on the server** (tagged auth key) + `tailscale serve` for HTTPS;
   ACL to `tag:shop:8080` only; `TRUST_PROXY=1`; never `funnel`.
5. **Set `PUBLIC_BASE_URL` to something a customer can reach**, and
   `DOCUMENT_SIGNING_KEY` so printed QR codes verify offline. Back that key up
   with the database — changing it invalidates every document already printed.
6. **Run `scripts/shop/offline-acceptance.sh`** — pull the WAN cable and ring a
   real sale — before you trust any of it. A `--simulate` run is not a sign-off
   and says so in its own output.
7. **Skip the cloud sync** unless you have a second site. The outbox and its
   relay are already built; a consumer is one `Handler` and one registry key
   (`apps/worker/src/handlers/cloud-sync.ts` is the worked example). Use logical
   replication for the ledger, never row-by-row inserts. Adding Redis to the till
   is adding a second thing that can stop the shop selling.
