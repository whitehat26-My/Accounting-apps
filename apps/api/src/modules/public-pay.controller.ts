import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Money } from '@emil/domain';
import {
  beginCollection,
  confirmCollection,
  markGatewayEventProcessed,
  markPaymentLinkViewed,
  recordGatewayEvent,
  resolvePaymentLink,
  resolvePaymentLinkForWebhook,
  verifyDocumentDigest,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { GATEWAYS } from '../tokens.js';
import type { GatewayRegistry } from '../gateways/registry.js';
import { NoIdempotencyKey, Public } from '../guards/decorators.js';
import { Doc } from '../openapi/doc.decorator.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { actorContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * The pay page and the gateway webhook.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONLY UNAUTHENTICATED SURFACE THAT TOUCHES TENANT DATA.
 *
 * It is one file so a reviewer can read the whole of it, which is the point of
 * keeping it out of `collections.controller.ts`. Four rules govern everything
 * here, and a change that breaks any of them is a security defect:
 *
 *  1. THE TENANT COMES FROM THE TOKEN, NEVER FROM A HEADER. An `X-Tenant-Id`
 *     on these routes is ignored entirely. Honouring it would let anyone read
 *     across tenants by pairing a valid token with someone else's id.
 *
 *  2. UNKNOWN AND EXPIRED ARE THE SAME 404. Distinguishing them tells a
 *     brute-forcer which guesses were once real, which is the only feedback
 *     that makes guessing worth doing.
 *
 *  3. THE RESPONSE CARRIES THE MINIMUM. Amount, currency, reference, invoice
 *     number, merchant name. No customer name, no address, no line items, no
 *     tenant id. A leaked link must expose one invoice and nothing that helps
 *     anyone enumerate further.
 *
 *  4. THE BROWSER NEVER CONFIRMS A PAYMENT. See `initiate` below — this is the
 *     rule most easily got wrong, and the most expensive.
 * ---------------------------------------------------------------------------
 */
@Controller()
export class PublicPayController {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(GATEWAYS) private readonly gateways: GatewayRegistry,
  ) {}

  /** What the pay page renders. */
  @Public()
  @Get('public/pay/:token')
  async view(@Param('token') token: string, @Req() request: FastifyRequest) {
    const link = await this.requireLink(token);

    // Advisory only, and after the 404 decision so a probe cannot inflate the
    // view count of a link it is not entitled to see.
    const ctx = { tenantId: link.tenantId, ...actorContextOf(request) };
    await withTenant(this.sql, ctx, (tx) => markPaymentLinkViewed(tx, ctx, link.id));

    return {
      reference: link.reference,
      amount: link.amountDue,
      currency: link.currency,
      invoiceNo: link.invoiceNo,
      merchantName: link.merchantName,
      status: link.status,
      expiresAt: link.expiresAt,
    };
  }

  /**
   * Hand the payer off to their bank.
   *
   * ---------------------------------------------------------------------------
   * THIS DOES NOT CONFIRM PAYMENT, AND MUST NEVER BE MADE TO.
   *
   * The obvious shape for a pay page is a `POST .../confirm` the browser calls
   * when the payer returns from their bank. It is also a way to mark any
   * invoice paid for free: the route is unauthenticated by necessity, so
   * anyone holding the link — or guessing one — could settle an invoice
   * without money moving. A redirect back from a bank proves nothing; the
   * payer controls their own browser.
   *
   * Confirmation therefore arrives ONLY from the provider, server to server,
   * with a verified signature. This route does the part the browser legitimately
   * owns: create a payment at the gateway and say where to send the payer.
   * ---------------------------------------------------------------------------
   */
  @Public()
  @Doc({ request: () => initiateSchema })
  @Post('public/pay/:token/initiate')
  async initiate(
    @Param('token') token: string,
    @Body() body: unknown,
    @Headers('idempotency-key') _idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const link = await this.requireLink(token);
    const input = parse(initiateSchema,
      body,
    );

    const gateway = this.gateways.get(input.provider);
    if (gateway === undefined) {
      // 503 rather than 404: the provider name is fine, this deployment simply
      // has no adapter for it. Saying so is more useful than pretending the
      // route does not exist, and reveals nothing — the list of gateways a
      // product supports is public information.
      throw new HttpException(
        {
          error: 'gateway_unavailable',
          message:
            `No payment gateway adapter is configured for "${input.provider}". ` +
            'Collections can be recorded through the API, but hosted payment ' +
            'hand-off needs an adapter with merchant credentials.',
          available: this.gateways.providers,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const handle = await gateway.createPayment({
      amount: Money.fromDecimal(link.amountDue, link.currency),
      // OUR id for this payment. The gateway echoes it back and it is what
      // routes the webhook to a tenant — see migration 0015 on why neither the
      // provider's reference nor the pay-link token can play that role.
      merchantOrderId: link.id,
      reference: link.reference,
      description: `Invoice ${link.invoiceNo}`,
      returnUrl: input.returnUrl,
      // Server to server. It carries no token: the merchant order id above is
      // what routes the event back to a tenant.
      callbackUrl: `/public/gateways/${input.provider}/webhook`,
    });

    const ctx = { tenantId: link.tenantId, ...actorContextOf(request) };
    await withTenant(this.sql, ctx, (tx) =>
      beginCollection(tx, ctx, {
        paymentLinkId: link.id,
        provider: input.provider,
        providerRef: handle.providerRef,
      }),
    );

    return { redirectUrl: handle.redirectUrl, providerRef: handle.providerRef };
  }

  /**
   * The gateway tells us what happened.
   *
   * Exempt from `Idempotency-Key` because no provider sends a header this
   * product invented — the guarantee here is `gateway_event`'s unique
   * constraint on the PROVIDER's event id, which is stronger. See
   * `@NoIdempotencyKey`.
   */
  @Public()
  @NoIdempotencyKey()
  @Doc({
    externalBody:
      'The payment provider\'s own event payload, verified by signature before it is ' +
      'parsed. This API does not define the shape — it belongs to the provider and ' +
      'changes when they change it. Consult the provider\'s documentation.',
  })
  @Post('public/gateways/:provider/webhook')
  async webhook(
    @Param('provider') provider: string,
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ) {
    // Fold provider casing to one canonical form. It reaches us from the URL a
    // provider was told to call, and `Billplz` vs `billplz` must resolve to the
    // same adapter and — more importantly — the same `(provider, event id)`
    // dedup key. Without this, a replayed event under different casing would
    // slip past the unique constraint and settle an invoice twice. Uppercase is
    // the canonical form the rest of the system already uses: the gateway
    // registry keys on it, `payment_gateway_config.provider` is stored in it,
    // and every `PaymentGateway.provider` is upper — so the dedup key, the
    // config lookup and the adapter lookup all agree.
    const canonicalProvider = provider.toUpperCase();

    const gateway = this.gateways.get(canonicalProvider);
    if (gateway === undefined) {
      // A 404, not a 503. A webhook route with no adapter cannot verify a
      // signature, and a route that accepts an unverifiable payment
      // notification is a way to mark any invoice paid for free. Refusing to
      // acknowledge it exists is the safe answer.
      throw new NotFoundError('Webhook endpoint');
    }

    // The exact bytes received, preserved by the JSON parser in main.ts. A
    // provider signs what it sent; re-serialising the parsed object would change
    // the bytes and break every real signature. Fall back only if the parser
    // hook did not run (a non-JSON content type).
    const raw =
      (request as FastifyRequest & { rawBody?: string }).rawBody ??
      (typeof body === 'string' ? body : JSON.stringify(body ?? {}));

    // Signature FIRST, before the payload is parsed or anything is stored.
    // Verifying afterwards would mean an attacker's payload had already
    // reached the parser.
    if (!gateway.verifySignature(raw, headersOf(request))) {
      throw new NotFoundError('Webhook endpoint');
    }

    const event = gateway.parseEvent(raw);

    const link = await resolvePaymentLinkForWebhook(this.sql, event.merchantOrderId);
    if (link === null) {
      // Nothing to apply it to. Answered 200 rather than 404 so the provider
      // stops retrying: a webhook for a reference we have no record of will
      // never become applicable, and an endless retry loop helps nobody.
      return { received: true, applied: false, reason: 'UNKNOWN_REFERENCE' };
    }

    // The actor is the person who ISSUED the link, not "the system". Every
    // posted journal entry names someone accountable — see migration 0015 —
    // and they are the one who invited this payment for this amount.
    // An unattributed USER is correct on a webhook — no human is present. An
    // unattributed REQUEST is not: a gateway callback that settles an invoice is
    // exactly the write worth being able to trace back to an origin and a
    // request id.
    const ctx = { tenantId: link.tenantId, userId: link.createdBy, ...actorContextOf(request) };

    return withTenant(this.sql, ctx, async (tx) => {
      const stored = await recordGatewayEvent(tx, ctx, {
        provider: canonicalProvider,
        providerEventId: event.eventId,
        providerRef: event.providerRef,
        eventType: event.type,
        paymentLinkId: link.id,
        amount: event.amount.toDecimalString(),
        ...(event.fee !== undefined ? { fee: event.fee.toDecimalString() } : {}),
        sentAt: event.sentAt,
        signatureValid: true,
        raw: event.raw,
      });

      // The database said this exact provider event is already stored. Stop
      // here — processing it again would settle the invoice twice.
      if (stored.replayed) {
        return { received: true, applied: false, reason: 'REPLAY' };
      }

      if (event.type !== 'PAID') {
        await markGatewayEventProcessed(tx, ctx, stored.id);
        return { received: true, applied: false, reason: event.type };
      }

      const confirmed = await confirmCollection(tx, ctx, {
        paymentLinkId: link.id,
        provider: canonicalProvider,
        providerRef: event.providerRef,
        amount: event.amount.toDecimalString(),
        ...(event.fee !== undefined ? { fee: event.fee.toDecimalString() } : {}),
        paidAt: event.sentAt,
        sentAt: event.sentAt,
        // The provider's event id makes the receipt idempotent on the same key
        // the webhook is deduplicated on, so the two guarantees cannot disagree.
        idempotencyKey: `${canonicalProvider}:${event.eventId}`,
      });

      await markGatewayEventProcessed(tx, ctx, stored.id);

      return {
        received: true,
        applied: true,
        paymentNo: confirmed.receipt.paymentNo,
        replayed: confirmed.receipt.replayed,
      };
    });
  }

  /**
   * Resolve a token or refuse, with no way to tell the two refusals apart.
   *
   * Unknown, expired and cancelled all answer the same 404. Anything else hands
   * a brute-forcer the signal that makes guessing worthwhile: "this token was
   * real once" narrows the search enormously.
   */
  private async requireLink(token: string) {
    if (token.length < 16 || token.length > 200) throw new NotFoundError('Payment link');

    const link = await resolvePaymentLink(this.sql, token);

    if (link === null) throw new NotFoundError('Payment link');
    if (link.expired) throw new NotFoundError('Payment link');
    if (link.status === 'CANCELLED') throw new NotFoundError('Payment link');

    if (link.status === 'PAID') {
      // Distinguished from the refusals above ON PURPOSE. The token was valid
      // and the payer got this far, so telling them the invoice is settled
      // prevents a second payment — the alternative is a customer paying twice
      // because a page said "not found".
      throw new ValidationError(
        `Invoice ${link.invoiceNo} has already been paid. No further payment is due.`,
      );
    }

    return link;
  }

  // ---- Document verification ----------------------------------------------

  /**
   * "Is this piece of paper genuine?"
   *
   * Lives beside the pay routes because it is part of the same surface — the
   * unauthenticated one — and the four rules above govern it too. Rule 3 is
   * the load-bearing one here: the answer is the document KIND and its DATE,
   * and nothing else. Not the tenant, not the customer, not the amount, not
   * the document number. Everything withheld is already printed on the paper
   * the asker is holding; everything withheld would also be a gift to
   * somebody who is not holding it.
   *
   * A digest is a capability. Possessing one means possessing the document
   * (or its QR), and 256 bits is not a space anybody enumerates — which is
   * why an unknown digest can answer plainly rather than evasively. It is
   * still a 200 either way, so the two answers cannot be told apart by
   * status code, timing at the proxy, or a response-length heuristic.
   */
  @Public()
  @NoIdempotencyKey()
  @Doc({ request: () => verifySchema })
  @Post('public/verify')
  async verify(@Body() body: unknown) {
    const { digest } = parse(verifySchema, body);
    return verifyDocumentDigest(this.sql, digest.toLowerCase());
  }
}

function headersOf(request: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value) && value[0] !== undefined) out[key] = value[0];
  }
  return out;
}

const verifySchema = z.object({
  /**
   * 64 lowercase hex characters. Accepted case-insensitively because a person
   * typing it off a printed receipt should not have to care, and normalised by
   * the caller before it reaches the database.
   */
  digest: z.string().regex(/^[0-9a-fA-F]{64}$/, 'A document reference is 64 hex characters'),
});

const initiateSchema = z.object({
  provider: z.string().min(1),
  returnUrl: z.string().url(),
});
