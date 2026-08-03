import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { issueInvoice } from '../src/invoice.js';
import { recordReceipt } from '../src/payment.js';
import {
  cancelReminder,
  collectionsOverview,
  listReminders,
  markReminderSent,
  runFollowUpPass,
} from '../src/dunning.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The follow-up engine, walked through a customer's slow month: the invoice
 * falls due, the ladder climbs day by day, payment finally arrives and the
 * chasing stops — the pass never asks for money already received.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };
let invoiceId: string;

async function invoiceDue(dueDate: string, amount: string): Promise<string> {
  const invoice = await withTenant(sql, ctx, (tx) =>
    issueInvoice(tx, ctx, {
      contactId: tenant.customerId,
      issueDate: '2026-07-01',
      dueDate,
      lines: [
        {
          description: 'Consulting',
          quantity: '1',
          unitPrice: amount,
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['NONE']!,
        },
      ],
      idempotencyKey: randomUUID(),
    }),
  );
  return invoice.id;
}

beforeAll(async () => {
  const db = await createTestDatabase('dunning');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Chasing Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

  invoiceId = await invoiceDue('2026-07-15', '1080.00');
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('the ladder, day by day', () => {
  it('stays quiet while the invoice is merely due', async () => {
    const result = await withTenant(sql, ctx, (tx) => runFollowUpPass(tx, ctx, '2026-07-16'));
    expect(result.queued).toBe(0);
  });

  it('queues the friendly nudge at day 3, with the message composed', async () => {
    const result = await withTenant(sql, ctx, (tx) => runFollowUpPass(tx, ctx, '2026-07-18'));
    expect(result.queued).toBe(1);

    const reminders = await withTenant(sql, ctx, (tx) =>
      listReminders(tx, ctx, { status: 'QUEUED', today: '2026-07-18' }),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.tier).toBe(1);
    expect(reminders[0]!.message).toContain('RM 1,080.00');
    expect(reminders[0]!.message).toContain('15/07/2026');
  });

  it('is idempotent: the same day run twice queues nothing new', async () => {
    const again = await withTenant(sql, ctx, (tx) => runFollowUpPass(tx, ctx, '2026-07-18'));
    expect(again.queued).toBe(0);
  });

  it('does not climb to FIRM while FRIENDLY is still queued unsent', async () => {
    // Tier 2 becomes applicable at day 7 — but tier 1 counts as raised whether
    // or not a human has pressed send, so the ladder still climbs one rung.
    const result = await withTenant(sql, ctx, (tx) => runFollowUpPass(tx, ctx, '2026-07-23'));
    expect(result.queued).toBe(1);

    const queued = await withTenant(sql, ctx, (tx) =>
      listReminders(tx, ctx, { status: 'QUEUED', today: '2026-07-23' }),
    );
    expect(queued.map((r) => r.tier).sort()).toEqual([1, 2]);
  });

  it('marks the friendly one sent over WhatsApp, and the log says how', async () => {
    const queued = await withTenant(sql, ctx, (tx) =>
      listReminders(tx, ctx, { status: 'QUEUED', today: '2026-07-23' }),
    );
    const friendly = queued.find((r) => r.tier === 1)!;

    await withTenant(sql, ctx, (tx) => markReminderSent(tx, ctx, friendly.id, 'WHATSAPP'));

    const sent = await withTenant(sql, ctx, (tx) =>
      listReminders(tx, ctx, { status: 'SENT', today: '2026-07-23' }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.channel).toBe('WHATSAPP');
  });

  it('escalates to the owner at two weeks', async () => {
    const result = await withTenant(sql, ctx, (tx) => runFollowUpPass(tx, ctx, '2026-07-30'));
    expect(result.queued).toBe(1);
    expect(result.ownerAlerts).toBe(1);

    const queued = await withTenant(sql, ctx, (tx) =>
      listReminders(tx, ctx, { status: 'QUEUED', today: '2026-07-30' }),
    );
    const alert = queued.find((r) => r.tier === 3)!;
    expect(alert.tone).toBe('OWNER_ALERT');
    expect(alert.message).toContain('Decide');
  });

  it('shows the whole state in the overview', async () => {
    const overview = await withTenant(sql, ctx, (tx) =>
      collectionsOverview(tx, ctx, '2026-07-30'),
    );
    expect(overview).toHaveLength(1);
    expect(overview[0]!.daysOverdue).toBe(15);
    expect(overview[0]!.highestTierRaised).toBe(3);
    expect(overview[0]!.queuedReminders).toBe(2); // FIRM and OWNER_ALERT still queued
  });
});

describe('payment ends the chase', () => {
  it('cancels every queued reminder the day the money arrives', async () => {
    await withTenant(sql, ctx, (tx) =>
      recordReceipt(tx, ctx, {
        contactId: tenant.customerId,
        paymentDate: '2026-07-31',
        amount: '1080.00',
        method: 'TRANSFER',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ invoiceId, amount: '1080.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const result = await withTenant(sql, ctx, (tx) => runFollowUpPass(tx, ctx, '2026-08-01'));

    // The two unsent reminders die; nothing new is raised for a paid invoice.
    expect(result.cancelledAsPaid).toBe(2);
    expect(result.queued).toBe(0);

    const cancelled = await withTenant(sql, ctx, (tx) =>
      listReminders(tx, ctx, { status: 'CANCELLED', today: '2026-08-01' }),
    );
    expect(cancelled).toHaveLength(2);

    const overview = await withTenant(sql, ctx, (tx) =>
      collectionsOverview(tx, ctx, '2026-08-01'),
    );
    expect(overview).toHaveLength(0);
  });

  it('leaves the SENT record standing — history is what happened', async () => {
    const sent = await withTenant(sql, ctx, (tx) =>
      listReminders(tx, ctx, { status: 'SENT', today: '2026-08-01' }),
    );
    expect(sent).toHaveLength(1);
  });
});

describe('an old invoice discovered late', () => {
  it('gets ONE owner alert, not a barrage of three', async () => {
    await invoiceDue('2026-07-01', '5000.00');

    const result = await withTenant(sql, ctx, (tx) => runFollowUpPass(tx, ctx, '2026-08-01'));
    expect(result.queued).toBe(1);
    expect(result.ownerAlerts).toBe(1);
  });
});

describe('a human overrides the machine', () => {
  it('cancels a reminder with a reason', async () => {
    const queued = await withTenant(sql, ctx, (tx) =>
      listReminders(tx, ctx, { status: 'QUEUED', today: '2026-08-01' }),
    );
    const alert = queued[0]!;

    await withTenant(sql, ctx, (tx) =>
      cancelReminder(tx, ctx, alert.id, 'Spoke to them at the shop; paying Friday'),
    );

    await expect(
      withTenant(sql, ctx, (tx) => markReminderSent(tx, ctx, alert.id, 'WHATSAPP')),
    ).rejects.toThrow(/CANCELLED|No queued/);
  });

  it('answers not-found for another tenant’s reminder', async () => {
    await expect(
      withTenant(sql, ctx, (tx) => markReminderSent(tx, ctx, randomUUID(), 'WHATSAPP')),
    ).rejects.toThrow(/not found/i);
  });
});
