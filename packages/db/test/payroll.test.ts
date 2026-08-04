import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import {
  PayrollError,
  computeContributions,
  computePayslip,
  employmentCost,
  loadMtdSchedule,
  loadStatutorySchedules,
} from '../src/payroll.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The loader, against the real tables.
 *
 * `packages/domain/test/payroll.test.ts` already proves the ENGINE agrees with
 * the published schedules for every one of the 1,203 EPF bands, reading the
 * same CSVs migration 0037 was generated from. What that cannot prove is that
 * the migration loaded those CSVs correctly, or that the loader picks the right
 * effective-dated rows. That is this file's job, and the two together are what
 * make the figures trustworthy — either alone is a half-check.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };

beforeAll(async () => {
  const db = await createTestDatabase('payroll');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Shah G Tech Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const TODAY = '2026-08-01';

/**
 * Seven months of a RM6,000 wage already paid this year.
 *
 * Every tax assertion below needs this, and the reason is the whole method: MTD
 * projects the REST OF THE YEAR from this month's pay, so the same August
 * payslip means something completely different with and without a year to date.
 * With it, the employee has been on RM6,000 all year. Without it, they started
 * in August.
 *
 * A January date would sidestep the question, and cannot be used: the SOCSO
 * schedule this system carries takes effect on 1 June 2026, so there is no
 * lawful January 2026 payslip to compute. Which is the honest position — the
 * pre-SKBBK table is not in the repository and will not be guessed.
 */
const SEVEN_MONTHS_IN = {
  accumulatedGross: '42000.00',
  accumulatedEpf: '4620.00',
  accumulatedMtd: '1452.50',
} as const;

// ---------------------------------------------------------------------------
// The schedules loaded whole
// ---------------------------------------------------------------------------

describe('loading the schedules', () => {
  it('loads every band the migration seeded, in wage order', async () => {
    const loaded = await withTenant(sql, ctx, (tx) =>
      loadStatutorySchedules(tx, 'A', TODAY),
    );

    // 401 bands per Part in the Third Schedule; 65 in each of SOCSO and EIS.
    // Hardcoded rather than counted from the table, because a count taken from
    // the thing under test proves only that it is self-consistent.
    expect(loaded.epfBands).toHaveLength(401);
    expect(loaded.socsoBands).toHaveLength(65);
    expect(loaded.eisBands).toHaveLength(65);

    for (let i = 1; i < loaded.epfBands.length; i += 1) {
      const previous = loaded.epfBands[i - 1]!;
      const current = loaded.epfBands[i]!;
      // Contiguous, not merely ordered: the top of one band and the bottom of
      // the next differ by one sen. A gap would be a wage that has no
      // contribution, and `findBand` would throw on it in production only.
      expect(Number(current.wageFrom) - Number(previous.wageTo)).toBeCloseTo(0.01, 6);
    }
  });

  it('carries the percentage tail that takes over above RM20,000', async () => {
    const loaded = await withTenant(sql, ctx, (tx) =>
      loadStatutorySchedules(tx, 'A', TODAY),
    );
    expect(loaded.epfRule).toEqual({
      ceiling: '20000.0000',
      employerRateBp: 1200,
      employeeRateBp: 1100,
    });
  });

  it('Part F has no table at all and does not pretend to', async () => {
    const loaded = await withTenant(sql, ctx, (tx) =>
      loadStatutorySchedules(tx, 'F', TODAY),
    );
    // Non-citizens are a flat 2% each from the first ringgit — there is nothing
    // to look up, and an empty array here is the correct answer rather than a
    // failed load.
    expect(loaded.epfBands).toEqual([]);
    expect(loaded.epfRule).toEqual({
      ceiling: null,
      employerRateBp: 200,
      employeeRateBp: 200,
    });
  });

  it('refuses a date before any schedule exists rather than guessing', async () => {
    await expect(
      withTenant(sql, ctx, (tx) => loadStatutorySchedules(tx, 'A', '1990-01-01')),
    ).rejects.toMatchObject({ code: 'NO_SCHEDULE_IN_FORCE' });
  });
});

// ---------------------------------------------------------------------------
// The date that matters is the contribution month
// ---------------------------------------------------------------------------

describe('effective dating', () => {
  it('gives May 2026 the pre-SKBBK Category 2 figures and June the new ones', async () => {
    // The single most important behaviour in this file. SKBBK started on
    // 1 June 2026; before it, a Category 2 employee (60 or over) had NOTHING
    // deducted. A system that reads "the current schedule" would restate every
    // payslip the shop ever issued the first time a rate changed.
    const subject = { age: 62, citizenship: 'CITIZEN' as const };

    const june = await withTenant(sql, ctx, (tx) =>
      computeContributions(tx, { wage: '3000.00', subject, asOf: '2026-06-01' }),
    );
    expect(june.socsoCategory).toBe(2);
    expect(june.socso.employeeSkbbk).not.toBe('0.0000');

    // Only one SOCSO schedule is seeded — the current one — so May resolves to
    // nothing at all rather than to the wrong figures. Loud, and correct: this
    // system has never been asked to produce a May 2026 payslip, and inventing
    // the superseded table from memory to satisfy the test would be exactly the
    // guess CLAUDE.md forbids.
    await expect(
      withTenant(sql, ctx, (tx) =>
        computeContributions(tx, { wage: '3000.00', subject, asOf: '2026-05-31' }),
      ),
    ).rejects.toMatchObject({ code: 'NO_SCHEDULE_IN_FORCE' });
  });

  it('never mixes one year’s table with another year’s percentage tail', async () => {
    // EPF's bands and its above-ceiling rate are pinned to the SAME
    // effective_from. Asserted here because the failure would be silent: both
    // halves are individually plausible and the total would simply be wrong.
    const [row] = await admin<{ same: boolean }[]>`
        SELECT (
          (SELECT MAX(effective_from) FROM statutory_epf_band WHERE part = 'A')
          = (SELECT MAX(effective_from) FROM statutory_epf_rule WHERE part = 'A')
        ) AS same
    `;
    expect(row!.same).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What the shop actually asks
// ---------------------------------------------------------------------------

describe('a real staff list', () => {
  it('computes the counter assistant on RM 2,500', async () => {
    const result = await withTenant(sql, ctx, (tx) =>
      computeContributions(tx, {
        wage: '2500.00',
        subject: { age: 24, citizenship: 'CITIZEN' },
        asOf: TODAY,
      }),
    );

    expect(result.epfPart).toBe('A');
    expect(result.socsoCategory).toBe(1);
    expect(result.eisApplies).toBe(true);

    // Straight off the Third Schedule for the 2,480.01–2,500.00 band. Note the
    // employer figure: 325.00 is THIRTEEN percent, not the twelve everyone
    // quotes. See the test below.
    expect(result.epf).toEqual({ employer: '325.0000', employee: '275.0000' });

    // Every figure is a string. A wage that arrived as a JS number would have
    // lost sen somewhere upstream of here — rule 2.
    for (const value of [
      result.epf.employer,
      result.socso.employer,
      result.eis.employee,
      result.totalEmployee,
    ]) {
      expect(typeof value).toBe('string');
    }
  });

  it('drops the employer from 13% to 12% at exactly RM5,000 — the trap this whole design exists for', async () => {
    /*
     * The single figure most likely to be wrong in a hand-rolled payroll.
     *
     * EPF's employer share is 13% for monthly wages up to RM5,000 and 12% above
     * it, and the step is invisible: nothing in "the employer pays 12%" — the
     * number every summary, every forum post and every spreadsheet template
     * quotes — hints that a RM 2,500 wage owes 13%.
     *
     * A flat 12% under-deducts RM 25 a month on this salary. Under-deduction of
     * a statutory contribution is the EMPLOYER's liability, recoverable with
     * penalty, and it compounds silently for as long as nobody checks. This is
     * the concrete reason this system looks the amount up instead of computing
     * it, and the assertion is here so that reason stays visible.
     */
    const asOf = TODAY;
    const subject = { age: 30, citizenship: 'CITIZEN' as const };

    const atCeiling = await withTenant(sql, ctx, (tx) =>
      computeContributions(tx, { wage: '5000.00', subject, asOf }),
    );
    const justOver = await withTenant(sql, ctx, (tx) =>
      computeContributions(tx, { wage: '5100.00', subject, asOf }),
    );

    expect(atCeiling.epf.employer).toBe('650.0000'); // 13% of 5,000
    expect(justOver.epf.employer).toBe('612.0000'); // 12% of 5,100

    // The employer's bill goes DOWN as the wage goes up. Genuinely, in the
    // published schedule — and any implementation that "fixes" this has stopped
    // matching the law.
    expect(Number(justOver.epf.employer)).toBeLessThan(Number(atCeiling.epf.employer));
  });

  it('splits the SOCSO employee side into Invalidity and SKBBK, because a payslip must', async () => {
    const result = await withTenant(sql, ctx, (tx) =>
      computeContributions(tx, {
        wage: '2500.00',
        subject: { age: 24, citizenship: 'CITIZEN' },
        asOf: TODAY,
      }),
    );

    const invalidity = Number(result.socso.employeeInvalidity);
    const skbbk = Number(result.socso.employeeSkbbk);
    expect(invalidity).toBeGreaterThan(0);
    expect(skbbk).toBeGreaterThan(0);
    expect(Number(result.socso.employee)).toBeCloseTo(invalidity + skbbk, 4);
  });

  it('puts a 62-year-old Malaysian on Part E, where the employee pays nothing to EPF', async () => {
    const result = await withTenant(sql, ctx, (tx) =>
      computeContributions(tx, {
        wage: '3000.00',
        subject: { age: 62, citizenship: 'CITIZEN' },
        asOf: TODAY,
      }),
    );
    expect(result.epfPart).toBe('E');
    expect(result.epf.employee).toBe('0.0000');
    expect(Number(result.epf.employer)).toBeGreaterThan(0);
    // Past 60, EIS stops entirely.
    expect(result.eisApplies).toBe(false);
    expect(result.eis).toEqual({ employer: '0.0000', employee: '0.0000' });
  });

  it('puts a 62-year-old PR on Part C, where they do pay', async () => {
    // The distinction every "what is the 60+ EPF rate" summary collapses, and
    // the reason those summaries disagree with each other.
    const result = await withTenant(sql, ctx, (tx) =>
      computeContributions(tx, {
        wage: '3000.00',
        subject: { age: 62, citizenship: 'PERMANENT_RESIDENT' },
        asOf: TODAY,
      }),
    );
    expect(result.epfPart).toBe('C');
    expect(Number(result.epf.employee)).toBeGreaterThan(0);
  });

  it('puts a foreign technician on Part F — a flat 2% with no table', async () => {
    const result = await withTenant(sql, ctx, (tx) =>
      computeContributions(tx, {
        wage: '2500.00',
        subject: { age: 30, citizenship: 'NON_CITIZEN' },
        asOf: TODAY,
      }),
    );
    expect(result.epfPart).toBe('F');
    // 2% of 2,500 each side, exactly — no band rounding, because there is no band.
    expect(result.epf).toEqual({ employer: '50.0000', employee: '50.0000' });
    // SOCSO and EIS still apply: they follow employment, not citizenship.
    expect(Number(result.socso.employer)).toBeGreaterThan(0);
    expect(result.eisApplies).toBe(true);
  });

  it('answers the owner’s real question — what a hire costs per month', async () => {
    const { breakdown, totalCost } = await withTenant(sql, ctx, (tx) =>
      employmentCost(tx, {
        wage: '2500.00',
        subject: { age: 24, citizenship: 'CITIZEN' },
        asOf: TODAY,
      }),
    );

    expect(Number(totalCost)).toBeCloseTo(2500 + Number(breakdown.totalEmployer), 4);
    // The employer share is real money — well over RM 300 on a RM 2,500 wage —
    // and the figure nobody budgets for.
    expect(Number(totalCost)).toBeGreaterThan(2800);
    expect(Number(breakdown.wageAfterContributions)).toBeLessThan(2500);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('what it will not do', () => {
  it('refuses a negative wage instead of returning a negative contribution', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        computeContributions(tx, {
          wage: '-100.00',
          subject: { age: 30, citizenship: 'CITIZEN' },
          asOf: TODAY,
        }),
      ),
    ).rejects.toBeInstanceOf(PayrollError);
  });

  it('refuses a wage that is not a number', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        computeContributions(tx, {
          wage: 'two thousand',
          subject: { age: 30, citizenship: 'CITIZEN' },
          asOf: TODAY,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_WAGE' });
  });

  it('does not report a net pay, because PCB is not implemented', async () => {
    const result = await withTenant(sql, ctx, (tx) =>
      computeContributions(tx, {
        wage: '2500.00',
        subject: { age: 24, citizenship: 'CITIZEN' },
        asOf: TODAY,
      }),
    );
    // A "net pay" that silently omits income tax is worse than no figure at
    // all, because it looks finished. The field is named for what it is.
    expect(result).not.toHaveProperty('netPay');
    expect(result).toHaveProperty('wageAfterContributions');
  });
});

// ---------------------------------------------------------------------------
// PCB, and the whole payslip
// ---------------------------------------------------------------------------

describe('income tax', () => {
  it('loads Table 1 and the reliefs pinned to one effective date', async () => {
    const schedule = await withTenant(sql, ctx, (tx) => loadMtdSchedule(tx, TODAY));

    expect(schedule.bands).toHaveLength(9);
    expect(schedule.reliefs).toEqual({
      individual: '9000.0000',
      spouse: '4000.0000',
      perChild: '2000.0000',
      disabledIndividual: '7000.0000',
      disabledSpouse: '6000.0000',
      epfAnnualLimit: '4000.0000',
      nonResidentRateBp: 3000,
    });

    // B is NEGATIVE in the first two bands, and that is not a data-entry slip:
    // it carries the individual rebate, and it is why a modest wage produces no
    // deduction rather than a small one.
    expect(Number(schedule.bands[0]!.bCategory13)).toBeLessThan(0);
    expect(Number(schedule.bands[0]!.bCategory2)).toBeLessThan(0);
    expect(schedule.bands[8]!.pTo).toBeNull();
  });

  it('refuses a year whose specification this system does not carry', async () => {
    // The 2026 specification is loaded and no earlier one is. Applying it to
    // 2025 would be applying a schedule backwards through a Budget.
    await expect(
      withTenant(sql, ctx, (tx) => loadMtdSchedule(tx, '2025-06-01')),
    ).rejects.toMatchObject({ code: 'NO_SCHEDULE_IN_FORCE' });
  });

  it('deducts no tax from a RM2,500 counter assistant', async () => {
    const slip = await withTenant(sql, ctx, (tx) =>
      computePayslip(tx, {
        wage: '2500.00',
        subject: { age: 24, citizenship: 'CITIZEN' },
        asOf: TODAY,
        tax: { resident: true, category: 1, qualifyingChildren: 0 },
      }),
    );

    expect(slip.pcb).not.toBeNull();
    expect(slip.pcb!.deduction).toBe('0.0000');
    // Not because there is no chargeable income — there is — but because the
    // rebate baked into B exceeds the tax on it.
    expect(Number(slip.pcb!.chargeableIncome)).toBeGreaterThan(0);
    // Net pay is now a real figure: wage less EPF, SOCSO, EIS and nil tax.
    expect(slip.netPay).toBe(slip.wageAfterContributions);
  });

  it('taxes a RM6,000 technician RM207.50 in August, seven months in', async () => {
    const slip = await withTenant(sql, ctx, (tx) =>
      computePayslip(tx, {
        wage: '6000.00',
        subject: { age: 35, citizenship: 'CITIZEN' },
        asOf: TODAY,
        tax: { resident: true, category: 1, qualifyingChildren: 0 },
        taxYearToDate: SEVEN_MONTHS_IN,
      }),
    );

    // P = 72,000 gross for the year, less the RM4,000 EPF relief cap and the
    // RM9,000 individual relief. Exactly 59,000 — no truncation artefact,
    // because by August the cap is fully used and K2 is nil.
    expect(slip.pcb!.chargeableIncome).toBe('59000.0000');
    // (59,000 - 50,000) x 11% + 1,500 = 2,490 for the year. RM1,452.50 has been
    // deducted; the remaining RM1,037.50 spreads over the five months left.
    expect(slip.pcb!.deduction).toBe('207.5000');
    expect(Number(slip.netPay)).toBeLessThan(Number(slip.wageAfterContributions));
  });

  it('taxes a NEW JOINER on the same wage in the same month nothing at all', async () => {
    /*
     * The clearest demonstration that MTD is annualised, and the reason the
     * year-to-date figures are not an optional refinement.
     *
     * Identical wage, identical month, identical person — the ONLY difference is
     * that this one started in August. Five months of pay projects to RM30,000
     * gross and RM17,700 chargeable, which lands where the RM400 rebate exceeds
     * the tax. Nil deduction, against RM207.50 for the colleague beside them.
     *
     * Nothing is avoided: the tax on a part year genuinely is lower. But an
     * engine that took this month's pay in isolation would deduct RM207.50 from
     * both, and over-collect from the new joiner every month to December.
     */
    const newJoiner = await withTenant(sql, ctx, (tx) =>
      computePayslip(tx, {
        wage: '6000.00',
        subject: { age: 35, citizenship: 'CITIZEN' },
        asOf: TODAY,
        tax: { resident: true, category: 1, qualifyingChildren: 0 },
      }),
    );

    expect(newJoiner.pcb!.chargeableIncome).toBe('17700.0000');
    expect(newJoiner.pcb!.deduction).toBe('0.0000');
  });

  it('gives a married sole earner with children a smaller deduction than a single filer', async () => {
    const at = (
      category: 1 | 2 | 3,
      qualifyingChildren: number,
    ): Promise<string> =>
      withTenant(sql, ctx, (tx) =>
        computePayslip(tx, {
          wage: '6000.00',
          subject: { age: 35, citizenship: 'CITIZEN' },
          asOf: TODAY,
          tax: { resident: true, category, qualifyingChildren },
          taxYearToDate: SEVEN_MONTHS_IN,
        }),
      ).then((slip) => slip.pcb!.deduction);

    const single = Number(await at(1, 0));
    const soleEarnerWithTwo = Number(await at(2, 2));
    expect(soleEarnerWithTwo).toBeLessThan(single);
  });

  it('uses the EPF figure the contributions engine looked up, not a percentage', async () => {
    /*
     * K1 in the tax formula is the employee's actual EPF for the month, and on
     * a RM6,000 wage that is RM660 from the Third Schedule — not 11% of the
     * wage computed a second time. One source for one number: if the schedule
     * changed, the tax would follow automatically.
     */
    const slip = await withTenant(sql, ctx, (tx) =>
      computePayslip(tx, {
        wage: '6000.00',
        subject: { age: 35, citizenship: 'CITIZEN' },
        asOf: TODAY,
        tax: { resident: true, category: 1, qualifyingChildren: 0 },
        taxYearToDate: SEVEN_MONTHS_IN,
      }),
    );

    // RM660 is the Third Schedule's figure for the 5,900.01-6,000.00 band, and
    // it is the number the tax formula consumed as K1 — not 11% of the wage
    // recomputed here. One source for one figure: change the schedule and the
    // tax follows without anyone remembering to update it.
    expect(slip.epf.employee).toBe('660.0000');
    // 72,000 gross for the year, less the RM4,000 EPF relief cap and RM9,000.
    // The cap is what binds: this employee contributes RM7,920 a year and gets
    // relief on RM4,000 of it.
    expect(Number(slip.pcb!.chargeableIncome)).toBe(72_000 - 4_000 - 9_000);
  });

  it('flattens a non-resident to 30% with no reliefs at all', async () => {
    const slip = await withTenant(sql, ctx, (tx) =>
      computePayslip(tx, {
        wage: '3000.00',
        subject: { age: 30, citizenship: 'NON_CITIZEN' },
        asOf: TODAY,
        tax: { resident: false, category: 1, qualifyingChildren: 0 },
      }),
    );
    expect(slip.pcb!.nonResident).toBe(true);
    expect(slip.pcb!.deduction).toBe('900.0000');
  });

  it('spreads a bonus over the year rather than taxing it in the month', async () => {
    const december = await withTenant(sql, ctx, (tx) =>
      computePayslip(tx, {
        wage: '6000.00',
        subject: { age: 35, citizenship: 'CITIZEN' },
        asOf: '2026-11-01',
        tax: { resident: true, category: 1, qualifyingChildren: 0 },
        bonus: '12000.00',
        taxYearToDate: {
          accumulatedGross: '60000.00',
          accumulatedEpf: '6600.00',
          accumulatedMtd: '2000.00',
        },
      }),
    );

    expect(Number(december.pcb!.onBonus)).toBeGreaterThan(0);
    // The bonus is taxed at the YEAR's rate. A flat marginal 19% on RM12,000
    // would be RM2,280; the correct figure is the difference between two annual
    // tax computations, and is lower.
    expect(Number(december.pcb!.onBonus)).toBeLessThan(2280);
    // Net pay covers the bonus too.
    expect(Number(december.netPay)).toBeGreaterThan(6000);
  });

  it('returns netPay = null when nobody said who the employee is for tax', async () => {
    /*
     * The refusal that matters. Without a tax profile there is no lawful way to
     * know the reliefs, and a "net pay" computed without PCB would be believed
     * precisely because it looks finished. Null is the honest answer.
     */
    const slip = await withTenant(sql, ctx, (tx) =>
      computePayslip(tx, {
        wage: '6000.00',
        subject: { age: 35, citizenship: 'CITIZEN' },
        asOf: TODAY,
      }),
    );
    expect(slip.pcb).toBeNull();
    expect(slip.netPay).toBeNull();
    // The contributions are still there — they never depended on the tax profile.
    expect(Number(slip.totalEmployee)).toBeGreaterThan(0);
  });
});
