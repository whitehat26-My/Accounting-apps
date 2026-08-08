import { Money } from './money.js';

/**
 * Malaysian statutory payroll contributions: EPF, SOCSO and EIS.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEDULES ARE THE RULE. THE PERCENTAGES ARE A DESCRIPTION OF THEM.
 *
 * Nothing here multiplies a wage by 11% or 1.75%. All three schemes are lookup
 * tables in law — the employer owes the exact ringgit amount printed against
 * the wage band, and a percentage produces a figure that is close and wrong.
 * "Close and wrong" on a statutory deduction is the employer's liability, not
 * the employee's, which is why this module refuses to compute what it can look
 * up.
 *
 * Percentages appear in exactly one place: above the banded range, where the
 * schedules themselves stop tabulating and state a rate. Those are carried as
 * basis points so 5.5% is the integer 550 rather than a float.
 *
 * This file is pure. The bands are passed in — loaded from the effective-dated
 * tables in migration 0037 — so the rules can be tested at volume and cannot
 * quietly couple themselves to a database.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Who a person is, for contribution purposes
// ---------------------------------------------------------------------------

/**
 * The attributes that decide which schedule applies. Deliberately the minimum:
 * anything else a payroll knows about a person is irrelevant to the statutes.
 */
export interface ContributionSubject {
  /** Age in completed years at the contribution month. */
  readonly age: number;
  readonly citizenship: 'CITIZEN' | 'PERMANENT_RESIDENT' | 'NON_CITIZEN';
  /**
   * A non-citizen who elected to contribute to EPF before 1 August 1998 stays
   * on the citizen/PR schedule for life. Vanishingly rare in 2026 and still in
   * the Act, so it is modelled rather than assumed away.
   */
  readonly electedBefore1Aug1998?: boolean;
  /** Already drawing an Invalidity Pension puts a person in SOCSO Category 2. */
  readonly onInvalidityPension?: boolean;
  /**
   * EIS exempts anyone who first became liable at 57 or older. The question is
   * "was there any contribution before 57", so it is recorded rather than
   * derived from the age alone.
   */
  readonly hadEisContributionBefore57?: boolean;
}

export type EpfPart = 'A' | 'C' | 'E' | 'F';

/**
 * Which Part of the EPF Third Schedule applies.
 *
 * Parts B and D were deleted by Act A1760/2025 and cannot be returned. The
 * order of these tests matters: citizenship is decided before age, because a
 * non-citizen is Part F whatever their age.
 */
export function epfPart(subject: ContributionSubject): EpfPart {
  const onCitizenSchedule =
    subject.citizenship === 'CITIZEN' ||
    subject.citizenship === 'PERMANENT_RESIDENT' ||
    subject.electedBefore1Aug1998 === true;

  if (!onCitizenSchedule) return 'F';

  if (subject.age < 60) return 'A';

  // At 60 the schedules split by citizenship: Part E is Malaysian citizens
  // (employer only), Part C is everyone else on the citizen schedule. This is
  // the distinction every summary of "the 60+ rate" collapses, and why they
  // disagree with each other.
  return subject.citizenship === 'CITIZEN' ? 'E' : 'C';
}

/** SOCSO's two categories. */
export type SocsoCategory = 1 | 2;

export function socsoCategory(subject: ContributionSubject): SocsoCategory {
  // Category 2 — Employment Injury and SKBBK only, no Invalidity — covers those
  // past 60 and those already receiving an Invalidity Pension, for whom
  // invalidity cover would be meaningless.
  return subject.age >= 60 || subject.onInvalidityPension === true ? 2 : 1;
}

/**
 * Is this person covered by EIS at all?
 *
 * Three exclusions, all from the Act: under 18, 60 or over, and anyone who
 * first became liable at 57 or later with no earlier contribution history.
 */
export function eisApplies(subject: ContributionSubject): boolean {
  if (subject.age < 18 || subject.age >= 60) return false;
  if (subject.age >= 57 && subject.hadEisContributionBefore57 !== true) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The bands, as loaded from the statutory tables
// ---------------------------------------------------------------------------

export interface EpfBand {
  readonly wageFrom: string;
  readonly wageTo: string;
  readonly employer: string;
  readonly employee: string;
}

export interface EpfRule {
  /** Where the table stops and the percentage begins. `null` for Part F. */
  readonly ceiling: string | null;
  readonly employerRateBp: number;
  readonly employeeRateBp: number;
}

export interface SocsoBand {
  readonly wageFrom: string;
  /** `null` on the final, unbounded band. */
  readonly wageTo: string | null;
  readonly cat1Employer: string;
  readonly cat1EmployeeInvalidity: string;
  readonly cat1EmployeeSkbbk: string;
  readonly cat2Employer: string;
  readonly cat2EmployeeSkbbk: string;
}

export interface EisBand {
  readonly wageFrom: string;
  readonly wageTo: string | null;
  readonly employer: string;
  readonly employee: string;
}

export interface Contribution {
  readonly employer: Money;
  readonly employee: Money;
}

export interface SocsoContribution extends Contribution {
  /** Split out because the schedule splits them, and a payslip must too. */
  readonly employeeInvalidity: Money;
  readonly employeeSkbbk: Money;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Find the band a wage falls in.
 *
 * Bands are inclusive at both ends and contiguous — "from 200.01 to 220.00" —
 * so a wage lands in exactly one, and the final band may be unbounded above.
 * Returns undefined only for a wage below the first band, which cannot happen
 * for a non-negative wage since every schedule starts at 0.01.
 */
function findBand<T extends { wageFrom: string; wageTo: string | null }>(
  bands: readonly T[],
  wage: Money,
): T | undefined {
  for (const band of bands) {
    const from = Money.fromDecimal(band.wageFrom, wage.currency);
    if (wage.compare(from) < 0) continue;
    if (band.wageTo === null) return band;
    if (wage.compare(Money.fromDecimal(band.wageTo, wage.currency)) <= 0) return band;
  }
  return undefined;
}

/** One whole ringgit, in Money's minor units (MONEY_SCALE = 4). */
const RINGGIT = 10_000n;

/**
 * Round UP to the next whole ringgit.
 *
 * Not a rounding mode Money offers, and deliberately not added to it: this is a
 * statutory rule about contributions, not a general arithmetic convention, and
 * it belongs beside the rule it serves. An exact multiple of a ringgit is left
 * alone — "to the next ringgit" means the next one up only if there are cents.
 */
function ceilToRinggit(amount: Money): Money {
  const remainder = amount.units % RINGGIT;
  if (remainder === 0n) return amount;
  return Money.fromUnits(amount.units + (RINGGIT - remainder), amount.currency);
}

/**
 * Apply a basis-point rate and round the TOTAL up to the next ringgit.
 *
 * The rounding rule is the schedules' own, and it is on the total rather than
 * on each side — "the total contribution which includes cents shall be rounded
 * to the next ringgit". Rounding each share separately would push the total a
 * ringgit high much of the time. The employer absorbs the rounding, which is
 * the conventional treatment and never costs the employee more than the
 * statute does.
 */
function applyRate(wage: Money, employerBp: number, employeeBp: number): Contribution {
  const employerRaw = wage.multiplyRatio(BigInt(employerBp), 10_000n);
  const employeeRaw = wage.multiplyRatio(BigInt(employeeBp), 10_000n);
  const roundedTotal = ceilToRinggit(employerRaw.add(employeeRaw));
  return { employer: roundedTotal.subtract(employeeRaw), employee: employeeRaw };
}

/**
 * EPF for one month.
 *
 * Part F has no table at all — non-citizens contribute a flat 2% each from the
 * first ringgit — so it never consults the bands.
 */
export function epfContribution(
  wage: Money,
  part: EpfPart,
  bands: readonly EpfBand[],
  rule: EpfRule,
): Contribution {
  if (rule.ceiling === null) {
    return applyRate(wage, rule.employerRateBp, rule.employeeRateBp);
  }

  const ceiling = Money.fromDecimal(rule.ceiling, wage.currency);
  if (wage.compare(ceiling) > 0) {
    return applyRate(wage, rule.employerRateBp, rule.employeeRateBp);
  }

  const band = findBand(bands, wage);
  if (band === undefined) {
    throw new Error(
      `No EPF band in Part ${part} covers wages of ${wage.toDecimalString()}. The ` +
        'schedule is contiguous from 0.01, so this means the wrong Part or an ' +
        'incomplete table was loaded.',
    );
  }
  return {
    employer: Money.fromDecimal(band.employer, wage.currency),
    employee: Money.fromDecimal(band.employee, wage.currency),
  };
}

/** SOCSO for one month. Always a table lookup — there is no percentage tail. */
export function socsoContribution(
  wage: Money,
  category: SocsoCategory,
  bands: readonly SocsoBand[],
): SocsoContribution {
  const band = findBand(bands, wage);
  if (band === undefined) {
    throw new Error(`No SOCSO band covers wages of ${wage.toDecimalString()}`);
  }
  const zero = Money.zero(wage.currency);

  if (category === 1) {
    const invalidity = Money.fromDecimal(band.cat1EmployeeInvalidity, wage.currency);
    const skbbk = Money.fromDecimal(band.cat1EmployeeSkbbk, wage.currency);
    return {
      employer: Money.fromDecimal(band.cat1Employer, wage.currency),
      employeeInvalidity: invalidity,
      employeeSkbbk: skbbk,
      employee: invalidity.add(skbbk),
    };
  }

  // Category 2 has no invalidity share — but since 1 June 2026 it DOES have an
  // SKBBK share, where before it took nothing from the employee at all.
  const skbbk = Money.fromDecimal(band.cat2EmployeeSkbbk, wage.currency);
  return {
    employer: Money.fromDecimal(band.cat2Employer, wage.currency),
    employeeInvalidity: zero,
    employeeSkbbk: skbbk,
    employee: skbbk,
  };
}

/** EIS for one month, or nothing at all if the person is not covered. */
export function eisContribution(
  wage: Money,
  applies: boolean,
  bands: readonly EisBand[],
): Contribution {
  const zero = Money.zero(wage.currency);
  if (!applies) return { employer: zero, employee: zero };

  const band = findBand(bands, wage);
  if (band === undefined) {
    throw new Error(`No EIS band covers wages of ${wage.toDecimalString()}`);
  }
  return {
    employer: Money.fromDecimal(band.employer, wage.currency),
    employee: Money.fromDecimal(band.employee, wage.currency),
  };
}

// ---------------------------------------------------------------------------
// The whole month, for one person
// ---------------------------------------------------------------------------

export interface StatutorySchedules {
  readonly epfBands: readonly EpfBand[];
  readonly epfRule: EpfRule;
  readonly socsoBands: readonly SocsoBand[];
  readonly eisBands: readonly EisBand[];
}

export interface MonthlyContributions {
  readonly epfPart: EpfPart;
  readonly socsoCategory: SocsoCategory;
  readonly eisApplies: boolean;
  readonly epf: Contribution;
  readonly socso: SocsoContribution;
  readonly eis: Contribution;
  /** What leaves the employee's pay. */
  readonly totalEmployee: Money;
  /** What the shop pays ON TOP of the wage — the real cost of employing. */
  readonly totalEmployer: Money;
}

export function monthlyContributions(
  wage: Money,
  subject: ContributionSubject,
  schedules: StatutorySchedules,
): MonthlyContributions {
  const part = epfPart(subject);
  const category = socsoCategory(subject);
  const eisCovered = eisApplies(subject);

  const epf = epfContribution(wage, part, schedules.epfBands, schedules.epfRule);
  const socso = socsoContribution(wage, category, schedules.socsoBands);
  const eis = eisContribution(wage, eisCovered, schedules.eisBands);

  return {
    epfPart: part,
    socsoCategory: category,
    eisApplies: eisCovered,
    epf,
    socso,
    eis,
    totalEmployee: epf.employee.add(socso.employee).add(eis.employee),
    totalEmployer: epf.employer.add(socso.employer).add(eis.employer),
  };
}
