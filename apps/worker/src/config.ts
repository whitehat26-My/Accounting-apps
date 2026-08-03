import type { LogLevel } from './logger.js';

/**
 * Worker configuration.
 *
 * Refuses to start without a database URL, and has NO development fallback —
 * the same discipline as `apps/api`'s JWT secret, for the same reason: a
 * fallback is the value that reaches production.
 */
export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly logLevel: LogLevel;
  /** How long to sleep when a relay pass found nothing. */
  readonly idlePollMs: number;
  /**
   * How long to sleep when a pass found a FULL batch.
   *
   * Short, because a full batch means there is probably more waiting. Polling
   * at the idle interval after a full batch is how a backlog takes an hour to
   * clear at one batch per tick.
   */
  readonly busyPollMs: number;
  readonly batchSize: number;
  /**
   * The event lease. Must exceed the slowest handler, or an event still being
   * worked on becomes claimable by another worker — which the idempotency rule
   * makes survivable but which is still duplicated effort.
   */
  readonly leaseSeconds: number;
  readonly maxAttempts: number;
  /** How often to look for due scheduled jobs. */
  readonly schedulerPollMs: number;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. The worker has no development default.');
  }

  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;

    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}; got ${raw}`);
    }
    return value;
  };

  const logLevel = (env['LOG_LEVEL'] ?? 'info') as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be debug, info, warn or error; got ${logLevel}`);
  }

  return {
    databaseUrl,
    logLevel,
    idlePollMs: int('WORKER_IDLE_POLL_MS', 2_000, 100, 60_000),
    busyPollMs: int('WORKER_BUSY_POLL_MS', 50, 0, 10_000),
    batchSize: int('WORKER_BATCH_SIZE', 25, 1, 1_000),
    leaseSeconds: int('WORKER_LEASE_SECONDS', 300, 10, 3_600),
    maxAttempts: int('WORKER_MAX_ATTEMPTS', 8, 1, 50),
    schedulerPollMs: int('WORKER_SCHEDULER_POLL_MS', 10_000, 1_000, 300_000),
  };
}
