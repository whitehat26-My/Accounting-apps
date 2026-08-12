import { buildDuitNowQr, DuitNowQrError, Money } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { loadGatewayConfig } from './collection.js';

/**
 * The one wire between stored merchant configuration and the EMVCo encoder.
 *
 * ---------------------------------------------------------------------------
 * EVERY PIECE OF THIS ALREADY EXISTED AND NOTHING JOINED THEM.
 *
 * `buildDuitNowQr` (packages/domain/src/duitnow-qr.ts) has encoded a correct
 * EMVCo merchant-presented payload — TLV, CRC-16/CCITT-FALSE, MYR as 458 — since
 * M2, tested against the published check vector. `loadGatewayConfig` has
 * returned the merchant name, city, category code and template for just as
 * long. `encodeQr` has been turning strings into scannable symbols on every
 * printed receipt. The encoder had ZERO production callers.
 *
 * This is that call, and it is deliberately the only one: a second place that
 * assembles a payment QR is a second place that can assemble it slightly
 * differently, and the failure mode of "slightly differently" is money arriving
 * somewhere unintended.
 *
 * WHY IT REFUSES RATHER THAN FALLING BACK. A QR is not a form that can be
 * half-filled. It either encodes a merchant PayNet recognises, or it encodes
 * something a bank app will resolve to nothing — or worse, to somebody else.
 * Both failures happen at the counter, after the customer has scanned, and the
 * shop finds out when the money does not arrive. So an incomplete template is
 * an error here, not a warning, and the caller renders "not configured" instead
 * of a symbol.
 * ---------------------------------------------------------------------------
 */

/** The provider row that carries the DuitNow merchant identity. */
export const DUITNOW_PROVIDER = 'DUITNOW';

export interface DuitNowQrRequest {
  /** Decimal string, e.g. "35.00". Never a JavaScript number. */
  readonly amount: string;
  /** What reconciliation will later match on — an invoice or cart reference. */
  readonly reference: string;
  readonly billNumber?: string;
  /** Defaults to `DUITNOW_PROVIDER`; overridable for a bank-specific row. */
  readonly provider?: string;
}

export interface DuitNowQrPayload {
  /** The EMVCo string to encode. Render with `encodeQr` from @emil/domain. */
  readonly payload: string;
  readonly amount: string;
  readonly reference: string;
  readonly merchantName: string;
  /**
   * True when the template is a sandbox value — structurally valid, pays
   * nobody. Surfaced so a caller can refuse to show it to a real payer rather
   * than discovering it at the till.
   */
  readonly sandbox: boolean;
}

export class DuitNowNotConfiguredError extends Error {
  readonly code = 'DUITNOW_NOT_CONFIGURED';
  constructor(
    message: string,
    /** What is missing, for an operator rather than a developer. */
    readonly missing: string,
  ) {
    super(message);
    this.name = 'DuitNowNotConfiguredError';
  }
}

export async function buildQrForAmount(
  tx: Tx,
  ctx: TenantContext,
  request: DuitNowQrRequest,
): Promise<DuitNowQrPayload> {
  const provider = request.provider ?? DUITNOW_PROVIDER;

  // No row at all is the commonest state and is not exceptional — a shop that
  // has never set up DuitNow is most shops. Folded into the one error type so
  // the caller has a single thing to handle rather than two.
  let config;
  try {
    config = await loadGatewayConfig(tx, ctx, provider);
  } catch {
    throw new DuitNowNotConfiguredError(
      `No active "${provider}" payment configuration exists for this organisation. ` +
        'Add one on the Settings screen before showing a QR at the till.',
      'gateway configuration',
    );
  }

  // Read the provenance alongside, so a sandbox template can be reported as
  // such rather than silently rendered. `readiness.ts` keys on the same prefix.
  const [row] = await tx<{ sandbox: boolean }[]>`
      SELECT COALESCE(merchant_template_source ILIKE 'SANDBOX%', FALSE) AS sandbox
        FROM payment_gateway_config
       WHERE tenant_id = ${ctx.tenantId} AND provider = ${provider} AND is_active
  `;

  // Each of these is a separate message because each has a different fix, and
  // "DuitNow is not configured" sends an operator to read code.
  if (config.merchantTemplate.length === 0) {
    throw new DuitNowNotConfiguredError(
      'No DuitNow merchant account template is configured. It comes from PayNet ' +
        'or your acquiring bank and cannot be guessed.',
      'merchant template',
    );
  }
  if (config.merchantTemplateTag === undefined) {
    throw new DuitNowNotConfiguredError(
      'The merchant template has no EMVCo tag. PayNet assigns which of tags 26-51 ' +
        'carries DuitNow; it is stored in payment_gateway_config.merchant_template_tag.',
      'merchant template tag',
    );
  }
  if (config.merchantName === undefined || config.merchantCity === undefined) {
    throw new DuitNowNotConfiguredError(
      'The merchant name and city are printed inside the QR and shown to the payer ' +
        'by their bank app. Set them on the payment gateway configuration.',
      'merchant name or city',
    );
  }
  if (config.merchantCategoryCode === undefined) {
    throw new DuitNowNotConfiguredError(
      'No merchant category code (ISO 18245) is set. Your acquiring bank assigns it.',
      'merchant category code',
    );
  }

  try {
    const payload = buildDuitNowQr({
      merchantAccount: {
        tag: config.merchantTemplateTag,
        fields: config.merchantTemplate,
      },
      merchantName: config.merchantName,
      merchantCity: config.merchantCity,
      merchantCategoryCode: config.merchantCategoryCode,
      // MYR throughout — the encoder refuses anything else, and a shop till
      // that quoted a foreign currency would be a different product.
      amount: Money.fromDecimal(request.amount, 'MYR'),
      reference: request.reference,
      ...(request.billNumber !== undefined ? { billNumber: request.billNumber } : {}),
    });

    return {
      payload,
      amount: request.amount,
      reference: request.reference,
      merchantName: config.merchantName,
      sandbox: row?.sandbox === true,
    };
  } catch (error) {
    // The encoder's own refusals — an over-long field, a non-MYR amount — are
    // configuration problems too, and read better as one kind of failure.
    if (error instanceof DuitNowQrError) {
      throw new DuitNowNotConfiguredError(error.message, error.code);
    }
    throw error;
  }
}
