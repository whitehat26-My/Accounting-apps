import type { OutboxEvent, TenantContext, Tx } from '@emil/db';

/**
 * What a handler is, and the two rules it lives under.
 *
 * ---------------------------------------------------------------------------
 * 1. A HANDLER MUST BE IDEMPOTENT.
 *
 * At-least-once delivery is not a shortcut here, it is the only honest option:
 * the alternative is acknowledging before the work commits, which loses the
 * work when the process dies in between. So a handler WILL occasionally run
 * twice — after a lease expiry, after a crash between commit and acknowledge —
 * and it must produce the same result the second time.
 *
 * In practice that means every write a handler makes is either an upsert, or
 * guarded by a uniqueness constraint, or carries an idempotency key. It is not
 * a style preference; a handler that posts a journal entry without one posts it
 * twice, and the ledger is append-only, so nobody can take it back.
 *
 * 2. A HANDLER RUNS INSIDE THE EVENT'S TENANT.
 *
 * It receives a `Tx` already inside `withTenant`, so RLS applies exactly as it
 * does to a request. The relay's cross-tenant privilege stops at the claim: a
 * handler cannot see another tenant's rows even though the process that called
 * it can enumerate every tenant's events.
 * ---------------------------------------------------------------------------
 */
export interface HandlerContext {
  readonly tx: Tx;
  readonly ctx: TenantContext;
  readonly event: OutboxEvent;
  readonly log: (message: string, detail?: Record<string, unknown>) => void;
}

/**
 * The outcome of handling an event.
 *
 *  - `HANDLED`  — the work was done.
 *  - `SKIPPED`  — the work does not apply here and never will. A tenant with
 *                 e-Invoice disabled is not a failure to retry; it is an answer.
 *                 Carrying a reason matters: "nothing happened" and "nothing
 *                 needed to happen" look identical in a queue that only records
 *                 success.
 *
 * Anything genuinely wrong THROWS, and the relay decides retry versus dead
 * letter. A handler does not get to swallow its own failure — that is how a
 * queue ends up reporting perfect health while doing nothing.
 */
export type HandlerResult =
  | { readonly outcome: 'HANDLED'; readonly detail?: Record<string, unknown> }
  | { readonly outcome: 'SKIPPED'; readonly reason: string };

export const handled = (detail?: Record<string, unknown>): HandlerResult =>
  detail ? { outcome: 'HANDLED', detail } : { outcome: 'HANDLED' };

export const skipped = (reason: string): HandlerResult => ({ outcome: 'SKIPPED', reason });

export type Handler = (context: HandlerContext) => Promise<HandlerResult>;

export type HandlerRegistry = Readonly<Record<string, Handler>>;
