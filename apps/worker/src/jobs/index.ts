import {
  allTenantIds,
  detectRollupDrift,
  dueForAttempt,
  queueHealth,
  scheduleRetry,
  withTenant,
  type Sql,
  type TenantContext,
} from '@emil/db';
import type { Logger } from '../logger.js';

/**
 * Scheduled jobs — the recurring work nothing has ever run.
 *
 * A job returns a summary object which is logged and, when it matters, becomes
 * the reason a job is recorded as failed. It throws only for a genuine fault;
 * "there was nothing to do" is a successful run with a count of zero.
 */
export interface JobContext {
  readonly sql: Sql;
  readonly log: Logger;
  /** Injected so tests can drive a job at a chosen instant. */
  readonly now: Date;
}

export type Job = (context: JobContext) => Promise<Record<string, unknown>>;

/**
 * Every tenant, for the jobs that ask a question of all of them.
 *
 * ---------------------------------------------------------------------------
 * THIS WENT THROUGH `SELECT id FROM organisation` FIRST, AND RETURNED NOTHING.
 *
 * `organisation` is RLS-forced like every other tenant table, and the worker
 * holds no tenant context when a scheduled job starts — so the query was
 * legal, fast, and empty. Every job then reported a clean run over zero
 * tenants: the rollup-drift canary asserted healthy while looking at nothing,
 * and the e-Invoice retry found nothing due because it never asked anybody.
 *
 * The integration test caught it only because it asserts a positive — that
 * drift IS detected — rather than that the job succeeds. A test that checked
 * for a successful run would have passed on a worker that did no work at all,
 * which is precisely the class of bug this whole component exists to prevent
 * elsewhere.
 *
 * `allTenantIds` is the narrow definer function that answers it. Identifiers
 * only; every job then works inside `withTenant`, RLS-bound exactly like a
 * request.
 * ---------------------------------------------------------------------------
 */
const everyTenant = allTenantIds;

/**
 * Ledger invariant canary.
 *
 * ---------------------------------------------------------------------------
 * `packages/db/src/ledger.ts` HAS DESCRIBED THIS AS A NIGHTLY JOB SINCE M1.
 *
 * Its own words: "This is the nightly canary for a posting bug. If it ever
 * returns rows, the journal is right and the rollup is wrong — rebuild the
 * rollup, never 'fix' the journal to match." `detectRollupDrift` was written,
 * tested, and never called by anything.
 *
 * That matters more than an unrun job usually would, because
 * `account_period_balance` is what every financial statement is built from
 * while `journal_line` is the truth. Drift between them means the balance
 * sheet a business sends its bank is wrong and the ledger underneath it is
 * fine — a discrepancy with no user-visible symptom until somebody
 * reconciles by hand.
 *
 * It only DETECTS. Rebuilding the rollup automatically at 03:00 would be
 * repairing evidence before anyone has looked at it, and the whole value of a
 * canary is that it was still holding the bad state when you arrived.
 * ---------------------------------------------------------------------------
 */
export const rollupDrift: Job = async ({ sql, log }) => {
  const tenants = await everyTenant(sql);
  const drifting: { tenantId: string; accounts: number }[] = [];

  for (const tenantId of tenants) {
    const ctx: TenantContext = { tenantId };
    const rows = await withTenant(sql, ctx, (tx) => detectRollupDrift(tx, ctx));

    if (rows.length > 0) {
      drifting.push({ tenantId, accounts: rows.length });
      log.error('rollup drift detected — the rollup is wrong, the journal is right', {
        tenantId,
        accounts: rows.length,
        sample: rows.slice(0, 5),
      });
    }
  }

  if (drifting.length > 0) {
    // Thrown so the run is recorded as ERROR and `last_error` carries it.
    // A canary that finds something and reports a healthy run is not a canary.
    throw new Error(
      `Rollup drift in ${drifting.length} organisation(s): ` +
        drifting.map((d) => `${d.tenantId} (${d.accounts} accounts)`).join(', '),
    );
  }

  return { tenantsChecked: tenants.length, drifting: 0 };
};

/**
 * Advance e-Invoice submissions whose next attempt is due.
 *
 * ---------------------------------------------------------------------------
 * REFUSES TO INVENT PROGRESS.
 *
 * There is no MyInvois adapter. `MyInvoisGateway` is a port with no
 * implementation, deferred until LHDN sandbox credentials exist, and the
 * trusted seam a real adapter will use — `POST /v1/einvoice/submissions/:id/
 * events` — is already built.
 *
 * So this job cannot submit anything, and the interesting decision is what it
 * does about that. It would be very easy to write something that marks
 * submissions SUBMITTED and moves on, and it would look like a working
 * pipeline. It would be a lie told to a compliance dashboard.
 *
 * Instead it counts what is due, pushes the next attempt out with the same
 * backoff a real adapter would use so the queue does not spin, and reports the
 * absence of an adapter as the reason. When an adapter is registered this job
 * gains a call and nothing else changes.
 * ---------------------------------------------------------------------------
 */
export const einvoiceRetry: Job = async ({ sql, log, now }) => {
  const tenants = await everyTenant(sql);
  const iso = now.toISOString();
  let due = 0;

  for (const tenantId of tenants) {
    const ctx: TenantContext = { tenantId };

    const submissions = await withTenant(sql, ctx, async (tx) => {
      const rows = await dueForAttempt(tx, ctx, iso);
      // Backoff applied in the SAME transaction the rows were locked in.
      // `dueForAttempt` takes FOR UPDATE SKIP LOCKED, and that lock is only
      // worth anything while the transaction that took it is still open —
      // rescheduling in a second transaction would let another worker claim
      // the same submissions in between.
      for (const submission of rows) {
        await scheduleRetry(tx, ctx, submission.id, iso);
      }
      return rows;
    });

    due += submissions.length;
  }

  if (due > 0) {
    log.warn('e-Invoice submissions are due and cannot be sent: no MyInvois adapter', {
      due,
      // Named so the reader knows this is a known gap with a known unblocker,
      // not a fault to go hunting for.
      blockedOn: 'LHDN MyInvois sandbox credentials',
    });
  }

  return { tenantsChecked: tenants.length, due, submitted: 0, adapter: 'NONE' };
};

/**
 * Report what has dead-lettered.
 *
 * The relay already logs each dead letter as it happens, which is exactly the
 * message nobody sees three weeks later. This is the standing count, so a
 * queue that quietly accumulated failures in April is visible in May.
 */
export const outboxSweep: Job = async ({ sql, log }) => {
  const tenants = await everyTenant(sql);

  let deadLettered = 0;
  let stalled = 0;
  let oldestPendingSeconds: number | null = null;
  const affected: { tenantId: string; deadLettered: number; stalled: number }[] = [];

  // Per tenant, through the SAME `queueHealth` the API serves — rather than one
  // cross-tenant aggregate behind another definer function. More queries, and a
  // privileged surface that stays a list of UUIDs; the job runs hourly, so the
  // cost is not the thing to optimise.
  for (const tenantId of tenants) {
    const ctx: TenantContext = { tenantId };
    const health = await withTenant(sql, ctx, (tx) => queueHealth(tx, ctx));

    deadLettered += health.outbox.failed;
    stalled += health.outbox.stalledOverAnHour;

    if (health.outbox.oldestPendingSeconds !== null) {
      oldestPendingSeconds = Math.max(
        oldestPendingSeconds ?? 0,
        health.outbox.oldestPendingSeconds,
      );
    }

    if (health.outbox.failed > 0 || health.outbox.stalledOverAnHour > 0) {
      affected.push({
        tenantId,
        deadLettered: health.outbox.failed,
        stalled: health.outbox.stalledOverAnHour,
      });
    }
  }

  if (affected.length > 0) {
    log.error('outbox is not draining cleanly', {
      deadLettered,
      stalledOverAnHour: stalled,
      oldestPendingSeconds,
      affected: affected.slice(0, 20),
    });
  }

  return {
    tenantsChecked: tenants.length,
    deadLettered,
    stalledOverAnHour: stalled,
    oldestPendingSeconds,
  };
};

/**
 * The registry, keyed by the `scheduled_job.name` seeded in migration 0021.
 *
 * A row with no entry here is reported as unroutable and disabled rather than
 * retried forever — an operator can add a schedule, but only code can add a
 * job, and a name with nothing behind it is a typo somebody should hear about.
 */
export const jobs: Readonly<Record<string, Job>> = {
  'rollup-drift': rollupDrift,
  'einvoice-retry': einvoiceRetry,
  'outbox-sweep': outboxSweep,
};
