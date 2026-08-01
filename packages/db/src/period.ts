/**
 * PeriodService — month-end close.
 *
 * ---------------------------------------------------------------------------
 * THE COLUMNS EXISTED; NOTHING COULD WRITE THEM.
 *
 * `fiscal_period.status`, `locked_by` and `locked_at` have been in the schema
 * since migration 0001, and `PERIOD_LOCKED` / `PERIOD_UNLOCKED` have been in
 * the `financial_event_log` enum since 0012. There was no service and no route,
 * so a period's status was whatever the test fixture happened to seed.
 *
 * Closing a period is the routine act that makes a set of figures final. Doing
 * it should be easy, undoing it should be visible, and this module is the
 * difference between those two.
 * ---------------------------------------------------------------------------
 */

import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';

export class PeriodError extends Error {
  constructor(
    readonly code:
      | 'PERIOD_NOT_FOUND'
      | 'ALREADY_IN_STATE'
      | 'YEAR_NOT_OPEN'
      | 'EARLIER_PERIOD_OPEN'
      | 'INVALID_TRANSITION',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'PeriodError';
  }
}

export type PeriodStatus = 'OPEN' | 'CLOSED' | 'LOCKED';

export interface PeriodView {
  readonly id: string;
  readonly fiscalYearId: string;
  readonly label: string;
  readonly sequence: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: PeriodStatus;
  readonly lockedBy: string | null;
  readonly lockedAt: string | null;
  /** Posted entries in this period. What a close is making final. */
  readonly entryCount: number;
}

export async function listPeriods(
  tx: Tx,
  ctx: TenantContext,
  options: { fiscalYearId?: string } = {},
): Promise<PeriodView[]> {
  const rows = await tx<
    {
      id: string;
      fiscal_year_id: string;
      label: string;
      sequence: number;
      start_date: Date;
      end_date: Date;
      status: string;
      locked_by: string | null;
      locked_at: Date | null;
      entry_count: string;
    }[]
  >`
      SELECT p.id, p.fiscal_year_id, y.label, p.sequence, p.start_date, p.end_date,
             p.status, p.locked_by::text, p.locked_at,
             (SELECT count(*) FROM journal_entry e
               WHERE e.tenant_id = p.tenant_id AND e.fiscal_period_id = p.id
                 AND e.status = 'POSTED')::text AS entry_count
        FROM fiscal_period p
        JOIN fiscal_year y ON y.tenant_id = p.tenant_id AND y.id = p.fiscal_year_id
       WHERE p.tenant_id = ${ctx.tenantId}
         AND (${options.fiscalYearId ?? null}::uuid IS NULL
              OR p.fiscal_year_id = ${options.fiscalYearId ?? null})
       ORDER BY p.start_date
  `;

  return rows.map((row) => ({
    id: row.id,
    fiscalYearId: row.fiscal_year_id,
    label: row.label,
    sequence: row.sequence,
    startDate: toIsoDate(row.start_date),
    endDate: toIsoDate(row.end_date),
    status: row.status as PeriodStatus,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at === null ? null : row.locked_at.toISOString(),
    entryCount: Number(row.entry_count),
  }));
}

export interface ChangePeriodStatusInput {
  readonly periodId: string;
  readonly status: PeriodStatus;
  /** Why. Recorded on the financial event; required when reopening. */
  readonly reason?: string;
}

/**
 * Move a period between OPEN, CLOSED and LOCKED.
 *
 * ---------------------------------------------------------------------------
 * CLOSING FORWARD IS ROUTINE. OPENING BACKWARD IS AN EVENT.
 *
 * Both directions write to `financial_event_log`, because both are on the list
 * an auditor asks about by name — but they are not symmetrical acts. Closing
 * January is bookkeeping. Reopening January in April means a figure that has
 * already been reported is about to change, and the reason for that is the
 * single most useful thing anyone can record about it. So a reopen requires
 * one, and a close does not.
 * ---------------------------------------------------------------------------
 */
export async function changePeriodStatus(
  tx: Tx,
  ctx: TenantContext,
  input: ChangePeriodStatusInput,
): Promise<PeriodView> {
  const [period] = await tx<
    { id: string; status: string; start_date: Date; end_date: Date; fiscal_year_id: string;
      year_status: string }[]
  >`
      SELECT p.id, p.status, p.start_date, p.end_date, p.fiscal_year_id,
             y.status AS year_status
        FROM fiscal_period p
        JOIN fiscal_year y ON y.tenant_id = p.tenant_id AND y.id = p.fiscal_year_id
       WHERE p.tenant_id = ${ctx.tenantId} AND p.id = ${input.periodId}
         FOR UPDATE OF p
  `;

  if (!period) {
    throw new PeriodError('PERIOD_NOT_FOUND', `Fiscal period ${input.periodId} not found`);
  }

  if (period.status === input.status) {
    throw new PeriodError(
      'ALREADY_IN_STATE',
      `Fiscal period is already ${input.status}`,
    );
  }

  const reopening = input.status === 'OPEN';

  if (reopening && (input.reason === undefined || input.reason.trim().length === 0)) {
    throw new PeriodError(
      'INVALID_TRANSITION',
      'Reopening a period needs a reason. Figures for a closed period may already ' +
        'have been reported, and why they are being changed is the one thing nobody ' +
        'can reconstruct later.',
    );
  }

  if (!reopening && period.year_status !== 'OPEN') {
    throw new PeriodError(
      'YEAR_NOT_OPEN',
      `The financial year is ${period.year_status}; its periods cannot be changed`,
    );
  }

  /*
   * Closing out of order is refused.
   *
   * A February that is CLOSED while January is still OPEN is not a close — the
   * comparatives underneath it can still move, so the figures it makes "final"
   * are not. Refusing it here is cheaper than explaining later why a closed
   * period's opening balance changed.
   */
  if (!reopening) {
    const [earlier] = await tx<{ label: string }[]>`
        SELECT to_char(p.start_date, 'YYYY-MM') AS label
          FROM fiscal_period p
         WHERE p.tenant_id = ${ctx.tenantId}
           AND p.start_date < ${toIsoDate(period.start_date)}::date
           AND p.status = 'OPEN'
         ORDER BY p.start_date
         LIMIT 1
    `;

    if (earlier) {
      throw new PeriodError(
        'EARLIER_PERIOD_OPEN',
        `Period ${earlier.label} is still open. Closing a later period first would make ` +
          'figures final that sit on top of comparatives which can still move.',
        { earliestOpen: earlier.label },
      );
    }
  }

  // `now()` has to be evaluated by PostgreSQL, not bound as a parameter — a
  // bound 'now()' is the seven-character string, and casting it to timestamptz
  // yields an invalid value rather than an error, which then surfaces somewhere
  // unrelated as "Invalid time value".
  const [updated] = await tx<{ id: string }[]>`
      UPDATE fiscal_period
         SET status    = ${input.status},
             locked_by = CASE WHEN ${input.status} = 'OPEN'
                              THEN NULL ELSE ${ctx.userId ?? null}::uuid END,
             locked_at = CASE WHEN ${input.status} = 'OPEN' THEN NULL ELSE now() END
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.periodId}
      RETURNING id
  `;

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId},
          ${reopening ? 'PERIOD_UNLOCKED' : 'PERIOD_LOCKED'},
          ${ctx.userId ?? null}, 'period.lock', 'fiscal_period', ${updated!.id},
          ${tx.json({
            from: period.status,
            to: input.status,
            periodStart: toIsoDate(period.start_date),
            periodEnd: toIsoDate(period.end_date),
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
          })}
      )
  `;

  const [view] = await listPeriods(tx, ctx, {}).then((all) =>
    all.filter((p) => p.id === input.periodId),
  );

  return view!;
}
