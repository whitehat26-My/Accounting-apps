import { describe, expect, it } from 'vitest';
import {
  benford,
  duplicatePayments,
  leadingDigit,
  oddTimings,
  roundNumberShare,
  thresholdHugging,
} from '../src/fraud-watch.js';

/**
 * The tests that matter most here are the ones asserting SILENCE.
 *
 * A fraud watch that fires on ordinary bookkeeping gets switched off within a
 * week, and is then absent for every case that mattered. So each detector is
 * tested twice: once that it notices the thing, and once that it stays quiet
 * on a small, honest, unremarkable shop.
 */

describe('leading digits', () => {
  it('skips zeros and the decimal point', () => {
    expect(leadingDigit('1234.00')).toBe(1);
    expect(leadingDigit('0.85')).toBe(8);
    expect(leadingDigit('-450.00')).toBe(4);
    expect(leadingDigit('0.00')).toBeNull();
  });
});

describe("Benford's Law", () => {
  /** log10(1+1/d) shares, scaled — a naturally distributed population. */
  const natural = (): string[] => {
    const shares = [301, 176, 125, 97, 79, 67, 58, 51, 46];
    const out: string[] = [];
    shares.forEach((count, index) => {
      for (let i = 0; i < count; i++) out.push(`${index + 1}${i % 90}.${i % 100}0`);
    });
    return out;
  };

  it('says nothing about a naturally distributed population', () => {
    const result = benford(natural());
    expect(result.conclusive).toBe(true);
    expect(result.finding).toBeNull();
  });

  it('refuses to conclude anything from a small sample', () => {
    // Forty invented amounts, all starting with 5 — blatant, and still not
    // enough data to say so. Reporting on 40 rows would be noise.
    const result = benford(Array.from({ length: 40 }, (_, i) => `5${i}0.00`));
    expect(result.conclusive).toBe(false);
    expect(result.finding).toBeNull();
  });

  it('flags a large population that does not fit — as a NOTE, not an accusation', () => {
    const invented = Array.from({ length: 400 }, (_, i) => `${(i % 4) + 5}00.00`);
    const result = benford(invented);
    expect(result.conclusive).toBe(true);
    expect(result.finding?.code).toBe('BENFORD');
    expect(result.finding?.severity).toBe('NOTE');
    // The innocent reading is carried with the finding, always.
    expect(result.finding?.innocentExplanation).toContain('usually innocent');
  });
});

describe('round numbers', () => {
  it('stays quiet on ordinary retail amounts with sen', () => {
    const amounts = Array.from({ length: 30 }, (_, i) => `${89 + i}.${(i * 7) % 100}0`);
    expect(roundNumberShare(amounts).finding).toBeNull();
  });

  it('notices when almost everything is a multiple of RM 100', () => {
    const amounts = Array.from({ length: 30 }, (_, i) => `${(i % 5) * 100 + 100}.00`);
    const result = roundNumberShare(amounts);
    expect(result.share).toBeGreaterThan(0.6);
    expect(result.finding?.code).toBe('ROUND_NUMBERS');
  });
});

describe('duplicate payments', () => {
  const payment = (party: string, amount: string, document: string, date: string) => ({
    party,
    amount,
    document,
    date,
  });

  it('finds the same amount paid to the same supplier twice in the window', () => {
    const result = duplicatePayments([
      payment('Sandisk Distributor', '4500.00', 'BILL-1', '2026-08-01'),
      payment('Sandisk Distributor', '4500.00', 'BILL-2', '2026-08-20'),
      payment('TNB', '380.40', 'BILL-3', '2026-08-05'),
    ]);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]!.daysApart).toBe(19);
    expect(result.finding?.severity).toBe('CHECK');
    // The most valuable sentence in the whole module.
    expect(result.finding?.innocentExplanation).toContain('recoverable');
  });

  it('leaves a monthly rent alone — same amount, but a month apart is a rhythm', () => {
    const result = duplicatePayments(
      [
        payment('Landlord', '3000.00', 'BILL-1', '2026-06-01'),
        payment('Landlord', '3000.00', 'BILL-2', '2026-07-01'),
        payment('Landlord', '3000.00', 'BILL-3', '2026-08-01'),
      ],
      20, // a tighter window than the default: a monthly rhythm is not a duplicate
    );
    expect(result.duplicates).toHaveLength(0);
    expect(result.finding).toBeNull();
  });
});

describe('threshold hugging', () => {
  it('notices bills clustering just under the approval limit', () => {
    const result = thresholdHugging(
      ['4900.00', '4850.00', '4950.00', '120.00'],
      '5000',
    );
    expect(result.justUnder).toBe(3);
    expect(result.finding?.code).toBe('THRESHOLD_HUGGING');
  });

  it('says nothing when only one or two land there', () => {
    expect(thresholdHugging(['4900.00', '120.00'], '5000').finding).toBeNull();
  });
});

describe('odd timings', () => {
  const entry = (reference: string, postedAtHourKl: number, backdatedDays: number) => ({
    reference,
    entryDate: '2026-08-05',
    postedAtHourKl,
    backdatedDays,
  });

  it('is quiet about a Sunday-evening catch-up', () => {
    expect(oddTimings([entry('JE-1', 20, 3), entry('JE-2', 21, 5)]).finding).toBeNull();
  });

  it('mentions 3am postings and deep backdating together', () => {
    const result = oddTimings([entry('JE-1', 3, 0), entry('JE-2', 14, 60)]);
    expect(result.lateNight).toBe(1);
    expect(result.heavilyBackdated).toBe(1);
    expect(result.finding?.headline).toContain('midnight and 5am');
    expect(result.finding?.headline).toContain('45 days');
  });
});
