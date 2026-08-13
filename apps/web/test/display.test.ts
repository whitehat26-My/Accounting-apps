import { describe, expect, it } from 'vitest';
import { qty, quantityDelta, rm } from '../src/lib/display.js';

/**
 * `src/lib/display.ts` is where every figure on screen gets its final shape,
 * and the two bugs below were both of the same kind: a helper that is correct
 * for the strings the SERVER sends, used on a value that came from somewhere
 * else.
 */

describe('qty', () => {
  it('trims a server quantity to something a person reads', () => {
    expect(qty('3.0000')).toBe('3');
    expect(qty('1.5000')).toBe('1.5');
    expect(qty('1.0500')).toBe('1.05');
    expect(qty('0.5000')).toBe('0.5');
  });

  it('leaves an integer alone, because "10" is not "1"', () => {
    /*
     * `decimal.replace(/\.?0+$/, '')` is right for a 4dp string — there is
     * always a point to anchor the trim. The POS cart passes
     * `String(line.quantity)`, a JavaScript integer with no point, and the
     * regex ate the zeros that carry the value: ten items scanned displayed as
     * `1 × RM 12.00` beside a total for ten. The sale posted correctly; only
     * the line the cashier reads was wrong.
     */
    expect(qty('10')).toBe('10');
    expect(qty('20')).toBe('20');
    expect(qty('100')).toBe('100');
    expect(qty('110')).toBe('110');
    expect(qty('5')).toBe('5');
  });
});

describe('quantityDelta', () => {
  it('is exact where a float is not', () => {
    /*
     * The stock count screen computed `Number(a) - Number(b)` and interpolated
     * it raw, so the variance sentence — the one meant to make somebody stop
     * and check before posting an adjustment — printed
     * "+0.10000000000000009 found".
     */
    expect(quantityDelta('1.1', '1.0000')).toBe('0.1');
    expect(quantityDelta('3.3', '3.0000')).toBe('0.3');
    expect(quantityDelta('4.35', '1.0000')).toBe('3.35');
  });

  it('signs the shortfall and names an exact match', () => {
    expect(quantityDelta('7', '10.0000')).toBe('-3');
    expect(quantityDelta('10.0000', '10.0000')).toBe('0');
    expect(quantityDelta('0', '2.5000')).toBe('-2.5');
  });

  it('keeps four decimal places, which is what the column holds', () => {
    expect(quantityDelta('1.0001', '1.0000')).toBe('0.0001');
    expect(quantityDelta('0.9999', '1.0000')).toBe('-0.0001');
  });

  it('does not lose precision on quantities a float would round', () => {
    expect(quantityDelta('9007199254740993.0000', '9007199254740992.0000')).toBe('1');
  });
});

describe('rm', () => {
  it('still formats money the way the rest of the app expects', () => {
    expect(rm('1234.5000')).toBe('RM 1,234.50');
    expect(rm('-1500.0000')).toBe('-RM 1,500.00');
  });
});
