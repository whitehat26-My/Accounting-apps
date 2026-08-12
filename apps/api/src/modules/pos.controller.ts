import { Body, Controller, Get, Headers, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDate, positiveDecimal, uuid } from '@emil/contracts';
import {
  buildQrForAmount,
  dailyTakings,
  DuitNowNotConfiguredError,
  recordCashSale,
  sellerBlock,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';
import { renderDaySheetPdf } from '../pdf/render.js';

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
   * The DuitNow QR for an amount at the counter.
   *
   * -------------------------------------------------------------------------
   * ANSWERS 200 EVEN WHEN IT CANNOT PRODUCE A QR.
   *
   * "Is DuitNow available?" is an ordinary question with an ordinary negative
   * answer — most shops have never set it up — and modelling that as an error
   * would make the till's checkout screen handle an exception on its happy
   * path. The same call the e-Invoice config route makes when it reports
   * `adapterConfigured: false`.
   *
   * `available: false` carries WHAT is missing, because the fixes differ: a
   * template comes from PayNet, a category code from the acquiring bank, and a
   * merchant name is typed on the Settings screen.
   * -------------------------------------------------------------------------
   */
  @Requires('pos.sale')
  @Get('duitnow-qr')
  async duitNowQr(
    @Query('amount') amount: string | undefined,
    @Query('reference') reference: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(duitNowQrSchema, { amount, reference });
    const ctx = tenantContextOf(request);

    try {
      return {
        available: true as const,
        ...(await withTenant(this.sql, ctx, (tx) => buildQrForAmount(tx, ctx, input))),
      };
    } catch (error) {
      if (error instanceof DuitNowNotConfiguredError) {
        return { available: false as const, reason: error.message, missing: error.missing };
      }
      throw error;
    }
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

  /**
   * The same Z-report as paper, to sign and file.
   *
   * A shop that closes up at 9pm wants one page it can put in a folder, not a
   * screen it has to remember. The counting box on it is left blank on
   * purpose — the control is a person counting the drawer, and printing our
   * own expectation into that box would make it a formality.
   */
  @Requires('pos.sale')
  @Get('takings/pdf')
  async takingsPdf(
    @Query('date') date: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const { date: parsed } = parse(takingsSchema, { date });
    const ctx = tenantContextOf(request);
    const { takings, seller } = await withTenant(this.sql, ctx, async (tx) => ({
      takings: await dailyTakings(tx, ctx, parsed),
      seller: await sellerBlock(tx, ctx),
    }));

    const pdf = await renderDaySheetPdf({ seller, ...takings });
    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="day-sheet-${takings.date}.pdf"`)
      .send(pdf);
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
        /** For a serialised item: scan each unit being sold. */
        serialNumbers: z.array(z.string().min(1).max(120)).max(1000).optional(),
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

const duitNowQrSchema = z.object({
  /** Decimal string, never a number — the amount goes into the QR verbatim. */
  amount: positiveDecimal,
  /** What reconciliation matches on later. The cart or invoice reference. */
  reference: z.string().min(1).max(25),
});
