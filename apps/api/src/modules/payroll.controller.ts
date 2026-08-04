import { Body, Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decimal, isoDate, positiveDecimal } from '@emil/contracts';
import {
  computeContributions,
  computePayslip,
  employmentCost,
  loadStatutorySchedules,
  payslipDocument,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';
import { renderPayslipPdf } from '../pdf/render.js';

/**
 * Statutory payroll — EPF, SOCSO, EIS and PCB.
 *
 * ---------------------------------------------------------------------------
 * A CALCULATOR, NOT A PAYROLL. THE DIFFERENCE IS DELIBERATE.
 *
 * There are no employee records here, no pay runs and no ledger postings. A
 * payslip CAN be printed — `payslip/pdf` — but nothing about it is retained,
 * because there is nowhere to retain it and pretending otherwise would be
 * worse than the gap. What exists is the part that must be RIGHT before any of
 * that is worth building: all four statutory deductions, loaded from
 * effective-dated tables and applied by pure engines tested against the
 * published schedules — 1,203 EPF bands, and IRBM's own four-month worked
 * example for the tax.
 *
 * Building the pay run first and the rates later would have meant a payroll
 * that produced numbers from day one — plausible numbers, wrong by a few sen on
 * most salaries, which is the employer's liability and not the employee's. So
 * the order is rates, then runs.
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
        subject: subjectOf(input),
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
        subject: subjectOf(input),
      }),
    );
  }

  /**
   * The whole payslip: contributions AND income tax.
   *
   * Separate from `/contributions` rather than a flag on it, because the inputs
   * are genuinely different — PCB needs to know who the employee is for tax
   * purposes and where they are in the tax year, and a route that took all of
   * that optionally would answer with a net pay that quietly omitted income tax
   * whenever a caller left a field out.
   */
  @Requires('payroll.read')
  @Doc({ request: () => payslipSchema })
  @Post('payslip')
  async payslip(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(payslipSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      computePayslip(tx, {
        wage: input.wage,
        asOf: input.asOf,
        subject: subjectOf(input),
        tax: {
          resident: input.tax.resident,
          category: input.tax.category,
          qualifyingChildren: input.tax.qualifyingChildren,
          ...(input.tax.disabled !== undefined ? { disabled: input.tax.disabled } : {}),
          ...(input.tax.disabledSpouse !== undefined
            ? { disabledSpouse: input.tax.disabledSpouse }
            : {}),
        },
        ...(input.bonus !== undefined ? { bonus: input.bonus } : {}),
        ...(input.taxYearToDate !== undefined ? { taxYearToDate: input.taxYearToDate } : {}),
      }),
    );
  }

  /**
   * The payslip as a printable document.
   *
   * A POST that returns a PDF, which is unusual and deliberate: there is no
   * stored payslip to GET by id, because this system keeps no employee records
   * and no pay runs. Everything the page shows arrives in the body, is rendered,
   * and is not retained — which is stated on the screen rather than left for
   * someone to discover when they look for last month's copy.
   */
  @Requires('payroll.read')
  @Doc({ request: () => payslipPdfSchema })
  @Post('payslip/pdf')
  async payslipPdf(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const input = parse(payslipPdfSchema, body);
    const ctx = tenantContextOf(request);
    const doc = await withTenant(this.sql, ctx, (tx) =>
      payslipDocument(tx, ctx, {
        wage: input.wage,
        asOf: input.asOf,
        subject: subjectOf(input),
        tax: {
          resident: input.tax.resident,
          category: input.tax.category,
          qualifyingChildren: input.tax.qualifyingChildren,
          ...(input.tax.disabled !== undefined ? { disabled: input.tax.disabled } : {}),
          ...(input.tax.disabledSpouse !== undefined
            ? { disabledSpouse: input.tax.disabledSpouse }
            : {}),
        },
        employee: {
          name: input.employee.name,
          ...(input.employee.staffId !== undefined ? { staffId: input.employee.staffId } : {}),
          ...(input.employee.jobTitle !== undefined ? { jobTitle: input.employee.jobTitle } : {}),
          ...(input.employee.idNumber !== undefined ? { idNumber: input.employee.idNumber } : {}),
        },
        ...(input.bonus !== undefined ? { bonus: input.bonus } : {}),
        ...(input.taxYearToDate !== undefined ? { taxYearToDate: input.taxYearToDate } : {}),
      }),
    );

    const pdf = await renderPayslipPdf(doc);
    const slug = doc.period.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="payslip-${slug}.pdf"`)
      .send(pdf);
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

/**
 * The contribution subject, assembled once.
 *
 * `exactOptionalPropertyTypes` is on, so an absent flag must be OMITTED rather
 * than passed as undefined — which is why this is a spread dance and not an
 * object literal, and why it lives in one place instead of three.
 */
function subjectOf(input: z.infer<typeof contributionSchema>) {
  return {
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
  };
}

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

/**
 * Who the employee is for INCOME TAX purposes — a different question from who
 * they are for contributions, which is why it is a different object.
 */
const taxProfileSchema = z.object({
  resident: z.boolean(),
  /**
   * 1 single · 2 married with a non-working spouse · 3 married with a working
   * spouse, divorced, widowed, or single with an adopted child. No default: a
   * guess of "single" over-deducts a sole earner by RM4,000 of relief a year.
   */
  category: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /**
   * C, not the number of children. A child in tertiary education counts as
   * FOUR and a disabled child in tertiary education as eight — the
   * specification expresses the larger relief by inflating this count, and the
   * client that knows the children's circumstances is the one that must do it.
   */
  qualifyingChildren: z.number().int().min(0).max(40),
  disabled: z.boolean().optional(),
  disabledSpouse: z.boolean().optional(),
});

const payslipSchema = contributionSchema.extend({
  tax: taxProfileSchema,
  /** A bonus or other additional remuneration paid this month. */
  bonus: positiveDecimal.optional(),
  /**
   * Where the employee already is in the tax year. Optional so a single-month
   * estimate is possible, but a real payroll run must send it: without it every
   * month is computed as though it were January, which under-deducts all year.
   */
  taxYearToDate: z
    .object({
      accumulatedGross: decimal,
      accumulatedEpf: decimal,
      accumulatedMtd: decimal,
      accumulatedOptionalDeductions: decimal.optional(),
      optionalDeductionsThisMonth: decimal.optional(),
      accumulatedZakat: decimal.optional(),
      zakatThisMonth: decimal.optional(),
    })
    .optional(),
});

const payslipPdfSchema = payslipSchema.extend({
  employee: z.object({
    /**
     * Typed by the shop, not looked up — this system holds no employee records,
     * and the payslip says so at the foot rather than implying a register that
     * does not exist.
     */
    name: z.string().trim().min(1).max(120),
    staffId: z.string().trim().max(40).optional(),
    jobTitle: z.string().trim().max(80).optional(),
    idNumber: z.string().trim().max(40).optional(),
  }),
});
