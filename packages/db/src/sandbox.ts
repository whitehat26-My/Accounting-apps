/**
 * Sandbox values for the capabilities that ship inert.
 *
 * ---------------------------------------------------------------------------
 * EVERY VALUE HERE IS DELIBERATELY, VISIBLY WRONG.
 *
 * Withholding rates and the DuitNow merchant template cannot be shipped with
 * real values, because they must be verified against LHDN and PayNet and a
 * plausible-looking wrong one is worse than an obvious gap. That leaves the
 * flows built on them unable to be demonstrated outside the test suite.
 *
 * The resolution is the same one `FakeGateway` uses: values that work
 * mechanically and cannot be mistaken for real ones. A withholding rate of 99%
 * is not a rate anyone will file; a merchant template whose identifier reads
 * SANDBOX-NOT-A-REAL-MERCHANT is not one anyone will scan by accident. Both
 * cite themselves as sandbox values, which is what `readiness.ts` reports and
 * what stops them being silently inherited into a production tenant.
 *
 * ⚠️ `loadConfig` in apps/api REFUSES to enable this when NODE_ENV is
 * production. Do not remove that check. A 99% rate reaching a real supplier
 * payment withholds almost the entire invoice.
 * ---------------------------------------------------------------------------
 */

import type { TenantContext, Tx } from './client.js';
import { setWithholdingRate } from './statutory.js';

/**
 * The marker every sandbox value carries.
 *
 * `readiness.ts` matches on this prefix to report SANDBOX rather than READY, so
 * changing it here without changing that query would make fake values report as
 * verified — the one failure this whole arrangement exists to prevent.
 */
export const SANDBOX_CITATION_PREFIX = 'SANDBOX';

/** Nobody withholds 99%. That is the point. */
const SANDBOX_RATE_BASIS_POINTS = 9_900;

export interface SandboxSeedResult {
  readonly withholdingRates: number;
  readonly merchantTemplates: number;
}

export async function seedSandboxStatutoryValues(
  tx: Tx,
  ctx: TenantContext,
): Promise<SandboxSeedResult> {
  const paymentTypes = ['ROYALTY', 'INTEREST', 'TECHNICAL_SERVICES', 'CONTRACT_PAYMENT'];
  let rates = 0;

  for (const paymentType of paymentTypes) {
    const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM wht_rate
         WHERE tenant_id = ${ctx.tenantId} AND payment_type = ${paymentType}
           AND country_code IS NULL
    `;
    if (existing) continue;

    await setWithholdingRate(tx, ctx, {
      paymentType,
      rateBasisPoints: SANDBOX_RATE_BASIS_POINTS,
      validFrom: '2000-01-01',
      legislationRef:
        `${SANDBOX_CITATION_PREFIX} VALUE — NOT VERIFIED AGAINST LHDN. ` +
        'Deliberately 99% so it cannot be mistaken for a real rate. ' +
        'Replace before withholding on any real payment.',
    });
    rates += 1;
  }

  /*
   * A merchant template shaped like the real thing, with values that are
   * obviously not. The EMVCo envelope around it is a published standard and is
   * genuinely correct; only the PayNet-assigned parts are invented, and they
   * announce themselves.
   */
  const templates = await tx<{ id: string }[]>`
      UPDATE payment_gateway_config
         SET merchant_template = ${tx.json([
           ['00', 'SANDBOX.NOT.A.REAL.AID'],
           ['01', 'SANDBOX-NOT-A-REAL-MERCHANT'],
         ] as never)},
             merchant_template_source =
                 ${`${SANDBOX_CITATION_PREFIX} VALUE — NOT CONFIRMED WITH PAYNET. ` +
                   'A QR built from this will not pay anyone.'},
             merchant_template_verified_by = ${ctx.userId ?? null},
             merchant_template_verified_at = now()
       WHERE tenant_id = ${ctx.tenantId}
         AND is_active
         AND jsonb_array_length(merchant_template) = 0
      RETURNING id
  `;

  return { withholdingRates: rates, merchantTemplates: templates.length };
}
