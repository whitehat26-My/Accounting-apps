import { claimDueJobs, finishJob, type Sql } from '@emil/db';
import type { Job } from './jobs/index.js';
import type { Logger } from './logger.js';

/**
 * The scheduler.
 *
 * Schedules live in `scheduled_job` rather than in code, so an operator can
 * disable a misbehaving job without a deploy — which is what you want at 03:00
 * and cannot have if the cron table is a constant in a bundle.
 *
 * Claiming leases the row, so two workers do not both run the nightly canary.
 * The lease also self-heals: a worker that dies mid-job releases it when the
 * lease expires, rather than leaving the job locked forever behind a process
 * that no longer exists.
 */
export interface SchedulerPass {
  readonly claimed: number;
  readonly ok: number;
  readonly failed: number;
  readonly unroutable: number;
}

export async function schedulerPass(
  sql: Sql,
  registry: Readonly<Record<string, Job>>,
  log: Logger,
  options: { leaseSeconds?: number; now?: Date } = {},
): Promise<SchedulerPass> {
  const due = await claimDueJobs(sql, options.leaseSeconds ?? 900);
  const tally = { claimed: due.length, ok: 0, failed: 0, unroutable: 0 };

  for (const entry of due) {
    const job = registry[entry.name];

    if (!job) {
      // Recorded as a failure rather than skipped quietly. A schedule naming a
      // job that does not exist is a typo or a half-finished deploy, and the
      // symptom of ignoring it is a job that never runs and never complains.
      await finishJob(sql, entry.name, {
        ok: false,
        error: `No job is registered under the name '${entry.name}'`,
        durationMs: 0,
      });
      log.error('scheduler: no such job', { job: entry.name });
      tally.unroutable += 1;
      continue;
    }

    const started = Date.now();

    try {
      const summary = await job({ sql, log, now: options.now ?? new Date() });
      const durationMs = Date.now() - started;

      await finishJob(sql, entry.name, { ok: true, durationMs });
      log.info('scheduler: job completed', { job: entry.name, durationMs, ...summary });
      tally.ok += 1;
    } catch (error) {
      const durationMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);

      // `finishJob` releases the lease and schedules the next run whether the
      // job succeeded or not. A job that failed must still be rescheduled —
      // leaving it leased on failure would mean one bad night stops it running
      // ever again, which is the opposite of what a canary is for.
      await finishJob(sql, entry.name, { ok: false, error: message, durationMs });
      log.error('scheduler: job failed', { job: entry.name, durationMs, error: message });
      tally.failed += 1;
    }
  }

  return tally;
}
