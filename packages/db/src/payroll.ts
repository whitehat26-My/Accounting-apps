/**
 * PayrollService — loading the statutory schedules and applying them.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE DOES NO ARITHMETIC. IT IS A LOADER.
 *
 * Every figure comes out of `statutory_epf_band`, `statutory_socso_band` and
 * `statutory_eis_band`, and every calculation happens in
 * `packages/domain/src/payroll.ts`, which is pure and tested against all 1,203
 * published EPF bands row for row. The split is deliberate: a contribution
 * engine that reaches into a database cannot be exercised at that volume, and
 * one that cannot be exercised at that volume is one nobody trusts.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEDULES ARE EFFECTIVE-DATED, AND THE DATE THAT MATTERS IS THE
 * CONTRIBUTION MONTH — NOT TODAY.
 *
 * SKBBK started on 1 June 2026. A payroll re-run for May 2026 must produce May's
 * figures, and a system that reads "the current schedule" silently restates
 * history the first time a rate changes. So `asOf` is required at every entry
 * point, there is no default of `now()`, and the rows selected are the ones with
 * the greatest `effective_from` at or before it. CLAUDE.md rule 7.
 * ---------------------------------------------------------------------------
 */

import {
  Money,
  epfPart,
  monthlyContributions,
  type ContributionSubject,
  type EisBand,
  type EpfBand,
  type EpfPart,
  type EpfRule,
  type MonthlyContributions,
  type SocsoBand,
  type StatutorySchedules,
} from '@emil/domain';

import type { Tx } from './client.js';

export class PayrollError extends Error {
  constructor(
    readonly code: 'NO_SCHEDULE_IN_FORCE' | 'INVALID_WAGE',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'PayrollError';
  }
}

/**
 * The EPF Part is resolved BEFORE the bands are loaded, because the bands are
 * per-Part: loading all three and picking one afterwards would move three
 * times the rows for no reason, and would let a caller apply Part A's table to
 * a 62-year-old by passing the wrong argument.
 */
async function loadEpf(
  tx: Tx,
  part: EpfPart,
  asOf: string,
): Promise<{ bands: EpfBand[]; rule: EpfRule }> {
  const [rule] = await tx<
    {
      ceiling: string | null;
      employer_rate_bp: number;
      employee_rate_bp: number;
      effective_from: Date;
    }[]
  >`
      SELECT ceiling, employer_rate_bp, employee_rate_bp, effective_from
        FROM statutory_epf_rule
       WHERE part = ${part}
         AND effective_from <= ${asOf}::date
       ORDER BY effective_from DESC
       LIMIT 1
  `;

  if (rule === undefined) {
    throw new PayrollError(
      'NO_SCHEDULE_IN_FORCE',
      `No EPF rule for Part ${part} is in force on ${asOf}. The Third Schedule is ` +
        'seeded by migration 0037; a missing Part means either a date before the ' +
        'earliest schedule this system carries, or an unapplied migration.',
      { part, asOf },
    );
  }

  // Part F is a flat percentage from the first ringgit and has no table at all.
  // Asking for its bands would return nothing, which is correct and would still
  // look like a fault, so it is not asked.
  if (rule.ceiling === null) {
    return {
      bands: [],
      rule: {
        ceiling: null,
        employerRateBp: rule.employer_rate_bp,
        employeeRateBp: rule.employee_rate_bp,
      },
    };
  }

  /*
   * The bands are pinned to the SAME `effective_from` as the rule, not merely
   * to one at or before `asOf`. Mixing a 2025 table with a 2026 percentage tail
   * would produce figures that exist in no published schedule — and would do it
   * quietly, since both halves are individually plausible.
   */
  const bands = await tx<
    { wage_from: string; wage_to: string; employer: string; employee: string }[]
  >`
      SELECT wage_from, wage_to, employer, employee
        FROM statutory_epf_band
       WHERE part = ${part}
         AND effective_from = (
               SELECT MAX(effective_from)
                 FROM statutory_epf_band
                WHERE part = ${part} AND effective_from <= ${asOf}::date
             )
       ORDER BY wage_from
  `;

  if (bands.length === 0) {
    throw new PayrollError(
      'NO_SCHEDULE_IN_FORCE',
      `EPF Part ${part} has a rule in force on ${asOf} but no bands. A banded Part ` +
        'without its table cannot be applied.',
      { part, asOf },
    );
  }

  return {
    bands: bands.map((b) => ({
      wageFrom: b.wage_from,
      wageTo: b.wage_to,
      employer: b.employer,
      employee: b.employee,
    })),
    rule: {
      ceiling: rule.ceiling,
      employerRateBp: rule.employer_rate_bp,
      employeeRateBp: rule.employee_rate_bp,
    },
  };
}

async function loadSocso(tx: Tx, asOf: string): Promise<SocsoBand[]> {
  const rows = await tx<
    {
      wage_from: string;
      wage_to: string | null;
      cat1_employer: string;
      cat1_employee_invalidity: string;
      cat1_employee_skbbk: string;
      cat2_employer: string;
      cat2_employee_skbbk: string;
    }[]
  >`
      SELECT wage_from, wage_to, cat1_employer, cat1_employee_invalidity,
             cat1_employee_skbbk, cat2_employer, cat2_employee_skbbk
        FROM statutory_socso_band
       WHERE effective_from = (
               SELECT MAX(effective_from)
                 FROM statutory_socso_band
                WHERE effective_from <= ${asOf}::date
             )
       ORDER BY wage_from
  `;

  if (rows.length === 0) {
    throw new PayrollError(
      'NO_SCHEDULE_IN_FORCE',
      `No SOCSO schedule is in force on ${asOf}.`,
      { asOf },
    );
  }

  return rows.map((r) => ({
    wageFrom: r.wage_from,
    wageTo: r.wage_to,
    cat1Employer: r.cat1_employer,
    cat1EmployeeInvalidity: r.cat1_employee_invalidity,
    cat1EmployeeSkbbk: r.cat1_employee_skbbk,
    cat2Employer: r.cat2_employer,
    cat2EmployeeSkbbk: r.cat2_employee_skbbk,
  }));
}

async function loadEis(tx: Tx, asOf: string): Promise<EisBand[]> {
  const rows = await tx<
    { wage_from: string; wage_to: string | null; employer: string; employee: string }[]
  >`
      SELECT wage_from, wage_to, employer, employee
        FROM statutory_eis_band
       WHERE effective_from = (
               SELECT MAX(effective_from)
                 FROM statutory_eis_band
                WHERE effective_from <= ${asOf}::date
             )
       ORDER BY wage_from
  `;

  if (rows.length === 0) {
    throw new PayrollError(
      'NO_SCHEDULE_IN_FORCE',
      `No EIS schedule is in force on ${asOf}.`,
      { asOf },
    );
  }

  return rows.map((r) => ({
    wageFrom: r.wage_from,
    wageTo: r.wage_to,
    employer: r.employer,
    employee: r.employee,
  }));
}

/**
 * Load every schedule a contribution calculation needs, as at one date.
 *
 * Exposed separately from the calculation because a payroll run computes for a
 * whole staff list against ONE month: loading the tables once and applying them
 * many times is the difference between four queries and four hundred.
 */
export async function loadStatutorySchedules(
  tx: Tx,
  part: EpfPart,
  asOf: string,
): Promise<StatutorySchedules> {
  const [epf, socsoBands, eisBands] = await Promise.all([
    loadEpf(tx, part, asOf),
    loadSocso(tx, asOf),
    loadEis(tx, asOf),
  ]);

  return {
    epfBands: epf.bands,
    epfRule: epf.rule,
    socsoBands,
    eisBands,
  };
}

export interface ContributionQuery {
  /** Monthly wage as a decimal string, in MYR. Never a JS number — rule 2. */
  readonly wage: string;
  readonly subject: ContributionSubject;
  /** The contribution month, as `YYYY-MM-DD`. Required, never defaulted. */
  readonly asOf: string;
}

/** What a payslip line needs, as strings ready to render. */
export interface ContributionBreakdown {
  readonly wage: string;
  readonly asOf: string;
  readonly epfPart: EpfPart;
  readonly socsoCategory: 1 | 2;
  readonly eisApplies: boolean;
  readonly epf: { readonly employer: string; readonly employee: string };
  readonly socso: {
    readonly employer: string;
    readonly employee: string;
    readonly employeeInvalidity: string;
    readonly employeeSkbbk: string;
  };
  readonly eis: { readonly employer: string; readonly employee: string };
  readonly totalEmployee: string;
  readonly totalEmployer: string;
  /** Wage less the employee's statutory deductions. NOT net pay — PCB is not applied. */
  readonly wageAfterContributions: string;
}

/**
 * Contributions for one person, for one month.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT RETURN: NET PAY.
 *
 * PCB (Monthly Tax Deduction) is the fourth statutory deduction and it is NOT
 * implemented — LHDN's computerised-calculation specification defines five
 * formulae and reliefs this system has not yet transcribed, and a "net pay"
 * figure that silently omits income tax is worse than no figure, because it
 * looks complete. So the field is called `wageAfterContributions`, which is
 * exactly what it is, and `docs/SETTLEMENT-REGISTER.md` names the unblocker.
 * ---------------------------------------------------------------------------
 */
export async function computeContributions(
  tx: Tx,
  query: ContributionQuery,
): Promise<ContributionBreakdown> {
  let wage: Money;
  try {
    wage = Money.fromDecimal(query.wage, 'MYR');
  } catch (cause) {
    throw new PayrollError(
      'INVALID_WAGE',
      `"${query.wage}" is not a wage amount. Wages are decimal strings in MYR.`,
      { cause },
    );
  }

  if (wage.isNegative()) {
    throw new PayrollError(
      'INVALID_WAGE',
      'A negative wage has no contribution. A deduction from a previous month is ' +
        'an adjustment to that month, not a negative wage in this one.',
    );
  }

  const part = epfPart(query.subject);
  const schedules = await loadStatutorySchedules(tx, part, query.asOf);
  const result: MonthlyContributions = monthlyContributions(wage, query.subject, schedules);

  return {
    wage: wage.toDecimalString(),
    asOf: query.asOf,
    epfPart: result.epfPart,
    socsoCategory: result.socsoCategory,
    eisApplies: result.eisApplies,
    epf: {
      employer: result.epf.employer.toDecimalString(),
      employee: result.epf.employee.toDecimalString(),
    },
    socso: {
      employer: result.socso.employer.toDecimalString(),
      employee: result.socso.employee.toDecimalString(),
      employeeInvalidity: result.socso.employeeInvalidity.toDecimalString(),
      employeeSkbbk: result.socso.employeeSkbbk.toDecimalString(),
    },
    eis: {
      employer: result.eis.employer.toDecimalString(),
      employee: result.eis.employee.toDecimalString(),
    },
    totalEmployee: result.totalEmployee.toDecimalString(),
    totalEmployer: result.totalEmployer.toDecimalString(),
    wageAfterContributions: wage.subtract(result.totalEmployee).toDecimalString(),
  };
}

/**
 * What one hire actually costs the shop per month.
 *
 * The reason this exists as its own function rather than as a note on the
 * breakdown: the owner's question is never "what is the EPF employer share", it
 * is "if I pay someone RM 2,500, what leaves my bank". That is the wage plus
 * every employer contribution, and it is a number nobody computes by hand
 * correctly on the first try.
 */
export async function employmentCost(
  tx: Tx,
  query: ContributionQuery,
): Promise<{ readonly breakdown: ContributionBreakdown; readonly totalCost: string }> {
  const breakdown = await computeContributions(tx, query);
  const totalCost = Money.fromDecimal(breakdown.wage, 'MYR')
    .add(Money.fromDecimal(breakdown.totalEmployer, 'MYR'))
    .toDecimalString();
  return { breakdown, totalCost };
}
