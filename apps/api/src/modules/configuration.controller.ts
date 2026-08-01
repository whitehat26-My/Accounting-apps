import { Body, Controller, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  endWithholdingRate,
  listWithholdingRates,
  seedSandboxStatutoryValues,
  setWithholdingRate,
  tenantReadiness,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL, CONFIG } from '../tokens.js';
import type { ApiConfig } from '../config.js';
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
  @Post('withholding-rates/:id/end')
  async endRate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const { validTo } = parse(
      z.object({ validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD') }),
      body,
    );

    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => endWithholdingRate(tx, ctx, id, validTo));
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
