import postgres from 'postgres';

/** A pooled connection. */
export type Sql = postgres.Sql<Record<string, never>>;
/** A connection inside a transaction, already bound to a tenant. */
export type Tx = postgres.TransactionSql<Record<string, never>>;

export interface TenantContext {
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
    return fn(tx);
  }) as Promise<T>;
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
): Promise<T> {
  return sql.begin(async (tx) => {
    if (userId) {
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    }
    return fn(tx);
  }) as Promise<T>;
}
