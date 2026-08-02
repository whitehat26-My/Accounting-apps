import { Body, Controller, Get, Headers, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decimal } from '@emil/contracts';
import {
  createPaymentLink,
  recordSettlement,
  unsettledCollections,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * The authenticated half of collections: creating links, and settling batches.
 *
 * The unauthenticated half — the pay page and the webhook — lives in
 * `public-pay.controller.ts`, deliberately separated so the surface that needs
 * no credential is one file a reviewer can read end to end.
 */
@Controller('v1')
export class CollectionsController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  private ctx(request: FastifyRequest) {
    return tenantContextOf(request);
  }

  /**
   * Create a pay link for an invoice.
   *
   * The token is in the response ONCE and is never retrievable again — only its
   * digest is stored, so this is the only moment it exists outside the payer's
   * browser. Re-issuing means creating a new link.
   */
  @Requires('receipt.create')
  @Doc({ request: () => createLinkSchema })
  @Post('invoices/:id/payment-link')
  async createLink(
    @Param('id') invoiceId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(createLinkSchema,
      body ?? {},
    );

    const ctx = this.ctx(request);
    const link = await withTenant(this.sql, ctx, (tx) =>
      createPaymentLink(tx, ctx, { ...input, invoiceId, idempotencyKey }),
    );

    return {
      id: link.id,
      token: link.token,
      reference: link.reference,
      amount: link.amount,
      currency: link.currency,
      expiresAt: link.expiresAt,
      payPath: `/public/pay/${link.token}`,
    };
  }

  /**
   * What the gateway owes us: collected, not yet settled to the bank.
   *
   * The clearing account's balance in a form a user can explain. A figure here
   * that does not match the account means either a collection was recognised
   * and never settled, or a settlement moved money never collected.
   */
  @Requires('bank.read')
  @Get('gateways/:provider/unsettled')
  async unsettled(@Param('provider') provider: string, @Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    const items = await withTenant(this.sql, ctx, (tx) =>
      unsettledCollections(tx, ctx, provider),
    );
    return { provider, awaitingSettlement: items };
  }

  /**
   * Record a settlement batch: clearing → bank, plus the fees.
   *
   * `bank.reconcile` rather than `payment.create`: this posts to the bank
   * account and produces the entry a bank line will be matched against, which
   * is reconciliation work rather than sales work.
   */
  @Requires('bank.reconcile')
  @Doc({ request: () => settlementSchema })
  @Post('gateways/:provider/settlements')
  async settle(
    @Param('provider') provider: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(settlementSchema, body);
    const ctx = this.ctx(request);

    return withTenant(this.sql, ctx, (tx) =>
      recordSettlement(tx, ctx, { ...input, provider, idempotencyKey }),
    );
  }
}

const settlementSchema = z.object({
  providerBatchId: z.string().min(1),
  settlementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD'),
  bankAccountId: z.string().uuid(),
  reportedNet: decimal,
  items: z
    .array(
      z.object({
        paymentId: z.string().uuid(),
        gross: decimal,
        fee: decimal.optional(),
      }),
    )
    .min(1),
});

const createLinkSchema = z.object({ expiresInDays: z.number().int().min(1).max(90).optional() });
