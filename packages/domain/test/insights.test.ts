import { describe, expect, it } from 'vitest';
import { daysIdleSince, idleBucket, marginFigures } from '../src/insights.js';

describe('idle buckets', () => {
  it('classifies at the boundaries, inclusively', () => {
    expect(idleBucket(0)).toBe('FRESH');
    expect(idleBucket(30)).toBe('FRESH');
    expect(idleBucket(31)).toBe('SLOWING');
    expect(idleBucket(90)).toBe('SLOWING');
    expect(idleBucket(91)).toBe('STALE');
    expect(idleBucket(180)).toBe('STALE');
    expect(idleBucket(181)).toBe('DEAD');
  });

  it('never reports negative idleness for a future-dated receipt', () => {
    expect(daysIdleSince('2026-08-10', '2026-08-05')).toBe(0);
    expect(daysIdleSince('2026-08-01', '2026-08-05')).toBe(4);
  });
});

describe('margin figures', () => {
  it('computes margin in basis points with no float anywhere', () => {
    const figures = marginFigures('1899.00', '1550.00', 'MYR');
    expect(figures.margin).toBe('349.0000');
    // 349 / 1899 = 18.3781...% → 1837bp, truncated not rounded — a margin is
    // never overstated by the display.
    expect(figures.marginBp).toBe(1837);
  });

  it('zero revenue is null, not 0% — a giveaway line must not look neutral', () => {
    const figures = marginFigures('0.00', '120.00', 'MYR');
    expect(figures.marginBp).toBeNull();
    expect(figures.margin).toBe('-120.0000');
  });

  it('a below-cost sale carries a negative margin and negative bp', () => {
    const figures = marginFigures('100.00', '150.00', 'MYR');
    expect(figures.margin).toBe('-50.0000');
    expect(figures.marginBp).toBe(-5000);
  });
});
