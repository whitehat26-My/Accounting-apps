import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import {
  eisApplies,
  eisContribution,
  epfContribution,
  epfPart,
  monthlyContributions,
  socsoCategory,
  socsoContribution,
  type ContributionSubject,
  type EisBand,
  type EpfBand,
  type EpfRule,
  type SocsoBand,
} from '../src/payroll.js';

/**
 * The statutory schedules, read from the SAME CSVs the migration is generated
 * from. Testing against a hand-typed subset would only prove the subset was
 * typed consistently; this proves the engine agrees with the published tables
 * row for row.
 */
const src = (name: string) =>
  fileURLToPath(new URL(`../../../docs/research/sources/${name}`, import.meta.url));

function csv(name: string): Record<string, string>[] {
  const lines = readFileSync(src(name), 'utf8').trim().split('\n');
  const head = lines[0]!.split(',');
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ''])) as Record<string, string>;
  });
}

const epfRows = csv('epf-third-schedule-2025-10-01.csv');
const socsoRows = csv('socso-akta4-skbbk-from-2026-06-01.csv');
const eisRows = csv('eis-akta800-from-2024-10-01.csv');

const epfBands = (part: string): EpfBand[] =>
  epfRows.filter((r) => r['part'] === part).map((r) => ({
    wageFrom: r['wage_from']!, wageTo: r['wage_to']!,
    employer: r['employer']!, employee: r['employee']!,
  }));

const socsoBands: SocsoBand[] = socsoRows.map((r) => ({
  wageFrom: r['wage_from']!,
  wageTo: r['wage_to'] === '' ? null : r['wage_to']!,
  cat1Employer: r['cat1_employer']!,
  cat1EmployeeInvalidity: r['cat1_employee_invalidity']!,
  cat1EmployeeSkbbk: r['cat1_employee_skbbk']!,
  cat2Employer: r['cat2_employer']!,
  cat2EmployeeSkbbk: r['cat2_employee_skbbk']!,
}));

const eisBands: EisBand[] = eisRows.map((r) => ({
  wageFrom: r['wage_from']!,
  wageTo: r['wage_to'] === '' ? null : r['wage_to']!,
  employer: r['employer']!, employee: r['employee']!,
}));

const RULES: Record<string, EpfRule> = {
  A: { ceiling: '20000', employerRateBp: 1200, employeeRateBp: 1100 },
  C: { ceiling: '20000', employerRateBp: 600, employeeRateBp: 550 },
  E: { ceiling: '20000', employerRateBp: 400, employeeRateBp: 0 },
  F: { ceiling: null, employerRateBp: 200, employeeRateBp: 200 },
};

const rm = (v: string) => Money.fromDecimal(v, 'MYR');
const person = (over: Partial<ContributionSubject> = {}): ContributionSubject => ({
  age: 30, citizenship: 'CITIZEN', ...over,
});

// ---------------------------------------------------------------------------

describe('which schedule applies', () => {
  it('picks the EPF Part by citizenship first, then age', () => {
    expect(epfPart(person({ age: 30, citizenship: 'CITIZEN' }))).toBe('A');
    expect(epfPart(person({ age: 30, citizenship: 'PERMANENT_RESIDENT' }))).toBe('A');
    // The distinction every summary of "the 60+ rate" collapses.
    expect(epfPart(person({ age: 60, citizenship: 'CITIZEN' }))).toBe('E');
    expect(epfPart(person({ age: 60, citizenship: 'PERMANENT_RESIDENT' }))).toBe('C');
    // A non-citizen is Part F whatever their age.
    expect(epfPart(person({ age: 30, citizenship: 'NON_CITIZEN' }))).toBe('F');
    expect(epfPart(person({ age: 70, citizenship: 'NON_CITIZEN' }))).toBe('F');
  });

  it('keeps a pre-1998 elector on the citizen schedule', () => {
    expect(epfPart(person({ age: 30, citizenship: 'NON_CITIZEN', electedBefore1Aug1998: true })))
      .toBe('A');
  });

  it('never returns a deleted Part (property)', () => {
    // Parts B and D were deleted by Act A1760/2025 and must be unreachable.
    fc.assert(
      fc.property(
        fc.integer({ min: 14, max: 80 }),
        fc.constantFrom('CITIZEN', 'PERMANENT_RESIDENT', 'NON_CITIZEN'),
        fc.boolean(),
        (age, citizenship, elected) => {
          const part = epfPart({ age, citizenship: citizenship as never, electedBefore1Aug1998: elected });
          expect(['A', 'C', 'E', 'F']).toContain(part);
        },
      ),
    );
  });

  it('puts the over-60s and invalidity pensioners in SOCSO Category 2', () => {
    expect(socsoCategory(person({ age: 59 }))).toBe(1);
    expect(socsoCategory(person({ age: 60 }))).toBe(2);
    expect(socsoCategory(person({ age: 40, onInvalidityPension: true }))).toBe(2);
  });

  it('applies the three EIS exclusions', () => {
    expect(eisApplies(person({ age: 17 }))).toBe(false);
    expect(eisApplies(person({ age: 18 }))).toBe(true);
    expect(eisApplies(person({ age: 60 }))).toBe(false);
    // 57 or over with no history before 57 is exempt; with history, covered.
    expect(eisApplies(person({ age: 58 }))).toBe(false);
    expect(eisApplies(person({ age: 58, hadEisContributionBefore57: true }))).toBe(true);
  });
});

describe('EPF against the Third Schedule', () => {
  it('returns the schedule amount for EVERY band in Parts A, C and E', () => {
    // The test that matters: 1,203 assertions that the engine agrees with the
    // legal instrument rather than with a percentage.
    let checked = 0;
    for (const part of ['A', 'C', 'E'] as const) {
      const bands = epfBands(part);
      for (const band of bands) {
        // Probe at both ends of the band and just inside the top.
        for (const wage of [band.wageFrom, band.wageTo]) {
          const got = epfContribution(rm(wage), part, bands, RULES[part]!);
          expect(got.employer.toDecimalString()).toBe(rm(band.employer).toDecimalString());
          expect(got.employee.toDecimalString()).toBe(rm(band.employee).toDecimalString());
          checked++;
        }
      }
    }
    expect(checked).toBe(1203 * 2);
  });

  it('the known percentages fall out of the bands rather than being applied', () => {
    const A = epfBands('A');
    // 13% employer below RM5,000, 11% employee.
    const at3000 = epfContribution(rm('3000'), 'A', A, RULES['A']!);
    expect(at3000.employer.toDecimalString()).toBe('390.0000');
    expect(at3000.employee.toDecimalString()).toBe('330.0000');
    // 12% employer at the top of the table.
    const at20000 = epfContribution(rm('20000'), 'A', A, RULES['A']!);
    expect(at20000.employer.toDecimalString()).toBe('2400.0000');
    // Part E takes nothing from a Malaysian citizen aged 60+.
    const e = epfContribution(rm('20000'), 'E', epfBands('E'), RULES['E']!);
    expect(e.employee.isZero()).toBe(true);
    expect(e.employer.toDecimalString()).toBe('800.0000');
  });

  it('switches to percentages above RM20,000 and rounds the total up', () => {
    // 11% + 12% of 20,000.01 = 4,600.0023, which rounds up to 4,601.
    const got = epfContribution(rm('20000.01'), 'A', epfBands('A'), RULES['A']!);
    const total = got.employer.add(got.employee);
    expect(total.toDecimalString()).toBe('4601.0000');
    // The employee's share stays exact; the employer absorbs the rounding.
    expect(got.employee.toDecimalString()).toBe('2200.0011');
  });

  it('Part F is a flat 2% each from the first ringgit, with no table', () => {
    const got = epfContribution(rm('1500'), 'F', [], RULES['F']!);
    expect(got.employee.toDecimalString()).toBe('30.0000');
    // 30 + 30 = 60, already a whole ringgit, so nothing to round.
    expect(got.employer.toDecimalString()).toBe('30.0000');
  });

  it('the total is never below the statutory total (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000_000 }), (sen) => {
        const wage = Money.fromUnits(BigInt(sen) * 100n, 'MYR');
        const got = epfContribution(wage, 'A', epfBands('A'), RULES['A']!);
        expect(got.employer.isNegative()).toBe(false);
        expect(got.employee.isNegative()).toBe(false);
      }),
    );
  });
});

describe('SOCSO against Act 4, including SKBBK', () => {
  it('returns the schedule amounts for every band, both categories', () => {
    for (const band of socsoBands) {
      const wage = rm(band.wageFrom);
      const c1 = socsoContribution(wage, 1, socsoBands);
      expect(c1.employer.toDecimalString()).toBe(rm(band.cat1Employer).toDecimalString());
      expect(c1.employeeInvalidity.toDecimalString())
        .toBe(rm(band.cat1EmployeeInvalidity).toDecimalString());
      expect(c1.employeeSkbbk.toDecimalString())
        .toBe(rm(band.cat1EmployeeSkbbk).toDecimalString());
      // The payslip figure is the two employee columns together.
      expect(c1.employee.toDecimalString())
        .toBe(rm(band.cat1EmployeeInvalidity).add(rm(band.cat1EmployeeSkbbk)).toDecimalString());

      const c2 = socsoContribution(wage, 2, socsoBands);
      expect(c2.employer.toDecimalString()).toBe(rm(band.cat2Employer).toDecimalString());
      expect(c2.employeeInvalidity.isZero()).toBe(true);
      expect(c2.employee.toDecimalString()).toBe(rm(band.cat2EmployeeSkbbk).toDecimalString());
    }
  });

  it('Category 2 now DEDUCTS from the employee — the SKBBK change', () => {
    // Before 1 June 2026 this was nil. A payroll still returning zero here is
    // under-deducting from every employee aged 60 or over.
    const c2 = socsoContribution(rm('6000'), 2, socsoBands);
    expect(c2.employee.isZero()).toBe(false);
    expect(c2.employee.toDecimalString()).toBe('44.6500');
  });

  it('holds the contribution flat above the RM6,000 ceiling', () => {
    const atCeiling = socsoContribution(rm('6000'), 1, socsoBands);
    for (const wage of ['6000.01', '9000', '250000']) {
      const above = socsoContribution(rm(wage), 1, socsoBands);
      expect(above.employer.toDecimalString()).toBe(atCeiling.employer.toDecimalString());
      expect(above.employee.toDecimalString()).toBe(atCeiling.employee.toDecimalString());
    }
  });
});

describe('EIS against Act 800', () => {
  it('returns the schedule amounts for every band, employer equalling employee', () => {
    for (const band of eisBands) {
      const got = eisContribution(rm(band.wageFrom), true, eisBands);
      expect(got.employer.toDecimalString()).toBe(rm(band.employer).toDecimalString());
      expect(got.employee.toDecimalString()).toBe(got.employer.toDecimalString());
    }
  });

  it('holds flat above the ceiling and pays nothing when not covered', () => {
    expect(eisContribution(rm('99000'), true, eisBands).employer.toDecimalString())
      .toBe('11.9000');
    const none = eisContribution(rm('3000'), false, eisBands);
    expect(none.employer.isZero() && none.employee.isZero()).toBe(true);
  });
});

describe('a month for one person', () => {
  const schedules = {
    epfBands: epfBands('A'), epfRule: RULES['A']!, socsoBands, eisBands,
  };

  it('adds up a counter assistant on RM3,000', () => {
    const got = monthlyContributions(rm('3000'), person({ age: 28 }), schedules);
    expect(got.epfPart).toBe('A');
    expect(got.socsoCategory).toBe(1);
    expect(got.eisApplies).toBe(true);

    // EPF 330 + SOCSO (invalidity 14.75 + SKBBK 22.15) + EIS 5.90
    expect(got.epf.employee.toDecimalString()).toBe('330.0000');
    expect(got.totalEmployee.toDecimalString())
      .toBe(rm('330').add(got.socso.employee).add(rm('5.90')).toDecimalString());

    // What the shop actually pays beyond the wage.
    expect(got.totalEmployer.toDecimalString())
      .toBe(got.epf.employer.add(got.socso.employer).add(got.eis.employer).toDecimalString());
    expect(got.totalEmployer.isPositive()).toBe(true);
  });

  it('a 62-year-old citizen: employer-only EPF, Category 2, no EIS', () => {
    const got = monthlyContributions(
      rm('3000'),
      person({ age: 62 }),
      { ...schedules, epfBands: epfBands('E'), epfRule: RULES['E']! },
    );
    expect(got.epfPart).toBe('E');
    expect(got.epf.employee.isZero()).toBe(true);
    expect(got.socsoCategory).toBe(2);
    expect(got.eisApplies).toBe(false);
    expect(got.eis.employer.isZero()).toBe(true);
    // But SKBBK still comes out of their pay.
    expect(got.totalEmployee.isZero()).toBe(false);
  });

  it('never returns a negative figure for any wage or person (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3_000_000 }),
        fc.integer({ min: 14, max: 80 }),
        fc.constantFrom('CITIZEN', 'PERMANENT_RESIDENT'),
        (sen, age, citizenship) => {
          const wage = Money.fromUnits(BigInt(sen) * 100n, 'MYR');
          const subject = { age, citizenship: citizenship as never };
          const part = epfPart(subject);
          const got = monthlyContributions(wage, subject, {
            ...schedules, epfBands: epfBands(part), epfRule: RULES[part]!,
          });
          expect(got.totalEmployee.isNegative()).toBe(false);
          expect(got.totalEmployer.isNegative()).toBe(false);
        },
      ),
    );
  });
});
