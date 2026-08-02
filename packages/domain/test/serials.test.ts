import { describe, expect, it } from 'vitest';
import { normaliseSerial, quantityToUnits, validateSerialSet } from '../src/index.js';

const qty = (q: string) => quantityToUnits(q)!;

describe('normaliseSerial', () => {
  it('uppercases, trims and collapses whitespace', () => {
    // "sn-001" typed at goods-in and "SN-001" scanned at the till are the same
    // physical unit; a lookup that misses on case loses a warranty argument.
    expect(normaliseSerial('  sn-001  ')).toBe('SN-001');
    expect(normaliseSerial('abc  123')).toBe('ABC 123');
  });
});

describe('validateSerialSet', () => {
  it('accepts a matching set and returns it normalised', () => {
    const result = validateSerialSet(qty('3'), ['sn-1', 'SN-2', ' sn-3 ']);
    expect(result.violations).toEqual([]);
    expect(result.serials).toEqual(['SN-1', 'SN-2', 'SN-3']);
  });

  it('refuses a fractional quantity — 2.5 laptops do not exist', () => {
    const result = validateSerialSet(qty('2.5'), ['A', 'B']);
    expect(result.violations.some((v) => v.code === 'FRACTIONAL_QUANTITY')).toBe(true);
  });

  it('refuses a count mismatch in either direction', () => {
    expect(
      validateSerialSet(qty('3'), ['A', 'B']).violations.some((v) => v.code === 'COUNT_MISMATCH'),
    ).toBe(true);
    expect(
      validateSerialSet(qty('1'), ['A', 'B']).violations.some((v) => v.code === 'COUNT_MISMATCH'),
    ).toBe(true);
  });

  it('refuses duplicates, INCLUDING duplicates by case or spacing', () => {
    // The same unit scanned twice is a mis-scan; booking it would create two
    // records claiming to be one machine.
    const result = validateSerialSet(qty('2'), ['SN-9', 'sn-9']);
    expect(result.violations).toEqual([{ code: 'DUPLICATE_SERIAL', serial: 'SN-9' }]);
  });

  it('refuses blanks and says which position', () => {
    const result = validateSerialSet(qty('2'), ['SN-1', '   ']);
    expect(result.violations).toEqual([{ code: 'EMPTY_SERIAL', index: 1 }]);
  });

  it('reports every problem at once, not just the first', () => {
    const result = validateSerialSet(qty('4'), ['A', 'a', ' ']);
    const codes = result.violations.map((v) => v.code).sort();
    expect(codes).toEqual(['COUNT_MISMATCH', 'DUPLICATE_SERIAL', 'EMPTY_SERIAL']);
  });
});
