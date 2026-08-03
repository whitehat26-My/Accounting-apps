# Deploying the real system

The GitHub Pages demo is a tour — data lives in the browser and vanishes with it.
This document takes the REAL system (PostgreSQL, append-only ledger, RLS, the
worker) to a server. Everything here is configuration and a runbook; the deploy
itself needs an account only the owner can create.

## The one constraint that picks your host

**Migrations must run as a role with SUPERUSER or BYPASSRLS.** Migration `0021`
checks and refuses otherwise — its SECURITY DEFINER functions are owned by the
migrating role, and an owner that cannot bypass RLS produces a relay that
silently sees zero rows in every tenant. Failing the deploy is the designed
outcome; the alternative is a system that starts cleanly and does not work.

What that means in practice:

| Host | Verdict |
| --- | --- |
| **Any VPS running this compose file** (Hetzner, DigitalOcean, Vultr, a spare PC) | ✅ The `db` container's `postgres` user is a real superuser. This is the recommended path, ~RM 25–40/month. |
| **Railway** | ✅ Its PostgreSQL template is the plain `postgres` image — the provided user is a superuser. Deploy the three Dockerfiles as three services. |
| **Fly.io** (unmanaged Postgres) | ✅ Full control. |
| **Render / Heroku managed PostgreSQL** | ❌ Their database user has neither SUPERUSER nor BYPASSRLS and they will not grant it. Migration 0021 refuses, on purpose. Use their compute with an external PostgreSQL if you must use them. |

## The VPS path (recommended)

Prerequisites: a server with Docker + the compose plugin, and this repository
cloned onto it.

```bash
cp .env.prod.example .env.prod        # fill in the four secrets (openssl rand -base64 32)
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Startup order is enforced inside the file: PostgreSQL → `migrate` (one-shot,
as superuser) → `roles` (one-shot: creates `emil_app_login` /
`emil_worker_login`, NOBYPASSRLS, mirroring the test harness) → API → worker →
web. Only `web` is published (port 8080 by default); the browser calls
`/api/*` and Next proxies to the API on the private network, so the API and
database never face the internet.

Verify:

```bash
curl -s http://localhost:8080/api/openapi.json | head -c 200   # API through the proxy
docker compose -f docker-compose.prod.yml logs worker | tail    # jobs claiming cleanly
```

Then open the site, **Register** the first account, run first-time setup
(shop name → chart seeded → numbering), and add the team on the Team page:
cashier as Cashier/Sales, technicians as Technician, the accountant as
Accountant.

### HTTPS

Use `docker/Caddyfile.example`: point your domain at the server, add the
`caddy` service from the comment block, remove `web`'s port mapping. Caddy
obtains and renews the certificate itself. Do this before real use — sessions
over plain HTTP on shop Wi-Fi are credentials in the clear.

### Backups — non-negotiable

The `backup` service runs `pg_dump` nightly into `./backups`, keeping 14.
Two rules:

1. **Copy them off the machine.** `rclone` to any object storage (Backblaze
   B2 is effectively free at this size). The server that dies takes its local
   backups with it.
2. **Rehearse a restore once**, before it matters:

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U postgres -d emil_restore_test --create --clean < backups/emil-<newest>.dump
```

A backup nobody has restored is a hope, not a backup.

### Upgrades

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

`migrate` re-runs idempotently (applied migrations are recorded and skipped);
`roles` re-runs and rotates the service passwords to whatever `.env.prod`
holds — which is also the credential-rotation procedure.

### Password rotation

Change the value in `.env.prod`, then `up -d` again: `roles` ALTERs the login
role, and the service containers restart with the new URL. Rotate
`JWT_SECRET` the same way; every session is invalidated, everyone signs in
again — that is what rotating a signing key means.

## Environment reference

| Variable | Used by | Notes |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | db, migrate, backup | The superuser. Never given to api/worker. |
| `EMIL_APP_PASSWORD` | api | Login role inheriting `emil_app` only. |
| `EMIL_WORKER_PASSWORD` | worker | Login role inheriting `emil_worker` — the only role that can call the cross-tenant outbox functions. |
| `JWT_SECRET` | api | 32+ chars, no default by design. |
| `WEB_PORT` | web | Published port, default 8080. |
| `API_ORIGIN` | web | Set in the compose file; where Next proxies `/api/*`. |

## What this deliberately does not include

- **Terraform / multi-server anything** — one shop, one machine, one file.
  The register's `infra` entry stays deferred until there is a reason.
- **A staging environment** — the test suite against a real PostgreSQL is the
  staging this codebase relies on; a second server would be cost without a
  second tenant.
- **Email, MyInvois, payment gateways** — each is one credential away and
  documented in the settlement register (§4.4, §3.2, §3.3); none blocks going
  live for daily shop use.
