/**
 * Where a synced event goes when it leaves this building.
 *
 * ---------------------------------------------------------------------------
 * AN INTERFACE AND A FAKE, BECAUSE THERE IS NO CLOUD YET.
 *
 * A shop that keeps selling through an ISP outage does not need a cloud copy of
 * its books to do it — the whole stack is on the counter's own LAN, and the
 * owner watches the real system from home over Tailscale. Cloud sync answers a
 * different question ("what if the shop burns down"), and the nightly `pg_dump`
 * to a synced folder already answers that more simply.
 *
 * So this ships as the plumbing and nothing more: an interface the relay can
 * drive, and a fake that records what it was handed. Writing a real HTTP client
 * against a service that does not exist would be untested code pretending to be
 * a feature, and the one thing worse than no second copy of the books is a
 * second copy that silently disagrees with the first.
 *
 * When there IS a target, implementing this interface and returning it from
 * `resolveCloudTarget` is the whole change. Nothing in the relay moves.
 * ---------------------------------------------------------------------------
 */

/**
 * One outbox event, flattened for transport.
 *
 * `aggregateId` is the idempotency key, and it is the right one for EVERY event
 * type rather than a per-type guess: it is the journal entry the event was
 * emitted alongside, it is on the row already, and it is stable across
 * redeliveries. The business identifier (`invoiceNo`, `paymentNo`) travels
 * inside `payload` and is NOT reliable for this — the payload shape differs by
 * event type, and two tenants can both hold `INV-00001`.
 */
export interface CloudSyncRecord {
  readonly tenantId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

export interface CloudTarget {
  /** Named so a log line says where an event went, or failed to go. */
  readonly name: string;

  /**
   * Push one record.
   *
   * MUST be idempotent on `(tenantId, aggregateId)` at the far end. The relay
   * guarantees at-least-once and nothing stronger: a lease can expire while a
   * push is in flight, the process can die between the push and the
   * acknowledgement, and either way the same record arrives twice. A target
   * that inserts blindly will double-count a sale.
   *
   * Throw to retry — the relay backs off (2^attempts seconds, capped at an
   * hour) and dead-letters after eight attempts, so a week-long outage costs
   * nothing but a queue that drains when the line returns.
   */
  push(record: CloudSyncRecord): Promise<void>;
}

/**
 * A target that remembers instead of sending. Test double, and the reference
 * implementation of the contract above.
 */
export class FakeCloudTarget implements CloudTarget {
  readonly name = 'fake';

  /** Every push in arrival order, including redeliveries. */
  readonly pushes: CloudSyncRecord[] = [];

  /** Set to make the next push throw, standing in for an unreachable target. */
  failWith: Error | undefined;

  async push(record: CloudSyncRecord): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith;
    this.pushes.push(record);
  }

  /**
   * What a correctly-implemented target would have stored: last write wins per
   * `(tenantId, aggregateId)`. Lets a test assert that N redeliveries of one
   * event still amount to a single record at the far end.
   */
  get stored(): CloudSyncRecord[] {
    const byKey = new Map<string, CloudSyncRecord>();
    for (const record of this.pushes) {
      byKey.set(`${record.tenantId}:${record.aggregateId}`, record);
    }
    return [...byKey.values()];
  }
}

/**
 * The configured target, or `undefined` when there is none.
 *
 * `undefined` is the normal state and is not a degraded one: with no cloud
 * configured the sync handlers are not registered at all, so the events they
 * would have taken keep reporting as *unroutable* — which is the truthful
 * signal that nothing consumes them. See `handlers/index.ts`.
 *
 * Reads `process.env` directly rather than `WorkerConfig` on purpose: this is
 * an optional egress integration, and threading it through the config schema
 * would make a missing value look like a misconfiguration instead of the
 * default.
 */
export function resolveCloudTarget(env: NodeJS.ProcessEnv = process.env): CloudTarget | undefined {
  const url = env['CLOUD_SYNC_URL']?.trim();
  if (url === undefined || url === '') return undefined;

  throw new Error(
    `CLOUD_SYNC_URL is set to "${url}" but no CloudTarget implementation exists yet. ` +
      'Implement the CloudTarget interface in apps/worker/src/sync/ and return it here. ' +
      'Refusing to start is deliberate: silently ignoring the setting would leave an ' +
      'operator believing their books were being copied somewhere when they were not.',
  );
}
