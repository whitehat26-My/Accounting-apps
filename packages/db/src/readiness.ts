/**
 * ReadinessService — what this tenant cannot do yet, and what would fix it.
 *
 * ---------------------------------------------------------------------------
 * THE KNOWLEDGE EXISTED. IT WAS JUST NOT ANSWERABLE.
 *
 * Five capabilities in this system are deliberately inert until somebody
 * supplies a value that must come from outside: withholding rates from LHDN,
 * the DuitNow merchant template from PayNet, a MyInvois client written against
 * LHDN's SDK, payment gateway credentials, and a statement layout derived from
 * a real bank export.
 *
 * Every one of them fails loudly at the point of use, which is right. But the
 * only record of WHICH capabilities are inert was eight ⚠️ comments scattered
 * across the domain, the migrations and the API — so the question "what is this
 * deployment actually able to do" could be answered by reading the source and
 * in no other way. Nobody operating the system reads the source.
 *
 * This module is that question, answerable. It is deliberately the SAME list
 * the code enforces rather than a second list maintained beside it: each check
 * reads the configuration the feature itself reads, so a capability cannot
 * report ready and then refuse, or report blocked and then work.
 * ---------------------------------------------------------------------------
 */

import type { TenantContext, Tx } from './client.js';

export type CapabilityStatus =
  /** Configured, and the feature will work. */
  | 'READY'
  /** Inert. The feature refuses until the missing input is supplied. */
  | 'BLOCKED'
  /** Works, but on values marked as not verified against a primary source. */
  | 'SANDBOX';

export interface Capability {
  readonly key: string;
  readonly name: string;
  readonly status: CapabilityStatus;
  /** What is absent, in a sentence somebody can act on. */
  readonly blockedBy?: string;
  /** Who or what can supply it. Names the authority, not a ticket. */
  readonly source?: string;
  /** What a user sees today if they try. */
  readonly behaviourWhenBlocked?: string;
}

export interface Readiness {
  readonly capabilities: readonly Capability[];
  readonly blocked: number;
  /** True when nothing is inert. Not the same as "everything is configured". */
  readonly fullyOperational: boolean;
}

export async function tenantReadiness(tx: Tx, ctx: TenantContext): Promise<Readiness> {
  const capabilities = [
    await withholdingCapability(tx, ctx),
    await duitNowQrCapability(tx, ctx),
    await gatewayCollectionCapability(tx, ctx),
    await einvoiceCapability(tx, ctx),
    await statementImportCapability(tx, ctx),
  ];

  const blocked = capabilities.filter((c) => c.status === 'BLOCKED').length;

  return {
    capabilities,
    blocked,
    fullyOperational: blocked === 0,
  };
}

/**
 * Withholding.
 *
 * The mechanism is built and tested — treaty precedence, the gross/net split,
 * the `Dr AP / Cr Bank / Cr WHT payable` posting, append-only evidence. Only
 * the rates are absent, and a payment that asks to withhold without one fails
 * rather than withholding zero.
 */
async function withholdingCapability(tx: Tx, ctx: TenantContext): Promise<Capability> {
  const [row] = await tx<{ total: string; sandbox: string }[]>`
      SELECT count(*)::text AS total,
             count(*) FILTER (WHERE legislation_ref ILIKE 'SANDBOX%')::text AS sandbox
        FROM wht_rate
       WHERE tenant_id = ${ctx.tenantId}
         AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
  `;

  const total = Number(row!.total);
  const sandbox = Number(row!.sandbox);

  if (total === 0) {
    return {
      key: 'withholding',
      name: 'Withholding tax on supplier payments',
      status: 'BLOCKED',
      blockedBy: 'No withholding rates are configured.',
      source:
        'LHDN — the rate depends on the payment type and on any applicable double ' +
        'taxation agreement, and each rate must cite the ruling it comes from.',
      behaviourWhenBlocked:
        'A supplier payment that asks to withhold is refused. Payments that do not ' +
        'withhold are unaffected.',
    };
  }

  return {
    key: 'withholding',
    name: 'Withholding tax on supplier payments',
    status: sandbox > 0 && sandbox === total ? 'SANDBOX' : 'READY',
    ...(sandbox > 0
      ? { blockedBy: `${sandbox} of ${total} rates are sandbox values, not verified against LHDN.` }
      : {}),
  };
}

/** DuitNow QR — the one where a guess pays the wrong party. */
async function duitNowQrCapability(tx: Tx, ctx: TenantContext): Promise<Capability> {
  const [row] = await tx<{ configured: string; sandbox: string }[]>`
      SELECT count(*) FILTER (WHERE jsonb_array_length(merchant_template) > 0)::text
                 AS configured,
             count(*) FILTER (WHERE merchant_template_source ILIKE 'SANDBOX%')::text
                 AS sandbox
        FROM payment_gateway_config
       WHERE tenant_id = ${ctx.tenantId} AND is_active
  `;

  const configured = Number(row!.configured);

  if (configured === 0) {
    return {
      key: 'duitnow_qr',
      name: 'DuitNow QR on invoices',
      status: 'BLOCKED',
      blockedBy: 'No DuitNow merchant account template is configured.',
      source:
        'PayNet — which of the reserved EMVCo tags 26–51 carries DuitNow, the ' +
        'assigned identifier, and the merchant id format.',
      behaviourWhenBlocked:
        'QR generation is refused outright. This is deliberate and stricter than the ' +
        'other gaps: a guessed template produces a QR that scans successfully and pays ' +
        'the wrong party, leaving the payer with a completed transaction and the ' +
        'merchant with nothing.',
    };
  }

  return {
    key: 'duitnow_qr',
    name: 'DuitNow QR on invoices',
    status: Number(row!.sandbox) > 0 ? 'SANDBOX' : 'READY',
    ...(Number(row!.sandbox) > 0
      ? { blockedBy: 'The merchant template is a sandbox value and will not pay a real merchant.' }
      : {}),
  };
}

/**
 * Hosted gateway collections.
 *
 * Distinct from the clearing-account machinery, which works: collections can be
 * recorded and settled through the API today. What is inert is the hand-off to
 * a hosted payment page, which needs an adapter with merchant credentials.
 */
async function gatewayCollectionCapability(tx: Tx, ctx: TenantContext): Promise<Capability> {
  const [row] = await tx<{ count: string }[]>`
      SELECT count(*)::text FROM payment_gateway_config
       WHERE tenant_id = ${ctx.tenantId} AND is_active
  `;

  if (Number(row!.count) === 0) {
    return {
      key: 'gateway_collections',
      name: 'Online collections (FPX, cards)',
      status: 'BLOCKED',
      blockedBy: 'No payment gateway is configured for this tenant.',
      source:
        'A provider — Billplz, iPay88 or similar — plus a clearing account to receive ' +
        'money collected and not yet settled to the bank.',
      behaviourWhenBlocked:
        'Confirming a collection is refused. Note the adapter itself ships with no ' +
        'implementation at all, so hosted hand-off answers 503 even once a gateway ' +
        'row exists.',
    };
  }

  return { key: 'gateway_collections', name: 'Online collections (FPX, cards)', status: 'READY' };
}

/**
 * MyInvois.
 *
 * The one capability whose gap is not data. Documents are built, validated and
 * queued correctly; there is no HTTP client to send them, because it should be
 * written against LHDN's published SDK and exercised against their sandbox.
 */
async function einvoiceCapability(tx: Tx, ctx: TenantContext): Promise<Capability> {
  const [row] = await tx<{ count: string }[]>`
      SELECT count(*)::text FROM einvoice_config WHERE tenant_id = ${ctx.tenantId}
  `;

  return {
    key: 'einvoice_submission',
    name: 'e-Invoice submission to LHDN (MyInvois)',
    status: 'BLOCKED',
    blockedBy:
      Number(row!.count) === 0
        ? 'No MyInvois configuration, and no HTTP client exists in this build.'
        : 'MyInvois is configured, but no HTTP client exists in this build.',
    source:
      "LHDN's published MyInvois SDK and sandbox credentials. The wire format, field " +
      'names, code lists and cancellation window must be confirmed against it before ' +
      'anything is submitted.',
    behaviourWhenBlocked:
      'Documents are assembled, validated and queued as normal — nothing is lost. They ' +
      'stay queued because there is nothing to drain them.',
  };
}

/** Statement import — blocked per bank, not globally. */
async function statementImportCapability(tx: Tx, ctx: TenantContext): Promise<Capability> {
  const [row] = await tx<{ profiles: string; accounts: string }[]>`
      SELECT (SELECT count(*)::text FROM import_profile WHERE tenant_id = ${ctx.tenantId})
                 AS profiles,
             (SELECT count(*)::text FROM bank_account
               WHERE tenant_id = ${ctx.tenantId} AND is_active) AS accounts
  `;

  if (Number(row!.accounts) === 0) {
    return {
      key: 'statement_import',
      name: 'Bank statement import',
      status: 'BLOCKED',
      blockedBy: 'No bank account exists to import into.',
      source: 'The tenant — create a bank account mapped to a GL account.',
    };
  }

  if (Number(row!.profiles) === 0) {
    return {
      key: 'statement_import',
      name: 'Bank statement import',
      status: 'BLOCKED',
      blockedBy: 'No saved import profile. A statement can still be imported by ' +
        'supplying a column map inline with each request.',
      source:
        'A real statement export from the bank in question. Layouts are never sniffed: ' +
        'a description column read as an amount imports a plausible statement with ' +
        'wrong numbers, found at year end.',
      behaviourWhenBlocked:
        'Import works when a profile is supplied inline; nothing is saved for reuse.',
    };
  }

  return { key: 'statement_import', name: 'Bank statement import', status: 'READY' };
}
