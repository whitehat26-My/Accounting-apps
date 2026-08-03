import {
  buildWeeklyDigest,
  lastCompletedWeek,
  Money,
  type WeekFigures,
  type WeeklyDigest,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';

/**
 * The weekly digest: gathered from the same sources the owner's screens use.
 *
 * Sales and expenses come from documents (invoice, bill), takings from
 * payments, COGS from the ledger filtered by SOURCE — each the same query
 * shape the Z-report and the P&L already rely on, so the digest can never
 * disagree with the screens it summarises.
 *
 * A digest is computed ONCE per completed week and stored (0032): the report
 * the owner read in July must still read the same in November, and trailing
 * averages move as history accumulates. `runWeeklyDigest` is the daily
 * idempotent entry point; the UNIQUE (tenant_id, week_start) constraint is
 * what makes "already done" a no-op rather than a race.
 */

async function weekFigures(
  tx: Tx,
  ctx: TenantContext,
  weekStart: string,
  currency: string,
): Promise<WeekFigures> {
  const weekEnd = addDaysUtc(weekStart, 6);

  const [sales] = await tx<{ net: string; days: number }[]>`
      SELECT COALESCE(SUM(ROUND(subtotal * fx_rate, 4)), 0)::text AS net,
             COUNT(DISTINCT issue_date)::int                      AS days
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND issue_date BETWEEN ${weekStart}::date AND ${weekEnd}::date
         AND status <> 'VOIDED'
  `;

  const [takings] = await tx<{ total: string }[]>`
      SELECT COALESCE(SUM(amount), 0)::text AS total
        FROM payment
       WHERE tenant_id = ${ctx.tenantId}
         AND direction = 'INBOUND'
         AND payment_date BETWEEN ${weekStart}::date AND ${weekEnd}::date
  `;

  /* By SOURCE, not account, exactly as the Z-report does: a manual journal
     touching the COGS account is not a week's trading cost. */
  const [cogs] = await tx<{ total: string }[]>`
      SELECT COALESCE(SUM(l.base_debit - l.base_credit), 0)::text AS total
        FROM journal_line l
        JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
        JOIN posting_account_map m
          ON m.tenant_id = l.tenant_id AND m.account_id = l.account_id AND m.role = 'COGS'
       WHERE l.tenant_id = ${ctx.tenantId}
         AND e.source_document_type = 'INVOICE_COGS'
         AND e.entry_date BETWEEN ${weekStart}::date AND ${weekEnd}::date
         AND e.status IN ('POSTED', 'REVERSED')
  `;

  /* Net of tax: SST paid on a purchase is a tax matter, not a running cost. */
  const [expenses] = await tx<{ total: string }[]>`
      SELECT COALESCE(SUM(ROUND(subtotal * fx_rate, 4)), 0)::text AS total
        FROM bill
       WHERE tenant_id = ${ctx.tenantId}
         AND bill_date BETWEEN ${weekStart}::date AND ${weekEnd}::date
         AND status NOT IN ('DRAFT', 'VOIDED')
  `;

  const salesNet = Money.fromDecimal(sales!.net, currency);
  return {
    weekStart,
    salesNet,
    takings: Money.fromDecimal(takings!.total, currency),
    grossProfit: salesNet.subtract(Money.fromDecimal(cogs!.total, currency)),
    expenses: Money.fromDecimal(expenses!.total, currency),
    daysWithSales: sales!.days,
  };
}

export interface WeeklyDigestRunResult {
  readonly weekStart: string;
  /** False when the week was already stored — the daily job's usual outcome. */
  readonly stored: boolean;
  readonly warnings: number;
}

/**
 * Compute and store the digest for the last completed week, once.
 * `today` is the tenant-local (Asia/Kuala_Lumpur) date.
 */
export async function runWeeklyDigest(
  tx: Tx,
  ctx: TenantContext,
  today: string,
): Promise<WeeklyDigestRunResult> {
  const { weekStart, weekEnd } = lastCompletedWeek(today);

  const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM weekly_digest
       WHERE tenant_id = ${ctx.tenantId} AND week_start = ${weekStart}::date
  `;
  if (existing) return { weekStart, stored: false, warnings: 0 };

  const [org] = await tx<{ base_currency: string }[]>`
      SELECT base_currency FROM organisation WHERE id = ${ctx.tenantId}
  `;
  const currency = org?.base_currency ?? 'MYR';

  const week = await weekFigures(tx, ctx, weekStart, currency);
  const priorWeeks: WeekFigures[] = [];
  for (let i = 1; i <= 4; i++) {
    priorWeeks.push(await weekFigures(tx, ctx, addDaysUtc(weekStart, -7 * i), currency));
  }

  const [overdue] = await tx<{ total: string; count: number }[]>`
      SELECT COALESCE(SUM(ROUND(amount_due * fx_rate, 4)), 0)::text AS total,
             COUNT(*)::int                                          AS count
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('ISSUED', 'PART_PAID')
         AND amount_due > 0
         AND due_date < ${today}::date
  `;

  const digest = buildWeeklyDigest({
    week,
    priorWeeks,
    overdueReceivables: {
      total: Money.fromDecimal(overdue!.total, currency),
      count: overdue!.count,
    },
    currency,
  });

  const warnings = digest.flags.filter((f) => f.severity === 'WARN').length;

  /* ON CONFLICT DO NOTHING: two workers racing the same day store one row. */
  const inserted = await tx<{ id: string }[]>`
      INSERT INTO weekly_digest (tenant_id, week_start, week_end, payload, warn_count)
      VALUES (${ctx.tenantId}, ${weekStart}::date, ${weekEnd}::date,
              ${tx.json(serialize(digest) as never)}, ${warnings})
      ON CONFLICT (tenant_id, week_start) DO NOTHING
      RETURNING id
  `;

  return { weekStart, stored: inserted.length > 0, warnings };
}

export interface StoredWeeklyDigest {
  readonly id: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly warnCount: number;
  readonly createdAt: string;
  readonly digest: SerializedDigest;
}

export async function listWeeklyDigests(
  tx: Tx,
  ctx: TenantContext,
  limit = 12,
): Promise<StoredWeeklyDigest[]> {
  const rows = await tx<
    { id: string; week_start: Date; week_end: Date; warn_count: number;
      created_at: Date; payload: SerializedDigest }[]
  >`
      SELECT id, week_start, week_end, warn_count, created_at, payload
        FROM weekly_digest
       WHERE tenant_id = ${ctx.tenantId}
       ORDER BY week_start DESC
       LIMIT ${Math.min(Math.max(limit, 1), 52)}
  `;

  return rows.map((r) => ({
    id: r.id,
    weekStart: toIsoDate(r.week_start),
    weekEnd: toIsoDate(r.week_end),
    warnCount: r.warn_count,
    createdAt: r.created_at.toISOString(),
    digest: r.payload,
  }));
}

// -------------------------------------------------------------- serialization

/** The stored/wire shape: every Money as a decimal string. */
export interface SerializedDigest {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly week: {
    readonly salesNet: string;
    readonly takings: string;
    readonly grossProfit: string;
    readonly expenses: string;
    readonly daysWithSales: number;
  };
  readonly comparedAgainstWeeks: number;
  readonly flags: readonly { code: string; severity: string; message: string }[];
}

function serialize(digest: WeeklyDigest): SerializedDigest {
  return {
    weekStart: digest.weekStart,
    weekEnd: digest.weekEnd,
    week: {
      salesNet: digest.week.salesNet.toDecimalString(),
      takings: digest.week.takings.toDecimalString(),
      grossProfit: digest.week.grossProfit.toDecimalString(),
      expenses: digest.week.expenses.toDecimalString(),
      daysWithSales: digest.week.daysWithSales,
    },
    comparedAgainstWeeks: digest.comparedAgainstWeeks,
    flags: digest.flags.map((f) => ({ ...f })),
  };
}

function addDaysUtc(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
