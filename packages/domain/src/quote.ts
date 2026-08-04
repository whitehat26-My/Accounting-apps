import { err, ok, type Result } from './result.js';

/**
 * Sales quotes — the document that comes BEFORE an invoice.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM A REPAIR QUOTE.
 *
 * The workshop already quotes: `repair.ts` owns the machine-on-the-bench case,
 * where the quote is one stage inside a job's life. This is the other half —
 * a customer asks "what would twelve of these cost me", and there is no job,
 * no device and no bench. Modelling that as a repair job with no device would
 * put a fiction in the workshop queue; modelling it as a draft invoice would
 * put a document in the sales ledger that nobody has agreed to buy.
 *
 * A quote is deliberately NOT an accounting document. Nothing here posts to
 * the ledger, and that is the whole point: a quote is an offer, and an offer
 * that has not been accepted is not revenue. The ledger entry happens exactly
 * once, at conversion, through the same `issueInvoice` path a typed invoice
 * uses — so a quoted sale and a typed sale are indistinguishable in the books.
 * ---------------------------------------------------------------------------
 */

export type QuoteStatus =
  | 'DRAFT'
  | 'SENT'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'INVOICED';

const TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  // Still being written. It can be sent, or abandoned outright.
  DRAFT: ['SENT', 'DECLINED'],
  // With the customer. They say yes, they say no, or it lapses.
  SENT: ['ACCEPTED', 'DECLINED', 'EXPIRED'],
  // Agreed. The only forward move is becoming an invoice — but a customer may
  // still pull out before it is billed, so DECLINED stays reachable.
  ACCEPTED: ['INVOICED', 'DECLINED'],
  // A "no" is not final: shops re-quote cheaper all the time, which returns
  // the document to DRAFT rather than creating a second one and losing the
  // history of what was first offered.
  DECLINED: ['DRAFT'],
  // Same reasoning — a lapsed quote is usually revived, not retyped.
  EXPIRED: ['DRAFT'],
  // Terminal. The invoice is now the document of record; correcting it is a
  // credit note against the invoice, never an edit here.
  INVOICED: [],
};

export interface QuoteTransitionContext {
  readonly lineCount?: number;
  readonly reason?: string;
  /**
   * Set only by the conversion path. Marking a quote INVOICED by hand would
   * claim an invoice exists when none does — the same trap `COLLECTED` closes
   * on a repair job.
   */
  readonly viaConversion?: boolean;
}

export type QuoteViolation =
  | { readonly code: 'ILLEGAL_TRANSITION'; readonly from: QuoteStatus; readonly to: QuoteStatus; readonly allowed: readonly QuoteStatus[] }
  | { readonly code: 'QUOTE_NEEDS_LINES' }
  | { readonly code: 'REASON_REQUIRED' }
  | { readonly code: 'INVOICED_IS_NOT_A_STATUS_CHANGE' };

export function checkQuoteTransition(
  from: QuoteStatus,
  to: QuoteStatus,
  context: QuoteTransitionContext = {},
): Result<true, QuoteViolation> {
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) return err({ code: 'ILLEGAL_TRANSITION', from, to, allowed });

  // An empty quote sent to a customer is a blank page with a number on it.
  if (to === 'SENT' && (context.lineCount ?? 0) === 0) return err({ code: 'QUOTE_NEEDS_LINES' });

  // "Why did we lose it" is the single most useful thing a quote records. A
  // shop that knows it loses on price behaves differently from one that loses
  // on lead time, and neither learns anything from an unexplained no.
  if (to === 'DECLINED' && !context.reason?.trim()) return err({ code: 'REASON_REQUIRED' });

  if (to === 'INVOICED' && context.viaConversion !== true) {
    return err({ code: 'INVOICED_IS_NOT_A_STATUS_CHANGE' });
  }

  return ok(true);
}

export function describeQuoteViolation(v: QuoteViolation): string {
  switch (v.code) {
    case 'ILLEGAL_TRANSITION':
      return `A ${v.from} quote cannot become ${v.to}. From here it may only become: ${
        v.allowed.length > 0 ? v.allowed.join(', ') : 'nothing — this quote is finished'
      }.`;
    case 'QUOTE_NEEDS_LINES':
      return 'A quote with no lines has nothing to offer. Add at least one line before sending it.';
    case 'REASON_REQUIRED':
      return 'Record why the customer said no — it is the only way the shop learns what it is losing on.';
    case 'INVOICED_IS_NOT_A_STATUS_CHANGE':
      return 'A quote becomes INVOICED by being converted, which creates the invoice. Marking it directly would claim an invoice that does not exist.';
  }
}

/**
 * Has an unanswered quote lapsed?
 *
 * Pure, and separate from the state machine, because expiry is a fact about
 * dates rather than an action anyone took — the nightly job asks this question
 * of every open quote, and a screen asks it to decide whether to show a
 * "expired" badge before anybody has run that job.
 */
export function quoteHasLapsed(validUntil: string | null, today: string): boolean {
  if (validUntil === null) return false;
  return validUntil < today;
}
