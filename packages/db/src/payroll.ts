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
  monthlyTaxDeduction,
  type ContributionSubject,
  type EisBand,
  type EpfBand,
  type EpfPart,
  type EpfRule,
  type MonthlyContributions,
  type MtdBand,
  type MtdEmployee,
  type MtdMonth,
  type MtdReliefs,
  type MtdSchedule,
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
  /**
   * Wage plus every employer contribution — what leaves the bank each month for
   * this person.
   *
   * Summed here rather than left to the caller, because the caller is a browser
   * and `apps/web` holds no arithmetic. A screen that added two money strings
   * would need parseFloat, and the moment it needs parseFloat the calculation
   * belongs on this side.
   */
  readonly totalEmploymentCost: string;
}

/**
 * Contributions for one person, for one month.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT RETURN: NET PAY.
 *
 * PCB — the fourth statutory deduction — IS implemented, in `computePayslip`
 * below. It is not here because it needs things this function is never told:
 * who the employee is for tax purposes, and where they are in the tax year.
 * Reaching for a default would produce a confident wrong answer, so the field
 * is called `wageAfterContributions`, which is exactly what it is, and the
 * caller that wants a take-home figure asks the function that can compute one.
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
    totalEmploymentCost: wage.add(result.totalEmployer).toDecimalString(),
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
  return { breakdown, totalCost: breakdown.totalEmploymentCost };
}

// ---------------------------------------------------------------------------
// PCB / MTD — the fourth statutory deduction
// ---------------------------------------------------------------------------

/**
 * Load Table 1 and the relief limits, as at a date.
 *
 * Both are pinned to the same `effective_from` for the same reason the EPF
 * bands and their percentage tail are: a Budget changes the table and the
 * limits together, and one year's bands applied with another year's reliefs
 * would produce a figure that exists in no published schedule while looking
 * entirely reasonable.
 */
export async function loadMtdSchedule(tx: Tx, asOf: string): Promise<MtdSchedule> {
  const [reliefRow] = await tx<
    {
      individual: string;
      spouse: string;
      per_child: string;
      disabled_individual: string;
      disabled_spouse: string;
      epf_annual_limit: string;
      non_resident_rate_bp: number;
      effective_from: Date;
    }[]
  >`
      SELECT individual, spouse, per_child, disabled_individual, disabled_spouse,
             epf_annual_limit, non_resident_rate_bp, effective_from
        FROM statutory_mtd_relief
       WHERE effective_from <= ${asOf}::date
       ORDER BY effective_from DESC
       LIMIT 1
  `;

  if (reliefRow === undefined) {
    throw new PayrollError(
      'NO_SCHEDULE_IN_FORCE',
      `No PCB relief schedule is in force on ${asOf}. This system carries the 2026 ` +
        'specification; an earlier year needs that year’s specification loaded as ' +
        'its own effective-dated rows, not this one applied backwards.',
      { asOf },
    );
  }

  const bands = await tx<
    {
      p_from: string;
      p_to: string | null;
      m: string;
      rate_bp: number;
      b_category_1_3: string;
      b_category_2: string;
    }[]
  >`
      SELECT p_from, p_to, m, rate_bp, b_category_1_3, b_category_2
        FROM statutory_mtd_band
       WHERE effective_from = ${reliefRow.effective_from}
       ORDER BY p_from
  `;

  if (bands.length === 0) {
    throw new PayrollError(
      'NO_SCHEDULE_IN_FORCE',
      `PCB reliefs are in force on ${asOf} but Table 1 is empty for the same ` +
        'effective date. Half a schedule cannot be applied.',
      { asOf },
    );
  }

  const reliefs: MtdReliefs = {
    individual: reliefRow.individual,
    spouse: reliefRow.spouse,
    perChild: reliefRow.per_child,
    disabledIndividual: reliefRow.disabled_individual,
    disabledSpouse: reliefRow.disabled_spouse,
    epfAnnualLimit: reliefRow.epf_annual_limit,
    nonResidentRateBp: reliefRow.non_resident_rate_bp,
  };

  const loaded: MtdBand[] = bands.map((b) => ({
    pFrom: b.p_from,
    pTo: b.p_to,
    m: b.m,
    rateBp: b.rate_bp,
    bCategory13: b.b_category_1_3,
    bCategory2: b.b_category_2,
  }));

  return { bands: loaded, reliefs };
}

export interface PayslipQuery {
  readonly wage: string;
  readonly subject: ContributionSubject;
  /** The contribution month, `YYYY-MM-DD`. Its MONTH drives the MTD projection. */
  readonly asOf: string;
  /** Who the employee is for tax purposes. Absent means PCB is not computed. */
  readonly tax?: MtdEmployee;
  /**
   * Where the employee is in the tax year. Absent for a first estimate; a real
   * payroll run must supply it or every month is computed as though it were the
   * first, which under-deducts all year.
   */
  readonly taxYearToDate?: {
    readonly accumulatedGross: string;
    readonly accumulatedEpf: string;
    readonly accumulatedMtd: string;
    readonly accumulatedOptionalDeductions?: string;
    readonly optionalDeductionsThisMonth?: string;
    readonly accumulatedZakat?: string;
    readonly zakatThisMonth?: string;
  };
  /** A bonus or other additional remuneration paid this month. */
  readonly bonus?: string;
}

export interface Payslip extends ContributionBreakdown {
  readonly pcb: {
    /** P — total chargeable income for the year, on this month's projection. */
    readonly chargeableIncome: string;
    readonly deduction: string;
    /** The portion attributable to a bonus, when there is one. */
    readonly onBonus: string;
    readonly nonResident: boolean;
  } | null;
  /**
   * Wage + bonus, less EPF, SOCSO, EIS and PCB. This IS net pay when `pcb` is
   * present — and is deliberately null when it is not, rather than falling back
   * to a figure that omits income tax and looks the same.
   */
  readonly netPay: string | null;
  /**
   * Everything taken off the pay: contributions AND tax. Null alongside
   * `netPay` for the same reason, and summed here for the same reason
   * `totalEmploymentCost` is — a payslip that showed "746.30 + 207.50" would be
   * asking the reader to do the arithmetic the system exists to do.
   */
  readonly totalDeducted: string | null;
}

/**
 * The whole payslip: contributions and income tax together.
 *
 * ---------------------------------------------------------------------------
 * `netPay` IS NULL UNLESS `tax` WAS SUPPLIED, AND THAT IS THE POINT.
 *
 * A net pay figure that silently omits PCB is worse than no figure, because it
 * looks finished and will be believed. So the caller must say who the employee
 * is for tax purposes — category, children, residence — before this will
 * produce one. There is no default category: "single" is a guess that
 * over-deducts a married sole earner by RM4,000 of relief a year.
 * ---------------------------------------------------------------------------
 */
export async function computePayslip(tx: Tx, query: PayslipQuery): Promise<Payslip> {
  const contributions = await computeContributions(tx, {
    wage: query.wage,
    subject: query.subject,
    asOf: query.asOf,
  });

  if (query.tax === undefined) {
    return { ...contributions, pcb: null, netPay: null, totalDeducted: null };
  }

  const schedule = await loadMtdSchedule(tx, query.asOf);

  // The MONTH, not the date. `n` — the balance of months in the year — is what
  // the whole projection turns on, and taking it from the asOf date rather than
  // asking for it separately means the two can never disagree.
  const month = Number(query.asOf.slice(5, 7));

  const ytd = query.taxYearToDate;
  const mtdMonth: MtdMonth = {
    month,
    accumulatedGross: ytd?.accumulatedGross ?? '0',
    accumulatedEpf: ytd?.accumulatedEpf ?? '0',
    grossThisMonth: contributions.wage,
    // K1 is the employee's EPF for the month — the figure the contributions
    // engine just looked up, not a percentage recomputed here.
    epfThisMonth: contributions.epf.employee,
    ...(query.bonus !== undefined ? { additionalThisMonth: query.bonus } : {}),
    ...(ytd?.accumulatedMtd !== undefined ? { accumulatedMtd: ytd.accumulatedMtd } : {}),
    ...(ytd?.accumulatedOptionalDeductions !== undefined
      ? { accumulatedOptionalDeductions: ytd.accumulatedOptionalDeductions }
      : {}),
    ...(ytd?.optionalDeductionsThisMonth !== undefined
      ? { optionalDeductionsThisMonth: ytd.optionalDeductionsThisMonth }
      : {}),
    ...(ytd?.accumulatedZakat !== undefined ? { accumulatedZakat: ytd.accumulatedZakat } : {}),
    ...(ytd?.zakatThisMonth !== undefined ? { zakatThisMonth: ytd.zakatThisMonth } : {}),
  };

  const result = monthlyTaxDeduction(query.tax, mtdMonth, schedule);

  const gross = Money.fromDecimal(contributions.wage, 'MYR').add(
    Money.fromDecimal(query.bonus ?? '0', 'MYR'),
  );
  const netPay = gross
    .subtract(Money.fromDecimal(contributions.totalEmployee, 'MYR'))
    .subtract(result.mtd);

  return {
    ...contributions,
    pcb: {
      chargeableIncome: result.chargeableIncome.toDecimalString(),
      deduction: result.mtd.toDecimalString(),
      onBonus: result.mtdOnAdditional.toDecimalString(),
      nonResident: result.nonResident,
    },
    netPay: netPay.toDecimalString(),
    totalDeducted: Money.fromDecimal(contributions.totalEmployee, 'MYR')
      .add(result.mtd)
      .toDecimalString(),
  };
}
