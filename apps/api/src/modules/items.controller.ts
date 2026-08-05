import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { positiveDecimal as decimal, uuid } from '@emil/contracts';
import {
  createItem,
  getItem,
  listItems,
  setItemActive,
  updateItem,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * The item catalogue.
 *
 * ---------------------------------------------------------------------------
 * THERE HAS BEEN NO WAY TO CREATE AN ITEM SINCE THE TABLE WAS ADDED IN M2.
 *
 * `invoice_line.item_id` has accepted an id the whole time, which means no real
 * user could ever have supplied a valid one. These are the routes that make the
 * column reachable, and with it the classification code whose absence
 * dead-letters an e-Invoice submission days after the invoice was issued.
 * ---------------------------------------------------------------------------
 *
 * Reading is `item.read`, which SALES holds — you cannot raise an invoice
 * without picking from the catalogue. Writing is `item.write`, which SALES does
 * NOT hold: an item decides which account revenue posts to, and that is a
 * bookkeeping decision rather than a sales-desk one.
 */
@Controller('v1/items')
export class ItemsController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Requires('item.read')
  @Get()
  async list(
    @Query('search') search: string | undefined,
    @Query('barcode') barcode: string | undefined,
    @Query('direction') direction: string | undefined,
    @Query('includeInactive') includeInactive: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      listItems(tx, ctx, {
        ...(search !== undefined ? { search } : {}),
        // Exact, for the scanner lane — see ListItemsOptions.barcode.
        ...(barcode !== undefined ? { barcode } : {}),
        ...(direction !== undefined ? { direction: parse(directionSchema, direction) } : {}),
        // A deactivated item stays visible on request, because "why can I not
        // find the item I used last year" is otherwise unanswerable.
        includeInactive: includeInactive === 'true',
      }),
    );
  }

  @Requires('item.read')
  @Get(':id')
  async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => getItem(tx, ctx, parse(uuid, id)));
  }

  @Requires('item.write')
  @Doc({ request: () => itemSchema })
  @Post()
  async create(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(itemSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => createItem(tx, ctx, input));
  }

  /**
   * Editing an item does NOT change any invoice already issued — the resolved
   * values were copied onto the line at issue. So this needs no confirmation
   * and no version history; it cannot damage what already happened, and the
   * audit trigger records the before-and-after either way.
   */
  @Requires('item.write')
  @Doc({ request: () => itemSchema })
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(itemSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => updateItem(tx, ctx, parse(uuid, id), input));
  }

  /**
   * Retire an item, or bring it back. There is no DELETE, deliberately: every
   * invoice line that used the item carries its id, and removing the row would
   * sever a historical document from what was actually sold.
   */
  @Requires('item.write')
  @Doc({ request: () => activeSchema })
  @Post(':id/active')
  async setActive(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const { isActive } = parse(activeSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => setItemActive(tx, ctx, parse(uuid, id), isActive));
  }
}

const directionSchema = z.enum(['SALE', 'PURCHASE']);
const sideSchema = z
  .object({
    unitPrice: decimal.optional(),
    accountId: uuid.optional(),
    taxCodeId: uuid.optional(),
  })
  .optional();

const itemSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  /** What the scanner reads. EAN-13 fits; so does any label the shop prints. */
  barcode: z.string().trim().min(4).max(64).optional(),
  itemType: z.enum(['GOODS', 'SERVICE']).optional(),
  unitOfMeasure: z.string().min(1).max(50).optional(),
  uomCode: z.string().min(1).max(20).optional(),
  classificationCode: z.string().min(1).max(20).optional(),
  isSold: z.boolean().optional(),
  isPurchased: z.boolean().optional(),
  /** Perpetual inventory. GOODS only; the database refuses it on a service. */
  isTracked: z.boolean().optional(),
  /** Serial-number tracking. Requires isTracked. */
  isSerialised: z.boolean().optional(),
  sale: sideSchema,
  purchase: sideSchema,
});

const activeSchema = z.object({ isActive: z.boolean() });
