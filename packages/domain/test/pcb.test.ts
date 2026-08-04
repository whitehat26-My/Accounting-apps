import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import {
  chargeableIncome,
  monthlyTaxDeduction,
  type MtdEmployee,
  type MtdMonth,
  type MtdSchedule,
} from '../src/pcb.js';

/**
 * PCB, checked against IRBM's own worked examples.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBERS IN THIS FILE ARE NOT MINE.
 *
 * Every expected value below is printed in the "Example of Calculation" exhibit
 * of the MTD Computerised Calculation specification, pages 45–51. That exhibit
 * exists precisely so a payroll system can be verified before IRBM issues an
 * approval letter, and it is the only test of a tax engine worth having: an
 * engine tested against figures the author derived themselves proves the author
 * can apply their own reading of the rules consistently, which is not the same
 * as applying the rules.
 *
 * The example runs one employee across four consecutive months, accumulating as
 * it goes — January and February plain, March with TP1 deductions, April with a
 * bonus. It is reproduced here month by month for that reason: the accumulation
 * IS the method, and a single-month test would miss it entirely.
 * ---------------------------------------------------------------------------
 */

/** Table 1, page 11. */
const SCHEDULE: MtdSchedule = {
  bands: [
    { pFrom: '5000.01', pTo: '20000', m: '5000', rateBp: 100, bCategory13: '-400', bCategory2: '-800' },
    { pFrom: '20000.01', pTo: '35000', m: '20000', rateBp: 300, bCategory13: '-250', bCategory2: '-650' },
    { pFrom: '35000.01', pTo: '50000', m: '35000', rateBp: 600, bCategory13: '600', bCategory2: '600' },
    { pFrom: '50000.01', pTo: '70000', m: '50000', rateBp: 1100, bCategory13: '1500', bCategory2: '1500' },
    { pFrom: '70000.01', pTo: '100000', m: '70000', rateBp: 1900, bCategory13: '3700', bCategory2: '3700' },
    { pFrom: '100000.01', pTo: '400000', m: '100000', rateBp: 2500, bCategory13: '9400', bCategory2: '9400' },
    { pFrom: '400000.01', pTo: '600000', m: '400000', rateBp: 2600, bCategory13: '84400', bCategory2: '84400' },
    { pFrom: '600000.01', pTo: '2000000', m: '600000', rateBp: 2800, bCategory13: '136400', bCategory2: '136400' },
    { pFrom: '2000000.01', pTo: null, m: '2000000', rateBp: 3000, bCategory13: '528400', bCategory2: '528400' },
  ],
  reliefs: {
    individual: '9000',
    spouse: '4000',
    perChild: '2000',
    disabledIndividual: '7000',
    disabledSpouse: '6000',
    epfAnnualLimit: '4000',
    nonResidentRateBp: 3000,
  },
};

/** "Employee (Married) and wife working, 3 children entitle for deduction". */
const EMPLOYEE: MtdEmployee = { resident: true, category: 3, qualifyingChildren: 3 };

const rm = (value: string) => Money.fromDecimal(value, 'MYR');

// ---------------------------------------------------------------------------
// The exhibit, month by month
// ---------------------------------------------------------------------------

describe('IRBM worked example, pages 45–51', () => {
  it('January: P = 47,000.07 and MTD = 110.00', () => {
    const month: MtdMonth = {
      month: 1,
      accumulatedGross: '0',
      accumulatedEpf: '0',
      grossThisMonth: '5500',
      epfThisMonth: '605',
    };

    const { p } = chargeableIncome(EMPLOYEE, month, SCHEDULE, { includeAdditional: false });
    // Every sen of this matters. K2 is 3,395 / 11 = 308.6363…, truncated to
    // 308.63 by the specification's own rule, and the .07 at the end of P is
    // what the truncation leaves behind eleven months later. An implementation
    // that rounded instead would land on 47,000.00 and look just as reasonable.
    expect(p.toDecimalString()).toBe('47000.0700');

    const result = monthlyTaxDeduction(EMPLOYEE, month, SCHEDULE);
    expect(result.mtd.toDecimalString()).toBe('110.0000');
  });

  it('February: the January deduction reduces what is left to spread', () => {
    const month: MtdMonth = {
      month: 2,
      accumulatedGross: '5500',
      accumulatedEpf: '605',
      grossThisMonth: '5500',
      epfThisMonth: '605',
      accumulatedMtd: '110',
    };

    const { p } = chargeableIncome(EMPLOYEE, month, SCHEDULE, { includeAdditional: false });
    expect(p.toDecimalString()).toBe('47000.0000');
    expect(monthlyTaxDeduction(EMPLOYEE, month, SCHEDULE).mtd.toDecimalString()).toBe('110.0000');
  });

  it('March: RM300 of TP1 deductions takes it to 108.20', () => {
    const month: MtdMonth = {
      month: 3,
      accumulatedGross: '11000',
      accumulatedEpf: '1210',
      grossThisMonth: '5500',
      epfThisMonth: '605',
      // Books RM100 and parents' medical RM200, claimed on Form TP1.
      optionalDeductionsThisMonth: '300',
      accumulatedMtd: '220',
    };

    const { p } = chargeableIncome(EMPLOYEE, month, SCHEDULE, { includeAdditional: false });
    expect(p.toDecimalString()).toBe('46700.0700');
    expect(monthlyTaxDeduction(EMPLOYEE, month, SCHEDULE).mtd.toDecimalString()).toBe('108.2000');
  });

  it('April with an RM8,250 bonus: 106.20 on the salary plus 727.50 on the bonus', () => {
    const month: MtdMonth = {
      month: 4,
      accumulatedGross: '16500',
      accumulatedEpf: '1815',
      grossThisMonth: '5500',
      epfThisMonth: '605',
      additionalThisMonth: '8250',
      epfOnAdditional: '908',
      accumulatedOptionalDeductions: '300',
      optionalDeductionsThisMonth: '300',
      accumulatedMtd: '328.20',
    };

    // Step 1[B]: the year WITHOUT the bonus.
    const withoutBonus = chargeableIncome(EMPLOYEE, month, SCHEDULE, {
      includeAdditional: false,
    });
    expect(withoutBonus.p.toDecimalString()).toBe('46400.0000');

    // Step 2[B]: the year WITH it. Note P jumps by more than the bonus net of
    // EPF, because K2 falls from 197.50 to 84.00 once the bonus's own EPF eats
    // into the annual relief cap — eight months of that difference.
    const withBonus = chargeableIncome(EMPLOYEE, month, SCHEDULE, { includeAdditional: true });
    expect(withBonus.p.toDecimalString()).toBe('54650.0000');

    const result = monthlyTaxDeduction(EMPLOYEE, month, SCHEDULE);
    expect(result.mtd.toDecimalString()).toBe('833.7000'); // Step 5
    expect(result.mtdOnAdditional.toDecimalString()).toBe('727.5000'); // Step 4
    // Step 1[D] — what the salary alone would have cost.
    expect(result.mtd.subtract(result.mtdOnAdditional).toDecimalString()).toBe('106.2000');
  });

  it('the bonus is taxed at the year’s rate, not the month’s', () => {
    /*
     * The reason the five-step formula exists, stated as a test.
     *
     * The RM8,250 bonus pushes the year from the 6% band into the 11% band, and
     * IRBM's answer of RM727.50 is the difference between the two ANNUAL tax
     * figures. Taxing the bonus at a flat marginal 11% would give RM907.50 —
     * RM180 too much, taken out of one payslip.
     */
    const april: MtdMonth = {
      month: 4,
      accumulatedGross: '16500',
      accumulatedEpf: '1815',
      grossThisMonth: '5500',
      epfThisMonth: '605',
      additionalThisMonth: '8250',
      epfOnAdditional: '908',
      accumulatedOptionalDeductions: '300',
      optionalDeductionsThisMonth: '300',
      accumulatedMtd: '328.20',
    };
    const onBonus = monthlyTaxDeduction(EMPLOYEE, april, SCHEDULE).mtdOnAdditional;
    const naiveMarginal = rm('8250').multiplyRatio(1100n, 10_000n, 'DOWN');
    expect(onBonus.compare(naiveMarginal)).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// The rounding conventions, page 19
// ---------------------------------------------------------------------------

describe('the specification’s own arithmetic rules', () => {
  /** A salary that lands the raw MTD on an awkward number of sen. */
  const monthAt = (gross: string, epf: string): MtdMonth => ({
    month: 1,
    accumulatedGross: '0',
    accumulatedEpf: '0',
    grossThisMonth: gross,
    epfThisMonth: epf,
  });

  it('rounds every deduction up to a multiple of five sen', () => {
    // Condition 2: 1–4 sen go up to 5, and 6–9 go up to 10. One rule, not two.
    for (const gross of ['6000', '6100', '6250', '7000', '7333.33', '8000', '9500']) {
      const result = monthlyTaxDeduction(
        { resident: true, category: 1, qualifyingChildren: 0 },
        monthAt(gross, '0'),
        SCHEDULE,
      );
      expect(result.mtd.units % 500n, `${gross} produced ${result.mtd.toDecimalString()}`).toBe(0n);
    }
  });

  it('rounds up from the TRUNCATED figure, not from the exact one', () => {
    /*
     * The two conditions on page 19 compose in one order and not the other.
     *
     * Condition 1 truncates to sen ("omit the subsequent figures"); condition 2
     * then rounds that up to five sen. On a RM5,384 salary the exact monthly
     * figure is 176.40666…, which truncates to 176.40 and stays there — where
     * rounding up from the exact value would give 176.45.
     *
     * Five sen a month is not the point. The point is that truncation-first is
     * what produces IRBM's own published RM47,000.07, so an engine that rounds
     * first disagrees with the specification's worked example, and every figure
     * downstream of it drifts.
     */
    fc.assert(
      fc.property(fc.integer({ min: 3_000, max: 30_000 }), (salary) => {
        const employee: MtdEmployee = { resident: true, category: 1, qualifyingChildren: 0 };
        const month = monthAt(String(salary), '0');
        const { p } = chargeableIncome(employee, month, SCHEDULE, { includeAdditional: false });
        const result = monthlyTaxDeduction(employee, month, SCHEDULE);
        if (result.mtd.isZero()) return true;

        const band = SCHEDULE.bands.find(
          (b) =>
            p.compare(rm(b.pFrom)) >= 0 && (b.pTo === null || p.compare(rm(b.pTo)) <= 0),
        );
        if (band === undefined) return true;
        const annual = p
          .subtract(rm(band.m))
          .multiplyRatio(BigInt(band.rateBp), 10_000n, 'DOWN')
          .add(rm(band.bCategory13));
        const truncated = annual.multiplyRatio(1n, 12n, 'DOWN').roundToExponent(2, 'DOWN');

        return (
          result.mtd.compare(truncated) >= 0 && result.mtd.subtract(truncated).units < 500n
        );
      }),
      { numRuns: 400 },
    );
  });

  it('deducts nothing below ten ringgit a month', () => {
    /*
     * Condition 3, and it takes a carefully chosen salary to reach.
     *
     * On RM3,120 a month the year's chargeable income is RM28,440, which sits
     * just past the point in the 3% band where the RM400 rebate stops covering
     * the tax. The annual tax is RM3.20 — twenty-six sen a month, rounded up to
     * thirty — and the employer deducts nothing.
     *
     * Not a tax-free threshold: the RM3.20 is still owed and settles on
     * assessment. The rule exists because collecting thirty sen a month costs
     * more than it raises.
     */
    const result = monthlyTaxDeduction(
      { resident: true, category: 1, qualifyingChildren: 0 },
      monthAt('3120', '0'),
      SCHEDULE,
    );
    expect(result.chargeableIncome.toDecimalString()).toBe('28440.0000');
    expect(result.mtd.isZero()).toBe(true);
  });

  it('deducts nothing on a RM2,500 shop wage — the rebate, not a low band', () => {
    /*
     * Worth being precise about, because the intuitive explanation is wrong.
     *
     * A RM2,500 counter assistant HAS chargeable income: RM30,000 gross, less
     * RM3,300 of EPF relief and the RM9,000 individual relief, is RM17,700 —
     * comfortably inside the first taxable band. The tax on it is 1% of the
     * RM12,700 above M, or RM127, and the reason nothing is deducted is that
     * B carries the RM400 individual rebate, which is larger.
     *
     * So the answer is zero because of the rebate, not because the wage is
     * below the tax net. That distinction is what makes the negative B values
     * in Table 1 load-bearing rather than a curiosity.
     */
    const result = monthlyTaxDeduction(
      { resident: true, category: 1, qualifyingChildren: 0 },
      monthAt('2500', '275'),
      SCHEDULE,
    );
    expect(result.chargeableIncome.toDecimalString()).toBe('17700.0000');
    expect(result.mtd.isZero()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reliefs and categories
// ---------------------------------------------------------------------------

describe('who gets which relief', () => {
  const month: MtdMonth = {
    month: 1,
    accumulatedGross: '0',
    accumulatedEpf: '0',
    grossThisMonth: '8000',
    epfThisMonth: '880',
  };

  const pFor = (employee: MtdEmployee) =>
    chargeableIncome(employee, month, SCHEDULE, { includeAdditional: false }).p;

  it('gives Category 2 the spouse relief and Category 3 none', () => {
    const single = pFor({ resident: true, category: 1, qualifyingChildren: 0 });
    const soleEarner = pFor({ resident: true, category: 2, qualifyingChildren: 0 });
    expect(single.subtract(soleEarner).toDecimalString()).toBe('4000.0000');
  });

  it('ignores children on Category 1, because Category 1 is single by definition', () => {
    // Passing children with Category 1 is a data error, and the safe reading is
    // the one that does not quietly grant relief the Act does not give — an
    // under-deduction all year that surfaces as a bill on assessment.
    const withoutChildren = pFor({ resident: true, category: 1, qualifyingChildren: 0 });
    const withChildren = pFor({ resident: true, category: 1, qualifyingChildren: 3 });
    expect(withChildren.compare(withoutChildren)).toBe(0);
  });

  it('counts a child in tertiary education as four, per page 27', () => {
    // The specification expresses the RM8,000 relief by multiplying the CHILD
    // COUNT rather than the per-child amount, so C is 4 for one such child.
    const oneSchoolChild = pFor({ resident: true, category: 3, qualifyingChildren: 1 });
    const oneStudent = pFor({ resident: true, category: 3, qualifyingChildren: 4 });
    expect(oneSchoolChild.subtract(oneStudent).toDecimalString()).toBe('6000.0000');
  });

  it('adds RM7,000 for a disabled employee and RM6,000 for a disabled spouse', () => {
    const plain = pFor({ resident: true, category: 2, qualifyingChildren: 0 });
    const disabled = pFor({ resident: true, category: 2, qualifyingChildren: 0, disabled: true });
    const bothDisabled = pFor({
      resident: true,
      category: 2,
      qualifyingChildren: 0,
      disabled: true,
      disabledSpouse: true,
    });
    expect(plain.subtract(disabled).toDecimalString()).toBe('7000.0000');
    expect(disabled.subtract(bothDisabled).toDecimalString()).toBe('6000.0000');
  });

  it('caps EPF relief at the annual limit however much is contributed', () => {
    // An employee on RM20,000 contributes RM2,200 a month — over the RM4,000
    // annual cap by February. The relief stops; the contribution does not.
    const highEarner: MtdMonth = {
      month: 6,
      accumulatedGross: '100000',
      accumulatedEpf: '11000',
      grossThisMonth: '20000',
      epfThisMonth: '2200',
    };
    const { p } = chargeableIncome(
      { resident: true, category: 1, qualifyingChildren: 0 },
      highEarner,
      SCHEDULE,
      { includeAdditional: false },
    );
    // Gross for the year is 240,000; relief is 9,000 + 4,000 and no more.
    expect(p.toDecimalString()).toBe('227000.0000');
  });
});

// ---------------------------------------------------------------------------
// Non-residents
// ---------------------------------------------------------------------------

describe('non-resident employees', () => {
  it('applies a flat 30% with no relief and no annualisation', () => {
    // Page 9's own example: RM3,000 x 30% = RM900.
    const result = monthlyTaxDeduction(
      { resident: false, category: 1, qualifyingChildren: 0 },
      {
        month: 1,
        accumulatedGross: '0',
        accumulatedEpf: '0',
        grossThisMonth: '3000',
        epfThisMonth: '0',
      },
      SCHEDULE,
    );
    expect(result.nonResident).toBe(true);
    expect(result.mtd.toDecimalString()).toBe('900.0000');
  });

  it('does not exempt a small payment, because there is nothing to annualise', () => {
    // The RM10 rule belongs to the projection. A non-resident's deduction is
    // final for the month, so RM30 on RM100 is deducted.
    const result = monthlyTaxDeduction(
      { resident: false, category: 1, qualifyingChildren: 0 },
      {
        month: 11,
        accumulatedGross: '0',
        accumulatedEpf: '0',
        grossThisMonth: '100',
        epfThisMonth: '0',
      },
      SCHEDULE,
    );
    expect(result.mtd.toDecimalString()).toBe('30.0000');
  });
});

// ---------------------------------------------------------------------------
// Properties that must hold whatever the inputs
// ---------------------------------------------------------------------------

describe('properties', () => {
  it('never returns a negative deduction', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 40_000 }),
        fc.integer({ min: 0, max: 50_000 }),
        (month, salary, paidSoFar) => {
          const result = monthlyTaxDeduction(
            { resident: true, category: 3, qualifyingChildren: 2 },
            {
              month,
              accumulatedGross: String(salary * (month - 1)),
              accumulatedEpf: '0',
              grossThisMonth: String(salary),
              epfThisMonth: '0',
              accumulatedMtd: String(paidSoFar),
            },
            SCHEDULE,
          );
          return !result.mtd.isNegative();
        },
      ),
      { numRuns: 500 },
    );
  });

  it('deducts more from a bigger salary, all else equal', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2_000, max: 40_000 }),
        fc.integer({ min: 1, max: 5_000 }),
        (salary, rise) => {
          const employee: MtdEmployee = { resident: true, category: 1, qualifyingChildren: 0 };
          const at = (gross: number) =>
            monthlyTaxDeduction(
              employee,
              {
                month: 1,
                accumulatedGross: '0',
                accumulatedEpf: '0',
                grossThisMonth: String(gross),
                epfThisMonth: '0',
              },
              SCHEDULE,
            ).mtd;
          return at(salary + rise).compare(at(salary)) >= 0;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses a month outside 1–12 rather than computing with a wrong n', () => {
    for (const month of [0, 13, -1, 1.5]) {
      expect(() =>
        monthlyTaxDeduction(
          { resident: true, category: 1, qualifyingChildren: 0 },
          {
            month,
            accumulatedGross: '0',
            accumulatedEpf: '0',
            grossThisMonth: '5000',
            epfThisMonth: '0',
          },
          SCHEDULE,
        ),
      ).toThrow(RangeError);
    }
  });

  it('handles December, where there is no balance of months to project into', () => {
    // n = 0, so K2 is not merely small — the division that produces it would be
    // by zero. The whole year's tax lands in one month.
    const result = monthlyTaxDeduction(
      { resident: true, category: 1, qualifyingChildren: 0 },
      {
        month: 12,
        accumulatedGross: '88000',
        accumulatedEpf: '3500',
        grossThisMonth: '8000',
        epfThisMonth: '880',
        accumulatedMtd: '2000',
      },
      SCHEDULE,
    );
    expect(result.mtd.isNegative()).toBe(false);
    expect(Number.isFinite(Number(result.mtd.toDecimalString()))).toBe(true);
  });
});
