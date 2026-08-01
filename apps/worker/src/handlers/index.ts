import { einvoiceHandlers } from './einvoice.js';
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
 * ---------------------------------------------------------------------------
 */
export const handlers: HandlerRegistry = {
  ...einvoiceHandlers,
};

export * from './registry.js';
