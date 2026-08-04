import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decimal, isoDate, positiveDecimal, uuid } from '@emil/contracts';
import {
  computeContributions,
  computePayslip,
  confirmPayRun,
  createEmployee,
  employmentCost,
  getPayRun,
  listEmployees,
  listPayRuns,
  loadStatutorySchedules,
  payRunCp39,
  payRunPayslip,
  payslipDocument,
  preparePayRun,
  reversePayRun,
  setPayrollSettings,
  updateEmployee,
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
 * Statutory payroll — the rates, and now the runs.
 *
 * ---------------------------------------------------------------------------
 * TWO SURFACES, BUILT IN THE ORDER THAT MADE THE SECOND TRUSTWORTHY.
 *
 * The CALCULATOR routes (contributions, employment-cost, payslip) answer for
 * one wage at a time and retain nothing — they exist so the figures could be
 * proven against the published schedules (1,203 EPF bands, IRBM's own worked
 * example) before anything was built on them.
 *
 * The RUN routes (employees, runs/*) are the payroll itself: a staff register,
 * a month computed for everyone on it, one balanced journal entry through the
 * single ledger write path, payslips served from the confirmed snapshot, and
 * the CP39 file LHDN actually accepts. The year-to-date the tax formula needs
 * is ACCUMULATED from confirmed runs — the bookkeeping a shop used to pay a
 * firm to keep.
 *
 * Rates first, then runs: a pay run shipped before the rates were proven would
 * have produced confident figures wrong by a few sen on most salaries, which
 * is the employer's liability and not the employee's.
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
   * A one-off payslip from typed figures — the calculator's printable output.
   *
   * A POST that returns a PDF: everything on the page arrives in the body and
   * nothing is retained. For staff on the register, the pay-run route below
   * serves payslips from the confirmed snapshot instead; this route stays for
   * the quick "print one for someone not on the books" case.
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

  // ---- The staff register -------------------------------------------------

  /**
   * The register holds every salary, so reading it needs `payroll.read` — the
   * same boundary that keeps SALES and TECHNICIAN out of the calculator.
   */
  @Requires('payroll.read')
  @Get('employees')
  async employees(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return { employees: await withTenant(this.sql, ctx, (tx) => listEmployees(tx, ctx)) };
  }

  @Requires('payroll.manage')
  @Doc({ request: () => employeeSchema })
  @Post('employees')
  async addEmployee(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(employeeSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => createEmployee(tx, ctx, employeeInput(input)));
  }

  @Requires('payroll.manage')
  @Doc({ request: () => employeeSchema })
  @Patch('employees/:id')
  async editEmployee(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(employeeSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      updateEmployee(tx, ctx, parse(uuid, id), employeeInput(input)),
    );
  }

  // ---- The month ----------------------------------------------------------

  /**
   * Compute the month for everyone on the books, as a DRAFT. Posts nothing;
   * preparing again replaces the draft. The year-to-date is read from
   * confirmed history — nobody types a running total.
   */
  @Requires('payroll.manage')
  @Doc({ request: () => prepareSchema })
  @Post('runs/prepare')
  async prepare(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(prepareSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      preparePayRun(tx, ctx, {
        payMonth: input.payMonth,
        ...(input.overrides !== undefined ? { overrides: input.overrides } : {}),
        idempotencyKey,
      }),
    );
  }

  @Requires('payroll.read')
  @Get('runs')
  async runs(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return { runs: await withTenant(this.sql, ctx, (tx) => listPayRuns(tx, ctx)) };
  }

  @Requires('payroll.read')
  @Get('runs/:id')
  async run(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => getPayRun(tx, ctx, parse(uuid, id)));
  }

  /** The one button that moves money: posts the month to the ledger. */
  @Requires('payroll.manage')
  @Post('runs/:id/confirm')
  async confirm(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      confirmPayRun(tx, ctx, parse(uuid, id), idempotencyKey),
    );
  }

  @Requires('payroll.manage')
  @Doc({ request: () => reverseSchema })
  @Post('runs/:id/reverse')
  async reverse(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(reverseSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      reversePayRun(tx, ctx, parse(uuid, id), input.reason, idempotencyKey),
    );
  }

  /** The CP39 text file, exactly as e-PCB Plus and internet banking take it. */
  @Requires('payroll.read')
  @Get('runs/:id/cp39')
  async cp39(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = tenantContextOf(request);
    const file = await withTenant(this.sql, ctx, (tx) => payRunCp39(tx, ctx, parse(uuid, id)));
    void reply
      .header('content-type', 'text/plain; charset=ascii')
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .send(file.content);
  }

  /** One payslip off a run, from the stored snapshot — never recomputed. */
  @Requires('payroll.read')
  @Get('runs/:id/payslips/:lineId/pdf')
  async runPayslipPdf(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = tenantContextOf(request);
    const doc = await withTenant(this.sql, ctx, (tx) =>
      payRunPayslip(tx, ctx, parse(uuid, id), parse(uuid, lineId)),
    );
    const pdf = await renderPayslipPdf(doc);
    const slug = doc.period.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="payslip-${slug}.pdf"`)
      .send(pdf);
  }

  /** The LHDN employer number the CP39 carries. */
  @Requires('payroll.manage')
  @Doc({ request: () => settingsSchema })
  @Patch('settings')
  async settings(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(settingsSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => setPayrollSettings(tx, ctx, input));
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
     * Typed by the shop, not looked up — this route is the quick one-off print
     * for someone not on the books. Staff on the register get their payslips
     * from the pay-run snapshot instead (`runs/:id/payslips/:lineId/pdf`).
     */
    name: z.string().trim().min(1).max(120),
    staffId: z.string().trim().max(40).optional(),
    jobTitle: z.string().trim().max(80).optional(),
    idNumber: z.string().trim().max(40).optional(),
  }),
});

/**
 * A staff record. One schema for create and edit: the form always sends the
 * whole row, which keeps the audit trail a complete before/after and lets an
 * edit clear a field (a patch of optionals cannot express "remove the
 * leaving date").
 */
const employeeSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  employeeNo: z.string().trim().max(40).optional(),
  idType: z.enum(['NRIC', 'PASSPORT']).optional(),
  idValue: z.string().trim().max(40).optional(),
  /** LHDN Tax Identification Number — what the CP39 identifies people by. */
  tin: z.string().trim().max(20).optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  dateOfBirth: isoDate,
  citizenship: z.enum(['CITIZEN', 'PERMANENT_RESIDENT', 'NON_CITIZEN']),
  taxResident: z.boolean(),
  taxCategory: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  qualifyingChildren: z.number().int().min(0).max(40),
  disabled: z.boolean().optional(),
  disabledSpouse: z.boolean().optional(),
  epfElectedBefore1998: z.boolean().optional(),
  onInvalidityPension: z.boolean().optional(),
  hadEisContributionBefore57: z.boolean().optional(),
  monthlyWage: positiveDecimal,
  jobTitle: z.string().trim().max(80).optional(),
  hiredOn: isoDate,
  leftOn: isoDate.nullable().optional(),
  /** Form TP3 — a previous employer's figures for THIS year. */
  ytdYear: z.number().int().min(2020).max(2100).optional(),
  ytdGrossBefore: decimal.optional(),
  ytdEpfBefore: decimal.optional(),
  ytdMtdBefore: decimal.optional(),
});

/** exactOptionalPropertyTypes: absent fields must be OMITTED, not undefined. */
function employeeInput(input: z.infer<typeof employeeSchema>) {
  return {
    fullName: input.fullName,
    dateOfBirth: input.dateOfBirth,
    citizenship: input.citizenship,
    taxResident: input.taxResident,
    taxCategory: input.taxCategory,
    qualifyingChildren: input.qualifyingChildren,
    monthlyWage: input.monthlyWage,
    hiredOn: input.hiredOn,
    ...(input.employeeNo !== undefined ? { employeeNo: input.employeeNo } : {}),
    ...(input.idType !== undefined ? { idType: input.idType } : {}),
    ...(input.idValue !== undefined ? { idValue: input.idValue } : {}),
    ...(input.tin !== undefined ? { tin: input.tin } : {}),
    ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
    ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
    ...(input.disabledSpouse !== undefined ? { disabledSpouse: input.disabledSpouse } : {}),
    ...(input.epfElectedBefore1998 !== undefined
      ? { epfElectedBefore1998: input.epfElectedBefore1998 }
      : {}),
    ...(input.onInvalidityPension !== undefined
      ? { onInvalidityPension: input.onInvalidityPension }
      : {}),
    ...(input.hadEisContributionBefore57 !== undefined
      ? { hadEisContributionBefore57: input.hadEisContributionBefore57 }
      : {}),
    ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
    ...(input.leftOn !== undefined ? { leftOn: input.leftOn } : {}),
    ...(input.ytdYear !== undefined ? { ytdYear: input.ytdYear } : {}),
    ...(input.ytdGrossBefore !== undefined ? { ytdGrossBefore: input.ytdGrossBefore } : {}),
    ...(input.ytdEpfBefore !== undefined ? { ytdEpfBefore: input.ytdEpfBefore } : {}),
    ...(input.ytdMtdBefore !== undefined ? { ytdMtdBefore: input.ytdMtdBefore } : {}),
  };
}

const prepareSchema = z.object({
  /** The first of the month, always — the day carries no information. */
  payMonth: isoDate.refine((d) => d.endsWith('-01'), 'payMonth must be the first of the month'),
  /** Per-employee adjustments for this month only, keyed by employee id. */
  overrides: z
    .record(
      uuid,
      z.object({
        bonus: positiveDecimal.optional(),
        wageOverride: positiveDecimal.optional(),
      }),
    )
    .optional(),
});

const reverseSchema = z.object({
  /** Kept on the record — six months later nobody remembers why. */
  reason: z.string().trim().min(1).max(500),
});

const settingsSchema = z.object({
  /** The E number on the employer's LHDN tax file. Digits only. */
  lhdnEmployerNo: z.string().regex(/^\d{1,10}$/),
});
