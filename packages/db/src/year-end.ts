import {
  buildClosingEntry,
  checkClosingEntry,
  isErr,
  Money,
  validateJournalEntry,
  type AccountType,
  type ClosableBalance,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry, reversePostedEntry } from './ledger.js';
import { loadBaseCurrency } from './invoice.js';
import { toIsoDate } from './internal.js';

/**
 * Closing and reopening a fiscal year.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS: POST, THEN CLOSE. AND IT HAS TO BE.
 *
 * 0017 established that a CLOSED period has no override path — an entry into
 * one requires visibly reopening it, because an override that quietly writes
 * into a closed period is how a reported figure changes after it was reported.
 *
 * The year-end close does not invent an exception to that. It posts the closing
 * entry while the year is still open, and only then marks it closed — which
 * also makes the closing entry the last thing posted into the year by
 * construction rather than by convention.
 * ---------------------------------------------------------------------------
 */

export class YearEndError extends Error {
  constructor(
    readonly code:
      | 'YEAR_NOT_FOUND'
      | 'ALREADY_CLOSED'
      | 'NOT_CLOSED'
      | 'CLOSE_INVALID'
      | 'PERIOD_NOT_CLOSEABLE',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'YearEndError';
  }
}

export interface ClosedYear {
  readonly fiscalYearId: string;
  readonly label: string;
  readonly status: string;
  /** Null when the year had no trading and needed no entry. */
  readonly closingEntryId: string | null;
  /** Credit-positive. A loss is negative. */
  readonly profitForYear: string;
  readonly accountsClosed: number;
  readonly replayed: boolean;
}

export interface CloseFiscalYearInput {
  readonly fiscalYearId: string;
  readonly idempotencyKey: string;
}

export async function closeFiscalYear(
  tx: Tx,
  ctx: TenantContext,
  input: CloseFiscalYearInput,
): Promise<ClosedYear> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  // FOR UPDATE: two concurrent closes of the same year would each compute the
  // full profit and post it, doubling retained earnings.
  const [year] = await tx<
    {
      id: string; label: string; start_date: Date; end_date: Date; status: string;
      closing_entry_id: string | null; close_idempotency_key: string | null;
    }[]
  >`
      SELECT id, label, start_date, end_date, status, closing_entry_id,
             close_idempotency_key
        FROM fiscal_year
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.fiscalYearId}
         FOR UPDATE
  `;

  // 404-shaped, and indistinguishable from another tenant's year.
  if (!year) {
    throw new YearEndError('YEAR_NOT_FOUND', `Fiscal year ${input.fiscalYearId} not found`);
  }

  if (year.status !== 'OPEN') {
    /*
     * Rule 5. A retried close — a dropped response, a double-clicked button —
     * must return what the first call returned, not an error. Recognised by the
     * key rather than by "the year is closed and looks about right", and only
     * the SAME key replays: a different key asking to close an already-closed
     * year is a different request, and is refused.
     */
    if (year.close_idempotency_key === input.idempotencyKey) {
      return {
        fiscalYearId: year.id,
        label: year.label,
        status: year.status,
        closingEntryId: year.closing_entry_id,
        ...(await summariseClosingEntry(tx, ctx, year.closing_entry_id, baseCurrency)),
        replayed: true,
      };
    }

    throw new YearEndError(
      'ALREADY_CLOSED',
      `Fiscal year ${year.label} is already ${year.status}. Reopen it before closing again.`,
    );
  }

  if (!ctx.userId) {
    // `fiscal_year.closed_by` is NOT NULL once closed, by constraint. An act
    // with nobody attached to it is the one an auditor cannot follow up.
    throw new YearEndError('CLOSE_INVALID', 'Closing a year records who closed it; this call has no user');
  }

  /*
   * A LOCKED period is one whose numbers have been filed. Posting the closing
   * entry into the year would land in the final period, and if that period is
   * locked the entry needs `period.override` — which is a decision a user
   * should make explicitly rather than have a year-end close make for them.
   */
  const [locked] = await tx<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM fiscal_period
       WHERE tenant_id = ${ctx.tenantId}
         AND fiscal_year_id = ${year.id}
         AND status = 'LOCKED'
  `;

  if (Number(locked!.count) > 0) {
    throw new YearEndError(
      'PERIOD_NOT_CLOSEABLE',
      `Fiscal year ${year.label} has ${locked!.count} LOCKED period(s). The closing entry ` +
        'would need a period override, which is a decision to make explicitly.',
    );
  }

  const yearEndDate = toIsoDate(year.end_date);

  // Profit-and-loss movement for this year's periods only. From the rollup,
  // which is what every statement is built from, so the close agrees with the
  // income statement it is closing.
  const balanceRows = await tx<
    { account_id: string; code: string; type: AccountType; movement: string }[]
  >`
      SELECT a.id AS account_id, a.code, a.type,
             COALESCE(SUM(b.net_movement), 0)::text AS movement
        FROM account a
        JOIN account_period_balance b
          ON b.tenant_id = a.tenant_id AND b.account_id = a.id
         AND b.currency = ${baseCurrency}
        JOIN fiscal_period p
          ON p.tenant_id = b.tenant_id AND p.id = b.fiscal_period_id
       WHERE a.tenant_id = ${ctx.tenantId}
         AND p.fiscal_year_id = ${year.id}
         AND a.type IN ('INCOME', 'EXPENSE')
       GROUP BY a.id, a.code, a.type
      HAVING COALESCE(SUM(b.net_movement), 0) <> 0
  `;

  const balances: ClosableBalance[] = balanceRows.map((r) => ({
    accountId: r.account_id,
    code: r.code,
    type: r.type,
    amount: Money.fromDecimal(r.movement, baseCurrency),
  }));

  const [retained] = await tx<{ account_id: string; type: AccountType }[]>`
      SELECT m.account_id, a.type
        FROM posting_account_map m
        JOIN account a ON a.tenant_id = m.tenant_id AND a.id = m.account_id
       WHERE m.tenant_id = ${ctx.tenantId} AND m.role = 'RETAINED_EARNINGS'
  `;

  const built = buildClosingEntry({
    yearEndDate,
    yearLabel: year.label,
    baseCurrency,
    retainedEarningsAccountId: retained?.account_id,
    retainedEarningsAccountType: retained?.type,
    balances,
  });

  let closingEntryId: string | null = null;
  let profitForYear = Money.zero(baseCurrency);
  let accountsClosed = 0;

  if (isErr(built)) {
    /*
     * A year with no trading is closed WITHOUT an entry rather than refused.
     * An entry that moves nothing still consumes a document number an auditor
     * will later ask about, and the year is legitimately finished.
     */
    const onlyNothingToClose =
      built.error.length === 1 && built.error[0]!.code === 'NOTHING_TO_CLOSE';

    if (!onlyNothingToClose) {
      throw new YearEndError(
        'CLOSE_INVALID',
        `Fiscal year ${year.label} cannot be closed: ${describe(built.error)}`,
        built.error,
      );
    }
  } else {
    const check = checkClosingEntry(built.value, balances, baseCurrency);
    if (!check.consistent) {
      // A close that restates the year is the kind of error found by a client a
      // year later, in a comparative column. It must never commit.
      throw new YearEndError(
        'CLOSE_INVALID',
        `The closing entry for ${year.label} is inconsistent: ${check.violations.join('; ')}`,
        check.violations,
      );
    }

    const validated = validateJournalEntry(built.value.draft, baseCurrency);
    if (isErr(validated)) {
      throw new YearEndError('CLOSE_INVALID', 'The closing entry failed validation', validated.error);
    }

    /*
     * The key is NAMESPACED to this year.
     *
     * Without it, closing 2024 and then closing 2025 under one client-supplied
     * Idempotency-Key would return 2024's entry for 2025 and leave 2025's P&L
     * accounts carrying their balances into 2026 — silently, because the caller
     * got a success and an entry id. The same reasoning `revaluation.ts` uses
     * for `revaluation-reversal:`.
     */
    const posted = await postJournalEntry(tx, ctx, validated.value, {
      idempotencyKey: `year-end-close:${year.id}:${input.idempotencyKey}`,
      emitEvent: {
        type: 'year.closed',
        payload: { fiscalYearId: year.id, label: year.label },
      },
    });

    /*
     * A replay reaching HERE is not a retried close — the year is OPEN, so the
     * retry check above did not fire. It means this key already posted the
     * closing entry for this year, that close was REOPENED (which nulls
     * `closing_entry_id` and reverses the entry), and the same key is now being
     * reused for a second close. Posting nothing while reporting success would
     * leave the year's P&L balances in place with the year marked closed.
     */
    if (posted.replayed) {
      throw new YearEndError(
        'CLOSE_INVALID',
        `Idempotency key ${input.idempotencyKey} already closed fiscal year ${year.label} once. ` +
          'Closing it again after a reopen is a new request and needs a new key.',
      );
    }

    closingEntryId = posted.id;
    profitForYear = built.value.profitForYear;
    accountsClosed = built.value.accountsClosed;
  }

  await tx`
      UPDATE fiscal_year
         SET status = 'CLOSED', closed_by = ${ctx.userId}, closed_at = now(),
             closing_entry_id = ${closingEntryId},
             close_idempotency_key = ${input.idempotencyKey}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${year.id}
  `;

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'YEAR_END_CLOSED', ${ctx.userId}, 'period.lock',
          'fiscal_year', ${year.id},
          ${tx.json({
            label: year.label,
            yearEndDate,
            profitForYear: profitForYear.toDecimalString(),
            accountsClosed,
            closingEntryId,
          })}
      )
  `;

  return {
    fiscalYearId: year.id,
    label: year.label,
    status: 'CLOSED',
    closingEntryId,
    profitForYear: profitForYear.toDecimalString(),
    accountsClosed,
    replayed: false,
  };
}

export interface ReopenFiscalYearInput {
  readonly fiscalYearId: string;
  /** Why. Required — see below. */
  readonly reason: string;
  readonly idempotencyKey: string;
}

/**
 * Reopen a closed year.
 *
 * ---------------------------------------------------------------------------
 * THE CLOSING ENTRY IS REVERSED, NEVER DELETED.
 *
 * Rule 1: the ledger is append-only, and a closing entry is a posted journal
 * entry like any other. Reopening posts a REVERSING entry that references it,
 * so the history shows a year that was closed and then reopened rather than a
 * year that was never closed.
 *
 * The reason is required rather than optional, for the same argument
 * `changePeriodStatus` makes: reopening a closed year is the act most likely to
 * be asked about in an audit, and "why" is the question. A field nobody has to
 * fill in is a field nobody fills in.
 * ---------------------------------------------------------------------------
 */
export async function reopenFiscalYear(
  tx: Tx,
  ctx: TenantContext,
  input: ReopenFiscalYearInput,
): Promise<{ fiscalYearId: string; label: string; reversalEntryId: string | null }> {
  const [year] = await tx<
    { id: string; label: string; status: string; closing_entry_id: string | null }[]
  >`
      SELECT id, label, status, closing_entry_id
        FROM fiscal_year
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.fiscalYearId}
         FOR UPDATE
  `;

  if (!year) {
    throw new YearEndError('YEAR_NOT_FOUND', `Fiscal year ${input.fiscalYearId} not found`);
  }

  if (year.status === 'OPEN') {
    throw new YearEndError('NOT_CLOSED', `Fiscal year ${year.label} is already open`);
  }

  if (input.reason.trim().length === 0) {
    throw new YearEndError(
      'CLOSE_INVALID',
      'Reopening a closed year requires a reason. It is the act most likely to be ' +
        'asked about in an audit.',
    );
  }

  /*
   * The year must be OPEN before the reversal can post — the trigger this
   * migration added refuses a posting into a CLOSED year, and the reversal is
   * a posting into it. Opening first is not a loophole: the reopen has already
   * been authorised at this point, and the reversal is the thing that makes it
   * honest.
   */
  await tx`
      UPDATE fiscal_year
         SET status = 'OPEN', closed_by = NULL, closed_at = NULL,
             closing_entry_id = NULL, close_idempotency_key = NULL
       WHERE tenant_id = ${ctx.tenantId} AND id = ${year.id}
  `;

  let reversalEntryId: string | null = null;

  if (year.closing_entry_id !== null) {
    const reversal = await reversePostedEntry(tx, ctx, {
      entryId: year.closing_entry_id,
      reason: `year ${year.label} reopened — ${input.reason}`,
      idempotencyKey: input.idempotencyKey,
    });
    reversalEntryId = reversal.id;
  }

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'YEAR_END_REOPENED', ${ctx.userId ?? null}, 'period.lock',
          'fiscal_year', ${year.id},
          ${tx.json({
            label: year.label,
            reason: input.reason,
            reversedClosingEntryId: year.closing_entry_id,
            reversalEntryId,
          })}
      )
  `;

  return { fiscalYearId: year.id, label: year.label, reversalEntryId };
}

export interface FiscalYearView {
  readonly id: string;
  readonly label: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
  readonly closedAt: string | null;
  readonly closingEntryId: string | null;
  readonly openPeriods: number;
}

export async function listFiscalYears(tx: Tx, ctx: TenantContext): Promise<FiscalYearView[]> {
  const rows = await tx<
    {
      id: string; label: string; start_date: Date; end_date: Date; status: string;
      closed_at: Date | null; closing_entry_id: string | null; open_periods: number;
    }[]
  >`
      SELECT y.id, y.label, y.start_date, y.end_date, y.status, y.closed_at,
             y.closing_entry_id,
             (SELECT COUNT(*)::int FROM fiscal_period p
               WHERE p.tenant_id = y.tenant_id AND p.fiscal_year_id = y.id
                 AND p.status = 'OPEN')                       AS open_periods
        FROM fiscal_year y
       WHERE y.tenant_id = ${ctx.tenantId}
       ORDER BY y.start_date DESC
  `;

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    startDate: toIsoDate(r.start_date),
    endDate: toIsoDate(r.end_date),
    status: r.status,
    closedAt: r.closed_at ? r.closed_at.toISOString() : null,
    closingEntryId: r.closing_entry_id,
    openPeriods: r.open_periods,
  }));
}

/**
 * Reconstruct a close's summary from the entry it posted.
 *
 * Derived rather than stored. The alternative — three more columns on
 * `fiscal_year` carrying a profit figure and a count — is a denormalisation of
 * something the journal already states exactly, and one that could disagree
 * with it after a reversal.
 */
async function summariseClosingEntry(
  tx: Tx,
  ctx: TenantContext,
  closingEntryId: string | null,
  baseCurrency: string,
): Promise<{ profitForYear: string; accountsClosed: number }> {
  // A year with no trading was closed without an entry. Nothing to summarise.
  if (closingEntryId === null) {
    return { profitForYear: Money.zero(baseCurrency).toDecimalString(), accountsClosed: 0 };
  }

  const rows = await tx<
    { account_id: string; base_debit: string; base_credit: string; is_retained: boolean }[]
  >`
      SELECT l.account_id, l.base_debit, l.base_credit,
             (m.account_id IS NOT NULL) AS is_retained
        FROM journal_line l
        LEFT JOIN posting_account_map m
          ON m.tenant_id = l.tenant_id
         AND m.account_id = l.account_id
         AND m.role = 'RETAINED_EARNINGS'
       WHERE l.tenant_id = ${ctx.tenantId} AND l.journal_entry_id = ${closingEntryId}
  `;

  // Credit-positive: a profit CREDITS retained earnings, so credit minus debit
  // on that line is the profit for the year.
  const profit = rows
    .filter((r) => r.is_retained)
    .reduce(
      (acc, r) =>
        acc.add(Money.fromDecimal(r.base_credit, baseCurrency)).subtract(
          Money.fromDecimal(r.base_debit, baseCurrency),
        ),
      Money.zero(baseCurrency),
    );

  return {
    profitForYear: profit.toDecimalString(),
    accountsClosed: rows.filter((r) => !r.is_retained).length,
  };
}

function describe(violations: readonly { code: string }[]): string {
  return violations
    .map((v) => {
      switch (v.code) {
        case 'NO_RETAINED_EARNINGS_ACCOUNT':
          return 'no account is mapped to the RETAINED_EARNINGS posting role';
        case 'RETAINED_EARNINGS_IS_NOT_EQUITY':
          return 'the RETAINED_EARNINGS account is not an equity account';
        case 'BALANCE_SHEET_ACCOUNT_IN_CLOSING_SET':
          return 'a balance-sheet account reached the closing set';
        default:
          return v.code;
      }
    })
    .join('; ');
}
