import {
  DEFAULT_DUNNING_TIERS,
  nextTier,
  reminderMessage,
  type DunningTier,
  type DunningTone,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';

/**
 * Payment follow-up: persistence and the daily pass.
 *
 * The domain owns the ladder — which tier an invoice earns today and what the
 * message says. This module owns the log: reminders are QUEUED with their
 * text fully composed, a human (or, later, an email transport) marks them
 * SENT, and the pass never chases money that has already arrived.
 */

export class DunningError extends Error {
  constructor(
    readonly code: 'REMINDER_NOT_FOUND' | 'REMINDER_NOT_QUEUED',
    message: string,
  ) {
    super(message);
    this.name = 'DunningError';
  }
}

/** The tenant's ladder, self-provisioned with the defaults on first use. */
export async function dunningPolicy(tx: Tx, ctx: TenantContext): Promise<DunningTier[]> {
  for (const tier of DEFAULT_DUNNING_TIERS) {
    await tx`
        INSERT INTO dunning_policy (tenant_id, tier, days_after_due, tone)
        VALUES (${ctx.tenantId}, ${tier.tier}, ${tier.daysAfterDue}, ${tier.tone})
        ON CONFLICT (tenant_id, tier) DO NOTHING
    `;
  }

  const rows = await tx<{ tier: number; days_after_due: number; tone: DunningTone }[]>`
      SELECT tier, days_after_due, tone FROM dunning_policy
       WHERE tenant_id = ${ctx.tenantId} AND is_enabled
       ORDER BY tier
  `;
  return rows.map((r) => ({ tier: r.tier, daysAfterDue: r.days_after_due, tone: r.tone }));
}

export interface FollowUpPassResult {
  readonly cancelledAsPaid: number;
  readonly queued: number;
  readonly ownerAlerts: number;
}

/**
 * The daily pass. Idempotent by construction: the unique (invoice, tier) key
 * means running it five times a day queues nothing twice, and cancellation of
 * since-paid invoices happens FIRST so a payment this morning stops this
 * afternoon's reminder.
 */
export async function runFollowUpPass(
  tx: Tx,
  ctx: TenantContext,
  today: string,
): Promise<FollowUpPassResult> {
  // 1. Never chase settled money.
  const cancelled = await tx<{ id: string }[]>`
      UPDATE payment_reminder r
         SET status = 'CANCELLED',
             cancelled_reason = 'Invoice settled before the reminder was sent'
        FROM invoice i
       WHERE r.tenant_id = ${ctx.tenantId}
         AND r.status = 'QUEUED'
         AND i.tenant_id = r.tenant_id AND i.id = r.invoice_id
         AND (i.status NOT IN ('ISSUED','PART_PAID') OR i.amount_due <= 0)
       RETURNING r.id
  `;

  const tiers = await dunningPolicy(tx, ctx);

  const [org] = await tx<{ name: string }[]>`
      SELECT name FROM organisation WHERE id = ${ctx.tenantId}
  `;
  const shopName = org?.name ?? 'us';

  // 2. Every overdue invoice, with the tiers already raised against it.
  const overdue = await tx<
    {
      id: string; invoice_no: string; due_date: Date; amount_due: string;
      currency: string; contact_name: string; days_overdue: number;
      tiers_raised: number[] | null;
    }[]
  >`
      SELECT i.id, i.invoice_no, i.due_date, i.amount_due, i.currency,
             c.name AS contact_name,
             (${today}::date - i.due_date)::int AS days_overdue,
             ARRAY(SELECT r.tier FROM payment_reminder r
                    WHERE r.tenant_id = i.tenant_id AND r.invoice_id = i.id
                      AND r.status <> 'CANCELLED') AS tiers_raised
        FROM invoice i
        JOIN contact c ON c.tenant_id = i.tenant_id AND c.id = i.contact_id
       WHERE i.tenant_id = ${ctx.tenantId}
         AND i.status IN ('ISSUED','PART_PAID')
         AND i.amount_due > 0
         AND i.due_date < ${today}::date
  `;

  let queued = 0;
  let ownerAlerts = 0;

  for (const invoice of overdue) {
    const facts = {
      invoiceNo: invoice.invoice_no,
      contactName: invoice.contact_name,
      dueDate: toIsoDate(invoice.due_date),
      amountDue: invoice.amount_due,
      currency: invoice.currency,
      daysOverdue: invoice.days_overdue,
      tiersAlreadyRaised: invoice.tiers_raised ?? [],
    };

    const tier = nextTier(facts, tiers);
    if (!tier) continue;

    const message = reminderMessage(tier.tone, facts, shopName);

    // ON CONFLICT DO NOTHING: a concurrent manual run and the nightly job
    // racing on the same invoice produce one reminder, not an error.
    const inserted = await tx<{ id: string }[]>`
        INSERT INTO payment_reminder (
            tenant_id, invoice_id, tier, tone, message, queued_on
        ) VALUES (
            ${ctx.tenantId}, ${invoice.id}, ${tier.tier}, ${tier.tone},
            ${message}, ${today}
        )
        ON CONFLICT (tenant_id, invoice_id, tier) DO NOTHING
        RETURNING id
    `;

    if (inserted.length > 0) {
      queued += 1;
      if (tier.tone === 'OWNER_ALERT') ownerAlerts += 1;
    }
  }

  return { cancelledAsPaid: cancelled.length, queued, ownerAlerts };
}

// ---------------------------------------------------------------------------
// Working the queue
// ---------------------------------------------------------------------------

export interface ReminderView {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly contactName: string;
  readonly tier: number;
  readonly tone: DunningTone;
  readonly message: string;
  readonly status: string;
  readonly channel: string | null;
  readonly queuedOn: string;
  readonly amountDue: string;
  readonly currency: string;
  readonly daysOverdue: number;
}

export async function listReminders(
  tx: Tx,
  ctx: TenantContext,
  options: { readonly status?: 'QUEUED' | 'SENT' | 'CANCELLED'; readonly today: string },
): Promise<ReminderView[]> {
  const rows = await tx<
    {
      id: string; invoice_id: string; invoice_no: string; contact_name: string;
      tier: number; tone: DunningTone; message: string; status: string;
      channel: string | null; queued_on: Date; amount_due: string; currency: string;
      days_overdue: number;
    }[]
  >`
      SELECT r.id, r.invoice_id, i.invoice_no, c.name AS contact_name,
             r.tier, r.tone, r.message, r.status, r.channel, r.queued_on,
             i.amount_due, i.currency,
             GREATEST((${options.today}::date - i.due_date)::int, 0) AS days_overdue
        FROM payment_reminder r
        JOIN invoice i ON i.tenant_id = r.tenant_id AND i.id = r.invoice_id
        JOIN contact c ON c.tenant_id = i.tenant_id AND c.id = i.contact_id
       WHERE r.tenant_id = ${ctx.tenantId}
         AND (${options.status ?? null}::text IS NULL OR r.status = ${options.status ?? null})
       ORDER BY r.tier DESC, r.queued_on, i.invoice_no
       LIMIT 200
  `;

  return rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoice_id,
    invoiceNo: r.invoice_no,
    contactName: r.contact_name,
    tier: r.tier,
    tone: r.tone,
    message: r.message,
    status: r.status,
    channel: r.channel,
    queuedOn: toIsoDate(r.queued_on),
    amountDue: r.amount_due,
    currency: r.currency,
    daysOverdue: r.days_overdue,
  }));
}

/** "I sent it" — over WhatsApp, by phone, however. The log records how. */
export async function markReminderSent(
  tx: Tx,
  ctx: TenantContext,
  reminderId: string,
  channel: 'WHATSAPP' | 'EMAIL' | 'PHONE' | 'OTHER',
): Promise<void> {
  const [updated] = await tx<{ id: string }[]>`
      UPDATE payment_reminder
         SET status = 'SENT', channel = ${channel}, sent_at = now(),
             sent_by = ${ctx.userId ?? null}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${reminderId} AND status = 'QUEUED'
       RETURNING id
  `;
  if (!updated) {
    const [exists] = await tx<{ status: string }[]>`
        SELECT status FROM payment_reminder
         WHERE tenant_id = ${ctx.tenantId} AND id = ${reminderId}
    `;
    if (!exists) {
      // Rule 9: another tenant's reminder is indistinguishable from none.
      throw new DunningError('REMINDER_NOT_FOUND', `Reminder ${reminderId} not found`);
    }
    throw new DunningError(
      'REMINDER_NOT_QUEUED',
      `Reminder is ${exists.status}; only a QUEUED reminder can be marked sent`,
    );
  }
}

/** "Don't chase this one" — with the why, because silence has a reason. */
export async function cancelReminder(
  tx: Tx,
  ctx: TenantContext,
  reminderId: string,
  reason: string,
): Promise<void> {
  const [updated] = await tx<{ id: string }[]>`
      UPDATE payment_reminder
         SET status = 'CANCELLED', cancelled_reason = ${reason}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${reminderId} AND status = 'QUEUED'
       RETURNING id
  `;
  if (!updated) {
    throw new DunningError('REMINDER_NOT_FOUND', `No queued reminder ${reminderId}`);
  }
}

/**
 * The collections overview: every overdue invoice with its escalation state —
 * the screen an owner scans with coffee.
 */
export async function collectionsOverview(
  tx: Tx,
  ctx: TenantContext,
  today: string,
): Promise<
  {
    invoiceId: string; invoiceNo: string; contactName: string; dueDate: string;
    amountDue: string; currency: string; daysOverdue: number;
    highestTierRaised: number; queuedReminders: number;
  }[]
> {
  const rows = await tx<
    {
      id: string; invoice_no: string; contact_name: string; due_date: Date;
      amount_due: string; currency: string; days_overdue: number;
      highest_tier: number; queued: number;
    }[]
  >`
      SELECT i.id, i.invoice_no, c.name AS contact_name, i.due_date,
             i.amount_due, i.currency,
             (${today}::date - i.due_date)::int AS days_overdue,
             COALESCE((SELECT MAX(r.tier) FROM payment_reminder r
                        WHERE r.tenant_id = i.tenant_id AND r.invoice_id = i.id
                          AND r.status <> 'CANCELLED'), 0) AS highest_tier,
             (SELECT COUNT(*)::int FROM payment_reminder r
               WHERE r.tenant_id = i.tenant_id AND r.invoice_id = i.id
                 AND r.status = 'QUEUED')                  AS queued
        FROM invoice i
        JOIN contact c ON c.tenant_id = i.tenant_id AND c.id = i.contact_id
       WHERE i.tenant_id = ${ctx.tenantId}
         AND i.status IN ('ISSUED','PART_PAID')
         AND i.amount_due > 0
         AND i.due_date < ${today}::date
       ORDER BY days_overdue DESC
  `;

  return rows.map((r) => ({
    invoiceId: r.id,
    invoiceNo: r.invoice_no,
    contactName: r.contact_name,
    dueDate: toIsoDate(r.due_date),
    amountDue: r.amount_due,
    currency: r.currency,
    daysOverdue: r.days_overdue,
    highestTierRaised: r.highest_tier,
    queuedReminders: r.queued,
  }));
}
