import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDate } from '@emil/contracts';
import {
  amendTaxReturn,
  endWithholdingRate,
  getTaxReturn,
  listTaxReturns,
  listWithholdingRates,
  outstandingTaxPeriods,
  prepareTaxReturn,
  seedSandboxStatutoryValues,
  setSstRegistration,
  setWithholdingRate,
  sstRegistrations,
  submitTaxReturn,
  taxReturnDocuments,
  tenantReadiness,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL, CONFIG } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';
import { NotFoundError } from '../errors.js';

/**
 * Configuration for the values this system refuses to invent.
 *
 * ---------------------------------------------------------------------------
 * THE POINT OF THESE ROUTES IS THAT UNBLOCKING NO LONGER NEEDS A DEVELOPER.
 *
 * Five capabilities ship inert because they depend on a figure that must come
 * from LHDN, PayNet, a bank or a payment provider. That was documented and
 * correct — but there was no way to enter any of those figures either, so
 * closing a gap meant writing code rather than supplying data. The person
 * holding the ruling could not use it.
 *
 * `GET /v1/readiness` is the other half: it answers what this tenant cannot do
 * yet and what would fix it, from the same configuration the features
 * themselves read — so a capability cannot report ready and then refuse.
 * ---------------------------------------------------------------------------
 */
@Controller('v1')
export class ConfigurationController {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * What works, what does not, and why.
   *
   * `journal.read` rather than an administrative permission: "can we issue an
   * e-invoice yet" is a question anyone doing the work needs answered, and the
   * response names authorities and missing configuration, never a secret.
   */
  @Requires('journal.read')
  @Get('readiness')
  async readiness(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => tenantReadiness(tx, ctx));
  }

  // ---- Withholding rates ---------------------------------------------------

  @Requires('tax.read')
  @Get('withholding-rates')
  async listRates(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return { rates: await withTenant(this.sql, ctx, (tx) => listWithholdingRates(tx, ctx)) };
  }

  /**
   * Record a withholding rate.
   *
   * `legislationRef` is required by the schema here, by the service, and by a
   * database CHECK with a length floor — three layers for one field, because a
   * rate whose origin nobody recorded cannot be re-checked when the law
   * changes, and the payer carries the liability for getting it wrong.
   */
  @Requires('tax.write')
  @Doc({ request: () => withholdingRateSchema })
  @Post('withholding-rates')
  async setRate(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(withholdingRateSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => setWithholdingRate(tx, ctx, input));
  }

  /**
   * Close a rate's validity window.
   *
   * The only permitted change to a rate already in force. The rate itself is
   * never edited: a payment withheld last month was withheld at whatever was
   * in force then, and rewriting the row makes that figure unexplainable.
   */
  @Requires('tax.write')
  @Doc({ request: () => registrationSchema })
  @Post('withholding-rates/:id/end')
  async endRate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const { validTo } = parse(endRateSchema,
      body,
    );

    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => endWithholdingRate(tx, ctx, id, validTo));
  }

  // ---- SST registration and returns ----------------------------------------

  @Requires('tax.read')
  @Get('sst-registrations')
  async listRegistrations(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return { registrations: await withTenant(this.sql, ctx, (tx) => sstRegistrations(tx, ctx)) };
  }

  /**
   * Record an SST registration and its taxable period cycle.
   *
   * The cadence is assigned by RMCD rather than chosen, and getting it wrong
   * does not produce a wrong figure — it produces a return filed for the wrong
   * period, or a period never filed. So it carries provenance, like a rate.
   */
  @Requires('tax.write')
  @Doc({ request: () => registrationSchema })
  @Post('sst-registrations')
  async setRegistration(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(registrationSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => setSstRegistration(tx, ctx, input));
  }

  @Requires('tax.read')
  @Get('tax-returns')
  async listReturns(
    @Query('regime') regime: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    const returns = await withTenant(this.sql, ctx, (tx) =>
      listTaxReturns(tx, ctx, regime !== undefined ? { regime } : {}),
    );
    return { returns: returns.map(renderReturn) };
  }

  /**
   * Periods that should have been filed and have not been.
   *
   * The most useful thing here. A wrong figure gets corrected by an amendment;
   * a period nobody filed is invisible by nature, because nothing prompts you
   * about a form you did not think about — and it is what draws an assessment.
   */
  @Requires('tax.read')
  @Get('tax-returns/outstanding')
  async outstanding(@Query('through') through: string, @Req() request: FastifyRequest) {
    const date = parse(isoDate, through ?? new Date().toISOString().slice(0, 10));
    const ctx = tenantContextOf(request);
    return {
      through: date,
      outstanding: await withTenant(this.sql, ctx, (tx) =>
        outstandingTaxPeriods(tx, ctx, date),
      ),
    };
  }

  @Requires('tax.write')
  @Doc({ request: () => prepareSchema })
  @Post('tax-returns')
  async prepare(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(prepareSchema, body);
    const ctx = tenantContextOf(request);
    const prepared = await withTenant(this.sql, ctx, (tx) =>
      prepareTaxReturn(tx, ctx, { ...input, idempotencyKey }),
    );
    return renderReturn(prepared);
  }

  @Requires('tax.read')
  @Get('tax-returns/:id')
  async getReturn(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return renderReturn(await withTenant(this.sql, ctx, (tx) => getTaxReturn(tx, ctx, id)));
  }

  /** The documents behind the figures — what makes the return checkable. */
  @Requires('tax.read')
  @Get('tax-returns/:id/documents')
  async drilldown(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return {
      documents: await withTenant(this.sql, ctx, (tx) => taxReturnDocuments(tx, ctx, id)),
    };
  }

  @Requires('tax.write')
  @Doc({ request: () => amendSchema })
  @Post('tax-returns/:id/submit')
  async submit(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return renderReturn(await withTenant(this.sql, ctx, (tx) => submitTaxReturn(tx, ctx, id)));
  }

  /**
   * Amend a filed return.
   *
   * The original is superseded, never edited. A return is a statement made to a
   * tax authority on a date, and an amendment is only explicable next to the
   * thing it amends.
   */
  @Requires('tax.write')
  @Doc({ request: () => amendSchema })
  @Post('tax-returns/:id/amend')
  async amend(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const { reason } = parse(amendSchema, body);
    const ctx = tenantContextOf(request);
    return renderReturn(
      await withTenant(this.sql, ctx, (tx) =>
        amendTaxReturn(tx, ctx, id, { reason, idempotencyKey }),
      ),
    );
  }

  // ---- Sandbox -------------------------------------------------------------

  /**
   * Load obviously-fake statutory values so the blocked flows can be shown.
   *
   * ---------------------------------------------------------------------------
   * 404 WHEN THE FLAG IS OFF, NOT 403.
   *
   * In a production deployment this route does not exist, and saying so is
   * better than acknowledging an endpoint that loads a 99% withholding rate.
   * `loadConfig` additionally refuses the flag outright when NODE_ENV is
   * production, so the two checks are independent — the route is unreachable
   * even if someone sets the environment variable on a production host.
   * ---------------------------------------------------------------------------
   */
  @Requires('tax.write')
  @Post('sandbox/statutory-values')
  async seedSandbox(@Req() request: FastifyRequest) {
    if (!this.config.enableSandboxValues) {
      throw new NotFoundError('Sandbox seeding');
    }

    const ctx = tenantContextOf(request);
    const result = await withTenant(this.sql, ctx, (tx) => seedSandboxStatutoryValues(tx, ctx));

    return {
      ...result,
      warning:
        'These are SANDBOX values. The withholding rate is 99% and the DuitNow merchant ' +
        'template pays nobody. GET /v1/readiness now reports these capabilities as ' +
        'SANDBOX rather than READY.',
    };
  }
}

const registrationSchema = z.object({
  regime: z.enum(['SST_SALES', 'SST_SERVICE']),
  registrationNo: z.string().min(1).max(60),
  cadenceMonths: z.number().int().min(1).max(12),
  firstPeriodStart: isoDate,
  sourceReference: z
    .string()
    .min(8, 'Record where the taxable period cycle was confirmed with RMCD')
    .max(300),
});

const prepareSchema = z.object({
  regime: z.enum(['SST_SALES', 'SST_SERVICE']),
  periodStart: isoDate,
  periodEnd: isoDate,
});

/**
 * Money crosses the wire as a decimal string, never a JSON number.
 *
 * `inputTaxAbsorbed` is rendered under a name that says what it is. A field
 * called `inputTax` sitting beside `netTaxPayable` invites exactly the
 * subtraction that SST does not allow.
 */
function renderReturn(view: {
  id: string; regime: string; periodStart: string; periodEnd: string; status: string;
  currency: string; taxableSupplies: { toDecimalString(): string };
  outputTaxCharged: { toDecimalString(): string };
  outputTaxAdjustments: { toDecimalString(): string };
  netTaxPayable: { toDecimalString(): string };
  inputTaxAbsorbed: { toDecimalString(): string };
  exemptSupplies: { toDecimalString(): string };
  documentCount: number; supersedesId: string | null;
  submittedAt: string | null; submittedBy: string | null;
}) {
  return {
    id: view.id,
    regime: view.regime,
    periodStart: view.periodStart,
    periodEnd: view.periodEnd,
    status: view.status,
    currency: view.currency,
    taxableSupplies: view.taxableSupplies.toDecimalString(),
    outputTaxCharged: view.outputTaxCharged.toDecimalString(),
    outputTaxAdjustments: view.outputTaxAdjustments.toDecimalString(),
    netTaxPayable: view.netTaxPayable.toDecimalString(),
    inputTaxAbsorbed: view.inputTaxAbsorbed.toDecimalString(),
    exemptSupplies: view.exemptSupplies.toDecimalString(),
    documentCount: view.documentCount,
    supersedesId: view.supersedesId,
    submittedAt: view.submittedAt,
    submittedBy: view.submittedBy,
    note:
      'inputTaxAbsorbed is reported, not deducted. SST is not a VAT: tax paid to ' +
      'suppliers is a cost already in the accounts, and netTaxPayable is the output ' +
      'tax in full.',
  };
}

const withholdingRateSchema = z.object({
  paymentType: z.string().min(1).max(60),
  // ISO 3166-1 alpha-2. Omitted for the domestic rate, set for a treaty rate.
  countryCode: z.string().length(2).optional(),
  // Basis points, never a percentage: 1000 is 10%. A percentage entered here
  // would silently withhold a hundredth of the intended amount.
  rateBasisPoints: z.number().int().min(0).max(10_000),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD'),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD').optional(),
  legislationRef: z
    .string()
    .min(8, 'Cite the source — e.g. "LHDN Public Ruling 11/2018 s4.2" or "MY-SG DTA Art 12(2)"')
    .max(300),
});

const endRateSchema = z.object({ validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD') });

const amendSchema = z.object({ reason: z.string().min(1).max(500) });
