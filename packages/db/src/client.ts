import postgres from 'postgres';

/** A pooled connection. */
export type Sql = postgres.Sql<Record<string, never>>;
/** A connection inside a transaction, already bound to a tenant. */
export type Tx = postgres.TransactionSql<Record<string, never>>;

/**
 * Where a write came from.
 *
 * ---------------------------------------------------------------------------
 * THIS EXISTS BECAUSE THE AUDIT LOG COULD NOT SEE IT.
 *
 * `audit_log` has carried `actor_ip`, `user_agent` and `request_id` columns
 * since migration 0001, and 04-security-compliance.md §4.3 asks for "who, what,
 * before, after, when, FROM WHERE". The API has always collected the last part
 * — `RequestContext` in apps/api holds all three — but there was no way to
 * carry it into the transaction, so every one of those columns was NULL on
 * every audit row that existed.
 *
 * Optional on purpose. A background job, a migration or a test has no request
 * behind it, and an audit row that cannot say where a write came from is worth
 * far more than a write that fails because nothing set a header.
 * ---------------------------------------------------------------------------
 */
export interface ActorContext {
  /** Correlates an audit row with the request log and the trace. */
  readonly requestId?: string;
  readonly actorIp?: string;
  readonly userAgent?: string;
}

export interface TenantContext extends ActorContext {
  readonly tenantId: string;
  readonly userId?: string;
  /** Set only when the caller holds the `period.override` permission. */
  readonly allowLockedPeriod?: boolean;
}

export function createClient(connectionString = requireDatabaseUrl()): Sql {
  // NOTE: postgres.js returns NUMERIC/DECIMAL as a **string** by default,
  // precisely because they do not fit a JS number without loss. That default is
  // load-bearing here — do NOT add a numeric type parser that converts to
  // `number`. Hand the string to `Money.fromDecimal()` instead.
  // `packages/db/test/numeric.test.ts` guards this.
  return postgres(connectionString, {
    max: 10,
    onnotice: () => {},
  });
}

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

/**
 * Run `fn` inside a transaction bound to a tenant.
 *
 * `SET LOCAL` scopes the setting to this transaction, so it cannot leak to the
 * next request served by the same pooled connection. Every query that touches
 * tenant data must go through here — a code path that opens a connection
 * without setting `app.tenant_id` is a P0 defect, and ledger invariant #14
 * exists to catch it.
 */
export async function withTenant<T>(
  sql: Sql,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`;
    if (ctx.userId) {
      await tx`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.allowLockedPeriod) {
      await tx`SELECT set_config('app.allow_locked_period', 'on', true)`;
    }
    await setActorContext(tx, ctx);
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Publish the actor context to the settings the audit trigger reads.
 *
 * `SET LOCAL`, like every other setting here: transaction-scoped, so it cannot
 * leak to the next request served by the same pooled connection. One request's
 * IP address appearing on another request's audit rows would be worse than no
 * IP at all — it would be evidence pointing at the wrong person.
 */
async function setActorContext(tx: Tx, ctx: ActorContext): Promise<void> {
  if (ctx.requestId) {
    await tx`SELECT set_config('app.request_id', ${ctx.requestId}, true)`;
  }
  if (ctx.actorIp) {
    await tx`SELECT set_config('app.actor_ip', ${ctx.actorIp}, true)`;
  }
  if (ctx.userAgent) {
    // Truncated: a user agent is attacker-controlled and unbounded, and this
    // string is copied onto every audit row the transaction writes.
    await tx`SELECT set_config('app.user_agent', ${ctx.userAgent.slice(0, 300)}, true)`;
  }
}

/**
 * Run `fn` bound to a USER but no tenant.
 *
 * ---------------------------------------------------------------------------
 * Deliberately narrow, and not a general-purpose escape from `withTenant`.
 *
 * Authentication and the organisation switcher are pre-tenant by nature: you
 * cannot ask "which organisations may I act for" from inside one of them. This
 * is the only sanctioned way to run without a tenant, and the only things
 * reachable from it are the identity SECURITY DEFINER functions and a user's
 * own `membership` rows — every tenant-owned table's policy compares against
 * `current_tenant_id()`, which is NULL here, so they return nothing.
 *
 * That last point is the safety property: forgetting to use `withTenant` and
 * reaching for this instead does not leak, it returns an empty set.
 * ---------------------------------------------------------------------------
 */
export async function withUser<T>(
  sql: Sql,
  userId: string | null,
  fn: (tx: Tx) => Promise<T>,
  actor: ActorContext = {},
): Promise<T> {
  return sql.begin(async (tx) => {
    if (userId) {
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    }
    await setActorContext(tx, actor);
    return fn(tx);
  }) as Promise<T>;
}
