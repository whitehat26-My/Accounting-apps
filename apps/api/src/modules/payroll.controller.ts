import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDate, positiveDecimal } from '@emil/contracts';
import {
  computeContributions,
  employmentCost,
  loadStatutorySchedules,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * Statutory contributions — EPF, SOCSO and EIS.
 *
 * ---------------------------------------------------------------------------
 * A CALCULATOR, NOT A PAYROLL. THE DIFFERENCE IS DELIBERATE.
 *
 * There are no employee records here, no pay runs, no payslips and no ledger
 * postings. What exists is the part that must be RIGHT before any of that is
 * worth building: the published schedules, loaded from effective-dated tables
 * and applied by a pure engine tested against all 1,203 EPF bands.
 *
 * Building the pay run first and the rates later would have meant a payroll
 * that produced numbers from day one — plausible numbers, wrong by a few sen on
 * most salaries, which is the employer's liability and not the employee's. So
 * the order is rates, then runs.
 *
 * PCB is NOT here. See `docs/SETTLEMENT-REGISTER.md`.
 * ---------------------------------------------------------------------------
 */
@Controller('v1/payroll')
export class PayrollController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  /**
   * What one month's contributions are for one wage and one person.
   *
   * A POST despite reading nothing, because the wage goes in the body: a salary
   * in a query string ends up in the access log of every proxy between the
   * browser and the shop PC, and stays there.
   */
  @Requires('payroll.read')
  @Doc({ request: () => contributionSchema })
  @Post('contributions')
  async contributions(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(contributionSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      computeContributions(tx, {
        wage: input.wage,
        asOf: input.asOf,
        subject: {
          age: input.age,
          citizenship: input.citizenship,
          ...(input.electedBefore1Aug1998 !== undefined
            ? { electedBefore1Aug1998: input.electedBefore1Aug1998 }
            : {}),
          ...(input.onInvalidityPension !== undefined
            ? { onInvalidityPension: input.onInvalidityPension }
            : {}),
          ...(input.hadEisContributionBefore57 !== undefined
            ? { hadEisContributionBefore57: input.hadEisContributionBefore57 }
            : {}),
        },
      }),
    );
  }

  /** The same figures, plus the one the owner actually asked for: total cost. */
  @Requires('payroll.read')
  @Doc({ request: () => contributionSchema })
  @Post('employment-cost')
  async cost(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(contributionSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      employmentCost(tx, {
        wage: input.wage,
        asOf: input.asOf,
        subject: {
          age: input.age,
          citizenship: input.citizenship,
          ...(input.electedBefore1Aug1998 !== undefined
            ? { electedBefore1Aug1998: input.electedBefore1Aug1998 }
            : {}),
          ...(input.onInvalidityPension !== undefined
            ? { onInvalidityPension: input.onInvalidityPension }
            : {}),
          ...(input.hadEisContributionBefore57 !== undefined
            ? { hadEisContributionBefore57: input.hadEisContributionBefore57 }
            : {}),
        },
      }),
    );
  }

  /**
   * The schedules themselves, as at a date.
   *
   * Here so the figures can be CHECKED against PERKESO's and EPF's own printed
   * tables without reading the migration file. A rate nobody can inspect is a
   * rate nobody can catch being wrong.
   */
  @Requires('payroll.read')
  @Get('schedules')
  async schedules(
    @Query('asOf') asOf: string,
    @Query('part') part: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    const epfPart = parse(partSchema, part ?? 'A');
    return withTenant(this.sql, ctx, async (tx) => {
      const loaded = await loadStatutorySchedules(tx, epfPart, parse(isoDate, asOf));
      return {
        asOf: parse(isoDate, asOf),
        epfPart,
        epfRule: loaded.epfRule,
        epfBands: loaded.epfBands,
        socsoBands: loaded.socsoBands,
        eisBands: loaded.eisBands,
      };
    });
  }
}

const partSchema = z.enum(['A', 'C', 'E', 'F']);

const contributionSchema = z.object({
  /** Monthly wage. A string, per rule 2 — a salary is money, and money is never a float. */
  wage: positiveDecimal,
  /**
   * The contribution MONTH, not today. Required with no default: SKBBK began on
   * 1 June 2026, so a re-run of May must be told it is May.
   */
  asOf: isoDate,
  /** Completed years at the contribution month. */
  age: z.number().int().min(14).max(100),
  citizenship: z.enum(['CITIZEN', 'PERMANENT_RESIDENT', 'NON_CITIZEN']),
  electedBefore1Aug1998: z.boolean().optional(),
  onInvalidityPension: z.boolean().optional(),
  hadEisContributionBefore57: z.boolean().optional(),
});
