# Cloud setup: Netlify + Supabase + Railway

The deployment where the books live on the internet rather than on a PC in the
shop. Reachable from home, from a phone on mobile data, and — the thing no
local install can do — **the QR code printed on every invoice, receipt and
warranty card actually resolves for the customer holding the paper.**

```
browser ──→ Netlify              the screens (static files), /api/* proxied onward
                └──→ Railway     API container + worker container
                        └──→ Supabase    PostgreSQL
```

The browser only ever talks to Netlify, so there is one origin and **CORS never
exists** — the same property `next.config.ts`'s `rewrites()` gives the Docker
deployment, moved one layer out.

> Doing this once and remembering it wrongly later is the normal outcome, which
> is why the order below is written down. **Steps 0 and 1 are the ones that
> decide whether this works at all.** Do them before creating any other account.

---

## Step 0 — the check that can end the plan

**Migrations must run as a role with `SUPERUSER` or `BYPASSRLS`.** Migration
`0021` checks and refuses otherwise. This is not a formality: its
`SECURITY DEFINER` functions are owned by the migrating role, `outbox_event`
has RLS `FORCED` (which applies to the owner too), and an owner that cannot
bypass RLS produces a relay that **silently sees zero rows in every tenant.**
Nothing errors. The outbox fills up, invoices never reach the e-Invoice queue,
and every health check reports an idle queue because from the relay's point of
view there is no work.

**Supabase's `postgres` role is not a superuser** — Supabase says so plainly
([roles & superuser access](https://supabase.com/docs/guides/database/postgres/roles-superuser)).
Whether it carries `BYPASSRLS` is the open question, so ask the database:

```sql
-- Supabase dashboard → SQL Editor
SELECT current_user, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = current_user;
```

| Result | What to do |
| --- | --- |
| `rolbypassrls = true` (or `rolsuper = true`) | Continue to step 1. |
| both false | **Supabase is out for this app.** Use **Railway's own PostgreSQL** instead — its template is the plain `postgres` image and the provided user *is* a superuser. Everything else in this document is unchanged; you simply have one service fewer and one bill fewer. |

Do not try to work around a `false` here by granting the app more privilege.
The refusal is the migration telling you the deployment would not work.

---

## Step 1 — which connection string, and why it is not the obvious one

Supabase offers three, and **two of them break this app.** Take the
**Session pooler**.

| Supabase option | Verdict |
| --- | --- |
| **Session pooler** (`aws-…pooler.supabase.com`, port 5432) | ✅ **Use this.** Reachable over IPv4, and it supports prepared statements. |
| Direct connection (`db.<ref>.supabase.co`, port 5432) | ⚠️ **IPv6 only** for projects created after 15 January 2024. Railway reaching it over IPv4 is the single most common failure of this setup. Works only with the paid IPv4 add-on. |
| Transaction pooler (port 6543) | ❌ **Does not support prepared statements** — and this app uses them. See below. |

### The prepared-statement trap, measured rather than assumed

`packages/db/src/client.ts` builds the client with `postgres.js` defaults, and
that default is `prepare: true`. Against a real PostgreSQL, two parameterised
queries leave **three** prepared statements on the server. The transaction
pooler shares one backend between clients, so those names collide and you get
`prepared statement "…" already exists` — intermittently, under load, which is
the worst way to find out.

If you are forced onto the transaction pooler anyway, **append `?prepare=false`
to `DATABASE_URL`.** No code change is needed; it is a `postgres.js` connection
option and it works (verified: zero server-side prepared statements with it,
three without). Note that the `?no_prepare=1` form some guides mention is
**rejected by PostgreSQL** as an unknown startup parameter — it is a JS option
only, not a URL one.

---

## Step 2 — migrations, then roles, in that order

Both are already rehearsed against a fresh PostgreSQL and are what the test
suite runs. Use the **privileged** role from step 0 for both.

```bash
# 1. Schema. Refuses immediately if step 0's answer was really "no".
DATABASE_URL="postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
  pnpm --filter @emil/db migrate

# 2. The two LOGIN roles the services connect as. Re-running rotates passwords.
psql "$DATABASE_URL" \
  -v app_password="'$EMIL_APP_PASSWORD'" \
  -v worker_password="'$EMIL_WORKER_PASSWORD'" \
  -f scripts/prod-roles.sql
```

Migrations create `emil_app` and `emil_worker` as `NOLOGIN` group roles.
Nothing connects *as* a group role: each service gets its own `LOGIN` role
inheriting one group, so a leaked API credential carries the API's permissions
and **never the worker's cross-tenant definer functions.**

Confirm that boundary is real before trusting it:

```bash
# As emil_app_login — MUST fail with "permission denied for function".
# If it returns rows instead, stop: the internet-facing service can read
# every tenant's outbox.
psql "postgres://emil_app_login:…" -c "SELECT * FROM claim_outbox_batch(1);"

# As emil_worker_login — must succeed (0 rows on a fresh database is correct).
psql "postgres://emil_worker_login:…" -c "SELECT count(*) FROM claim_outbox_batch(1);"
```

---

## Step 3 — Railway: the API and the worker

Two services from this repository, `docker/api.Dockerfile` and
`docker/worker.Dockerfile`.

**API service:**

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase session pooler, as `emil_app_login` |
| `JWT_SECRET` | `openssl rand -base64 32` |
| `PUBLIC_BASE_URL` | `https://<your domain>` — the address on every printed QR code |
| `SIGNUP_MODE` | `invite` |
| `TRUST_PROXY` | see below |
| `NODE_ENV` | `production` |
| `PORT` | whatever Railway injects |

**Worker service:** `DATABASE_URL` as `emil_worker_login`, and `NODE_ENV`.
Nothing else — it faces nothing.

### `PUBLIC_BASE_URL` outlives the deployment

It is printed as a QR code on invoices, receipts, warranty cards and repair
reports so a customer can check the document is real. **Paper outlives the
deployment that printed it.** Set it to the final domain before printing
anything a customer keeps; a receipt carrying a dead link cannot be recalled.

### `TRUST_PROXY` — state it, do not guess it

It sets how many reverse-proxy hops sit in front of the API, so `request.ip` is
the real client. That address keys the rate limiter and is written to the audit
log as `actor_ip`.

- **Too high** — a client forges its own `X-Forwarded-For` and walks past every
  rate limit, and forges the "from where" on the audit trail.
- **Too low** — every request appears to come from Netlify, so the whole system
  shares one rate-limit bucket and the first busy shop locks out the rest.

Unset means `false`: trust nothing, use the socket address. That is the safe
default and it is *wrong here* only in that it under-counts. Determine the real
number after deploying — sign in from a known address and read the `actor_ip`
on your own audit row. If it is your address, the value is right. If it is a
Netlify or Railway address, raise the hop count by one and check again.

---

## Step 4 — Netlify: the screens

Connect the repository. `netlify.toml` already declares the build; set only:

| Variable | Value |
| --- | --- |
| `API_ORIGIN` | `https://<your Railway API domain>` |
| `NEXT_PUBLIC_APP_NAME` | the name on the sign-in page and browser tab |

`API_ORIGIN` is **not** optional and **not** a runtime setting. Netlify does not
substitute environment variables into redirect targets, so
`scripts/netlify-redirects.mjs` writes the proxy rule during the build and
**fails the build** if the value is missing, unparseable, plain `http`, or
carries a path. Without that check the site deploys green, every screen loads,
and only signing in fails.

`NEXT_PUBLIC_APP_NAME` is inlined by Next at build time, so changing it needs a
redeploy, not a restart.

---

## Step 5 — prove it, in this order

1. `https://<domain>/` loads, and `https://<domain>/api/openapi.json` returns
   the document. If the first works and the second 404s, `API_ORIGIN` was wrong
   at build time — redeploy, do not restart.
2. Response headers carry `Content-Security-Policy`, `X-Frame-Options: DENY`
   and `Strict-Transport-Security`. A static export runs no server and so never
   applies `next.config.ts`'s `headers()`; `netlify.toml` is the only thing
   supplying them, and `apps/web/test/netlify-headers.test.ts` keeps the two in
   step.
3. Register → onboard → add an item → make a cash sale → print a receipt.
4. **Scan the receipt's QR code with a phone on mobile data, not on WiFi.**
   This is the step no shop-PC deployment can pass, and it is the proof the
   move was worth making.
5. Read your own audit row and confirm `actor_ip` is your real address
   (step 3's `TRUST_PROXY`).

---

## What it costs, plainly

| | |
| --- | --- |
| **Netlify** | Free is genuinely enough — it serves static files. |
| **Supabase** | Free gives 500 MB. **Repair photos are `BYTEA` inside PostgreSQL** (`0035_repair_photos.sql`), so a shop photographing jobs will pass 500 MB and need Pro (~USD 25/month). Moving photos to object storage is the real fix and is separate work. |
| **Railway / Fly** | ~USD 5–20/month for two small containers. |

**Realistically RM 100–200/month once past the free tiers.** Worth knowing
before starting: "because it is free" is not what this stays.

---

## Deliberately not here

- **Netlify Functions for the API.** The worker is a polling loop that cannot
  run there, the controllers cold-start slowly enough to be felt at a till, and
  the in-memory rate limiter stops limiting across invocations. The API belongs
  in a container.
- **Moving repair photos out of PostgreSQL.** The right fix for the Supabase
  bill, and its own migration.
- **MyInvois.** Selling to other Malaysian shops makes this the most valuable
  thing left (`docs/SETTLEMENT-REGISTER.md` §3.2), but it needs LHDN
  credentials and is not a hosting question.
