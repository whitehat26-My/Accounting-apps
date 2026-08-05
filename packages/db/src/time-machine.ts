import {
  Money,
  classifyChange,
  diffBalances,
  type BalanceAtInstant,
  type BalanceChange,
  type ChangedEntry,
  type Currency,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { loadBaseCurrency } from './invoice.js';

/**
 * The books as at a past instant, and what changed since.
 *
 * ---------------------------------------------------------------------------
 * THE ROLLUP CANNOT ANSWER THIS, AND THAT IS THE POINT.
 *
 * `account_period_balance` is a mutable cache: it holds where each account
 * stands NOW, and posting an entry updates it in place. There is no version of
 * it from April. So every query here reads `journal_line` directly, filtered
 * by the entry's `posted_at` — slower than the rollup, and the only thing that
 * is actually true.
 *
 * The filter is `posted_at <= T`, with no reference to `status`, and that is
 * deliberate:
 *
 *   * a DRAFT entry has `posted_at NULL` and is excluded automatically;
 *   * a REVERSED entry keeps its lines and its original `posted_at`, so at
 *     instant T — before the reversal existed — it correctly still counts;
 *   * the reversal is a separate entry with a LATER `posted_at`, so it enters
 *     the picture exactly when it actually did.
 *
 * Filtering on today's `status` instead would retroactively erase entries that
 * were live at the time, which is the precise error this feature exists to
 * expose in other systems.
 * ---------------------------------------------------------------------------
 */

export interface BooksAsAt {
  readonly asAt: string;
  readonly currency: string;
  readonly balances: readonly BalanceAtInstant[];
  readonly totalDebit: string;
  readonly totalCredit: string;
}

/** Optional accounting-date window — "only entries dated inside March". */
export interface EntryDateWindow {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export async function booksAsAt(
  tx: Tx,
  ctx: TenantContext,
  input: { readonly asAt: string } & EntryDateWindow,
): Promise<BooksAsAt> {
  const currency = (await loadBaseCurrency(tx, ctx)) as Currency;
  const balances = await balancesAt(tx, ctx, input, currency);

  let debit = Money.zero(currency);
  let credit = Money.zero(currency);
  for (const account of balances) {
    if (account.balance.isNegative()) credit = credit.subtract(account.balance);
    else debit = debit.add(account.balance);
  }

  return {
    asAt: input.asAt,
    currency,
    balances,
    totalDebit: debit.toDecimalString(),
    totalCredit: credit.toDecimalString(),
  };
}

async function balancesAt(
  tx: Tx,
  ctx: TenantContext,
  input: { readonly asAt: string } & EntryDateWindow,
  currency: Currency,
): Promise<BalanceAtInstant[]> {
  const rows = await tx<{ account_id: string; code: string; name: string; balance: string }[]>`
      SELECT a.id AS account_id, a.code, a.name,
             SUM(l.base_debit - l.base_credit)::text AS balance
        FROM journal_line l
        JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
        JOIN account a       ON a.tenant_id = l.tenant_id AND a.id = l.account_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND e.posted_at IS NOT NULL
         AND e.posted_at <= ${input.asAt}::timestamptz
         AND (${input.from ?? null}::date IS NULL OR e.entry_date >= ${input.from ?? null})
         AND (${input.to ?? null}::date   IS NULL OR e.entry_date <= ${input.to ?? null})
       GROUP BY a.id, a.code, a.name
      HAVING SUM(l.base_debit - l.base_credit) <> 0
       ORDER BY a.code
  `;

  return rows.map((r) => ({
    accountId: r.account_id,
    code: r.code,
    name: r.name,
    balance: Money.fromDecimal(r.balance, currency),
  }));
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

export interface WhatChanged {
  readonly since: string;
  readonly until: string;
  readonly examined: EntryDateWindow;
  readonly currency: string;
  readonly changes: readonly BalanceChange[];
  readonly entries: readonly ChangedEntry[];
  /** True when nothing moved — the answer the owner usually wants. */
  readonly unchanged: boolean;
}

/**
 * What moved between two instants, and who moved it.
 *
 * The account deltas alone would leave the question half-answered. The entries
 * responsible — with the name of the person who posted each one — are the
 * other half, and the reason this is a tool rather than a curiosity.
 */
export async function whatChanged(
  tx: Tx,
  ctx: TenantContext,
  input: { readonly since: string; readonly until: string } & EntryDateWindow,
): Promise<WhatChanged> {
  const currency = (await loadBaseCurrency(tx, ctx)) as Currency;

  const before = await balancesAt(tx, ctx, { asAt: input.since, ...windowOf(input) }, currency);
  const after = await balancesAt(tx, ctx, { asAt: input.until, ...windowOf(input) }, currency);
  const changes = diffBalances(before, after, currency);

  /*
   * The poster's name comes through `audit_actor`, the SECURITY DEFINER
   * function 0016 already provides: `app_user` is GLOBAL and deliberately
   * unreadable by `emil_app`, and the function resolves a name only for
   * somebody who is a member of THIS tenant. Granting the table instead would
   * let one organisation enumerate another's people.
   */
  const rows = await tx<
    {
      entry_no: string;
      entry_date: Date;
      posted_at: Date;
      description: string | null;
      source_module: string;
      reversal_of_id: string | null;
      posted_by_name: string | null;
    }[]
  >`
      SELECT e.entry_no, e.entry_date, e.posted_at, e.description, e.source_module,
             e.reversal_of_id, act.full_name AS posted_by_name
        FROM journal_entry e
        LEFT JOIN LATERAL audit_actor(e.posted_by) act ON TRUE
       WHERE e.tenant_id = ${ctx.tenantId}
         AND e.posted_at IS NOT NULL
         AND e.posted_at >  ${input.since}::timestamptz
         AND e.posted_at <= ${input.until}::timestamptz
         AND (${input.from ?? null}::date IS NULL OR e.entry_date >= ${input.from ?? null})
         AND (${input.to ?? null}::date   IS NULL OR e.entry_date <= ${input.to ?? null})
       ORDER BY e.posted_at
  `;

  const entries: ChangedEntry[] = rows.map((r) => {
    const entryDate = r.entry_date.toISOString().slice(0, 10);
    return {
      entryNo: r.entry_no,
      entryDate,
      postedAt: r.posted_at.toISOString(),
      description: r.description,
      sourceModule: r.source_module,
      reversalOfId: r.reversal_of_id,
      postedByName: r.posted_by_name,
      kind: classifyChange(
        { entryDate, reversalOfId: r.reversal_of_id },
        { from: input.from, to: input.to },
      ),
    };
  });

  return {
    since: input.since,
    until: input.until,
    examined: windowOf(input),
    currency,
    changes,
    entries,
    unchanged: changes.length === 0 && entries.length === 0,
  };
}

function windowOf(input: EntryDateWindow): EntryDateWindow {
  return {
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
  };
}

// ---------------------------------------------------------------------------
// When the books were closed
// ---------------------------------------------------------------------------

export interface LockMoment {
  readonly eventType: string;
  readonly occurredAt: string;
  readonly periodLabel: string | null;
  readonly actorName: string | null;
}

/**
 * The instants worth comparing against, read from the financial event log.
 *
 * Without these the feature asks for a timestamp, and nobody knows theirs.
 * With them the screen offers "since you closed March — 05/04/2026", which is
 * the question people actually have. `period.ts` writes PERIOD_LOCKED and
 * PERIOD_UNLOCKED; the year-end close writes YEAR_END_CLOSED.
 */
export async function lockMoments(tx: Tx, ctx: TenantContext): Promise<LockMoment[]> {
  const rows = await tx<
    { event_type: string; occurred_at: Date; detail: Record<string, unknown>; actor: string | null }[]
  >`
      SELECT f.event_type, f.occurred_at, f.detail, act.full_name AS actor
        FROM financial_event_log f
        LEFT JOIN LATERAL audit_actor(f.actor_user_id) act ON TRUE
       WHERE f.tenant_id = ${ctx.tenantId}
         AND f.event_type IN ('PERIOD_LOCKED', 'PERIOD_UNLOCKED', 'YEAR_END_CLOSED')
       ORDER BY f.occurred_at DESC
       LIMIT 50
  `;

  return rows.map((r) => ({
    eventType: r.event_type,
    occurredAt: r.occurred_at.toISOString(),
    periodLabel:
      typeof r.detail['periodLabel'] === 'string'
        ? r.detail['periodLabel']
        : typeof r.detail['startDate'] === 'string'
          ? String(r.detail['startDate']).slice(0, 7)
          : null,
    actorName: r.actor,
  }));
}
