import type { Sql, Tx, TenantContext } from './client.js';

/**
 * The outbox relay's data access, and the scheduler's.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY MODULE IN `packages/db` THAT DELIBERATELY WORKS ACROSS TENANTS.
 *
 * Everything else here runs inside `withTenant`, with `app.tenant_id` set and
 * RLS deciding what the query can see. A relay cannot: its question is "what
 * work is outstanding anywhere", which by definition has no tenant context —
 * the same shape as authenticating a user, and handled the same way, through
 * narrow SECURITY DEFINER functions rather than by loosening a policy.
 *
 * The functions are granted to `emil_worker` and to nothing else. The
 * internet-facing API connects as `emil_app` and cannot call them, which is
 * what stops this escape hatch from being reachable from a request. See
 * migration 0021.
 * ---------------------------------------------------------------------------
 */

export interface OutboxEvent {
  readonly tenantId: string;
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  /** Includes this claim. First delivery is 1, not 0. */
  readonly attempts: number;
}

/**
 * Claim a batch of due events, leasing them.
 *
 * The lease is what makes a crash survivable: the events become claimable
 * again when it expires rather than sitting PENDING-but-invisible. Set it
 * comfortably longer than the slowest handler — reclaiming an event that is
 * still being processed means running the handler twice, which is exactly why
 * handlers must be idempotent.
 */
export async function claimOutboxBatch(
  sql: Sql,
  options: { limit?: number; leaseSeconds?: number } = {},
): Promise<OutboxEvent[]> {
  const rows = await sql<
    {
      tenant_id: string; id: string; event_type: string;
      aggregate_type: string; aggregate_id: string;
      payload: Record<string, unknown>; attempts: number;
    }[]
  >`
      SELECT * FROM claim_outbox_batch(
          ${options.limit ?? 25}::int,
          ${options.leaseSeconds ?? 300}::int
      )
  `;

  return rows.map((r) => ({
    tenantId: r.tenant_id,
    id: r.id,
    eventType: r.event_type,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    payload: r.payload,
    attempts: r.attempts,
  }));
}

export async function completeOutboxEvent(
  tx: Tx | Sql,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const [row] = await tx<{ complete_outbox_event: boolean }[]>`
      SELECT complete_outbox_event(${tenantId}::uuid, ${id}::uuid)
  `;
  return row?.complete_outbox_event ?? false;
}

export type FailOutcome = 'RETRY' | 'FAILED' | 'UNKNOWN';

/**
 * Record a failure. Returns whether the event will be retried or is dead.
 *
 * Deliberately NOT called inside the handler's transaction: a handler that
 * threw has had its transaction rolled back, and writing the failure there
 * would roll back with it — leaving an event that fails silently and forever
 * with no record of why. Same reason the audit trail is written by a trigger
 * rather than by the code that might be the thing going wrong.
 */
export async function failOutboxEvent(
  sql: Sql,
  tenantId: string,
  id: string,
  error: string,
  maxAttempts = 8,
): Promise<FailOutcome> {
  const [row] = await sql<{ fail_outbox_event: FailOutcome }[]>`
      SELECT fail_outbox_event(
          ${tenantId}::uuid, ${id}::uuid, ${error}, ${maxAttempts}::int
      )
  `;
  return row?.fail_outbox_event ?? 'UNKNOWN';
}

/**
 * Every organisation's id.
 *
 * The scheduled jobs ask their question of all of them, and `organisation` is
 * RLS-forced — so a worker with no tenant context set sees nothing at all. The
 * first version of the worker read the table directly and reported a clean run
 * over zero tenants, which is the worst possible answer from a canary.
 *
 * Returns identifiers only. The jobs then work inside `withTenant`, RLS-bound
 * exactly like a request, so the privileged surface is a list of UUIDs rather
 * than the data behind them.
 */
export async function allTenantIds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ all_tenant_ids: string }[]>`SELECT all_tenant_ids()`;
  return rows.map((r) => r.all_tenant_ids);
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

export interface DueJob {
  readonly name: string;
  readonly intervalSeconds: number;
  readonly runCount: number;
}

export async function claimDueJobs(sql: Sql, leaseSeconds = 900): Promise<DueJob[]> {
  const rows = await sql<{ name: string; interval_seconds: number; run_count: number }[]>`
      SELECT * FROM claim_due_jobs(${leaseSeconds}::int)
  `;
  return rows.map((r) => ({
    name: r.name,
    intervalSeconds: r.interval_seconds,
    runCount: r.run_count,
  }));
}

export async function finishJob(
  sql: Sql,
  name: string,
  result: { ok: boolean; error?: string; durationMs: number },
): Promise<void> {
  await sql`
      SELECT finish_job(
          ${name}, ${result.ok}, ${result.error ?? null}, ${result.durationMs}::int
      )
  `;
}

// ---------------------------------------------------------------------------
// Observability — the tenant-scoped view of the same thing
// ---------------------------------------------------------------------------

export interface QueueHealth {
  readonly outbox: {
    readonly pending: number;
    readonly failed: number;
    readonly dispatched: number;
    /** Age of the oldest undispatched event, in seconds. The lag signal. */
    readonly oldestPendingSeconds: number | null;
    /**
     * Pending for over an hour.
     *
     * A different question from `pending`, and the more useful one: a healthy
     * queue is pending-but-moving. This counts events that are pending and NOT
     * moving, which is the only kind worth waking somebody for.
     */
    readonly stalledOverAnHour: number;
  };
  readonly deadLettered: readonly {
    readonly id: string;
    readonly eventType: string;
    readonly aggregateId: string;
    readonly attempts: number;
    readonly lastError: string | null;
    readonly createdAt: string;
  }[];
}

/**
 * What is stuck, for THIS tenant.
 *
 * Tenant-scoped and RLS-enforced — an ordinary query, not a definer function.
 * A user is entitled to know that their own invoice never reached the
 * e-Invoice queue, and to no more than that.
 */
export async function queueHealth(tx: Tx, ctx: TenantContext): Promise<QueueHealth> {
  const [counts] = await tx<
    {
      pending: string; failed: string; dispatched: string;
      oldest: string | null; stalled: string;
    }[]
  >`
      SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::text    AS pending,
             COUNT(*) FILTER (WHERE status = 'FAILED')::text     AS failed,
             COUNT(*) FILTER (WHERE status = 'DISPATCHED')::text AS dispatched,
             EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE status = 'PENDING')))::text
                                                                 AS oldest,
             COUNT(*) FILTER (
                 WHERE status = 'PENDING' AND created_at < now() - INTERVAL '1 hour'
             )::text                                             AS stalled
        FROM outbox_event
       WHERE tenant_id = ${ctx.tenantId}
  `;

  const dead = await tx<
    {
      id: string; event_type: string; aggregate_id: string;
      attempts: number; last_error: string | null; created_at: Date;
    }[]
  >`
      SELECT id, event_type, aggregate_id, attempts, last_error, created_at
        FROM outbox_event
       WHERE tenant_id = ${ctx.tenantId} AND status = 'FAILED'
       ORDER BY created_at DESC
       LIMIT 50
  `;

  return {
    outbox: {
      pending: Number(counts!.pending),
      failed: Number(counts!.failed),
      dispatched: Number(counts!.dispatched),
      oldestPendingSeconds: counts!.oldest === null ? null : Math.round(Number(counts!.oldest)),
      stalledOverAnHour: Number(counts!.stalled),
    },
    deadLettered: dead.map((d) => ({
      id: d.id,
      eventType: d.event_type,
      aggregateId: d.aggregate_id,
      attempts: d.attempts,
      lastError: d.last_error,
      createdAt: d.created_at.toISOString(),
    })),
  };
}

export interface ScheduledJobStatus {
  readonly name: string;
  readonly description: string;
  readonly intervalSeconds: number;
  readonly isEnabled: boolean;
  readonly nextRunAt: string;
  readonly lastRunAt: string | null;
  readonly lastStatus: 'OK' | 'ERROR' | null;
  readonly lastError: string | null;
  readonly lastDurationMs: number | null;
  readonly runCount: number;
  readonly failureCount: number;
}

/**
 * Scheduled job health.
 *
 * Global rather than tenant-scoped, because the jobs are: `rollup-drift` asks
 * a question of every tenant at once. It exposes job names and timings — no
 * tenant data — and is behind `system.read`.
 */
export async function scheduledJobs(tx: Tx): Promise<ScheduledJobStatus[]> {
  const rows = await tx<
    {
      name: string; description: string; interval_seconds: number; is_enabled: boolean;
      next_run_at: Date; last_run_at: Date | null; last_status: 'OK' | 'ERROR' | null;
      last_error: string | null; last_duration_ms: number | null;
      run_count: number; failure_count: number;
    }[]
  >`
      SELECT name, description, interval_seconds, is_enabled, next_run_at,
             last_run_at, last_status, last_error, last_duration_ms,
             run_count, failure_count
        FROM scheduled_job
       ORDER BY name
  `;

  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    intervalSeconds: r.interval_seconds,
    isEnabled: r.is_enabled,
    nextRunAt: r.next_run_at.toISOString(),
    lastRunAt: r.last_run_at ? r.last_run_at.toISOString() : null,
    lastStatus: r.last_status,
    lastError: r.last_error,
    lastDurationMs: r.last_duration_ms,
    runCount: r.run_count,
    failureCount: r.failure_count,
  }));
}
