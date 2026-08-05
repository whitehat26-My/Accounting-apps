import { describe, expect, it } from 'vitest';
import { dedupeHash, Money, normaliseFeedTransactions } from '../src/index.js';

/**
 * The property that matters: A FEED AND AN IMPORT OF THE SAME EVENT COLLIDE.
 * Everything else here is arithmetic hygiene around it.
 */
describe('normalising feed transactions', () => {
  it('produces the SAME dedupe hash a CSV import would', () => {
    const { rows } = normaliseFeedTransactions(
      [{ date: '2026-08-05', description: 'DuitNow QR  settlement', amount: '1250.00' }],
      'MYR',
    );

    // The hash the statement-import path computes for the same real event —
    // same date, same amount, same narrative modulo whitespace and case.
    const importHash = dedupeHash({
      txnDate: '2026-08-05',
      description: 'DUITNOW QR SETTLEMENT',
      amount: Money.fromDecimal('1250.00', 'MYR'),
    });

    expect(rows[0]!.dedupeHash).toBe(importHash);
  });

  it('keeps the provider reference as a reference, never in the hash', () => {
    const twice = normaliseFeedTransactions(
      [
        { date: '2026-08-05', description: 'QR SETTLEMENT', amount: '100.00', reference: 'A-1' },
        { date: '2026-08-05', description: 'QR SETTLEMENT', amount: '100.00', reference: 'A-2' },
      ],
      'MYR',
    );
    // Different provider ids, identical facts: SAME hash, occurrences 1 and 2 —
    // exactly how the CSV path treats two identical ATM withdrawals.
    expect(twice.rows[0]!.dedupeHash).toBe(twice.rows[1]!.dedupeHash);
    expect(twice.rows.map((r) => r.occurrence)).toEqual([1, 2]);
    expect(twice.rows.map((r) => r.reference)).toEqual(['A-1', 'A-2']);
  });

  it('refuses the malformed row and keeps the rest', () => {
    const { rows, violations } = normaliseFeedTransactions(
      [
        { date: '2026-08-05', description: 'GOOD', amount: '10.00' },
        { date: '05/08/2026', description: 'BAD DATE', amount: '10.00' },
        { date: '2026-08-05', description: 'BAD AMOUNT', amount: 'sepuluh' },
        { date: '2026-08-05', description: 'ZERO', amount: '0.00' },
        { date: '2026-08-05', description: '   ', amount: '10.00' },
      ],
      'MYR',
    );
    expect(rows).toHaveLength(1);
    expect(violations.map((v) => v.code)).toEqual([
      'BAD_DATE',
      'BAD_AMOUNT',
      'ZERO_AMOUNT',
      'EMPTY_DESCRIPTION',
    ]);
  });

  it('keeps money out negative and money in positive, as Money not number', () => {
    const { rows } = normaliseFeedTransactions(
      [
        { date: '2026-08-05', description: 'IN', amount: '1250.55' },
        { date: '2026-08-05', description: 'OUT', amount: '-420.00' },
      ],
      'MYR',
    );
    expect(rows[0]!.amount.toDecimalString()).toBe('1250.5500');
    expect(rows[1]!.amount.isNegative()).toBe(true);
  });
});
