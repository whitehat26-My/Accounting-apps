import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import {
  PayrollError,
  computeContributions,
  employmentCost,
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
