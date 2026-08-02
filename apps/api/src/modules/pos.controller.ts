import { Body, Controller, Get, Headers, Inject, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDate, positiveDecimal, uuid } from '@emil/contracts';
import { dailyTakings, recordCashSale, withTenant, type Sql } from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * The till.
 *
 * One route rings a sale — invoice, stock relief, COGS and receipt in a single
 * transaction — and one reads the day back for the drawer count. Both sit
 * under `pos.sale`, which SALES holds: the person who can ring the sale is the
 * person who closes the till, and neither act needs the general receipt
 * powers that stay with the bookkeeping roles.
 */
@Controller('v1/pos')
export class PosController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Requires('pos.sale')
  @Doc({ request: () => cashSaleSchema })
  @Post('sales')
  async sale(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(cashSaleSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      recordCashSale(tx, ctx, { ...input, idempotencyKey }),
    );
  }

  /**
   * The Z-report: takings by method for the drawer, plus what the day made.
   */
  @Requires('pos.sale')
  @Get('takings')
  async takings(@Query('date') date: string | undefined, @Req() request: FastifyRequest) {
    const { date: parsed } = parse(takingsSchema, { date });
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => dailyTakings(tx, ctx, parsed));
  }
}

const cashSaleSchema = z.object({
  saleDate: isoDate,
  lines: z
    .array(
      z.object({
        quantity: positiveDecimal,
        itemId: uuid.optional(),
        description: z.string().min(1).optional(),
        unitPrice: positiveDecimal.optional(),
        accountId: uuid.optional(),
        taxCodeId: uuid.optional(),
        discountBasisPoints: z.number().int().min(0).max(10_000).optional(),
      }),
    )
    .min(1),
  method: z.enum(['CASH', 'CARD', 'DUITNOW', 'TRANSFER', 'CHEQUE', 'OTHER']),
  depositAccountId: uuid,
  /** Omit for the anonymous walk-in customer. */
  contactId: uuid.optional(),
  tenderedAmount: positiveDecimal.optional(),
  reference: z.string().optional(),
  amountsAreTaxInclusive: z.boolean().optional(),
});

const takingsSchema = z.object({ date: isoDate });
