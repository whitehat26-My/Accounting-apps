/**
 * Online collections — FPX, DuitNow and cards (M2).
 *
 * ---------------------------------------------------------------------------
 * GATEWAY MONEY IS NOT BANK MONEY. THIS IS THE WHOLE POINT OF THE MODULE.
 *
 * A customer pays RM 1,080 by FPX at 14:32 on Monday. The gateway keeps a fee
 * of RM 1.00 and settles RM 1,079 to the bank on WEDNESDAY, batched with
 * eleven other payments as a SINGLE bank line.
 *
 * The naive treatment books `Dr Bank 1,080 / Cr AR 1,080` on Monday. Three
 * things break at once:
 *
 *   * the bank statement never shows 1,080, so the line never matches;
 *   * the RM 1.00 fee is invisible — silently netted out of income;
 *   * the bank balance is overstated for two days.
 *
 * The correct treatment routes through a CLEARING account:
 *
 *   Monday    (paid)      Dr Undeposited funds 1,080 / Cr AR                 1,080
 *   Fee                   Dr Gateway fees          1  / Cr Undeposited funds     1
 *   Wednesday (settled)   Dr Bank              1,079  / Cr Undeposited funds 1,079
 *
 * The customer's debt is settled WHEN THEY PAY, which is both correct and what
 * the customer expects to see when they ring up about it. The bank line on
 * Wednesday is one figure for twelve payments — and the matching engine built
 * for M4 already handles exactly that, as its one-to-many case.
 * ---------------------------------------------------------------------------
 *
 * Pure. No HTTP, no gateway SDK, no clock. `PaymentGateway` is declared as a
 * port with no implementation in this repository, for the same reason
 * `MyInvoisGateway` and `BankFeedProvider` are: a client written against
 * endpoints nobody can exercise looks finished and is probably wrong.
 */

import { Money, type Currency } from './money.js';
import { err, ok, type Result } from './result.js';
import type { JournalEntryDraft, JournalLineDraft } from './journal-entry.js';

// ---------------------------------------------------------------------------
// The collection lifecycle
// ---------------------------------------------------------------------------

export type CollectionStatus =
  /** A link exists; nobody has opened it. */
  | 'CREATED'
  /** The payer opened the page. Useful for "they saw it and did not pay". */
  | 'VIEWED'
  /** Handed off to the gateway. The outcome is not yet known. */
  | 'PENDING'
  | 'PAID'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

export type CollectionEvent =
  | { readonly type: 'VIEWED' }
  | { readonly type: 'HANDED_OFF'; readonly providerRef: string }
  | { readonly type: 'PAID'; readonly providerRef: string; readonly paidAt: string }
  | { readonly type: 'FAILED'; readonly reason: string }
  | { readonly type: 'EXPIRED' }
  | { readonly type: 'CANCELLED'; readonly reason: string };

export type CollectionViolation = {
  readonly code: 'ILLEGAL_TRANSITION';
  readonly from: CollectionStatus;
  readonly event: CollectionEvent['type'];
};

/**
 * The collection state machine.
 *
 * Named `advanceCollection` rather than `transition` because the domain barrel
 * re-exports flat and `einvoice.ts` already owns that name. Two different state
 * machines sharing one identifier would resolve by import order, which is the
 * kind of ambiguity that reads fine and behaves surprisingly.
 *
 * ---------------------------------------------------------------------------
 * `PAID` IS TERMINAL AND IRREVERSIBLE HERE, INCLUDING FROM `EXPIRED`.
 *
 * A link can expire while the payer is mid-flow at their bank, and the
 * confirmation then arrives after expiry. The money is real. Refusing it
 * because a timer elapsed would take a customer's payment and leave the
 * invoice outstanding — so `EXPIRED` still accepts `PAID`, and only `PAID`.
 *
 * The reverse is not allowed: nothing moves a `PAID` collection anywhere. A
 * refund is a separate business event with its own ledger entry, not a
 * backwards step through this machine.
 * ---------------------------------------------------------------------------
 */
export function advanceCollection(
  from: CollectionStatus,
  event: CollectionEvent,
): Result<CollectionStatus, CollectionViolation> {
  const illegal = err<CollectionViolation>({
    code: 'ILLEGAL_TRANSITION',
    from,
    event: event.type,
  });

  // Once paid, always paid. Checked first so no later branch can undo it.
  if (from === 'PAID') return illegal;

  switch (event.type) {
    case 'VIEWED':
      return from === 'CREATED' ? ok<CollectionStatus>('VIEWED') : illegal;

    case 'HANDED_OFF':
      return from === 'CREATED' || from === 'VIEWED' || from === 'FAILED'
        ? ok<CollectionStatus>('PENDING')
        : illegal;

    case 'PAID':
      // Deliberately permitted from EXPIRED — see the note above.
      return from === 'CANCELLED' ? illegal : ok<CollectionStatus>('PAID');

    case 'FAILED':
      // A failure is retryable: the payer picks another bank and tries again.
      return from === 'PENDING' ? ok<CollectionStatus>('FAILED') : illegal;

    case 'EXPIRED':
      return from === 'CREATED' || from === 'VIEWED' || from === 'FAILED'
        ? ok<CollectionStatus>('EXPIRED')
        : illegal;

    case 'CANCELLED':
      return from === 'CANCELLED' ? illegal : ok<CollectionStatus>('CANCELLED');
  }
}

export function isCollectionTerminal(status: CollectionStatus): boolean {
  return status === 'PAID' || status === 'CANCELLED';
}

// ---------------------------------------------------------------------------
// Payment references — the join with reconciliation
// ---------------------------------------------------------------------------

/**
 * The reference a payer quotes on a DuitNow Transfer.
 *
 * ---------------------------------------------------------------------------
 * THIS FUNCTION EXISTS TO BE FOUND BY THE MATCHING ENGINE.
 *
 * DuitNow Transfer is a plain bank transfer: the money arrives on the
 * statement with whatever the payer typed in the reference field, and nothing
 * ties it to an invoice except that string. `05-malaysia-localization.md:100`
 * makes the point directly — "this is why the reference-extraction part of the
 * matching engine matters so much".
 *
 * So the format is not cosmetic. It must survive `referenceMatch()` in
 * `text.ts`, and the way that function works dictates the format exactly:
 *
 *   `referenceMatchIndexed` scores EXACT when the CANDIDATE DOCUMENT NUMBER,
 *   reduced to `[A-Z0-9]`, appears as a substring of the narrative reduced the
 *   same way. It falls back to NUMERIC only when the narrative's extracted
 *   digits happen to include the document's digits with leading zeros stripped.
 *
 * The matcher compares against `candidate.documentNo` — the invoice number —
 * not against whatever we generated. So the reference must carry the invoice
 * number's compact form INTACT, leading zeros and all.
 *
 * This is subtle enough to have been got wrong here once: an earlier version
 * stripped punctuation AND leading zeros, so `INV-00042` produced `INV42`.
 * That still "matched", but only as NUMERIC on the bare digits `42` — a two
 * digit token that collides with a date, an amount, or any other invoice ending
 * in 42, and which scores far lower in `matching.ts`. Preserving the zeros
 * turns the same payment into an EXACT hit.
 *
 * A property test asserts the generated reference is recoverable from a
 * realistic Malaysian narrative. That test is the contract between this module
 * and M4, and it is why the two halves cannot drift apart.
 * ---------------------------------------------------------------------------
 */

/**
 * How much room a payer's reference field has.
 *
 * ⚠️ A heuristic, not a published limit: Malaysian banks each cap the DuitNow
 * Transfer recipient-reference field differently and none of it is documented
 * in one place. 20 is chosen to sit safely inside the tightest of them. Worth
 * confirming against real bank behaviour before relying on the upper end.
 */
export const MAX_REFERENCE_LENGTH = 20;

export class CollectionReferenceError extends Error {
  constructor(
    readonly code: 'EMPTY_DOCUMENT_NO' | 'DOCUMENT_NO_TOO_LONG',
    message: string,
  ) {
    super(message);
    this.name = 'CollectionReferenceError';
  }
}

export function paymentReference(documentNo: string): string {
  const compact = documentNo.toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (compact.length === 0) {
    throw new CollectionReferenceError(
      'EMPTY_DOCUMENT_NO',
      `Cannot build a payment reference from "${documentNo}": it has no alphanumeric content`,
    );
  }

  // A bare number gets an `INV` prefix so the payer sees what it is for in
  // their banking app. A document number that already starts with letters
  // carries its own prefix and must not be given a second one — `INVINV00042`
  // still matches, but it is nonsense on a bank statement.
  const reference = /^[A-Z]/.test(compact) ? compact : `INV${compact}`;

  // -------------------------------------------------------------------------
  // A document number too long to carry is REFUSED, not truncated.
  //
  // There is no salvage here, and that was worth discovering rather than
  // assuming. Truncating the compact form breaks the substring test that earns
  // an EXACT match. Falling back to the digits does not help either: a long
  // number's digit run overflows what `extractReferences()` will pull out of a
  // narrative (12 digits after a prefix, 8 standing alone), so it scores NONE
  // just the same. Every degraded form is equally unmatchable.
  //
  // So the only honest outcomes are a reference that reconciles or an error
  // saying why one cannot be built. Emitting an unmatchable string would put
  // real customer payments into the unmatched pile with nothing to explain it —
  // the failure would surface weeks later as a bank reconciliation that will
  // not close, rather than here, where the fix is to shorten a prefix.
  // -------------------------------------------------------------------------
  if (reference.length > MAX_REFERENCE_LENGTH) {
    throw new CollectionReferenceError(
      'DOCUMENT_NO_TOO_LONG',
      `Document number "${documentNo}" is ${reference.length} characters once punctuation is ` +
        `stripped, over the ${MAX_REFERENCE_LENGTH}-character payment reference limit. A ` +
        'truncated reference cannot be matched back to the invoice, so shorten the document ' +
        'number prefix or padding in number_sequence instead.',
    );
  }

  return reference;
}

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

export interface CollectionPostingAccounts {
  /** The clearing account. `UNDEPOSITED_FUNDS` — money owed to us by the gateway. */
  readonly clearingAccountId: string;
  readonly bankAccountId?: string;
  /** Where the gateway's cut lands. An expense, never netted into revenue. */
  readonly feeAccountId?: string;
}

export interface CollectionPostingContext {
  readonly entryDate: string;
  readonly description?: string;
  readonly documentType: string;
  readonly documentId: string;
  readonly contactId?: string;
}

/**
 * The gateway's fee.
 *
 * ---------------------------------------------------------------------------
 * A SEPARATE ENTRY, NEVER NETTED.
 *
 * The tempting shortcut is to credit AR with the gross and debit bank with the
 * net, letting the difference fall wherever it lands. That understates both
 * revenue and expenses by the fee — the P&L nets to the same profit, so
 * nothing looks wrong, and the business never learns what it pays its payment
 * provider. Over a year of card and FPX volume that is a real number a
 * business is entitled to see on its own P&L.
 * ---------------------------------------------------------------------------
 *
 * Returns null for a zero fee rather than posting an empty line.
 */
export function buildGatewayFeeJournal(
  fee: Money,
  accounts: CollectionPostingAccounts,
  ctx: CollectionPostingContext,
): JournalEntryDraft | null {
  if (fee.isZero()) return null;

  if (accounts.feeAccountId === undefined) {
    throw new Error(
      'This gateway charged a fee but no GATEWAY_FEE account is configured. ' +
        'Map the GATEWAY_FEE posting role before recording a settlement with fees.',
    );
  }

  const amount = fee.abs();

  return {
    entryDate: ctx.entryDate,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    sourceModule: 'BANKING',
    sourceDocumentType: ctx.documentType,
    sourceDocumentId: ctx.documentId,
    lines: [
      {
        accountId: accounts.feeAccountId,
        side: 'DEBIT',
        amount,
        baseAmount: amount,
        description: 'Payment gateway fee',
      },
      {
        accountId: accounts.clearingAccountId,
        side: 'CREDIT',
        amount,
        baseAmount: amount,
        description: 'Gateway fee withheld from settlement',
      },
    ],
  };
}

/**
 * Settlement: the gateway pays the batch into the bank.
 *
 *   Dr Bank                (net actually received)
 *   Cr Undeposited funds   (net)
 *
 * The gross and the fee were already recorded when each payment confirmed, so
 * this entry moves only what genuinely arrived. Posting the gross here and the
 * fee separately would double-count.
 */
export function buildSettlementToBankJournal(
  net: Money,
  accounts: CollectionPostingAccounts,
  ctx: CollectionPostingContext,
): JournalEntryDraft | null {
  if (net.isZero()) return null;

  if (accounts.bankAccountId === undefined) {
    throw new Error('A settlement needs the bank account it was paid into');
  }

  const amount = net.abs();
  const lines: JournalLineDraft[] = [
    {
      accountId: accounts.bankAccountId,
      side: 'DEBIT',
      amount,
      baseAmount: amount,
      description: 'Gateway settlement received',
    },
    {
      accountId: accounts.clearingAccountId,
      side: 'CREDIT',
      amount,
      baseAmount: amount,
      description: 'Gateway settlement cleared',
    },
  ];

  return {
    entryDate: ctx.entryDate,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    sourceModule: 'BANKING',
    sourceDocumentType: ctx.documentType,
    sourceDocumentId: ctx.documentId,
    lines,
  };
}

/**
 * What a settlement batch should reconcile to.
 *
 * `gross - fees = net`, and the net is what the bank line must show. Computed
 * rather than trusted from the provider so a mismatch is visible: a settlement
 * whose parts do not add up is a provider bug or a misread file, and silently
 * accepting it puts an unexplained difference into the clearing account that
 * nobody will ever find.
 */
export interface SettlementCheck {
  readonly gross: Money;
  readonly fees: Money;
  readonly expectedNet: Money;
  readonly reportedNet: Money;
  readonly balances: boolean;
  readonly difference: Money;
}

export function checkSettlement(
  gross: Money,
  fees: Money,
  reportedNet: Money,
): SettlementCheck {
  const expectedNet = gross.subtract(fees);
  const difference = reportedNet.subtract(expectedNet);

  return {
    gross,
    fees,
    expectedNet,
    reportedNet,
    balances: difference.isZero(),
    difference,
  };
}

// ---------------------------------------------------------------------------
// Webhook safety — gateway-agnostic
// ---------------------------------------------------------------------------

/**
 * Whether a webhook is stale enough to refuse.
 *
 * A captured webhook replayed weeks later must not be accepted, even if its
 * signature is still valid — signatures do not expire on their own. The window
 * is generous because provider clocks drift and retries are legitimate; five
 * minutes is the usual choice and is too tight for a provider that retries
 * with backoff over an hour.
 *
 * Note this rejects a FUTURE timestamp beyond the tolerance too: a clock far
 * ahead is either a misconfigured provider or a forged payload, and neither
 * should be trusted.
 */
export const REPLAY_WINDOW_SECONDS = 60 * 60;
const CLOCK_SKEW_TOLERANCE_SECONDS = 5 * 60;

export function withinReplayWindow(
  sentAt: string,
  now: string,
  windowSeconds: number = REPLAY_WINDOW_SECONDS,
): boolean {
  const sent = Date.parse(sentAt);
  const current = Date.parse(now);
  if (Number.isNaN(sent) || Number.isNaN(current)) return false;

  const ageSeconds = (current - sent) / 1000;
  if (ageSeconds > windowSeconds) return false;
  if (ageSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS) return false;

  return true;
}

/**
 * The port. Declared here, implemented nowhere in this repository.
 *
 * ---------------------------------------------------------------------------
 * NO ADAPTER SHIPS WITH THIS SLICE, DELIBERATELY.
 *
 * `03-tech-stack.md:88` recommends Billplz or iPay88 without choosing, and
 * both need merchant credentials to exercise. An adapter written against
 * documentation alone — the endpoint paths, the signature scheme, the field
 * names — would look complete and be untestable, which is worse than an
 * obvious gap because it invites trust.
 *
 * `verifySignature` belongs to the adapter and NOT to this module: every
 * provider signs differently (Billplz uses an X-Signature over sorted
 * key-value pairs; others sign a raw body). The parts that are the same for
 * everyone — replay windows and event de-duplication — are here and are
 * tested.
 * ---------------------------------------------------------------------------
 */
export interface PaymentGateway {
  readonly provider: string;
  /** Create a hosted payment and return where to send the payer. */
  createPayment(request: GatewayPaymentRequest): Promise<GatewayPaymentHandle>;
  /** Verify an inbound webhook. Provider-specific; the adapter owns it. */
  verifySignature(rawBody: string, headers: Readonly<Record<string, string>>): boolean;
  parseEvent(rawBody: string): GatewayEvent;
}

export interface GatewayPaymentRequest {
  readonly amount: Money;
  readonly reference: string;
  readonly description: string;
  readonly payerName?: string;
  readonly payerEmail?: string;
  readonly returnUrl: string;
  readonly callbackUrl: string;
}

export interface GatewayPaymentHandle {
  readonly providerRef: string;
  /** Where to send the payer's browser. */
  readonly redirectUrl: string;
}

export interface GatewayEvent {
  /** The provider's own id. The de-duplication key — see `gateway_event`. */
  readonly eventId: string;
  readonly providerRef: string;
  readonly type: 'PAID' | 'FAILED' | 'PENDING';
  readonly amount: Money;
  readonly fee?: Money;
  readonly sentAt: string;
  readonly raw: unknown;
}

/**
 * Whether an event has been seen before.
 *
 * The real guarantee is a UNIQUE constraint on
 * `(tenant_id, provider, provider_event_id)` — this is the pure counterpart,
 * for callers holding a set in memory. Providers retry aggressively and a
 * double-processed `PAID` would settle an invoice twice, so the check is not
 * optional and the database is what actually enforces it.
 */
export function isReplay(eventId: string, seen: ReadonlySet<string>): boolean {
  return seen.has(eventId);
}

/** A collection as the pay page shows it — deliberately minimal. */
export interface PublicCollectionView {
  readonly reference: string;
  readonly amount: Money;
  readonly currency: Currency;
  readonly merchantName: string;
  readonly documentNo: string;
  readonly status: CollectionStatus;
  readonly expiresAt: string;
}
