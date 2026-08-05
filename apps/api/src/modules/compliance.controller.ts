import { Body, Controller, Delete, Get, Inject, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  complianceCalendar,
  tickDeadline,
  untickDeadline,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * The compliance calendar — every statutory deadline, next to the state of
 * the thing it depends on.
 *
 * The calendar READS (which deadlines exist for this shop, which pay runs
 * back them) and the tick WRITES one auditable fact: "we filed this, for
 * this period, says this person". Nothing here computes a tax figure; it
 * computes whether anyone remembered.
 */
@Controller('v1/compliance')
export class ComplianceController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Requires('compliance.read')
  @Get('calendar')
  async calendar(@Query('year') year: string | undefined, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    const parsed = parse(yearSchema, year ?? String(new Date().getFullYear()));
    return withTenant(this.sql, ctx, (tx) => complianceCalendar(tx, ctx, parsed));
  }

  @Requires('compliance.manage')
  @Doc({ request: () => tickSchema })
  @Post('ticks')
  async tick(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(tickSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      tickDeadline(tx, ctx, {
        ruleCode: input.ruleCode,
        periodKey: input.periodKey,
        ...(input.note !== undefined ? { note: input.note } : {}),
      }),
    );
  }

  /** Undo a mistaken tick — audited like the tick itself. */
  @Requires('compliance.manage')
  @Doc({ request: () => untickSchema })
  @Delete('ticks')
  async untick(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(untickSchema, body);
    const ctx = tenantContextOf(request);
    await withTenant(this.sql, ctx, (tx) => untickDeadline(tx, ctx, input));
    return { removed: true };
  }
}

const yearSchema = z.coerce.number().int().min(2020).max(2100);

const tickSchema = z.object({
  ruleCode: z.string().min(1).max(40),
  /** '2026-08', '2026-P4' or '2026' — validated by shape, owned by the rule. */
  periodKey: z.string().regex(/^\d{4}(-\d{2}|-P[1-6])?$/),
  note: z.string().trim().max(500).optional(),
});

const untickSchema = tickSchema.omit({ note: true });
