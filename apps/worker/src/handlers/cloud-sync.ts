import { handled, type Handler, type HandlerRegistry } from './registry.js';
import { PermanentHandlerError } from './einvoice.js';
import type { CloudTarget } from '../sync/cloud-target.js';

/**
 * Copy an outbox event to a second system, off this machine.
 *
 * ---------------------------------------------------------------------------
 * THE EVENT IS ALREADY THE SYNC QUEUE. THERE IS NOTHING TO ADD.
 *
 * The obvious design is a `SYNC_TO_CLOUD` event type written alongside the
 * business write. It is unnecessary: `postJournalEntry` already emits
 * `invoice.issued`, `payment.received` and seven others INSIDE the transaction
 * that posts the ledger, so the queue of things-that-happened exists and is
 * already transactional. A second event type would be a second row saying the
 * same thing, with its own chance to disagree.
 *
 * So a cloud consumer is an ordinary handler. Offline is not a special case:
 * the row simply sits in `outbox_event` at `status='PENDING'` until something
 * drains it, which is the behaviour an ISP outage needs and the behaviour a
 * healthy line gets too.
 *
 * WHAT MUST NEVER BE SYNCED THIS WAY — and this is the trap, because it looks
 * like it works. Do not push `audit_log` or `journal_entry` rows for the far
 * end to INSERT. The receiving database runs the same triggers this one does:
 * `audit_log_chain` recomputes `prev_hash`/`row_hash` on insert and, since
 * migration 0052, FORCES the actor columns from the inserting session. The
 * copy's hashes would differ from the originals and `verify_audit_chain` would
 * report tampering that the sync itself caused. A ledger is replicated as
 * BYTES, not as statements — logical replication, or `pg_dump` plus the proof
 * packs `scripts/verify-proof-pack.mjs` verifies offline. This handler carries
 * business events, never ledger rows.
 * ---------------------------------------------------------------------------
 *
 * IDEMPOTENT, as every handler must be: the record is keyed on `aggregateId`,
 * and `CloudTarget.push` is contracted to upsert on it. A redelivery overwrites
 * rather than doubling a sale.
 */
const syncToCloud = (target: CloudTarget): Handler =>
  async ({ event, log }) => {
    // The relay hands over `payload` as JSONB. A non-object means the emitter
    // wrote something it should not have, which eight retries an hour apart
    // will not improve — so it dead-letters immediately and stays visible.
    if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
      throw new PermanentHandlerError(
        `${event.eventType}: payload is not an object, so there is nothing to sync ` +
          `(got ${JSON.stringify(event.payload)})`,
      );
    }

    await target.push({
      tenantId: event.tenantId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
    });

    log('synced', { target: target.name, aggregateId: event.aggregateId });
    return handled({ target: target.name, aggregateId: event.aggregateId });
  };

/**
 * The events a cloud copy takes, or nothing at all.
 *
 * Returning `{}` when there is no target is the load-bearing part. Registering
 * a handler that skipped would turn these events from *unroutable* — the honest
 * "nothing consumes this" — into *skipped*, which reads as "considered and
 * declined". The queue would look attended to while no second copy existed.
 *
 * Only events that are safe to carry as business facts appear here. Nothing
 * that would make the far end recompute a hash chain; see the note above.
 */
export const cloudSyncHandlers = (target: CloudTarget | undefined): HandlerRegistry => {
  if (target === undefined) return {};

  const sync = syncToCloud(target);
  return {
    'payment.received': sync,
    'payment.sent': sync,
    'bill.entered': sync,
    'gateway.settled': sync,
  };
};
