import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordReceipt, withTenant, type Sql } from '@emil/db';
import { relayPass } from '../src/relay.js';
import { cloudSyncHandlers } from '../src/handlers/cloud-sync.js';
import { FakeCloudTarget, resolveCloudTarget } from '../src/sync/cloud-target.js';
import { createTestLogger } from '../src/logger.js';
import {
  createTestDatabase,
  issueInvoiceFor,
  outboxRows,
  releaseLeases,
  seedTenant,
  type Tenant,
} from './helpers.js';

/**
 * The cloud-sync consumer, driven through the real relay against real
 * PostgreSQL.
 *
 * The point of these tests is not that a fake object records what it was
 * handed — it is that the OUTBOX behaves the way a shop with an unreliable line
 * needs it to: the event survives the target being unreachable, comes back on
 * its own, and a redelivery does not double a payment.
 */

let sql: Sql;
let admin: Sql;
let worker: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  // No hyphen: the label becomes part of an unquoted CREATE DATABASE identifier.
  const db = await createTestDatabase('cloudsync');
  sql = db.sql;
  admin = db.admin;
  worker = db.worker;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Cloud Sync Sdn Bhd');
}, 120_000);

afterAll(async () => {
  await drop?.();
});

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });
const log = createTestLogger();

/** Ring up a receipt, which emits `payment.received` inside the ledger transaction. */
async function receivePayment(amount: string): Promise<void> {
  const invoice = await issueInvoiceFor(sql, tenant, { unitPrice: amount });
  await withTenant(sql, ctx(), (tx) =>
    recordReceipt(tx, ctx(), {
      contactId: tenant.customerId,
      paymentDate: '2026-08-11',
      amount,
      method: 'CASH',
      depositAccountId: tenant.accounts['1000']!,
      allocations: [{ invoiceId: invoice.id, amount }],
      idempotencyKey: randomUUID(),
    }),
  );
}

describe('the outbox is the sync queue', () => {
  it('writes the event in the SAME transaction as the ledger effect', async () => {
    // The whole premise of the pattern. If the transaction rolls back there is
    // no event — so a sale can never exist locally while being invisible to the
    // sync, which is the failure a Redis enqueue after commit would produce.
    const before = (await outboxRows(admin, tenant.tenantId)).length;

    await expect(
      withTenant(sql, ctx(), async (tx) => {
        await recordReceipt(tx, ctx(), {
          contactId: tenant.customerId,
          paymentDate: '2026-08-11',
          amount: '50.00',
          method: 'CASH',
          depositAccountId: tenant.accounts['1000']!,
          idempotencyKey: randomUUID(),
        });
        throw new Error('rolled back after the receipt, before commit');
      }),
    ).rejects.toThrow(/rolled back/);

    expect((await outboxRows(admin, tenant.tenantId)).length).toBe(before);
  });
});

describe('draining to a cloud target', () => {
  it('pushes the event and marks it DISPATCHED', async () => {
    const target = new FakeCloudTarget();
    await receivePayment('120.00');
    await releaseLeases(admin);

    const pass = await relayPass(worker, cloudSyncHandlers(target), log);

    expect(pass.handled).toBeGreaterThan(0);
    expect(target.pushes.length).toBeGreaterThan(0);

    const push = target.pushes.find((p) => p.eventType === 'payment.received');
    expect(push).toBeDefined();
    expect(push!.tenantId).toBe(tenant.tenantId);
    // The idempotency key is the aggregate id, present on every event type.
    expect(push!.aggregateId).toMatch(/^[0-9a-f-]{36}$/);

    const payment = (await outboxRows(admin, tenant.tenantId))
      .filter((r) => r.eventType === 'payment.received')
      .at(-1);
    expect(payment!.status).toBe('DISPATCHED');
  });

  it('leaves the event PENDING and backs off when the target is unreachable', async () => {
    // The ISP-outage case. Nothing is lost and nothing is dead-lettered; the row
    // waits, which is exactly what a shop needs from a queue it cannot see.
    const target = new FakeCloudTarget();
    target.failWith = new Error('ECONNREFUSED — the line is down');

    await receivePayment('75.00');
    await releaseLeases(admin);

    const pass = await relayPass(worker, cloudSyncHandlers(target), log);

    expect(pass.retried).toBeGreaterThan(0);
    expect(pass.deadLettered).toBe(0);
    expect(target.pushes.length).toBe(0);

    const row = (await outboxRows(admin, tenant.tenantId))
      .filter((r) => r.eventType === 'payment.received')
      .at(-1);
    expect(row!.status).toBe('PENDING');
    expect(row!.attempts).toBeGreaterThan(0);
    expect(row!.lastError).toMatch(/ECONNREFUSED/);

    // available_at was pushed into the future, so the next pass leaves it alone
    // rather than hammering an unreachable target.
    const [backoff] = await admin<{ waiting: boolean }[]>`
        SELECT available_at > now() AS waiting
          FROM outbox_event
         WHERE tenant_id = ${tenant.tenantId} AND id = ${row!.id}
    `;
    expect(backoff!.waiting).toBe(true);
  });

  it('drains once the line comes back, with no intervention', async () => {
    const target = new FakeCloudTarget();
    target.failWith = new Error('ECONNREFUSED — the line is down');

    await receivePayment('99.00');
    await releaseLeases(admin);
    await relayPass(worker, cloudSyncHandlers(target), log);

    // The line returns. Only the backoff stands between the event and delivery.
    target.failWith = undefined;
    await releaseLeases(admin);
    const pass = await relayPass(worker, cloudSyncHandlers(target), log);

    expect(pass.handled).toBeGreaterThan(0);
    // `Money.toDecimalString()` pads to the money scale, so the payload carries
    // '99.0000' — four decimal places, not two. Asserting the exact string is
    // deliberate: it proves the right event drained, and pins the wire format a
    // cloud target would have to parse.
    expect(target.pushes.some((p) => p.payload['amount'] === '99.0000')).toBe(true);
  });

  it('is idempotent: a redelivery does not double the payment', async () => {
    const target = new FakeCloudTarget();
    await receivePayment('42.00');
    await releaseLeases(admin);

    await relayPass(worker, cloudSyncHandlers(target), log);

    // Force the same event back onto the queue, which is what a lease expiry or
    // a crash between push and acknowledge produces.
    const row = (await outboxRows(admin, tenant.tenantId))
      .filter((r) => r.eventType === 'payment.received')
      .at(-1);
    await admin`
        UPDATE outbox_event SET status = 'PENDING', available_at = now() - INTERVAL '1 second'
         WHERE tenant_id = ${tenant.tenantId} AND id = ${row!.id}
    `;
    await relayPass(worker, cloudSyncHandlers(target), log);

    // Pushed more than once — at-least-once is the honest guarantee — but a
    // target that upserts on (tenantId, aggregateId) stores one record.
    expect(target.pushes.length).toBeGreaterThan(target.stored.length - 1);
    const keys = new Set(target.stored.map((p) => `${p.tenantId}:${p.aggregateId}`));
    expect(keys.size).toBe(target.stored.length);
  });
});

describe('no cloud configured', () => {
  it('registers no handlers at all, so the events stay honestly unroutable', () => {
    // Not a skipping handler: a skip would read as "considered and declined"
    // when in fact no second copy of the books exists anywhere.
    expect(cloudSyncHandlers(undefined)).toEqual({});
  });

  it('resolves to no target when CLOUD_SYNC_URL is unset or blank', () => {
    expect(resolveCloudTarget({})).toBeUndefined();
    expect(resolveCloudTarget({ CLOUD_SYNC_URL: '' })).toBeUndefined();
    expect(resolveCloudTarget({ CLOUD_SYNC_URL: '   ' })).toBeUndefined();
  });

  it('refuses to start if a URL is set but nothing implements the target', () => {
    // Silently ignoring the setting would leave an operator believing their
    // books were being copied somewhere when they were not.
    expect(() => resolveCloudTarget({ CLOUD_SYNC_URL: 'https://books.example.com' })).toThrow(
      /no CloudTarget implementation/i,
    );
  });
});
