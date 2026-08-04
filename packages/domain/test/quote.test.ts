import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  checkQuoteTransition,
  describeQuoteViolation,
  quoteHasLapsed,
  type QuoteStatus,
} from '../src/quote.js';
import { isErr, isOk } from '../src/result.js';

const STATUSES: QuoteStatus[] = [
  'DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'INVOICED',
];

describe('quote transitions', () => {
  it('walks the happy path: draft → sent → accepted → invoiced', () => {
    expect(isOk(checkQuoteTransition('DRAFT', 'SENT', { lineCount: 2 }))).toBe(true);
    expect(isOk(checkQuoteTransition('SENT', 'ACCEPTED'))).toBe(true);
    expect(isOk(checkQuoteTransition('ACCEPTED', 'INVOICED', { viaConversion: true }))).toBe(true);
  });

  it('refuses to send an empty quote', () => {
    // A quote with no lines is a blank page with a number on it.
    const result = checkQuoteTransition('DRAFT', 'SENT', { lineCount: 0 });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('QUOTE_NEEDS_LINES');
  });

  it('demands a reason for a no', () => {
    // "Why did we lose it" is the most useful thing a quote records.
    const bare = checkQuoteTransition('SENT', 'DECLINED');
    expect(isErr(bare)).toBe(true);
    if (isErr(bare)) expect(bare.error.code).toBe('REASON_REQUIRED');

    expect(isOk(checkQuoteTransition('SENT', 'DECLINED', { reason: 'Bought elsewhere' }))).toBe(true);
  });

  it('will not let INVOICED be set by hand', () => {
    // Claiming an invoice exists when none does is the same trap COLLECTED
    // closes on a repair job.
    const byHand = checkQuoteTransition('ACCEPTED', 'INVOICED');
    expect(isErr(byHand)).toBe(true);
    if (isErr(byHand)) expect(byHand.error.code).toBe('INVOICED_IS_NOT_A_STATUS_CHANGE');
  });

  it('lets a lost or lapsed quote be revived rather than retyped', () => {
    expect(isOk(checkQuoteTransition('DECLINED', 'DRAFT'))).toBe(true);
    expect(isOk(checkQuoteTransition('EXPIRED', 'DRAFT'))).toBe(true);
  });

  it('treats INVOICED as terminal (property)', () => {
    // Once billed, the invoice is the document of record. Correcting it is a
    // credit note, never an edit back here.
    fc.assert(
      fc.property(fc.constantFrom(...STATUSES), (to) => {
        expect(isErr(checkQuoteTransition('INVOICED', to, {
          lineCount: 1, reason: 'x', viaConversion: true,
        }))).toBe(true);
      }),
    );
  });

  it('never throws, whatever pair it is handed (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...STATUSES),
        fc.constantFrom(...STATUSES),
        (from, to) => {
          const r = checkQuoteTransition(from, to, { lineCount: 1, reason: 'r', viaConversion: true });
          if (isErr(r)) expect(describeQuoteViolation(r.error).length).toBeGreaterThan(0);
        },
      ),
    );
  });
});

describe('quoteHasLapsed', () => {
  it('is false when the quote has no expiry', () => {
    expect(quoteHasLapsed(null, '2026-08-03')).toBe(false);
  });

  it('lapses the day AFTER the valid-until date, not on it', () => {
    // A quote valid until the 3rd is still good on the 3rd — the customer who
    // walks in that afternoon holds a price the shop offered.
    expect(quoteHasLapsed('2026-08-03', '2026-08-03')).toBe(false);
    expect(quoteHasLapsed('2026-08-03', '2026-08-04')).toBe(true);
  });
});
