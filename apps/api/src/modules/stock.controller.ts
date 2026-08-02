import { Body, Controller, Get, Headers, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDate, positiveDecimal, uuid } from '@emil/contracts';
import {
  countStock,
  detectStockDrift,
  stockLevels,
  stockMovements,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * Stock: what is on the shelf and what it is worth.
 *
 * Levels and movements are reads. The one write is the counted adjustment —
 * the operation that reconciles the system to the shelf, posts the value
 * difference to the ledger, and leaves a STOCK_COUNTED event behind, because
 * stock that quietly disappears is the number a shop owner most needs to see.
 */
@Controller('v1/stock')
export class StockController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Requires('stock.read')
  @Get()
  async levels(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return { stock: await withTenant(this.sql, ctx, (tx) => stockLevels(tx, ctx)) };
  }

  @Requires('stock.read')
  @Get('items/:itemId/movements')
  async movements(@Param('itemId') itemId: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return {
      movements: await withTenant(this.sql, ctx, (tx) => stockMovements(tx, ctx, itemId)),
    };
  }

  /**
   * Reconcile the system to a physical count.
   *
   * The shelf wins. Shortfalls post to the STOCK_SHRINKAGE role by default so
   * they surface as their own line rather than hiding inside COGS; opening
   * stock supplies a `unitCost` and an equity `offsetAccountId` instead.
   */
  @Requires('stock.adjust')
  @Doc({ request: () => countSchema })
  @Post('counts')
  async count(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(countSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      countStock(tx, ctx, { ...input, idempotencyKey }),
    );
  }

  /**
   * The canary: `item_stock` recomputed from `stock_movement`. Rows mean the
   * cache is wrong and the movements are right — the stock twin of
   * `GET /v1/ledger/drift`.
   */
  @Requires('stock.read')
  @Get('drift')
  async drift(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return { drift: await withTenant(this.sql, ctx, (tx) => detectStockDrift(tx, ctx)) };
  }
}

const countSchema = z.object({
  itemId: uuid,
  /** What the shelf actually says — an absolute quantity, not a delta. */
  countedQuantity: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/, 'Counted quantity must be a non-negative decimal'),
  countDate: isoDate,
  reason: z.string().min(1, 'A count with no reason is a write-off nobody explains'),
  /** For a count UP with a known cost — opening stock, an unbilled delivery. */
  unitCost: positiveDecimal.optional(),
  /** Defaults to the STOCK_SHRINKAGE posting role. */
  offsetAccountId: uuid.optional(),
});
