/**
 * CollectionService — online collections (M2).
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE DOES NOT HAVE ITS OWN RECEIPT PATH, AND THAT IS THE POINT.
 *
 * `confirmCollection()` calls the existing `recordReceipt()` in `payment.ts`
 * with `depositAccountId` set to the gateway's CLEARING account. Everything a
 * receipt already does — allocation against open invoices, realised FX,
 * settlement-status transitions, ledger invariant #6, the audit trail — comes
 * for free and, more importantly, cannot drift. A parallel "gateway receipt"
 * path would start identical and diverge on the first bug fixed in only one of
 * them.
 *
 * The single difference between a gateway collection and someone walking in
 * with cash is WHICH ACCOUNT the money lands in. That is a parameter, not a
 * new code path.
 * ---------------------------------------------------------------------------
 */

import {
  buildGatewayFeeJournal,
  buildSettlementToBankJournal,
  checkSettlement,
  isErr,
  Money,
  paymentReference,
  validateJournalEntry,
  withinReplayWindow,
  type CollectionStatus,
  type GatewayEvent,
  type GatewayPaymentHandle,
  type GatewayPaymentRequest,
  type PaymentGateway,
} from '@emil/domain';
import type { Sql, TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';
import { recordReceipt, type RecordedReceipt } from './payment.js';
import { hashToken, mintToken } from './identity.js';
import { loadBaseCurrency } from './invoice.js';
import { toIsoDate } from './internal.js';

export class CollectionError extends Error {
  constructor(
    readonly code:
      | 'INVOICE_NOT_FOUND'
      | 'LINK_NOT_FOUND'
      | 'GATEWAY_NOT_CONFIGURED'
      | 'NO_CLEARING_ACCOUNT'
      | 'NO_FEE_ACCOUNT'
      | 'STALE_WEBHOOK'
      | 'SETTLEMENT_UNBALANCED'
      | 'SETTLEMENT_EMPTY'
      | 'JOURNAL_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'CollectionError';
  }
}

// ---------------------------------------------------------------------------
// Gateway configuration
// ---------------------------------------------------------------------------

export interface GatewayConfig {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly clearingAccountId: string;
  readonly feeAccountId?: string;
  readonly settlementBankAccountId?: string;
  /** Empty until confirmed against PayNet. See duitnow-qr.ts. */
  readonly merchantTemplate: readonly (readonly [string, string])[];
  readonly merchantName?: string;
  readonly merchantCity?: string;
  readonly merchantCategoryCode?: string;
}

export async function loadGatewayConfig(
  tx: Tx,
  ctx: TenantContext,
  provider: string,
): Promise<GatewayConfig> {
  const [row] = await tx<
    {
      id: string;
      provider: string;
      display_name: string;
      clearing_account_id: string;
      fee_account_id: string | null;
      settlement_bank_account_id: string | null;
      merchant_template: unknown;
      merchant_name: string | null;
      merchant_city: string | null;
      merchant_category_code: string | null;
    }[]
  >`
      SELECT id, provider, display_name, clearing_account_id, fee_account_id,
             settlement_bank_account_id, merchant_template, merchant_name,
             merchant_city, merchant_category_code
        FROM payment_gateway_config
       WHERE tenant_id = ${ctx.tenantId} AND provider = ${provider} AND is_active
  `;

  if (!row) {
    throw new CollectionError(
      'GATEWAY_NOT_CONFIGURED',
      `No active payment gateway configured for provider "${provider}". A clearing ` +
        'account must be mapped before collections can be accepted — money received ' +
        'and not yet banked has to go somewhere other than the bank account.',
    );
  }

  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    clearingAccountId: row.clearing_account_id,
    ...(row.fee_account_id !== null ? { feeAccountId: row.fee_account_id } : {}),
    ...(row.settlement_bank_account_id !== null
      ? { settlementBankAccountId: row.settlement_bank_account_id }
      : {}),
    merchantTemplate: Array.isArray(row.merchant_template)
      ? (row.merchant_template as (readonly [string, string])[])
      : [],
    ...(row.merchant_name !== null ? { merchantName: row.merchant_name } : {}),
    ...(row.merchant_city !== null ? { merchantCity: row.merchant_city } : {}),
    ...(row.merchant_category_code !== null
      ? { merchantCategoryCode: row.merchant_category_code }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Payment links
// ---------------------------------------------------------------------------

export interface CreatePaymentLinkInput {
  readonly invoiceId: string;
  /** Defaults to seven days. */
  readonly expiresInDays?: number;
  readonly idempotencyKey: string;
}

export interface CreatedPaymentLink {
  readonly id: string;
  /**
   * Returned ONCE, at creation. Only its digest is stored, so this is the only
   * moment the token exists outside the payer's browser — the same contract as
   * an API key.
   */
  readonly token: string;
  readonly reference: string;
  readonly amount: string;
  readonly currency: string;
  readonly expiresAt: string;
  readonly replayed: boolean;
}

const DEFAULT_LINK_LIFETIME_DAYS = 7;

export async function createPaymentLink(
  tx: Tx,
  ctx: TenantContext,
  input: CreatePaymentLinkInput,
): Promise<CreatedPaymentLink> {
  const [invoice] = await tx<
    { id: string; invoice_no: string; amount_due: string; currency: string; status: string }[]
  >`
      SELECT id, invoice_no, amount_due, currency, status
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.invoiceId}
  `;

  if (!invoice) {
    throw new CollectionError('INVOICE_NOT_FOUND', `Invoice ${input.invoiceId} not found`);
  }

  if (ctx.userId === undefined) {
    // `created_by` is NOT NULL and becomes `posted_by` on the journal entry a
    // webhook later posts. A link created without an actor would be a
    // collection that can never be recorded, discovered only once a customer's
    // money has already moved. See migration 0015.
    throw new CollectionError(
      'LINK_NOT_FOUND',
      'A payment link must record who issued it: the confirming journal entry is ' +
        'posted in their name, and every posted entry names someone accountable.',
    );
  }

  // The reference is derived from the invoice number, not generated randomly.
  // A random reference would be unrecognisable to the payer and, worse,
  // invisible to `referenceMatch()` when the money arrives by plain transfer.
  const reference = paymentReference(invoice.invoice_no);
  const { token, hash } = mintToken();
  const lifetimeDays = input.expiresInDays ?? DEFAULT_LINK_LIFETIME_DAYS;

  const [row] = await tx<{ id: string; expires_at: Date; token_hash: string }[]>`
      INSERT INTO payment_link (
          tenant_id, invoice_id, token_hash, reference, amount, currency, expires_at, created_by
      )
      VALUES (
          ${ctx.tenantId}, ${invoice.id}, ${hash}, ${reference},
          ${invoice.amount_due}, ${invoice.currency},
          now() + make_interval(days => ${lifetimeDays}),
          ${ctx.userId}
      )
      RETURNING id, expires_at, token_hash
  `;

  return {
    id: row!.id,
    token,
    reference,
    amount: invoice.amount_due,
    currency: invoice.currency,
    expiresAt: row!.expires_at.toISOString(),
    replayed: false,
  };
}

/** What the pay page is allowed to see. Deliberately minimal. */
export interface ResolvedPaymentLink {
  readonly tenantId: string;
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly reference: string;
  readonly amount: string;
  readonly amountDue: string;
  readonly currency: string;
  readonly status: CollectionStatus;
  readonly merchantName: string;
  readonly expiresAt: string;
  readonly expired: boolean;
}

/**
 * Resolve a pay-link token with no tenant context.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY UNAUTHENTICATED READ OF TENANT DATA IN THE SYSTEM.
 *
 * The caller has no session, so `app.tenant_id` is unset and every RLS policy
 * denies. `find_payment_link_by_digest` is SECURITY DEFINER for exactly that
 * reason, mirroring `find_user_for_authentication` on the login path, and the
 * digest — never the token — is what crosses into SQL.
 *
 * `expired` is returned rather than filtered. The public route refuses an
 * expired link, but a webhook confirming a payment made seconds before expiry
 * must still find it: money that has already left a customer's account is real
 * whatever a timer says.
 * ---------------------------------------------------------------------------
 */
export async function resolvePaymentLink(
  sql: Sql,
  token: string,
): Promise<ResolvedPaymentLink | null> {
  const [row] = await sql<
    {
      tenant_id: string;
      id: string;
      invoice_id: string;
      invoice_no: string;
      reference: string;
      amount: string;
      amount_due: string;
      currency: string;
      status: string;
      merchant_name: string;
      expires_at: Date;
    }[]
  >`SELECT * FROM find_payment_link_by_digest(${hashToken(token)})`;

  if (!row) return null;

  return {
    tenantId: row.tenant_id,
    id: row.id,
    invoiceId: row.invoice_id,
    invoiceNo: row.invoice_no,
    reference: row.reference,
    amount: row.amount,
    amountDue: row.amount_due,
    currency: row.currency,
    status: row.status as CollectionStatus,
    merchantName: row.merchant_name,
    expiresAt: row.expires_at.toISOString(),
    expired: row.expires_at.getTime() < Date.now(),
  };
}

/**
 * Route an inbound webhook to a tenant, with no tenant context.
 *
 * ---------------------------------------------------------------------------
 * KEYED ON OUR MERCHANT ORDER ID — THE PAY LINK'S UUID — AND ON NOTHING ELSE.
 *
 * Two rejected alternatives, both of which look reasonable:
 *
 *   * THE PROVIDER'S OWN REFERENCE. Unique within their namespace, not across
 *     merchants, so two tenants on one provider can be handed the same id.
 *     Routing on it means either refusing a legitimate payment or applying a
 *     webhook to the wrong tenant's invoice.
 *
 *   * THE PAY-LINK TOKEN, embedded in the callback URL. That token is the
 *     payer's bearer credential; handing it to a third party puts it in their
 *     logs and their support tooling, turning one compromised vendor into read
 *     access to invoices.
 *
 * The link's UUID is globally unique by construction and is not a credential.
 * It goes out as the merchant order id — a field every gateway carries so a
 * merchant can recognise its own payment — and comes back on every event.
 *
 * Returns routing information only. Amounts and invoice details are re-read
 * inside a tenant transaction once the tenant is known.
 */
export async function resolvePaymentLinkForWebhook(
  sql: Sql,
  merchantOrderId: string,
): Promise<WebhookRoute | null> {
  // A malformed id is a probe, not a payment. Refuse before it reaches SQL,
  // where a non-UUID would raise rather than simply miss.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(merchantOrderId)) {
    return null;
  }

  const [row] = await sql<
    { tenant_id: string; id: string; status: string; created_by: string; expires_at: Date }[]
  >`SELECT * FROM find_payment_link_for_webhook(${merchantOrderId})`;

  if (!row) return null;

  return {
    tenantId: row.tenant_id,
    id: row.id,
    status: row.status as CollectionStatus,
    createdBy: row.created_by,
    expired: row.expires_at.getTime() < Date.now(),
  };
}

export interface WebhookRoute {
  readonly tenantId: string;
  readonly id: string;
  readonly status: CollectionStatus;
  readonly expired: boolean;
  /**
   * Who issued the link — and therefore who the resulting journal entry is
   * posted by.
   *
   * A webhook has no session, but `journal_entry` requires an accountable
   * person on every posted row, and that constraint is right: "the system did
   * it" is the attribution an auditor cannot follow up. The person who invited
   * this payment, against this invoice, for this amount, is the honest answer.
   */
  readonly createdBy: string;
}

/**
 * Hand a link off to a gateway: record which provider and reference own it.
 *
 * Separate from `confirmCollection` because the outcome is not yet known. The
 * status moves to PENDING, which is what distinguishes "the payer went to their
 * bank and we are waiting" from "the payer never tried" — the difference a
 * merchant chasing a debt actually wants to see.
 */
export async function beginCollection(
  tx: Tx,
  ctx: TenantContext,
  input: { paymentLinkId: string; provider: string; providerRef: string },
): Promise<void> {
  const updated = await tx<{ id: string }[]>`
      UPDATE payment_link
         SET status       = 'PENDING',
             provider     = ${input.provider},
             provider_ref = ${input.providerRef},
             updated_at   = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.paymentLinkId}
         -- Never out of a terminal state. A second hand-off on a link already
         -- paid would let a payer be charged twice for one invoice.
         AND status NOT IN ('PAID', 'CANCELLED')
      RETURNING id
  `;

  if (updated.length === 0) {
    throw new CollectionError(
      'LINK_NOT_FOUND',
      `Payment link ${input.paymentLinkId} is not available for payment`,
    );
  }
}

/** Record that the payer opened the page. Advisory only; never blocks. */
export async function markPaymentLinkViewed(
  tx: Tx,
  ctx: TenantContext,
  linkId: string,
): Promise<void> {
  await tx`
      UPDATE payment_link
         SET view_count      = view_count + 1,
             first_viewed_at = COALESCE(first_viewed_at, now()),
             status          = CASE WHEN status = 'CREATED' THEN 'VIEWED' ELSE status END,
             updated_at      = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${linkId}
  `;
}

// ---------------------------------------------------------------------------
// Webhook intake
// ---------------------------------------------------------------------------

export interface RecordGatewayEventInput {
  readonly provider: string;
  readonly providerEventId: string;
  readonly providerRef?: string;
  readonly eventType: 'PAID' | 'FAILED' | 'PENDING';
  readonly paymentLinkId?: string;
  readonly amount?: string;
  readonly fee?: string;
  readonly currency?: string;
  readonly sentAt?: string;
  readonly signatureValid?: boolean;
  readonly raw: unknown;
}

export interface RecordedGatewayEvent {
  readonly id: string;
  /** True when this exact provider event has already been stored. */
  readonly replayed: boolean;
}

/**
 * Store an inbound webhook, letting the database reject the replay.
 *
 * ---------------------------------------------------------------------------
 * INSERT FIRST, ASK AFTERWARDS.
 *
 * The obvious shape — SELECT to check, then INSERT — has a race exactly wide
 * enough to matter: providers retry in parallel, and two concurrent deliveries
 * of the same event both find nothing and both insert. The UNIQUE constraint on
 * (tenant_id, provider, provider_event_id) closes it, so the insert is attempted
 * unconditionally and a unique violation IS the duplicate answer.
 *
 * `ON CONFLICT DO NOTHING` is used rather than catching the error because a
 * caught constraint violation aborts the surrounding transaction in PostgreSQL,
 * which would take the rest of the request down with it.
 * ---------------------------------------------------------------------------
 */
export async function recordGatewayEvent(
  tx: Tx,
  ctx: TenantContext,
  input: RecordGatewayEventInput,
): Promise<RecordedGatewayEvent> {
  const rows = await tx<{ id: string }[]>`
      INSERT INTO gateway_event (
          tenant_id, provider, provider_event_id, provider_ref, event_type,
          payment_link_id, amount, fee, currency, sent_at, signature_valid, raw_payload
      )
      VALUES (
          ${ctx.tenantId}, ${input.provider}, ${input.providerEventId},
          ${input.providerRef ?? null}, ${input.eventType},
          ${input.paymentLinkId ?? null}, ${input.amount ?? null}, ${input.fee ?? null},
          ${input.currency ?? 'MYR'}, ${input.sentAt ?? null},
          ${input.signatureValid ?? null},
          ${tx.json(input.raw as never)}
      )
      ON CONFLICT (tenant_id, provider, provider_event_id) DO NOTHING
      RETURNING id
  `;

  if (rows.length > 0) return { id: rows[0]!.id, replayed: false };

  const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM gateway_event
       WHERE tenant_id = ${ctx.tenantId}
         AND provider = ${input.provider}
         AND provider_event_id = ${input.providerEventId}
  `;

  return { id: existing!.id, replayed: true };
}

/** Mark an event handled. The one field the append-only trigger permits moving. */
export async function markGatewayEventProcessed(
  tx: Tx,
  ctx: TenantContext,
  eventId: string,
): Promise<void> {
  await tx`
      UPDATE gateway_event SET processed_at = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${eventId} AND processed_at IS NULL
  `;
}

// ---------------------------------------------------------------------------
// Confirming a collection
// ---------------------------------------------------------------------------

export interface ConfirmCollectionInput {
  readonly paymentLinkId: string;
  readonly provider: string;
  readonly providerRef: string;
  /** Gross — what the customer paid, before the gateway's cut. */
  readonly amount: string;
  /** The gateway's cut, if it is known at confirmation time. */
  readonly fee?: string;
  readonly paidAt: string;
  /** Sent by the provider; checked against the replay window. */
  readonly sentAt?: string;
  readonly now?: string;
  readonly idempotencyKey: string;
}

export interface ConfirmedCollection {
  readonly paymentLinkId: string;
  readonly receipt: RecordedReceipt;
  readonly feeJournalEntryId: string | null;
  readonly replayed: boolean;
}

/**
 * A confirmed payment becomes a receipt into the CLEARING account.
 *
 * ---------------------------------------------------------------------------
 *   Dr Undeposited funds  1,080   ← gross, because that is what the customer paid
 *   Cr Accounts receivable        1,080
 *
 * The customer's debt is settled the moment they pay, not two days later when
 * the bank shows it. That is what the customer believes, what they will say on
 * the phone, and what an aged receivables report has to agree with.
 *
 * The fee, if the provider reports it now, is a SEPARATE entry against the same
 * clearing account. Netting it into the receipt would credit AR with less than
 * the invoice and leave the customer owing a ringgit they already paid.
 * ---------------------------------------------------------------------------
 */
export async function confirmCollection(
  tx: Tx,
  ctx: TenantContext,
  input: ConfirmCollectionInput,
): Promise<ConfirmedCollection> {
  if (input.sentAt !== undefined) {
    const now = input.now ?? new Date().toISOString();
    if (!withinReplayWindow(input.sentAt, now)) {
      throw new CollectionError(
        'STALE_WEBHOOK',
        `Webhook for link ${input.paymentLinkId} was sent at ${input.sentAt}, outside the ` +
          'replay window. A valid signature does not expire on its own, so age is the ' +
          'only thing between a captured payload and it being replayed.',
      );
    }
  }

  const [link] = await tx<
    {
      id: string;
      invoice_id: string;
      currency: string;
      status: string;
      payment_id: string | null;
      contact_id: string;
    }[]
  >`
      SELECT pl.id, pl.invoice_id, pl.currency, pl.status, pl.payment_id, i.contact_id
        FROM payment_link pl
        JOIN invoice i ON i.tenant_id = pl.tenant_id AND i.id = pl.invoice_id
       WHERE pl.tenant_id = ${ctx.tenantId} AND pl.id = ${input.paymentLinkId}
         FOR UPDATE OF pl
  `;

  if (!link) {
    throw new CollectionError('LINK_NOT_FOUND', `Payment link ${input.paymentLinkId} not found`);
  }

  const config = await loadGatewayConfig(tx, ctx, input.provider);

  // The receipt itself. Not a parallel path — the same function a walk-in cash
  // payment goes through, differing only in which account the money lands in.
  const receipt = await recordReceipt(tx, ctx, {
    contactId: link.contact_id,
    paymentDate: toIsoDate(new Date(input.paidAt)),
    amount: input.amount,
    method: input.provider.toUpperCase() === 'DUITNOW' ? 'DUITNOW' : 'FPX',
    depositAccountId: config.clearingAccountId,
    allocations: [{ invoiceId: link.invoice_id, amount: input.amount }],
    reference: input.providerRef,
    currency: link.currency,
    idempotencyKey: `collection:${input.idempotencyKey}`,
  });

  let feeJournalEntryId: string | null = null;

  if (input.fee !== undefined && !Money.fromDecimal(input.fee, link.currency).isZero()) {
    feeJournalEntryId = await postGatewayFee(tx, ctx, {
      fee: input.fee,
      currency: link.currency,
      config,
      entryDate: toIsoDate(new Date(input.paidAt)),
      documentId: link.id,
      idempotencyKey: `collection-fee:${input.idempotencyKey}`,
    });
  }

  await tx`
      UPDATE payment_link
         SET status       = 'PAID',
             provider     = ${input.provider},
             provider_ref = ${input.providerRef},
             payment_id   = ${receipt.id},
             paid_at      = ${input.paidAt},
             -- What this confirmation booked. The settlement that follows
             -- reports the same fee again and must not book it twice.
             fee_amount   = ${feeJournalEntryId !== null ? (input.fee ?? '0') : '0'},
             updated_at   = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${link.id}
  `;

  // `gateway_txn_id` was declared in 0003 and never written until now.
  await tx`
      UPDATE payment SET gateway_txn_id = ${input.providerRef}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${receipt.id}
  `;

  return {
    paymentLinkId: link.id,
    receipt,
    feeJournalEntryId,
    replayed: receipt.replayed,
  };
}

async function postGatewayFee(
  tx: Tx,
  ctx: TenantContext,
  args: {
    fee: string;
    currency: string;
    config: GatewayConfig;
    entryDate: string;
    documentId: string;
    idempotencyKey: string;
  },
): Promise<string> {
  if (args.config.feeAccountId === undefined) {
    throw new CollectionError(
      'NO_FEE_ACCOUNT',
      `Gateway "${args.config.provider}" reported a fee of ${args.fee} but no GATEWAY_FEE ` +
        'account is mapped. Booking it anywhere else would hide what the business pays ' +
        'its payment provider.',
    );
  }

  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const draft = buildGatewayFeeJournal(
    Money.fromDecimal(args.fee, args.currency),
    {
      clearingAccountId: args.config.clearingAccountId,
      feeAccountId: args.config.feeAccountId,
    },
    {
      entryDate: args.entryDate,
      description: `${args.config.displayName} transaction fee`,
      documentType: 'PAYMENT_LINK',
      documentId: args.documentId,
    },
  );

  // Non-null: the caller already established the fee is non-zero.
  const valid = validateJournalEntry(draft!, baseCurrency);
  if (isErr(valid)) {
    throw new CollectionError('JOURNAL_INVALID', 'Gateway fee journal is invalid', valid.error);
  }

  const posted = await postJournalEntry(tx, ctx, valid.value, {
    idempotencyKey: args.idempotencyKey,
  });

  return posted.id;
}

// ---------------------------------------------------------------------------
// Settlement — the batch that becomes one bank line
// ---------------------------------------------------------------------------

export interface RecordSettlementInput {
  readonly provider: string;
  readonly providerBatchId: string;
  readonly settlementDate: string;
  readonly bankAccountId: string;
  /** What the provider says it paid into the bank. Verified, not trusted. */
  readonly reportedNet: string;
  readonly items: readonly { paymentId: string; gross: string; fee?: string }[];
  readonly idempotencyKey: string;
}

export interface RecordedSettlement {
  readonly id: string;
  readonly gross: string;
  readonly fees: string;
  readonly net: string;
  readonly journalEntryId: string;
  readonly feeJournalEntryId: string | null;
  readonly replayed: boolean;
}

/**
 * The gateway pays the batch into the bank.
 *
 *   Dr Bank              1,079
 *   Cr Undeposited funds 1,079
 *
 * Only the net moves. The gross was recognised when each payment confirmed and
 * the fees are booked here as one entry for the batch, so posting the gross
 * again would double-count every collection in it.
 *
 * The clearing account nets to zero across the pair, which is the property the
 * integration test asserts: a non-zero balance in undeposited funds after every
 * settlement has landed means money was recognised and never banked.
 */
export async function recordSettlement(
  tx: Tx,
  ctx: TenantContext,
  input: RecordSettlementInput,
): Promise<RecordedSettlement> {
  if (input.items.length === 0) {
    throw new CollectionError(
      'SETTLEMENT_EMPTY',
      'A settlement with no items would move money out of the clearing account without ' +
        'saying which collections it covers',
    );
  }

  const existing = await tx<
    {
      id: string;
      gross_amount: string;
      fee_amount: string;
      net_amount: string;
      journal_entry_id: string | null;
      fee_journal_entry_id: string | null;
    }[]
  >`
      SELECT id, gross_amount, fee_amount, net_amount, journal_entry_id, fee_journal_entry_id
        FROM gateway_settlement
       WHERE tenant_id = ${ctx.tenantId} AND idempotency_key = ${input.idempotencyKey}
  `;

  if (existing.length > 0) {
    const row = existing[0]!;
    return {
      id: row.id,
      gross: row.gross_amount,
      fees: row.fee_amount,
      net: row.net_amount,
      journalEntryId: row.journal_entry_id!,
      feeJournalEntryId: row.fee_journal_entry_id,
      replayed: true,
    };
  }

  const config = await loadGatewayConfig(tx, ctx, input.provider);
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const [bank] = await tx<{ gl_account_id: string; currency: string }[]>`
      SELECT gl_account_id, currency FROM bank_account
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.bankAccountId}
  `;

  if (!bank) {
    throw new CollectionError(
      'LINK_NOT_FOUND',
      `Bank account ${input.bankAccountId} not found`,
    );
  }

  const currency = bank.currency;
  const zero = Money.zero(currency);
  const gross = input.items.reduce(
    (sum, item) => sum.add(Money.fromDecimal(item.gross, currency)),
    zero,
  );
  const fees = input.items.reduce(
    (sum, item) => sum.add(Money.fromDecimal(item.fee ?? '0', currency)),
    zero,
  );

  // Verified rather than trusted: a batch whose parts do not add up is a
  // provider bug or a misread file, and accepting it silently leaves an
  // unexplained residue in the clearing account that nobody will ever find.
  const check = checkSettlement(gross, fees, Money.fromDecimal(input.reportedNet, currency));
  if (!check.balances) {
    throw new CollectionError(
      'SETTLEMENT_UNBALANCED',
      `Settlement ${input.providerBatchId} does not add up: gross ${gross.toDecimalString()} ` +
        `less fees ${fees.toDecimalString()} is ${check.expectedNet.toDecimalString()}, but ` +
        `the provider reports ${check.reportedNet.toDecimalString()} — a difference of ` +
        `${check.difference.toDecimalString()}`,
      { difference: check.difference.toDecimalString() },
    );
  }

  const [settlement] = await tx<{ id: string }[]>`
      INSERT INTO gateway_settlement (
          tenant_id, provider, provider_batch_id, settlement_date, currency,
          gross_amount, fee_amount, net_amount, bank_account_id, idempotency_key
      )
      VALUES (
          ${ctx.tenantId}, ${input.provider}, ${input.providerBatchId},
          ${input.settlementDate}, ${currency},
          ${gross.toDecimalString()}, ${fees.toDecimalString()},
          ${check.expectedNet.toDecimalString()},
          ${input.bankAccountId}, ${input.idempotencyKey}
      )
      RETURNING id
  `;

  const settlementId = settlement!.id;

  for (const item of input.items) {
    await tx`
        INSERT INTO gateway_settlement_item (
            tenant_id, settlement_id, payment_id, gross_amount, fee_amount
        )
        VALUES (
            ${ctx.tenantId}, ${settlementId}, ${item.paymentId},
            ${item.gross}, ${item.fee ?? '0'}
        )
    `;
  }

  /*
   * Book only the fees confirmation did not already book.
   *
   * -------------------------------------------------------------------------
   * THE SAME RINGGIT, REPORTED TWICE.
   *
   * A provider states the fee on the PAID webhook and again on the settlement
   * report. Booking both leaves the clearing account permanently short by the
   * total fees and overstates expenses by the same amount — and because the
   * difference lands in undeposited funds, the books still balance and nothing
   * is flagged. The only symptom is a clearing account that never returns to
   * zero, which is exactly the error this whole treatment exists to surface.
   *
   * So the settlement books the REMAINDER. Usually that is zero.
   * -------------------------------------------------------------------------
   */
  const [booked] = await tx<{ already: string }[]>`
      SELECT COALESCE(SUM(pl.fee_amount), 0)::text AS already
        FROM payment_link pl
       WHERE pl.tenant_id = ${ctx.tenantId}
         AND pl.payment_id IN ${tx(input.items.map((i) => i.paymentId))}
  `;

  const alreadyBooked = Money.fromDecimal(booked!.already, currency);
  const feesToBook = fees.subtract(alreadyBooked);

  if (feesToBook.isNegative()) {
    // The provider now reports LESS fee than it charged at confirmation.
    // Silently reversing part of an expense on a settlement is not something
    // to do without a human looking at it.
    throw new CollectionError(
      'SETTLEMENT_UNBALANCED',
      `Settlement ${input.providerBatchId} reports ${fees.toDecimalString()} of fees, but ` +
        `${alreadyBooked.toDecimalString()} was already booked when these payments ` +
        'confirmed. A settlement cannot reduce a fee already charged — check the ' +
        'provider report against the individual confirmations.',
      { alreadyBooked: alreadyBooked.toDecimalString() },
    );
  }

  let feeJournalEntryId: string | null = null;
  if (!feesToBook.isZero()) {
    feeJournalEntryId = await postGatewayFee(tx, ctx, {
      fee: feesToBook.toDecimalString(),
      currency,
      config,
      entryDate: input.settlementDate,
      documentId: settlementId,
      idempotencyKey: `settlement-fee:${input.idempotencyKey}`,
    });
  }

  const draft = buildSettlementToBankJournal(
    check.expectedNet,
    {
      clearingAccountId: config.clearingAccountId,
      bankAccountId: bank.gl_account_id,
      ...(config.feeAccountId !== undefined ? { feeAccountId: config.feeAccountId } : {}),
    },
    {
      entryDate: input.settlementDate,
      description: `${config.displayName} settlement ${input.providerBatchId}`,
      documentType: 'GATEWAY_SETTLEMENT',
      documentId: settlementId,
    },
  );

  const valid = validateJournalEntry(draft!, baseCurrency);
  if (isErr(valid)) {
    throw new CollectionError('JOURNAL_INVALID', 'Settlement journal is invalid', valid.error);
  }

  const posted = await postJournalEntry(tx, ctx, valid.value, {
    idempotencyKey: `settlement:${input.idempotencyKey}`,
    emitEvent: {
      type: 'gateway.settled',
      payload: { settlementId, net: check.expectedNet.toDecimalString() },
    },
  });

  await tx`
      UPDATE gateway_settlement
         SET journal_entry_id     = ${posted.id},
             fee_journal_entry_id = ${feeJournalEntryId},
             status               = 'POSTED'
       WHERE tenant_id = ${ctx.tenantId} AND id = ${settlementId}
  `;

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, entity_type, entity_id, detail
      )
      VALUES (
          ${ctx.tenantId}, 'GATEWAY_SETTLEMENT_POSTED', ${ctx.userId ?? null},
          'GATEWAY_SETTLEMENT', ${settlementId},
          ${tx.json({
            provider: input.provider,
            batch: input.providerBatchId,
            gross: gross.toDecimalString(),
            fees: fees.toDecimalString(),
            net: check.expectedNet.toDecimalString(),
          })}
      )
  `;

  return {
    id: settlementId,
    gross: gross.toDecimalString(),
    fees: fees.toDecimalString(),
    net: check.expectedNet.toDecimalString(),
    journalEntryId: posted.id,
    feeJournalEntryId,
    replayed: false,
  };
}

/**
 * What is sitting in the clearing account: collected, not yet banked.
 *
 * The number a user should be able to explain at any moment. A balance that
 * does not correspond to payments awaiting settlement means either a collection
 * was recognised and never settled, or a settlement moved money that was never
 * collected.
 */
export async function unsettledCollections(
  tx: Tx,
  ctx: TenantContext,
  provider: string,
): Promise<{ paymentId: string; paymentNo: string; amount: string; paymentDate: string }[]> {
  const config = await loadGatewayConfig(tx, ctx, provider);

  const rows = await tx<
    { id: string; payment_no: string; amount: string; payment_date: Date }[]
  >`
      SELECT p.id, p.payment_no, p.amount, p.payment_date
        FROM payment p
       WHERE p.tenant_id = ${ctx.tenantId}
         AND p.deposit_account_id = ${config.clearingAccountId}
         AND p.direction = 'INBOUND'
         AND NOT EXISTS (
             SELECT 1 FROM gateway_settlement_item i
              WHERE i.tenant_id = p.tenant_id AND i.payment_id = p.id
         )
       ORDER BY p.payment_date, p.payment_no
  `;

  return rows.map((r) => ({
    paymentId: r.id,
    paymentNo: r.payment_no,
    amount: r.amount,
    paymentDate: toIsoDate(r.payment_date),
  }));
}

// ---------------------------------------------------------------------------
// A gateway that needs no credentials
// ---------------------------------------------------------------------------

/**
 * An in-memory `PaymentGateway` for tests and local development.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A STUB STANDING IN FOR A MISSING BILLPLZ CLIENT.
 *
 * No concrete adapter ships with this slice, deliberately: Billplz and iPay88
 * both need merchant credentials to exercise, and an adapter written from
 * documentation alone would look complete and be untestable — worse than an
 * obvious gap, because it invites trust.
 *
 * What this does is let the WHOLE collection flow — link, redirect, webhook,
 * receipt, settlement, reconciliation — be driven end to end with no
 * credentials at all. When a real adapter arrives it implements the same port
 * and the tests above it do not change.
 *
 * `verifySignature` returns true unconditionally. That is safe only because
 * this class is never registered outside tests, and the API layer must refuse
 * to select it in production.
 * ---------------------------------------------------------------------------
 */
export class FakeGateway implements PaymentGateway {
  readonly provider = 'FAKE';

  private counter = 0;
  private readonly issued = new Map<string, GatewayPaymentRequest>();
  /** providerRef → merchantOrderId, so an event can echo ours back. */
  private readonly orders = new Map<string, string>();

  createPayment(request: GatewayPaymentRequest): Promise<GatewayPaymentHandle> {
    const providerRef = `fake_${++this.counter}`;
    this.issued.set(providerRef, request);
    this.orders.set(providerRef, request.merchantOrderId);
    return Promise.resolve({
      providerRef,
      redirectUrl: `https://gateway.invalid/pay/${providerRef}`,
    });
  }

  verifySignature(): boolean {
    return true;
  }

  parseEvent(rawBody: string): GatewayEvent {
    const parsed = JSON.parse(rawBody) as {
      eventId: string;
      providerRef: string;
      merchantOrderId?: string;
      type: 'PAID' | 'FAILED' | 'PENDING';
      amount: string;
      currency?: string;
      fee?: string;
      sentAt: string;
    };

    const currency = parsed.currency ?? 'MYR';

    return {
      eventId: parsed.eventId,
      providerRef: parsed.providerRef,
      // A real gateway echoes the merchant order id it was given. The fake
      // one remembers it, so a caller need not repeat it.
      merchantOrderId:
        parsed.merchantOrderId ?? this.orders.get(parsed.providerRef) ?? parsed.providerRef,
      type: parsed.type,
      amount: Money.fromDecimal(parsed.amount, currency),
      ...(parsed.fee !== undefined ? { fee: Money.fromDecimal(parsed.fee, currency) } : {}),
      sentAt: parsed.sentAt,
      raw: parsed,
    };
  }

  /** What was requested for a ref — lets a test assert the redirect payload. */
  requestFor(providerRef: string): GatewayPaymentRequest | undefined {
    return this.issued.get(providerRef);
  }
}
