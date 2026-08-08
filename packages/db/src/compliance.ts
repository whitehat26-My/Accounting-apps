import {
  deadlineStatus,
  expandCalendar,
  type DeadlineInstance,
  type DeadlineRule,
  type DeadlineStatus,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { businessToday } from './internal.js';

/**
 * The compliance calendar service — rules from the database, facts from the
 * tenant, statuses from the pure domain function.
 *
 * The statuses read REAL data: a payroll deadline knows whether the pay run
 * it depends on is confirmed, because "CP39 due on the 15th" is only useful
 * next to "and the file you need exists / does not exist yet".
 */

export class ComplianceError extends Error {
  constructor(
    readonly code: 'RULE_NOT_FOUND' | 'TICK_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'ComplianceError';
  }
}

export interface CalendarEntry extends DeadlineInstance {
  readonly label: string;
  readonly description: string;
  readonly legislationRef: string;
  /** SECONDARY means "agency page confirmed, primary document not yet committed". */
  readonly verification: 'PRIMARY' | 'SECONDARY';
  readonly status: DeadlineStatus;
  readonly ticked: {
    readonly at: string;
    readonly note: string | null;
  } | null;
}

export interface ComplianceCalendar {
  readonly year: number;
  readonly today: string;
  /** Why payroll/SST rows are present or absent — stated, not implied. */
  readonly applies: { readonly payroll: boolean; readonly sst: boolean };
  readonly entries: readonly CalendarEntry[];
}

interface RuleRow {
  code: string;
  label: string;
  description: string;
  frequency: DeadlineRule['frequency'];
  due_day: number | null;
  due_month: number | null;
  applies_when: DeadlineRule['appliesWhen'];
  legislation_ref: string;
  verification: 'PRIMARY' | 'SECONDARY';
}

export async function complianceCalendar(
  tx: Tx,
  ctx: TenantContext,
  year: number,
): Promise<ComplianceCalendar> {
  const today = businessToday();

  const ruleRows = await tx<RuleRow[]>`
      SELECT code, label, description, frequency, due_day, due_month,
             applies_when, legislation_ref, verification
        FROM statutory_deadline_rule
       WHERE effective_from <= ${`${year}-12-31`}
         AND (effective_to IS NULL OR effective_to >= ${`${year}-01-01`})
       ORDER BY code
  `;

  // Which rule families exist for THIS shop.
  const [staff] = await tx<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM employee WHERE tenant_id = ${ctx.tenantId}
  `;
  const [org] = await tx<{ sst_no: string | null }[]>`
      SELECT sst_no FROM organisation WHERE id = ${ctx.tenantId}
  `;
  const applies = {
    payroll: Number(staff!.n) > 0,
    sst: org!.sst_no !== null && org!.sst_no.trim() !== '',
  };

  const rules: DeadlineRule[] = ruleRows
    .filter(
      (r) =>
        r.applies_when === 'ALWAYS' ||
        (r.applies_when === 'PAYROLL' && applies.payroll) ||
        (r.applies_when === 'SST' && applies.sst),
    )
    .map((r) => ({
      code: r.code,
      label: r.label,
      description: r.description,
      frequency: r.frequency,
      dueDay: r.due_day,
      dueMonth: r.due_month,
      appliesWhen: r.applies_when,
      legislationRef: r.legislation_ref,
      verification: r.verification,
    }));

  const instances = expandCalendar(rules, year);

  const ticks = await tx<{ rule_code: string; period_key: string; ticked_at: Date; note: string | null }[]>`
      SELECT rule_code, period_key, ticked_at, note FROM compliance_tick
       WHERE tenant_id = ${ctx.tenantId}
  `;
  const tickByKey = new Map(ticks.map((t) => [`${t.rule_code}|${t.period_key}`, t]));

  // One query for every confirmed/any run the payroll instances reference.
  const runs = await tx<{ pay_month: Date; status: string }[]>`
      SELECT pay_month, status FROM pay_run WHERE tenant_id = ${ctx.tenantId}
  `;
  const runByMonth = new Map(
    runs.map((r) => [r.pay_month.toISOString().slice(0, 10), r.status]),
  );

  const byCode = new Map(rules.map((r) => [r.code, r]));

  const entries = instances.map((instance): CalendarEntry => {
    const rule = byCode.get(instance.ruleCode)!;
    const tick = tickByKey.get(`${instance.ruleCode}|${instance.periodKey}`);

    let artifactReady: boolean | undefined;
    let artifactMissing: boolean | undefined;
    if (instance.payMonth !== null && rule.appliesWhen === 'PAYROLL') {
      const runStatus = runByMonth.get(instance.payMonth);
      artifactReady = runStatus === 'CONFIRMED';
      // The covered month has fully ended and nothing is confirmed for it.
      const monthEnded = instance.payMonth.slice(0, 7) < today.slice(0, 7);
      artifactMissing = monthEnded && runStatus !== 'CONFIRMED';
    }

    return {
      ...instance,
      label: rule.label,
      description: rule.description,
      legislationRef: rule.legislationRef,
      verification: rule.verification,
      status: deadlineStatus({
        dueDate: instance.dueDate,
        today,
        ticked: tick !== undefined,
        ...(artifactReady !== undefined ? { artifactReady } : {}),
        ...(artifactMissing !== undefined ? { artifactMissing } : {}),
      }),
      ticked: tick ? { at: tick.ticked_at.toISOString(), note: tick.note } : null,
    };
  });

  return { year, today, applies, entries };
}

/** Mark a filing done. Idempotent: ticking twice keeps the first record. */
export async function tickDeadline(
  tx: Tx,
  ctx: TenantContext,
  input: { readonly ruleCode: string; readonly periodKey: string; readonly note?: string },
): Promise<{ ruleCode: string; periodKey: string; replayed: boolean }> {
  const [rule] = await tx<{ code: string }[]>`
      SELECT DISTINCT code FROM statutory_deadline_rule WHERE code = ${input.ruleCode}
  `;
  if (!rule) throw new ComplianceError('RULE_NOT_FOUND', `No deadline rule ${input.ruleCode}.`);

  const inserted = await tx<{ id: string }[]>`
      INSERT INTO compliance_tick (tenant_id, rule_code, period_key, note, ticked_by)
      VALUES (${ctx.tenantId}, ${input.ruleCode}, ${input.periodKey},
              ${input.note ?? null}, ${ctx.userId ?? null})
      ON CONFLICT (tenant_id, rule_code, period_key) DO NOTHING
      RETURNING id
  `;
  return { ruleCode: input.ruleCode, periodKey: input.periodKey, replayed: inserted.length === 0 };
}

/**
 * Undo a mistaken tick. A DELETE, deliberately: the audit trigger records
 * both the tick and its removal, which IS the paper trail — a soft-delete
 * column would duplicate what 0016 already guarantees.
 */
export async function untickDeadline(
  tx: Tx,
  ctx: TenantContext,
  input: { readonly ruleCode: string; readonly periodKey: string },
): Promise<void> {
  const deleted = await tx<{ id: string }[]>`
      DELETE FROM compliance_tick
       WHERE tenant_id = ${ctx.tenantId}
         AND rule_code = ${input.ruleCode} AND period_key = ${input.periodKey}
      RETURNING id
  `;
  if (deleted.length === 0) {
    throw new ComplianceError(
      'TICK_NOT_FOUND',
      `${input.ruleCode} for ${input.periodKey} is not marked done.`,
    );
  }
}
