import {
  claimOutboxBatch,
  completeOutboxEvent,
  failOutboxEvent,
  withTenant,
  type OutboxEvent,
  type Sql,
} from '@emil/db';
import type { HandlerRegistry, HandlerResult } from './handlers/registry.js';
import type { Logger } from './logger.js';

/**
 * The outbox relay.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF OPERATIONS IS THE ENTIRE DESIGN. IT IS:
 *
 *   1. claim   — lease the event, cross-tenant, as `emil_worker`
 *   2. handle  — in a transaction, INSIDE the event's tenant, subject to RLS
 *   3. settle  — mark DISPATCHED, or record the failure and back off
 *
 * Step 2 and step 3 are separate transactions, and that is deliberate and
 * costly and correct.
 *
 * Doing the work and marking it done in ONE transaction would be exactly-once
 * and is what everybody reaches for first. It cannot be done here: marking the
 * event dispatched is a write to `outbox_event`, which is RLS-forced, and the
 * settle has to happen through a definer function precisely because the relay
 * is cross-tenant. More fundamentally, the moment a handler's work reaches
 * anything outside this database — and the point of these handlers is that it
 * will — a single transaction stops being available at all.
 *
 * So this is AT-LEAST-ONCE, and it says so. If the process dies between step 2
 * and step 3, the work has committed and the event has not been marked, and it
 * will be redelivered when the lease expires. The alternative — settle first,
 * then work — is at-most-once, and loses the work outright on the same crash.
 * For "queue this invoice with the tax authority", doing it twice is a
 * duplicate the upsert absorbs, and not doing it is a compliance failure
 * nobody finds out about. That asymmetry decides it.
 * ---------------------------------------------------------------------------
 */

export interface RelayOptions {
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  readonly maxAttempts?: number;
}

export interface RelayPass {
  readonly claimed: number;
  readonly handled: number;
  readonly skipped: number;
  readonly unroutable: number;
  readonly retried: number;
  readonly deadLettered: number;
}

const EMPTY: RelayPass = {
  claimed: 0, handled: 0, skipped: 0, unroutable: 0, retried: 0, deadLettered: 0,
};

/**
 * One pass over the queue. Returns what happened, so a caller can decide
 * whether to poll again immediately or sleep.
 *
 * Exported and pure of any timing so tests drive it directly. A test that had
 * to start the loop and wait would be slow and flaky, and the interesting
 * behaviour is all in one pass.
 */
export async function relayPass(
  sql: Sql,
  handlers: HandlerRegistry,
  log: Logger,
  options: RelayOptions = {},
): Promise<RelayPass> {
  const events = await claimOutboxBatch(sql, {
    ...(options.batchSize !== undefined ? { limit: options.batchSize } : {}),
    ...(options.leaseSeconds !== undefined ? { leaseSeconds: options.leaseSeconds } : {}),
  });

  if (events.length === 0) return EMPTY;

  const tally = { ...EMPTY, claimed: events.length };

  for (const event of events) {
    const outcome = await dispatch(sql, handlers, log, event, options);
    switch (outcome) {
      case 'HANDLED': tally.handled += 1; break;
      case 'SKIPPED': tally.skipped += 1; break;
      case 'UNROUTABLE': tally.unroutable += 1; break;
      case 'RETRY': tally.retried += 1; break;
      case 'DEAD': tally.deadLettered += 1; break;
    }
  }

  return tally;
}

type Outcome = 'HANDLED' | 'SKIPPED' | 'UNROUTABLE' | 'RETRY' | 'DEAD';

async function dispatch(
  sql: Sql,
  handlers: HandlerRegistry,
  log: Logger,
  event: OutboxEvent,
  options: RelayOptions,
): Promise<Outcome> {
  const handler = handlers[event.eventType];

  if (!handler) {
    /*
     * No handler claims this type. NOT an error, and NOT a silent success.
     *
     * Most of the eight event types emitted today have no consumer yet —
     * `payment.received`, `bill.entered`, `bank.entry.created` are there for
     * notifications and webhooks that do not exist. Retrying them would fill
     * the dead-letter queue with events that are working as intended, and
     * marking them dispatched without comment would lose the fact that
     * something was published and nothing listened.
     *
     * So they are marked dispatched and COUNTED, and the count is reported.
     * The day a handler is added, the events after that point are picked up;
     * the ones before it were consciously dropped, which is the honest
     * description of what happens either way.
     */
    await completeOutboxEvent(sql, event.tenantId, event.id);
    log.debug('outbox: no handler', { eventType: event.eventType, id: event.id });
    return 'UNROUTABLE';
  }

  let result: HandlerResult;

  try {
    result = await withTenant(sql, { tenantId: event.tenantId }, (tx) =>
      handler({
        tx,
        // No `userId`: nobody clicked anything. The handler's writes are
        // attributed to the system, and anything that genuinely requires a
        // human actor must refuse rather than invent one.
        ctx: { tenantId: event.tenantId },
        event,
        log: (message, detail) =>
          log.info(`outbox: ${message}`, { eventType: event.eventType, ...detail }),
      }),
    );
  } catch (error) {
    return settleFailure(sql, log, event, error, options);
  }

  const acknowledged = await completeOutboxEvent(sql, event.tenantId, event.id);

  if (!acknowledged) {
    // The row was no longer PENDING — another worker settled it while this one
    // was working, or an operator intervened. The work has been done twice,
    // which the idempotency rule exists to make harmless. Worth logging: a
    // steady stream of these means the lease is shorter than the handlers.
    log.warn('outbox: acknowledged an event that was already settled', {
      id: event.id,
      eventType: event.eventType,
      attempts: event.attempts,
    });
  }

  if (result.outcome === 'SKIPPED') {
    log.debug('outbox: skipped', { eventType: event.eventType, reason: result.reason });
    return 'SKIPPED';
  }

  return 'HANDLED';
}

async function settleFailure(
  sql: Sql,
  log: Logger,
  event: OutboxEvent,
  error: unknown,
  options: RelayOptions,
): Promise<Outcome> {
  const message = error instanceof Error ? error.message : String(error);
  const permanent = isPermanent(error);

  // A permanent failure skips the backoff schedule entirely: passing an
  // attempt ceiling of zero makes the next `fail_outbox_event` dead-letter it
  // on the spot. Working through eight escalating retries for a document that
  // is missing a TIN buries the one thing somebody needs to see.
  const outcome = await failOutboxEvent(
    sql,
    event.tenantId,
    event.id,
    message,
    permanent ? 0 : (options.maxAttempts ?? 8),
  );

  const detail = {
    id: event.id,
    eventType: event.eventType,
    attempts: event.attempts,
    permanent,
    error: message,
  };

  if (outcome === 'FAILED') {
    log.error('outbox: dead-lettered', detail);
    return 'DEAD';
  }

  log.warn('outbox: will retry', detail);
  return 'RETRY';
}

function isPermanent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { permanent?: unknown }).permanent === true
  );
}
