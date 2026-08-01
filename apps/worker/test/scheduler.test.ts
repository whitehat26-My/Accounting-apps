import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '@emil/db';
import { schedulerPass } from '../src/scheduler.js';
import { einvoiceRetry, jobs, outboxSweep, rollupDrift, type Job } from '../src/jobs/index.js';
import { createTestLogger } from '../src/logger.js';
import {
  createTestDatabase,
  issueInvoiceFor,
  seedEInvoiceTenant,
  seedTenant,
  type Tenant,
} from './helpers.js';

let sql: Sql;
let admin: Sql;
let worker: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDatabase('scheduler');
  sql = db.sql;
  admin = db.admin;
  worker = db.worker;
  drop = db.drop;
}, 120_000);

afterAll(async () => {
  await drop?.();
});

const log = createTestLogger();

/** Only one job due, so a pass exercises exactly the one under test. */
async function onlyDue(name: string): Promise<void> {
  await admin`UPDATE scheduled_job SET is_enabled = FALSE, leased_until = NULL`;
  await admin`
      UPDATE scheduled_job
         SET is_enabled = TRUE, next_run_at = now() - INTERVAL '1 second', leased_until = NULL
       WHERE name = ${name}
  `;
}

const jobRow = async (name: string) => {
  const [row] = await admin<
    {
      last_status: string | null; last_error: string | null; run_count: number;
      failure_count: number; next_run_at: Date; leased_until: Date | null;
    }[]
  >`
      SELECT last_status, last_error, run_count, failure_count, next_run_at, leased_until
        FROM scheduled_job WHERE name = ${name}
  `;
  return row!;
};

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

describe('the scheduler', () => {
  it('runs a due job, records the outcome, and pushes the next run out', async () => {
    await onlyDue('outbox-sweep');

    const pass = await schedulerPass(worker, jobs, log);

    expect(pass).toMatchObject({ claimed: 1, ok: 1, failed: 0 });

    const row = await jobRow('outbox-sweep');
    expect(row.last_status).toBe('OK');
    expect(row.run_count).toBe(1);
    // The lease is released, or one bad night would lock the job forever.
    expect(row.leased_until).toBeNull();
    expect(row.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('does not run the same job twice while it is still due', async () => {
    await onlyDue('outbox-sweep');

    await schedulerPass(worker, jobs, log);
    const second = await schedulerPass(worker, jobs, log);

    // `finish_job` schedules from NOW, so a job that ran late is not
    // immediately due again and a worker restarted after an outage does not
    // fire a backlog of the same job.
    expect(second.claimed).toBe(0);
  });

  it('reschedules a job that FAILED, rather than leaving it stuck', async () => {
    await onlyDue('outbox-sweep');

    const throwing: Record<string, Job> = {
      'outbox-sweep': async () => {
        throw new Error('deliberate');
      },
    };

    const pass = await schedulerPass(worker, throwing, log);
    expect(pass.failed).toBe(1);

    const row = await jobRow('outbox-sweep');
    expect(row.last_status).toBe('ERROR');
    expect(row.last_error).toBe('deliberate');
    expect(row.failure_count).toBe(1);
    expect(row.leased_until).toBeNull();
    expect(row.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('records a schedule naming a job that does not exist as a failure', async () => {
    // A typo or a half-finished deploy. Skipping it quietly means a job that
    // never runs and never complains.
    await admin`
        INSERT INTO scheduled_job (name, description, interval_seconds, next_run_at)
        VALUES ('does-not-exist', 'A schedule with nothing behind it', 3600,
                now() - INTERVAL '1 second')
    `;
    await admin`UPDATE scheduled_job SET is_enabled = (name = 'does-not-exist')`;

    const pass = await schedulerPass(worker, jobs, log);

    expect(pass.unroutable).toBe(1);
    expect((await jobRow('does-not-exist')).last_error).toMatch(/No job is registered/);

    await admin`DELETE FROM scheduled_job WHERE name = 'does-not-exist'`;
  });

  it('leases so two workers do not both run the nightly job', async () => {
    await onlyDue('outbox-sweep');

    const [a, b] = await Promise.all([
      schedulerPass(worker, jobs, log),
      schedulerPass(worker, jobs, log),
    ]);

    expect(a!.claimed + b!.claimed).toBe(1);
  });

  it('leaves a disabled job alone, which is the 03:00 escape hatch', async () => {
    // Schedules are rows rather than constants precisely so an operator can do
    // this without a deploy.
    await admin`UPDATE scheduled_job SET is_enabled = FALSE, next_run_at = now() - INTERVAL '1 day'`;
    expect((await schedulerPass(worker, jobs, log)).claimed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The jobs
// ---------------------------------------------------------------------------

describe('rollup-drift — the canary ledger.ts has described since M1', () => {
  const run = (job: Job) => job({ sql: worker, log, now: new Date() });

  it('passes over a healthy ledger', async () => {
    const t = await seedTenant(admin, 'Healthy Sdn Bhd');
    await issueInvoiceFor(sql, t, { classificationCode: null });

    const summary = await run(rollupDrift);
    expect(summary).toMatchObject({ drifting: 0 });
  });

  it('THROWS when the rollup disagrees with the journal', async () => {
    /*
     * `account_period_balance` is what every financial statement is built from;
     * `journal_line` is the truth. Drift between them means the balance sheet a
     * business sends its bank is wrong while the ledger underneath it is fine —
     * and there is no user-visible symptom until somebody reconciles by hand.
     *
     * Corrupting the CACHE, not the journal, is the direction that matters: it
     * is what a posting bug would actually do.
     */
    const t = await seedTenant(admin, 'Drifting Sdn Bhd');
    await issueInvoiceFor(sql, t, { classificationCode: null });

    const before = await admin<{ debit_total: string }[]>`
        UPDATE account_period_balance
           SET debit_total = debit_total + 1
         WHERE tenant_id = ${t.tenantId}
           AND account_id = ${t.accounts['1100']!}
        RETURNING debit_total
    `;

    // Thrown, so the run is recorded as ERROR. A canary that finds something
    // and reports a healthy run is not a canary.
    await expect(run(rollupDrift)).rejects.toThrow(/Rollup drift in 1 organisation/);

    // And it does NOT repair the rollup: the whole value is that the bad state
    // is still there when somebody arrives to look at it.
    const [row] = await admin<{ debit_total: string }[]>`
        SELECT debit_total FROM account_period_balance
         WHERE tenant_id = ${t.tenantId} AND account_id = ${t.accounts['1100']!}
    `;
    expect(row!.debit_total).toBe(before[0]!.debit_total);

    await admin`
        UPDATE account_period_balance SET debit_total = debit_total - 1
         WHERE tenant_id = ${t.tenantId} AND account_id = ${t.accounts['1100']!}
    `;
  });
});

describe('einvoice-retry — refuses to invent progress', () => {
  it('counts what is due, backs it off, and reports that no adapter exists', async () => {
    /*
     * There is no MyInvois adapter, and the honest behaviour is the point of
     * this test. It would be easy to write a job that marks submissions
     * SUBMITTED and moves on; it would look like a working pipeline and would
     * be a lie told to a compliance dashboard.
     */
    const t = await seedEInvoiceTenant(admin, 'Retry Sdn Bhd');
    await issueInvoiceFor(sql, t);

    const { relayPass } = await import('../src/relay.js');
    const { handlers } = await import('../src/handlers/index.js');
    await relayPass(worker, handlers, log);

    const first = await einvoiceRetry({ sql: worker, log, now: new Date() });

    expect(first).toMatchObject({ due: 1, submitted: 0, adapter: 'NONE' });

    // Backed off, so a second pass does not spin on the same submission.
    const second = await einvoiceRetry({ sql: worker, log, now: new Date() });
    expect(second).toMatchObject({ due: 0 });

    const [row] = await withTenant(admin, { tenantId: t.tenantId }, (tx) =>
      tx<{ status: string; next_attempt_at: Date | null }[]>`
          SELECT status, next_attempt_at FROM einvoice_submission
           WHERE tenant_id = ${t.tenantId}
      `,
    );

    // Still QUEUED. Nothing pretended otherwise.
    expect(row!.status).toBe('QUEUED');
    expect(row!.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('outbox-sweep — the standing count', () => {
  it('reports dead letters and events stalled over an hour', async () => {
    const t = await seedTenant(admin, 'Sweep Sdn Bhd');

    await admin`
        INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id,
                                  payload, status, attempts, last_error)
        VALUES (${t.tenantId}, 'test.dead', 'journal_entry', ${randomUUID()},
                '{}'::jsonb, 'FAILED', 8, 'gave up')
    `;
    await admin`
        INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id,
                                  payload, created_at)
        VALUES (${t.tenantId}, 'test.stalled', 'journal_entry', ${randomUUID()},
                '{}'::jsonb, now() - INTERVAL '4 hours')
    `;

    const summary = await outboxSweep({ sql: worker, log, now: new Date() });

    expect(summary['deadLettered']).toBeGreaterThanOrEqual(1);
    expect(summary['stalledOverAnHour']).toBeGreaterThanOrEqual(1);
    expect(Number(summary['oldestPendingSeconds'])).toBeGreaterThan(3_000);
  });
});
