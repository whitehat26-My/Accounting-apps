import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '@emil/db';
import { relayPass } from '../src/relay.js';
import { handlers } from '../src/handlers/index.js';
import { createTestLogger } from '../src/logger.js';
import type { HandlerRegistry } from '../src/handlers/registry.js';
import { handled, skipped } from '../src/handlers/registry.js';
import {
  createTestDatabase,
  issueInvoiceFor,
  outboxRows,
  releaseLeases,
  seedEInvoiceTenant,
  seedTenant,
  type Tenant,
} from './helpers.js';

let sql: Sql;
let admin: Sql;
let worker: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDatabase('relay');
  sql = db.sql;
  admin = db.admin;
  worker = db.worker;
  drop = db.drop;
}, 120_000);

afterAll(async () => {
  await drop?.();
});

const log = createTestLogger();

const submissions = (t: Tenant) =>
  withTenant(admin, { tenantId: t.tenantId }, (tx) =>
    tx<{ id: string; document_no: string; status: string; attempt_count: number }[]>`
        SELECT id, document_no, status, attempt_count
          FROM einvoice_submission WHERE tenant_id = ${t.tenantId}
    `,
  );

async function emit(t: Tenant, eventType: string, payload: Record<string, unknown> = {}) {
  const [row] = await admin<{ id: string }[]>`
      INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id, payload)
      VALUES (${t.tenantId}, ${eventType}, 'journal_entry', ${randomUUID()},
              ${admin.json(payload as never)})
      RETURNING id
  `;
  return row!.id;
}

// ---------------------------------------------------------------------------
// The gap this whole slice exists to close
// ---------------------------------------------------------------------------

describe('an issued invoice reaches the e-Invoice queue', () => {
  it('queues a submission with no human ever asking for one', async () => {
    /*
     * THE HEADLINE ASSERTION.
     *
     * Before the relay: `issueInvoice` wrote `invoice.issued` to the outbox and
     * nothing read it, so an invoice issued through the API never entered the
     * MyInvois queue. Nothing failed and nothing went red — the compliance
     * summary counted zero submissions and looked exactly like a business that
     * had not invoiced yet.
     *
     * The invoice here is issued through the REAL service, so this also fails
     * if `issueInvoice` ever stops emitting the event.
     */
    const t = await seedEInvoiceTenant(admin, 'Relay Sdn Bhd');
    const invoice = await issueInvoiceFor(sql, t);

    expect(await submissions(t)).toHaveLength(0);

    const pass = await relayPass(worker, handlers, log);

    expect(pass.handled).toBe(1);
    expect(pass.deadLettered).toBe(0);

    const queued = await submissions(t);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ document_no: invoice.invoiceNo, status: 'QUEUED' });

    const events = await outboxRows(admin, t.tenantId);
    expect(events.find((e) => e.eventType === 'invoice.issued')!.status).toBe('DISPATCHED');
  });

  it('is idempotent — a redelivered event re-queues rather than duplicating', async () => {
    // At-least-once is the delivery guarantee, so this is not a hypothetical:
    // a crash between the handler's commit and its acknowledgement produces
    // exactly this, on an ordinary deploy.
    const t = await seedEInvoiceTenant(admin, 'Idem Sdn Bhd');
    await issueInvoiceFor(sql, t);

    await relayPass(worker, handlers, log);

    // Put the same event back, as a lease expiry would.
    await admin`
        UPDATE outbox_event SET status = 'PENDING', dispatched_at = NULL,
                                available_at = now() - INTERVAL '1 second'
         WHERE tenant_id = ${t.tenantId} AND event_type = 'invoice.issued'
    `;

    await relayPass(worker, handlers, log);

    // ONE submission, not two. The unique constraint on
    // (tenant_id, document_type, document_id) is what makes that true.
    expect(await submissions(t)).toHaveLength(1);
  });

  it('skips a tenant that has not enabled e-Invoice, without dead-lettering it', async () => {
    // Most Malaysian SMEs below the mandate threshold will never enable this.
    // Retrying their every invoice eight times before giving up would turn an
    // ordinary configuration into a queue full of red.
    const t = await seedTenant(admin, 'Disabled Sdn Bhd');
    await issueInvoiceFor(sql, t, { classificationCode: null });

    const pass = await relayPass(worker, handlers, log);

    expect(pass.skipped).toBeGreaterThanOrEqual(1);
    expect(pass.deadLettered).toBe(0);
    expect(
      (await outboxRows(admin, t.tenantId)).every((e) => e.status === 'DISPATCHED'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe('failures', () => {
  it('retries a transient failure with backoff, then dead-letters it', async () => {
    const t = await seedTenant(admin, 'Transient Sdn Bhd');
    const id = await emit(t, 'test.transient');

    const failing: HandlerRegistry = {
      'test.transient': async () => {
        throw new Error('the network was down');
      },
    };

    // First failure: retried, with `available_at` pushed into the future.
    const first = await relayPass(worker, failing, log, { maxAttempts: 3 });
    expect(first.retried).toBe(1);

    const [afterFirst] = await outboxRows(admin, t.tenantId);
    expect(afterFirst!.status).toBe('PENDING');
    expect(afterFirst!.lastError).toBe('the network was down');

    // The backoff is real: without releasing the lease, the next pass finds
    // nothing. That is the assertion — a queue that retried immediately would
    // hammer a failing dependency at full speed.
    expect((await relayPass(worker, failing, log, { maxAttempts: 3 })).claimed).toBe(0);

    for (let attempt = 0; attempt < 3; attempt++) {
      await releaseLeases(admin);
      await relayPass(worker, failing, log, { maxAttempts: 3 });
    }

    const [dead] = await outboxRows(admin, t.tenantId);
    expect(dead!.id).toBe(id);
    expect(dead!.status).toBe('FAILED');
    expect(dead!.attempts).toBeGreaterThanOrEqual(3);
  });

  it('dead-letters a PERMANENT failure immediately, skipping the backoff', async () => {
    /*
     * An invoice with no valid classification code fails validation the same
     * way on every attempt, an hour further apart each time. Working through
     * the full retry schedule would leave it PENDING for most of a day — so the
     * queue looks busy rather than broken, and the one thing somebody needs to
     * see is the thing they cannot.
     */
    const t = await seedEInvoiceTenant(admin, 'Permanent Sdn Bhd');
    await issueInvoiceFor(sql, t, { classificationCode: null });

    const pass = await relayPass(worker, handlers, log, { maxAttempts: 8 });

    expect(pass.deadLettered).toBe(1);

    const [event] = await outboxRows(admin, t.tenantId);
    expect(event!.status).toBe('FAILED');
    // One attempt, not eight.
    expect(event!.attempts).toBe(1);
    expect(event!.lastError).toMatch(/cannot be submitted/);
  });

  it('records the failure even though the handler transaction rolled back', async () => {
    // The failure is written OUTSIDE the handler's transaction on purpose.
    // Writing it inside would roll back with the handler, leaving an event that
    // fails silently and forever with no record of why.
    const t = await seedTenant(admin, 'Rollback Sdn Bhd');
    await emit(t, 'test.writes-then-throws');

    const registry: HandlerRegistry = {
      'test.writes-then-throws': async ({ tx, ctx }) => {
        await tx`
            INSERT INTO account (tenant_id, code, name, type)
            VALUES (${ctx.tenantId}, '9999', 'Should not survive', 'ASSET')
        `;
        throw new Error('after writing');
      },
    };

    await relayPass(worker, registry, log);

    const [event] = await outboxRows(admin, t.tenantId);
    expect(event!.lastError).toBe('after writing');

    // The handler's write is gone; the failure record is not.
    const [account] = await admin<{ id: string }[]>`
        SELECT id FROM account WHERE tenant_id = ${t.tenantId} AND code = '9999'
    `;
    expect(account).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('events with no handler', () => {
  it('are counted as unroutable, dispatched rather than retried forever', async () => {
    // Six of the eight event types emitted today have no consumer. They must
    // not accumulate as failures — they are working as intended — and they must
    // not vanish without the fact being reported.
    const t = await seedTenant(admin, 'Unrouted Sdn Bhd');
    await emit(t, 'payment.received', { paymentNo: 'PAY-00001' });
    await emit(t, 'bank.entry.created', {});

    const pass = await relayPass(worker, handlers, log);

    expect(pass.unroutable).toBe(2);
    expect(pass.deadLettered).toBe(0);
    expect((await outboxRows(admin, t.tenantId)).every((e) => e.status === 'DISPATCHED')).toBe(true);
  });

  it('does not register a handler for debitnote.issued', () => {
    // Deliberate: MyInvois has a DEBIT_NOTE type but M6 never built the
    // document mapping, and guessing at the field semantics of a submission to
    // a tax authority is exactly what CLAUDE.md forbids. Asserted so that
    // adding one is a conscious act rather than a drive-by.
    expect(Object.keys(handlers)).toEqual(['invoice.issued', 'creditnote.issued']);
  });
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('runs the handler INSIDE the event’s tenant, even though the claim is global', async () => {
    /*
     * The relay claims across every tenant — that is what a relay is. The
     * privilege has to stop at the claim, or one confused handler turns the
     * whole outbox into a cross-tenant read.
     */
    const mine = await seedTenant(admin, 'Handler Mine Sdn Bhd');
    const theirs = await seedTenant(admin, 'Handler Theirs Sdn Bhd');
    await emit(mine, 'test.counts-accounts');

    let visibleTenants: string[] = [];

    const registry: HandlerRegistry = {
      'test.counts-accounts': async ({ tx }) => {
        const rows = await tx<{ tenant_id: string }[]>`
            SELECT DISTINCT tenant_id FROM account
        `;
        visibleTenants = rows.map((r) => r.tenant_id);
        return handled();
      },
    };

    await relayPass(worker, registry, log);

    expect(visibleTenants).toEqual([mine.tenantId]);
    expect(visibleTenants).not.toContain(theirs.tenantId);
  });

  it('gives the handler no user, so nothing can be attributed to a person', async () => {
    // Nobody clicked anything. A handler that needs a human actor must refuse
    // rather than borrow one — a system-posted entry attributed to whoever
    // happened to issue the invoice is a lie in the audit trail.
    const t = await seedTenant(admin, 'NoUser Sdn Bhd');
    await emit(t, 'test.inspects-ctx');

    let seenUserId: unknown = 'unset';

    await relayPass(
      worker,
      {
        'test.inspects-ctx': async ({ ctx }) => {
          seenUserId = ctx.userId;
          return skipped('inspection only');
        },
      },
      log,
    );

    expect(seenUserId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('two workers', () => {
  it('never hand the same event to both, because of SKIP LOCKED', async () => {
    /*
     * The property the whole claim design rests on. Without SKIP LOCKED the
     * second worker blocks behind the first — correct but serialised, so
     * scaling out buys nothing — and without the lock at all both process
     * every event.
     */
    const t = await seedTenant(admin, 'Concurrent Sdn Bhd');
    for (let i = 0; i < 20; i++) await emit(t, 'test.concurrent', { i });

    const seen: string[] = [];
    const registry: HandlerRegistry = {
      'test.concurrent': async ({ event }) => {
        seen.push(event.id);
        return handled();
      },
    };

    const [a, b] = await Promise.all([
      relayPass(worker, registry, log, { batchSize: 20 }),
      relayPass(worker, registry, log, { batchSize: 20 }),
    ]);

    expect(a!.claimed + b!.claimed).toBe(20);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(20);
  });
});
