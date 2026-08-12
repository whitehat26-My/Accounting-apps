import { einvoiceHandlers } from './einvoice.js';
import { cloudSyncHandlers } from './cloud-sync.js';
import { resolveCloudTarget } from '../sync/cloud-target.js';
import type { HandlerRegistry } from './registry.js';

/**
 * Every handler the relay knows about.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE.
 *
 * Eight event types are emitted to the outbox today. Two are handled. The
 * other six — `payment.received`, `payment.sent`, `bill.entered`,
 * `bank.entry.created`, `gateway.settled`, `debitnote.issued` — have no
 * consumer, and the relay reports them as unroutable rather than pretending.
 *
 * That is the honest state, and it is better than the alternatives. Five of
 * them are waiting on notifications and webhooks, neither of which exists:
 * there is no email transport, no webhook registration, no delivery log, and a
 * handler for "tell the customer their payment arrived" that logged a line
 * would look finished while telling nobody anything. `debitnote.issued` is
 * waiting on a MyInvois document mapping that M6 never built and that must not
 * be guessed — see the note in `einvoice.ts`.
 *
 * A registry that quietly grew a no-op entry for each of these would report a
 * fully-consumed queue. The count of unroutable events is the more useful
 * number, and it is in every pass summary.
 *
 * CLOUD SYNC IS REGISTERED ONLY WHEN A TARGET EXISTS. `cloudSyncHandlers`
 * returns `{}` when `resolveCloudTarget` finds none, which is the default. That
 * is the same principle as the paragraph above: a handler that existed and
 * skipped would move four of those events from *unroutable* to *skipped*, and
 * "nothing consumes this" would start reading as "considered and declined"
 * while no second copy of the books existed anywhere.
 * ---------------------------------------------------------------------------
 */
export const handlers: HandlerRegistry = {
  ...einvoiceHandlers,
  ...cloudSyncHandlers(resolveCloudTarget()),
};

export * from './registry.js';
