import { pathToFileURL } from 'node:url';
import { createClient } from '@emil/db';
import { loadWorkerConfig } from './config.js';
import { createLogger } from './logger.js';
import { relayPass } from './relay.js';
import { schedulerPass } from './scheduler.js';
import { handlers } from './handlers/index.js';
import { jobs } from './jobs/index.js';

/**
 * The worker process.
 *
 * Two independent loops in one process, because they have nothing to do with
 * each other and everything to do with the same database:
 *
 *   * the RELAY drains `outbox_event` — event-driven, adaptive polling
 *   * the SCHEDULER runs due entries in `scheduled_job` — time-driven
 *
 * Both are safe to run in N copies. Nothing here assumes it is the only worker.
 *
 * ---------------------------------------------------------------------------
 * SHUTDOWN IS NOT AN AFTERTHOUGHT. IT IS THE DIFFERENCE BETWEEN A DEPLOY THAT
 * COSTS NOTHING AND ONE THAT DUPLICATES WORK.
 *
 * On SIGTERM — which is what a container orchestrator sends before it kills you
 * — the loops stop taking NEW work and the current pass is allowed to finish.
 * Exiting mid-pass would abandon leased events until their lease expires, and
 * abandon a handler between its commit and its acknowledgement, which is
 * precisely the window that produces a redelivery. Draining costs a few seconds
 * per deploy and removes that window on every ordinary restart.
 *
 * The pool is closed last, after both loops have stopped, so no query is torn
 * out from under a transaction that was about to commit.
 * ---------------------------------------------------------------------------
 */
export async function run(): Promise<void> {
  const config = loadWorkerConfig();
  const log = createLogger(config.logLevel);
  const sql = createClient(config.databaseUrl);

  let stopping = false;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

  const relayLoop = async () => {
    while (!stopping) {
      try {
        const pass = await relayPass(sql, handlers, log, {
          batchSize: config.batchSize,
          leaseSeconds: config.leaseSeconds,
          maxAttempts: config.maxAttempts,
        });

        if (pass.claimed > 0) {
          log.info('outbox: pass complete', { ...pass });
        }

        // A full batch means there is probably more behind it; anything less
        // means the queue is drained and polling harder just burns the
        // database. Adaptive rather than fixed, because a fixed interval is
        // either too slow under load or too noisy when idle.
        await sleep(pass.claimed >= config.batchSize ? config.busyPollMs : config.idlePollMs);
      } catch (error) {
        // The claim itself failed — the database is unreachable or the grant is
        // wrong. Back off rather than spinning: a worker that retries a
        // connection failure in a tight loop is a denial of service against a
        // database that is already struggling.
        log.error('outbox: relay pass failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(config.idlePollMs);
      }
    }
  };

  const schedulerLoop = async () => {
    while (!stopping) {
      try {
        const pass = await schedulerPass(sql, jobs, log);
        if (pass.claimed > 0) log.info('scheduler: pass complete', { ...pass });
      } catch (error) {
        log.error('scheduler: pass failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(config.schedulerPollMs);
    }
  };

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down: finishing the current pass', { signal });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log.info('worker started', {
    batchSize: config.batchSize,
    leaseSeconds: config.leaseSeconds,
    handlers: Object.keys(handlers),
    jobs: Object.keys(jobs),
  });

  await Promise.all([relayLoop(), schedulerLoop()]);
  await sql.end();
  log.info('worker stopped');
}

// Only when executed directly. Importing this module — which the tests do, to
// drive a single pass — must not start a loop that never ends.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
