import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decimal, isoDate, positiveDecimal, uuid } from '@emil/contracts';
import {
  convertQuoteToInvoice,
  createQuote,
  getQuote,
  listQuotes,
  transitionQuote,
  updateQuoteLines,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * Sales quotes.
 *
 * Everything here is an offer, not an accounting fact — no route in this file
 * posts to the ledger. The one exception is `convert`, which delegates to
 * `issueInvoice` and is the moment the offer becomes revenue. That asymmetry is
 * the whole design: quoting is cheap and reversible, invoicing is neither.
 */
@Controller('v1/quotes')
export class QuotesController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Requires('quote.read')
  @Get()
  async list(
    @Query('status') status: string | undefined,
    @Query('contactId') contactId: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    return {
      quotes: await withTenant(this.sql, ctx, (tx) =>
        listQuotes(tx, ctx, {
          ...(status !== undefined ? { status: parse(statusSchema, status) } : {}),
          ...(contactId !== undefined ? { contactId: parse(uuid, contactId) } : {}),
        }),
      ),
    };
  }

  @Requires('quote.read')
  @Get(':id')
  async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => getQuote(tx, ctx, parse(uuid, id)));
  }

  @Requires('quote.write')
  @Doc({ request: () => createQuoteSchema })
  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(createQuoteSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => createQuote(tx, ctx, { ...input, idempotencyKey }));
  }

  /** Rewrite the lines. DRAFT only — the service explains why. */
  @Requires('quote.write')
  @Doc({ request: () => linesSchema })
  @Post(':id/lines')
  async lines(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(linesSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      updateQuoteLines(tx, ctx, parse(uuid, id), input.lines),
    );
  }

  /** Send it, record the yes or the no, or revive a lapsed one. */
  @Requires('quote.write')
  @Doc({ request: () => transitionSchema })
  @Post(':id/status')
  async status(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(transitionSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => transitionQuote(tx, ctx, parse(uuid, id), input));
  }

  /**
   * The one route here that moves money: an accepted quote becomes an invoice
   * through the same path a typed one takes.
   */
  @Requires('quote.write')
  @Doc({ request: () => convertSchema })
  @Post(':id/convert')
  async convert(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(convertSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      convertQuoteToInvoice(tx, ctx, parse(uuid, id), { ...input, idempotencyKey }),
    );
  }
}

const statusSchema = z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'INVOICED']);

const lineSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: positiveDecimal,
  unitPrice: decimal,
  itemId: uuid.optional(),
  accountId: uuid.optional(),
  taxCodeId: uuid.optional(),
  discountBasisPoints: z.number().int().min(0).max(10000).optional(),
});

const createQuoteSchema = z.object({
  contactId: uuid,
  quoteDate: isoDate,
  validUntil: isoDate.optional(),
  currency: z.string().length(3).optional(),
  reference: z.string().min(1).max(200).optional(),
  notes: z.string().min(1).max(2000).optional(),
  amountsAreTaxInclusive: z.boolean().optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

const linesSchema = z.object({ lines: z.array(lineSchema).min(1).max(200) });

const transitionSchema = z.object({
  to: statusSchema,
  reason: z.string().min(1).max(1000).optional(),
});

const convertSchema = z.object({
  issueDate: isoDate,
  dueDate: isoDate.optional(),
});
