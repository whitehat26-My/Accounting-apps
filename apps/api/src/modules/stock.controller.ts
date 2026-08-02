import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDate, positiveDecimal, uuid } from '@emil/contracts';
import {
  countStock,
  detectSerialDrift,
  detectStockDrift,
  findSerial,
  stockLevels,
  stockMovements,
  stockUnits,
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

  /** The units of a serialised item, optionally by status. */
  @Requires('stock.read')
  @Get('items/:itemId/units')
  async units(
    @Param('itemId') itemId: string,
    @Query('status') status: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const parsed = status === undefined ? undefined : parse(unitStatusSchema, status);
    const ctx = tenantContextOf(request);
    return {
      units: await withTenant(this.sql, ctx, (tx) =>
        stockUnits(tx, ctx, itemId, ...(parsed !== undefined ? [parsed] : [])),
      ),
    };
  }

  /**
   * The warranty question. A customer is at the counter holding a device;
   * this answers what it is, when it came in on which document, and when it
   * left on which. An empty list — "we have never seen this serial" — is
   * itself the answer, so it is a 200, never a 404.
   */
  @Requires('stock.read')
  @Get('serials/:serialNo')
  async serial(@Param('serialNo') serialNo: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return { matches: await withTenant(this.sql, ctx, (tx) => findSerial(tx, ctx, serialNo)) };
  }

  /**
   * The canaries: `item_stock` recomputed from `stock_movement`, and IN_STOCK
   * unit counts against pool quantities for serialised items. Rows mean the
   * cache (or the unit ledger) disagrees with the movements — the stock twin
   * of `GET /v1/ledger/drift`.
   */
  @Requires('stock.read')
  @Get('drift')
  async drift(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, async (tx) => ({
      drift: await detectStockDrift(tx, ctx),
      serialDrift: await detectSerialDrift(tx, ctx),
    }));
  }
}

const unitStatusSchema = z.enum(['IN_STOCK', 'SOLD', 'WRITTEN_OFF']);

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
  /** For a serialised item: the units that appeared or went missing. */
  serialNumbers: z.array(z.string().min(1).max(120)).max(1000).optional(),
  /** Defaults to the STOCK_SHRINKAGE posting role. */
  offsetAccountId: uuid.optional(),
});
