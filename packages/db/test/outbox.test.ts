import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql, type TenantContext } from '../src/client.js';
import {
  allTenantIds,
  claimDueJobs,
  claimOutboxBatch,
  completeOutboxEvent,
  failOutboxEvent,
  queueHealth,
  scheduledJobs,
} from '../src/outbox.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let worker: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDatabase('outbox');
  sql = db.sql;
  admin = db.admin;
  worker = db.worker;
  drop = db.drop;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

async function emit(t: Tenant, type = 'test.event', payload: Record<string, unknown> = {}) {
  const [row] = await admin<{ id: string }[]>`
      INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id, payload)
      VALUES (${t.tenantId}, ${type}, 'journal_entry', ${randomUUID()},
              ${admin.json(payload as never)})
      RETURNING id
  `;
  return row!.id;
}

const statusOf = async (id: string) => {
  const [row] = await admin<{ status: string; attempts: number; available_at: Date }[]>`
      SELECT status, attempts, available_at FROM outbox_event WHERE id = ${id}
  `;
  return row!;
};

// ---------------------------------------------------------------------------
// The privileged surface, and its boundary
// ---------------------------------------------------------------------------

describe('the relay is the one thing that crosses tenants', () => {
  it('claims across every tenant with no tenant context set', async () => {
    const a = await seedTenant(admin, 'Outbox A Sdn Bhd');
    const b = await seedTenant(admin, 'Outbox B Sdn Bhd');
    await emit(a);
    await emit(b);

    const claimed = await claimOutboxBatch(worker, { limit: 50 });
    const tenants = new Set(claimed.map((e) => e.tenantId));

    expect(tenants.has(a.tenantId)).toBe(true);
    expect(tenants.has(b.tenantId)).toBe(true);
  });

  it('is NOT reachable from the role the API connects as', async () => {
    /*
     * The assertion that keeps the escape hatch an escape hatch.
     *
     * `claim_outbox_batch` is SECURITY DEFINER and sees every tenant's events —
     * that is what a relay is. Granting it to `emil_app`, the role serving
     * internet traffic, would put a cross-tenant read one confused code path
     * away. So the GRANT is to `emil_worker` alone, and this fails if somebody
     * widens it.
     */
    await expect(claimOutboxBatch(sql, { limit: 1 })).rejects.toThrow(/permission denied/i);
    await expect(allTenantIds(sql)).rejects.toThrow(/permission denied/i);
    await expect(claimDueJobs(sql)).rejects.toThrow(/permission denied/i);
  });

  it('lists every organisation, which RLS makes impossible to do directly', async () => {
    // The worker CAN call the function and still CANNOT read the table, which
    // is the whole shape of the design: the privileged surface is a list of
    // identifiers, not the data behind them.
    const ids = await allTenantIds(worker);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    const direct = await worker<{ id: string }[]>`SELECT id FROM organisation`;
    expect(direct).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

describe('claiming leases rather than deleting', () => {
  it('makes a claimed event invisible until its lease expires', async () => {
    const t = await seedTenant(admin, 'Lease Sdn Bhd');
    const id = await emit(t);

    const first = await claimOutboxBatch(worker, { limit: 50, leaseSeconds: 300 });
    expect(first.map((e) => e.id)).toContain(id);

    const second = await claimOutboxBatch(worker, { limit: 50 });
    expect(second.map((e) => e.id)).not.toContain(id);

    const row = await statusOf(id);
    expect(row.status).toBe('PENDING');
    expect(row.available_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('releases it again when the lease expires, so a crash is survivable', async () => {
    // The alternative — marking it in-flight with no expiry — strands the event
    // forever behind a process that no longer exists.
    const t = await seedTenant(admin, 'Expiry Sdn Bhd');
    const id = await emit(t);

    await claimOutboxBatch(worker, { limit: 50, leaseSeconds: 300 });
    await admin`UPDATE outbox_event SET available_at = now() - INTERVAL '1 second' WHERE id = ${id}`;

    const again = await claimOutboxBatch(worker, { limit: 50 });
    expect(again.map((e) => e.id)).toContain(id);
    // Counted, so an event that crashes the worker every time still runs out
    // of attempts rather than poisoning the queue in a loop no counter escapes.
    expect((await statusOf(id)).attempts).toBe(2);
  });

  it('refuses an absurd batch size instead of scanning the table', async () => {
    await expect(claimOutboxBatch(worker, { limit: 100_000 })).rejects.toThrow(
      /between 1 and 1000/,
    );
  });
});

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

describe('settling an event', () => {
  it('marks it dispatched exactly once', async () => {
    const t = await seedTenant(admin, 'Settle Sdn Bhd');
    const id = await emit(t);
    await claimOutboxBatch(worker, { limit: 50 });

    expect(await completeOutboxEvent(worker, t.tenantId, id)).toBe(true);
    // The second call reports false rather than silently succeeding — which is
    // how the relay notices another worker settled it first.
    expect(await completeOutboxEvent(worker, t.tenantId, id)).toBe(false);
    expect((await statusOf(id)).status).toBe('DISPATCHED');
  });

  it('backs off exponentially and eventually dead-letters', async () => {
    const t = await seedTenant(admin, 'Backoff Sdn Bhd');
    const id = await emit(t);

    let outcome = '';
    let previousDelay = -1;

    for (let attempt = 0; attempt < 4; attempt++) {
      await admin`UPDATE outbox_event SET available_at = now() - INTERVAL '1 second' WHERE id = ${id}`;
      await claimOutboxBatch(worker, { limit: 50 });
      outcome = await failOutboxEvent(worker, t.tenantId, id, 'boom', 4);

      if (outcome === 'RETRY') {
        const row = await statusOf(id);
        const delay = row.available_at.getTime() - Date.now();
        // 2^attempts, so strictly increasing. A flat retry interval hammers a
        // failing dependency at full speed for as long as it is down.
        expect(delay).toBeGreaterThan(previousDelay);
        previousDelay = delay;
      }
    }

    expect(outcome).toBe('FAILED');
    const row = await statusOf(id);
    expect(row.status).toBe('FAILED');
    // Kept, never deleted: a dead letter is the evidence for why something
    // downstream never happened.
    expect(row.attempts).toBe(4);
  });

  it('dead-letters immediately when the caller says the failure is permanent', async () => {
    const t = await seedTenant(admin, 'Permanent Sdn Bhd');
    const id = await emit(t);
    await claimOutboxBatch(worker, { limit: 50 });

    expect(await failOutboxEvent(worker, t.tenantId, id, 'invalid document', 0)).toBe('FAILED');
    expect((await statusOf(id)).attempts).toBe(1);
  });

  it('reports UNKNOWN for an event that does not exist', async () => {
    const t = await seedTenant(admin, 'Ghost Sdn Bhd');
    expect(await failOutboxEvent(worker, t.tenantId, randomUUID(), 'x')).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// The tenant-facing view
// ---------------------------------------------------------------------------

describe('queueHealth', () => {
  it('shows a tenant its own stuck work and nobody else’s', async () => {
    const mine = await seedTenant(admin, 'Health Mine Sdn Bhd');
    const theirs = await seedTenant(admin, 'Health Theirs Sdn Bhd');

    await admin`
        INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id,
                                  payload, status, attempts, last_error)
        VALUES (${mine.tenantId}, 'test.dead', 'journal_entry', ${randomUUID()},
                '{}'::jsonb, 'FAILED', 8, 'gave up'),
               (${theirs.tenantId}, 'test.dead', 'journal_entry', ${randomUUID()},
                '{}'::jsonb, 'FAILED', 8, 'not yours')
    `;

    const ctx: TenantContext = { tenantId: mine.tenantId };
    const health = await withTenant(sql, ctx, (tx) => queueHealth(tx, ctx));

    expect(health.outbox.failed).toBe(1);
    expect(health.deadLettered).toHaveLength(1);
    expect(health.deadLettered[0]!.lastError).toBe('gave up');
  });

  it('counts events pending for over an hour separately from pending', async () => {
    // A healthy queue is pending-but-moving. Pending-and-not-moving is the only
    // kind worth waking somebody for, and conflating them means an alert that
    // fires on every busy afternoon.
    const t = await seedTenant(admin, 'Stalled Sdn Bhd');
    await emit(t, 'test.fresh');
    await admin`
        INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id,
                                  payload, created_at)
        VALUES (${t.tenantId}, 'test.old', 'journal_entry', ${randomUUID()},
                '{}'::jsonb, now() - INTERVAL '4 hours')
    `;

    const ctx: TenantContext = { tenantId: t.tenantId };
    const health = await withTenant(sql, ctx, (tx) => queueHealth(tx, ctx));

    expect(health.outbox.pending).toBe(2);
    expect(health.outbox.stalledOverAnHour).toBe(1);
    expect(health.outbox.oldestPendingSeconds).toBeGreaterThan(3_000);
  });
});

describe('scheduledJobs', () => {
  it('reports the schedule seeded by the migration', async () => {
    const tenantId = (await allTenantIds(worker))[0]!;
    const rows = await withTenant(sql, { tenantId }, (tx) => scheduledJobs(tx));

    expect(rows.map((r) => r.name).sort()).toEqual([
      'einvoice-retry',
      'outbox-sweep',
      'payment-reminders',
      'rollup-drift',
      'weekly-digest',
    ]);
    // Job names and timings only — no tenant data — which is why an ordinary
    // read grant is enough and no definer function is involved.
    expect(rows.every((r) => r.isEnabled)).toBe(true);
  });
});
