import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDate, positiveDecimal, uuid } from '@emil/contracts';
import {
  collectRepairJob,
  createRepairJob,
  getRepairJob,
  listRepairJobs,
  quoteRepairJob,
  setFittedSerials,
  transitionRepairJob,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * The workshop.
 *
 * Intake, quote, status transitions, and the one route that touches money:
 * collection, which converts the job to an invoice through the same paths the
 * till uses. A job cannot be marked COLLECTED by a status change — the invoice
 * IS the collection, or the work walks out unbilled.
 */
@Controller('v1/repairs')
export class RepairsController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Requires('repair.read')
  @Get()
  async list(@Query('status') status: string | undefined, @Req() request: FastifyRequest) {
    const parsed = status === undefined ? undefined : parse(statusSchema, status);
    const ctx = tenantContextOf(request);
    return {
      jobs: await withTenant(this.sql, ctx, (tx) =>
        listRepairJobs(tx, ctx, parsed !== undefined ? { status: parsed } : {}),
      ),
    };
  }

  @Requires('repair.read')
  @Get(':id')
  async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => getRepairJob(tx, ctx, parse(uuid, id)));
  }

  @Requires('repair.write')
  @Doc({ request: () => intakeSchema })
  @Post()
  async intake(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(intakeSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      createRepairJob(tx, ctx, { ...input, idempotencyKey }),
    );
  }

  @Requires('repair.write')
  @Doc({ request: () => quoteSchema })
  @Post(':id/quote')
  async quote(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(quoteSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => quoteRepairJob(tx, ctx, parse(uuid, id), input));
  }

  @Requires('repair.write')
  @Doc({ request: () => transitionSchema })
  @Post(':id/status')
  async transition(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(transitionSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      transitionRepairJob(tx, ctx, parse(uuid, id), input),
    );
  }

  /**
   * Name the units the bench fitted. Serials only — the agreed price cannot
   * drift in through this door, which is why it is not a quote revision.
   */
  @Requires('repair.write')
  @Doc({ request: () => fittedSchema })
  @Post(':id/lines/:lineNo/serials')
  async fitted(
    @Param('id') id: string,
    @Param('lineNo') lineNo: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(fittedSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      setFittedSerials(tx, ctx, parse(uuid, id), Number(lineNo), input.serialNumbers),
    );
  }

  /** Collect: invoice the quote, optionally taking payment at the counter. */
  @Requires('repair.write')
  @Doc({ request: () => collectSchema })
  @Post(':id/collect')
  async collect(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(collectSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      collectRepairJob(tx, ctx, parse(uuid, id), { ...input, idempotencyKey }),
    );
  }
}

const statusSchema = z.enum([
  'RECEIVED', 'QUOTED', 'APPROVED', 'DECLINED', 'IN_PROGRESS', 'READY', 'COLLECTED', 'CANCELLED',
]);

const intakeSchema = z.object({
  contactId: uuid,
  deviceDescription: z.string().min(1).max(500),
  deviceSerial: z.string().min(1).max(120).optional(),
  reportedFault: z.string().min(1).max(2000),
  receivedOn: isoDate,
});

const quoteSchema = z.object({
  diagnosis: z.string().min(1).max(2000),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        quantity: positiveDecimal,
        /** The AGREED price — what collection will invoice, verbatim. */
        unitPrice: z.string().regex(/^\d+(\.\d{1,4})?$/),
        itemId: uuid.optional(),
        taxCodeId: uuid.optional(),
        accountId: uuid.optional(),
        serialNumbers: z.array(z.string().min(1).max(120)).max(100).optional(),
      }),
    )
    .min(1),
});

const transitionSchema = z.object({
  to: statusSchema,
  reason: z.string().min(1).max(1000).optional(),
  approvalNote: z.string().min(1).max(500).optional(),
});

const fittedSchema = z.object({
  serialNumbers: z.array(z.string().min(1).max(120)).min(1).max(100),
});

const collectSchema = z.object({
  collectDate: isoDate,
  payment: z
    .object({
      method: z.enum(['CASH', 'CARD', 'DUITNOW', 'TRANSFER', 'CHEQUE', 'OTHER']),
      depositAccountId: uuid,
      tenderedAmount: positiveDecimal.optional(),
    })
    .optional(),
});
