import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { uuid } from '@emil/contracts';
import {
  connectFeed,
  feedForSync,
  ingestFeedTransactions,
  listFeeds,
  recordFeedError,
  revokeFeed,
  setFeedStatus,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';
import { ValidationError } from '../errors.js';
import { feedProvider } from '../feeds/providers.js';

/**
 * Bank feeds — lines that arrive on their own.
 *
 * ---------------------------------------------------------------------------
 * THE PUSH ROUTE IS THE ONE THAT MATTERS.
 *
 * `POST /v1/bank-feeds/:id/transactions` takes JSON transactions and is
 * authenticated by the SAME guard as everything else — which means it works
 * with a scoped API key (`X-Api-Key`, scopes `['bank.import']`, issued at
 * `POST /v1/auth/api-keys`). No second front door, no bespoke token format,
 * no webhook secret to invent: a key that can feed the bank account cannot
 * read an invoice, cannot see payroll, and can be revoked from the Team
 * screen like any other key.
 *
 * So "the app has a bank-feed API" is true TODAY, one curl away — what waits
 * on a bank agreement is only who calls it. A script the shop schedules, a
 * middleware service, or eventually a bank's own delivery can all use the
 * same route; the books cannot tell them apart, which is the point.
 *
 * The pull side (`/sync`) goes through the provider port. SANDBOX is the only
 * adapter — see `../feeds/providers.ts` for why that is honest rather than
 * unfinished.
 * ---------------------------------------------------------------------------
 */
@Controller('v1/bank-feeds')
export class FeedsController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Requires('bank.read')
  @Get()
  async list(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return { feeds: await withTenant(this.sql, ctx, (tx) => listFeeds(tx, ctx)) };
  }

  /** Wire a source to a bank account. Evented: the audit question is "who". */
  @Requires('bank.import')
  @Doc({ request: () => connectSchema })
  @Post()
  async connect(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(connectSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => connectFeed(tx, ctx, input));
  }

  @Requires('bank.import')
  @Doc({ request: () => statusSchema })
  @Patch(':id')
  async status(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(statusSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      input.status === 'REVOKED'
        ? revokeFeed(tx, ctx, parse(uuid, id))
        : setFeedStatus(tx, ctx, parse(uuid, id), input.status),
    );
  }

  /**
   * Pull from the provider and land whatever is new. Idempotent per key, and
   * safe to mash: everything already held dedupes to `duplicates`.
   */
  @Requires('bank.import')
  @Post(':id/sync')
  async sync(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    const feedId = parse(uuid, id);

    const { view, cursor } = await withTenant(this.sql, ctx, (tx) =>
      feedForSync(tx, ctx, feedId),
    );
    const provider = feedProvider(view.provider);
    if (provider === undefined) {
      throw new ValidationError(
        view.provider === 'API_PUSH'
          ? 'This feed is pushed to, not pulled — its source sends transactions to ' +
            `POST /v1/bank-feeds/${feedId}/transactions with an API key.`
          : `No adapter exists for ${view.provider}.`,
      );
    }

    // The provider call happens OUTSIDE the transaction: an HTTP fetch inside
    // one would hold a connection open for as long as a third party takes to
    // answer. Failure is recorded on the connection so the screen can say so.
    let pulled;
    try {
      pulled = await provider.fetch({ cursor });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withTenant(this.sql, ctx, (tx) => recordFeedError(tx, ctx, feedId, message));
      throw new ValidationError(`The provider could not be read: ${message}`);
    }

    return withTenant(this.sql, ctx, (tx) =>
      ingestFeedTransactions(tx, ctx, {
        feedId,
        transactions: pulled.transactions,
        cursor: pulled.cursor,
        idempotencyKey,
      }),
    );
  }

  /**
   * The push API. See the file header — this is the route an outside system
   * calls with a scoped key, and the reason "bank integration" is a true
   * sentence before any bank agreement exists.
   */
  @Requires('bank.import')
  @Doc({ request: () => pushSchema })
  @Post(':id/transactions')
  async push(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(pushSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      ingestFeedTransactions(tx, ctx, {
        feedId: parse(uuid, id),
        transactions: input.transactions,
        idempotencyKey,
      }),
    );
  }
}

const connectSchema = z.object({
  bankAccountId: uuid,
  provider: z.enum(['SANDBOX', 'API_PUSH']),
});

const statusSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'REVOKED']),
});

/**
 * One pushed transaction. Amounts are signed decimal STRINGS — a JSON number
 * would ride through JavaScript floats on the way in, and rule 2 exists
 * precisely so money never does.
 */
const pushSchema = z.object({
  transactions: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        description: z.string().trim().min(1).max(500),
        amount: z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/),
        reference: z.string().trim().max(120).optional(),
        valueDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        runningBalance: z
          .string()
          .regex(/^-?\d{1,15}(\.\d{1,4})?$/)
          .optional(),
      }),
    )
    .min(1)
    .max(1000),
});
