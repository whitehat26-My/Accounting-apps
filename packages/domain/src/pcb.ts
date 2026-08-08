import { Money } from './money.js';

/**
 * PCB / MTD — Monthly Tax Deduction, by the Computerised Calculation Method.
 *
 * ---------------------------------------------------------------------------
 * SOURCE: IRBM, "Specification for Monthly Tax Deduction (MTD) Calculations
 * using Computerized Calculation for 2026", updated 01 January 2026, committed
 * at `docs/research/sources/lhdn-mtd-computerised-specification-2026.pdf`.
 *
 * That document is normative, not explanatory: Rule 3 of the Income Tax
 * (Deduction from Remuneration) Rules 1994 makes the Schedule part of the MTD
 * specification, and IRBM verifies payroll software against these formulae
 * before issuing an approval letter. Every rule below cites the page it came
 * from, so a reviewer can check this file against the PDF line by line rather
 * than trusting it.
 *
 * The 2026 amendment states, at page 7: "there is no amendment to the MTD
 * formula" — the Budget 2026 changes are to relief LIMITS and to the TP1/TP3
 * forms. That is why this engine implements the formula as published and takes
 * every monetary constant as effective-dated data.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ANNUALISED AND NOT "TAX ON THIS MONTH'S PAY".
 *
 * MTD is not a monthly tax. It projects the whole YEAR — this month's pay is
 * assumed to repeat for every remaining month — computes the tax on that
 * projection, subtracts what has already been deducted, and spreads the
 * remainder over the months left. That is why the formula carries `n`, `X` and
 * the accumulated figures, and why a mid-year pay rise changes the deduction by
 * more than the rise itself would suggest.
 *
 * A "simple" implementation that taxes each month independently produces a
 * figure that is wrong every month and only accidentally right in December.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// The employee
// ---------------------------------------------------------------------------

/**
 * The three categories, from page 10–11 of the specification.
 *
 * They are about which RELIEFS apply, not about marital status as such — which
 * is why "married, spouse working" and "divorced" and "single with an adopted
 * child" are all one category: each gets the individual relief and child
 * relief, and no spouse relief.
 */
export type MtdCategory =
  /** Single. D only. */
  | 1
  /** Married, spouse not working. D + S + children. */
  | 2
  /** Married with a working spouse, divorced, widowed, or single with an adopted child. D + children. */
  | 3;

export interface MtdEmployee {
  /**
   * Resident, or known to be resident. A non-resident is a flat rate on gross
   * with no reliefs at all — page 9.
   */
  readonly resident: boolean;
  readonly category: MtdCategory;
  /**
   * `C` — the number of qualifying children, which is NOT always the number of
   * children. Page 27 makes a child in tertiary education count as FOUR, a
   * disabled child as four, and a disabled child in tertiary education as
   * EIGHT. The multiplier is expressed by inflating C rather than by varying Q,
   * because that is how the specification expresses it, and inventing a
   * different encoding here would make this file harder to check against the
   * source rather than easier.
   */
  readonly qualifyingChildren: number;
  /** DU — a further deduction where the employee is a disabled person. */
  readonly disabled?: boolean;
  /** SU — a further deduction for a disabled spouse. Category 2 only. */
  readonly disabledSpouse?: boolean;
}

// ---------------------------------------------------------------------------
// The month
// ---------------------------------------------------------------------------

/**
 * Everything the formula needs about where in the year this payment falls.
 *
 * Every field is a decimal string. There is no default of zero on the
 * accumulated figures: `X` and `Y` being absent is a real state (January, or a
 * new joiner with no TP3) and it is different from them being unknown, which
 * would silently under-deduct all year.
 */
export interface MtdMonth {
  /** 1–12. `n` (months remaining) is derived from it, never passed in. */
  readonly month: number;

  /** Y — accumulated gross remuneration paid BEFORE this month, this year. */
  readonly accumulatedGross: string;
  /** K — EPF and other approved scheme paid in respect of Y. */
  readonly accumulatedEpf: string;

  /** Y1 — gross normal remuneration for THIS month. */
  readonly grossThisMonth: string;
  /** K1 — EPF in respect of Y1. */
  readonly epfThisMonth: string;

  /** Yt — gross ADDITIONAL remuneration this month: bonus, arrears, ex-gratia. */
  readonly additionalThisMonth?: string;
  /** Kt — EPF in respect of Yt. */
  readonly epfOnAdditional?: string;

  /** ∑LP — accumulated optional deductions claimed on Form TP1. */
  readonly accumulatedOptionalDeductions?: string;
  /** LP1 — optional deductions for this month. */
  readonly optionalDeductionsThisMonth?: string;

  /** Z — accumulated zakat paid this year, EXCLUDING this month's. */
  readonly accumulatedZakat?: string;
  /** Zakat paid for this month, deducted from the MTD after it is computed. */
  readonly zakatThisMonth?: string;

  /** X — accumulated MTD already paid this year, including a previous employer's. */
  readonly accumulatedMtd?: string;
}

// ---------------------------------------------------------------------------
// The statutory data — all of it loaded, none of it hardcoded
// ---------------------------------------------------------------------------

/** One row of Table 1, page 11. */
export interface MtdBand {
  /** Inclusive lower bound of P. */
  readonly pFrom: string;
  /** Inclusive upper bound. `null` on the final, unbounded band. */
  readonly pTo: string | null;
  /** M — the first chargeable income of the range. */
  readonly m: string;
  /** R — basis points, so 1% is 100 and never 0.01. */
  readonly rateBp: number;
  /**
   * B for categories 1 and 3 — the tax on M, already NET of the individual
   * rebate. It is NEGATIVE in the first two bands, and that negativity IS the
   * RM400 rebate: it is what makes a low chargeable income produce no
   * deduction at all rather than a small one.
   */
  readonly bCategory13: string;
  /** B for category 2 — the same, with the spouse rebate as well. */
  readonly bCategory2: string;
}

/** The compulsory deductions, from pages 26–28. */
export interface MtdReliefs {
  /** D — granted automatically, for the individual and dependent relatives. */
  readonly individual: string;
  /** S — husband or wife with no source of income. */
  readonly spouse: string;
  /** Q — per qualifying child. Multiplied by C. */
  readonly perChild: string;
  /** DU. */
  readonly disabledIndividual: string;
  /** SU. */
  readonly disabledSpouse: string;
  /**
   * The annual cap on K + K1 + K2 + Kt. Page 28: relief for contributions to
   * approved provident funds. This is the cap on the RELIEF, not on the
   * contribution — an employee contributes far more than this and gets tax
   * relief on this much.
   */
  readonly epfAnnualLimit: string;
  /** The flat rate applied to a non-resident's gross remuneration. Page 9. */
  readonly nonResidentRateBp: number;
}

export interface MtdSchedule {
  readonly bands: readonly MtdBand[];
  readonly reliefs: MtdReliefs;
}

// ---------------------------------------------------------------------------
// The specification's own arithmetic conventions
// ---------------------------------------------------------------------------

/** 5 sen, in Money's minor units (MONEY_SCALE = 4). */
const FIVE_SEN = 500n;

/**
 * Page 19, condition 1: "Calculations is limited to two decimal points only
 * and omit the subsequent figures. Example: 123.4534 = 123.45".
 *
 * OMIT, not round. This is applied to intermediate values as well as the final
 * one — the specification's own worked example truncates K2 from 308.6363… to
 * 308.63 and then multiplies by 11, so rounding here instead would diverge from
 * IRBM's published answer by sen at the end.
 */
function truncateToSen(amount: Money): Money {
  return amount.roundToExponent(2, 'DOWN');
}

/**
 * Page 19, condition 2: round the deduction UP to the nearest five sen.
 *
 * "one, two, three and four cents to be rounded up to five cents" and "six,
 * seven, eight and nine cents to be rounded up to ten cents" — which is one
 * rule, not two: ceiling to a multiple of 5 sen. 287.02 becomes 287.05 and
 * 152.06 becomes 152.10, both of which the specification gives as examples.
 *
 * Only ever applied to a positive amount; the caller zeroes anything else
 * first, because a "round up" on a negative would round toward zero and the
 * question does not arise.
 */
function ceilToFiveSen(amount: Money): Money {
  const remainder = amount.units % FIVE_SEN;
  if (remainder === 0n) return amount;
  return Money.fromUnits(amount.units + (FIVE_SEN - remainder), amount.currency);
}

/**
 * Page 19, condition 3: below ten ringgit the employer does not deduct at all.
 *
 * Note what this is NOT: it is not a threshold below which tax is not owed. The
 * tax is still owed and settles on assessment; the rule exists because
 * collecting two ringgit a month costs more than it raises.
 */
const TEN_RINGGIT_UNITS = 100_000n;

function applyDeductionThreshold(amount: Money): Money {
  const zero = Money.zero(amount.currency);
  if (!amount.isPositive()) return zero;
  const rounded = ceilToFiveSen(truncateToSen(amount));
  return rounded.units < TEN_RINGGIT_UNITS ? zero : rounded;
}

// ---------------------------------------------------------------------------
// The pieces of P
// ---------------------------------------------------------------------------

function findBand(bands: readonly MtdBand[], p: Money): MtdBand | undefined {
  for (const band of bands) {
    if (p.compare(Money.fromDecimal(band.pFrom, p.currency)) < 0) continue;
    if (band.pTo === null) return band;
    if (p.compare(Money.fromDecimal(band.pTo, p.currency)) <= 0) return band;
  }
  return undefined;
}

function bFor(band: MtdBand, category: MtdCategory, currency: Money['currency']): Money {
  return Money.fromDecimal(category === 2 ? band.bCategory2 : band.bCategory13, currency);
}

/** The compulsory deductions total: D + S + DU + SU + QC. */
function compulsoryDeductions(employee: MtdEmployee, reliefs: MtdReliefs): Money {
  const currency = 'MYR' as const;
  let total = Money.fromDecimal(reliefs.individual, currency);

  // S and SU are Category 2 only — by definition, since a spouse with income
  // claims their own individual relief on their own return.
  if (employee.category === 2) {
    total = total.add(Money.fromDecimal(reliefs.spouse, currency));
    if (employee.disabledSpouse === true) {
      total = total.add(Money.fromDecimal(reliefs.disabledSpouse, currency));
    }
  }

  if (employee.disabled === true) {
    total = total.add(Money.fromDecimal(reliefs.disabledIndividual, currency));
  }

  // Category 1 is single with no children by definition (page 10), so C is
  // forced to zero rather than trusted from the caller. A single employee with
  // a child is Category 3, and passing children with Category 1 is a mistake
  // that would otherwise silently under-deduct all year.
  if (employee.category !== 1 && employee.qualifyingChildren > 0) {
    total = total.add(
      Money.fromDecimal(reliefs.perChild, currency).multiplyInt(
        BigInt(employee.qualifyingChildren),
      ),
    );
  }

  return total;
}

/**
 * The EPF relief actually usable, split the way the formula needs it.
 *
 * The cap is on the SUM: "K + K1 + K2 + Kt not exceeding the total qualifying
 * amount per year" (page 10, footnote *). So each component is admitted in
 * turn against the remaining headroom, and K2 — the estimate for the remaining
 * months — takes what is left, divided over those months, or K1, whichever is
 * lower.
 */
function epfRelief(
  month: MtdMonth,
  limit: Money,
  n: number,
  includeAdditional: boolean,
): { k: Money; k1: Money; kt: Money; k2: Money } {
  const currency = 'MYR' as const;
  const zero = Money.zero(currency);

  const cap = (requested: Money, headroom: Money): Money =>
    requested.compare(headroom) > 0 ? headroom : requested;

  const k = cap(Money.fromDecimal(month.accumulatedEpf, currency), limit);
  const k1 = cap(Money.fromDecimal(month.epfThisMonth, currency), limit.subtract(k));

  /*
   * Kt is zero in Step 1 and real in Step 2 — and this is not a detail.
   *
   * K2 estimates the EPF relief still to come, so it depends on how much of the
   * annual cap is already spoken for. Step 1 asks "what would the year look
   * like WITHOUT this bonus", so the bonus's EPF is not yet spoken for. IRBM's
   * own April example makes the difference visible: K2 is RM197.50 in Step 1
   * and RM84.00 in Step 2, from the same month and the same employee.
   *
   * Carrying Kt into Step 1 gets both steps individually plausible and the
   * bonus deduction wrong, which is exactly the kind of error that survives
   * review.
   */
  const kt = includeAdditional
    ? cap(
        Money.fromDecimal(month.epfOnAdditional ?? '0', currency),
        limit.subtract(k).subtract(k1),
      )
    : zero;

  // In December there is no "balance of months", so there is nothing to
  // estimate — and dividing by n would be a division by zero rather than an
  // edge case worth a special value.
  if (n === 0) return { k, k1, kt, k2: zero };

  const headroom = limit.subtract(k).subtract(k1).subtract(kt);
  // Clamped at zero rather than allowed negative: once the year's relief is
  // used up the balance is nothing, and a negative K2 would INCREASE projected
  // income by pretending future contributions add to it.
  const perMonth = headroom.isPositive()
    ? truncateToSen(headroom.multiplyRatio(1n, BigInt(n), 'DOWN'))
    : zero;

  return { k, k1, kt, k2: perMonth.compare(k1) > 0 ? k1 : perMonth };
}

export interface ChargeableIncome {
  /** P — total chargeable income for the year. */
  readonly p: Money;
  /** Kept for the payslip explanation, and because they are worth checking. */
  readonly netCurrentMonth: Money;
  readonly projectedRemaining: Money;
  readonly totalDeductions: Money;
}

/**
 * P = [∑(Y – K) + (Y1 – K1) + (Y2 – K2)n + (Yt – Kt)] – [D + S + DU + SU + QC + (∑LP + LP1)]
 *
 * Y2 — "estimated remuneration as Y1 for the subsequent months" — is this
 * month's pay, repeated. That is the projection the whole method rests on.
 */
export function chargeableIncome(
  employee: MtdEmployee,
  month: MtdMonth,
  schedule: MtdSchedule,
  options: { readonly includeAdditional: boolean },
): ChargeableIncome {
  const currency = 'MYR' as const;
  const n = 12 - month.month;

  const limit = Money.fromDecimal(schedule.reliefs.epfAnnualLimit, currency);
  const { k, k1, kt, k2 } = epfRelief(month, limit, n, options.includeAdditional);

  const y = Money.fromDecimal(month.accumulatedGross, currency);
  const y1 = Money.fromDecimal(month.grossThisMonth, currency);
  const yt = Money.fromDecimal(month.additionalThisMonth ?? '0', currency);

  const accumulatedNet = y.subtract(k);
  const netCurrentMonth = y1.subtract(k1);
  // Y2 = Y1. Named rather than inlined because it is the assumption a reader
  // most needs to see stated.
  const y2 = y1;
  const projectedRemaining = y2.subtract(k2).multiplyInt(BigInt(n));

  const additionalNet = options.includeAdditional ? yt.subtract(kt) : Money.zero(currency);

  const totalDeductions = compulsoryDeductions(employee, schedule.reliefs)
    .add(Money.fromDecimal(month.accumulatedOptionalDeductions ?? '0', currency))
    .add(Money.fromDecimal(month.optionalDeductionsThisMonth ?? '0', currency));

  const p = accumulatedNet
    .add(netCurrentMonth)
    .add(projectedRemaining)
    .add(additionalNet)
    .subtract(totalDeductions);

  return { p, netCurrentMonth, projectedRemaining, totalDeductions };
}

/** Tax on a whole year's chargeable income: (P – M)R + B. Zero below the first band. */
function annualTax(p: Money, employee: MtdEmployee, schedule: MtdSchedule): Money {
  const currency = 'MYR' as const;
  const band = findBand(schedule.bands, p);
  // Table 1 begins at RM5,001. Below it there is no band, and no tax — the
  // absence is the rule, not a missing row.
  if (band === undefined) return Money.zero(currency);

  const m = Money.fromDecimal(band.m, currency);
  const taxed = p.subtract(m).multiplyRatio(BigInt(band.rateBp), 10_000n, 'DOWN');
  return taxed.add(bFor(band, employee.category, currency));
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export interface MtdResult {
  /** P, for showing the working. */
  readonly chargeableIncome: Money;
  /** The deduction for the month, after rounding and the RM10 threshold. */
  readonly mtd: Money;
  /** MTD less this month's zakat. Rule 4: this one is paid even if under RM10. */
  readonly netMtd: Money;
  /** The portion attributable to the bonus, when there is one. */
  readonly mtdOnAdditional: Money;
  /** True when the flat non-resident rate was applied and no relief given. */
  readonly nonResident: boolean;
}

/**
 * Monthly Tax Deduction for one employee, one month.
 *
 * Normal remuneration alone follows page 10. When there is additional
 * remuneration — a bonus, arrears, an ex-gratia payment — pages 12–13 apply
 * instead, and the difference matters: the bonus is NOT taxed at the marginal
 * rate of the month. The whole year is recomputed with and without it, and the
 * deduction on the bonus is the difference between the two annual figures. On a
 * small salary with a large bonus, taxing it monthly would over-deduct badly.
 */
export function monthlyTaxDeduction(
  employee: MtdEmployee,
  month: MtdMonth,
  schedule: MtdSchedule,
): MtdResult {
  const currency = 'MYR' as const;
  const zero = Money.zero(currency);

  if (month.month < 1 || month.month > 12 || !Number.isInteger(month.month)) {
    throw new RangeError(
      `${month.month} is not a month. MTD depends on how many months remain in ` +
        'the year, so the month is required and cannot be inferred.',
    );
  }

  const zakatThisMonth = Money.fromDecimal(month.zakatThisMonth ?? '0', currency);

  if (!employee.resident) {
    // Page 9. A flat rate on remuneration, no reliefs, no annualisation. The
    // rounding rules still apply, but not the RM10 threshold — there is no
    // projection to be small.
    const gross = Money.fromDecimal(month.grossThisMonth, currency).add(
      Money.fromDecimal(month.additionalThisMonth ?? '0', currency),
    );
    const flat = ceilToFiveSen(
      truncateToSen(
        gross.multiplyRatio(BigInt(schedule.reliefs.nonResidentRateBp), 10_000n, 'DOWN'),
      ),
    );
    return {
      chargeableIncome: gross,
      mtd: flat,
      netMtd: flat.subtract(zakatThisMonth),
      mtdOnAdditional: zero,
      nonResident: true,
    };
  }

  const n = 12 - month.month;
  const nPlusOne = BigInt(n + 1);
  const z = Money.fromDecimal(month.accumulatedZakat ?? '0', currency);
  const x = Money.fromDecimal(month.accumulatedMtd ?? '0', currency);

  // ---- Step 1: the year WITHOUT this month's additional remuneration -------
  const normal = chargeableIncome(employee, month, schedule, { includeAdditional: false });
  const normalAnnual = annualTax(normal.p, employee, schedule);
  const normalMonthlyRaw = truncateToSen(
    normalAnnual.subtract(z).subtract(x).multiplyRatio(1n, nPlusOne, 'DOWN'),
  );
  const normalMtd = applyDeductionThreshold(normalMonthlyRaw);

  const additional = Money.fromDecimal(month.additionalThisMonth ?? '0', currency);
  if (!additional.isPositive()) {
    return {
      chargeableIncome: normal.p,
      mtd: normalMtd,
      netMtd: normalMtd.subtract(zakatThisMonth),
      mtdOnAdditional: zero,
      nonResident: false,
    };
  }

  // ---- Steps 1[E] to 5: the bonus -----------------------------------------
  /*
   * Step 1[E] uses the UNROUNDED-to-threshold monthly figure times (n+1) plus
   * what has been paid: it is the year's expected deduction on normal pay. The
   * specification's worked example uses the Step [C] value, which is the
   * rounded monthly amount — so the rounded one is what is multiplied here.
   */
  const yearOnNormal = x.add(normalMtd.multiplyInt(nPlusOne));

  const withBonus = chargeableIncome(employee, month, schedule, { includeAdditional: true });
  const yearWithBonus = annualTax(withBonus.p, employee, schedule);

  // Step 4. Zakat already paid is added back because it reduced the running
  // total without reducing the tax the year actually owes.
  const bonusMtd = applyDeductionThreshold(yearWithBonus.subtract(yearOnNormal).add(z));

  const total = normalMtd.add(bonusMtd);
  return {
    chargeableIncome: withBonus.p,
    mtd: total,
    netMtd: total.subtract(zakatThisMonth),
    mtdOnAdditional: bonusMtd,
    nonResident: false,
  };
}
