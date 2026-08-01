import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CurrencyMismatchError, Money, sumMoney } from '../src/money.js';

const MYR = 'MYR';

/** Arbitrary Money in MYR, bounded to realistic ledger magnitudes. */
const arbMoney = fc
  .bigInt({ min: -1_000_000_000_0000n, max: 1_000_000_000_0000n })
  .map((units) => Money.fromUnits(units, MYR));

const arbPositiveMoney = fc
  .bigInt({ min: 1n, max: 1_000_000_000_0000n })
  .map((units) => Money.fromUnits(units, MYR));

describe('Money — construction and representation', () => {
  it('round-trips a decimal string', () => {
    expect(Money.fromDecimal('1234.56', MYR).toDecimalString()).toBe('1234.5600');
    expect(Money.fromDecimal('0', MYR).toDecimalString()).toBe('0.0000');
    expect(Money.fromDecimal('-0.0001', MYR).toDecimalString()).toBe('-0.0001');
    expect(Money.fromDecimal('999999999.9999', MYR).toDecimalString()).toBe('999999999.9999');
  });

  it('rejects more precision than it can hold rather than silently rounding', () => {
    expect(() => Money.fromDecimal('1.00001', MYR)).toThrow(RangeError);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'abc', '1.2.3', '1,234.56', '1e5', ' ']) {
      expect(() => Money.fromDecimal(bad, MYR)).toThrow();
    }
  });

  it('never loses precision across a decimal round trip (property)', () => {
    fc.assert(
      fc.property(arbMoney, (m) => {
        expect(Money.fromDecimal(m.toDecimalString(), MYR).equals(m)).toBe(true);
      }),
    );
  });
});

describe('Money — arithmetic', () => {
  it('is commutative and associative under addition (property)', () => {
    fc.assert(
      fc.property(arbMoney, arbMoney, arbMoney, (a, b, c) => {
        expect(a.add(b).equals(b.add(a))).toBe(true);
        expect(a.add(b).add(c).equals(a.add(b.add(c)))).toBe(true);
      }),
    );
  });

  it('subtraction inverts addition (property)', () => {
    fc.assert(
      fc.property(arbMoney, arbMoney, (a, b) => {
        expect(a.add(b).subtract(b).equals(a)).toBe(true);
      }),
    );
  });

  it('computes exactly where a float would not', () => {
    // The canonical demonstration: 0.1 + 0.2 !== 0.3 in IEEE 754.
    const sum = Money.fromDecimal('0.10', MYR).add(Money.fromDecimal('0.20', MYR));
    expect(sum.equals(Money.fromDecimal('0.30', MYR))).toBe(true);
    expect(sum.toDecimalString()).toBe('0.3000');

    // 100 sen must add up to exactly one ringgit, one hundred times over.
    let acc = Money.zero(MYR);
    for (let i = 0; i < 100; i++) acc = acc.add(Money.fromDecimal('0.01', MYR));
    expect(acc.toDecimalString()).toBe('1.0000');
  });

  it('refuses cross-currency arithmetic', () => {
    const rm = Money.fromDecimal('100', 'MYR');
    const usd = Money.fromDecimal('100', 'USD');
    expect(() => rm.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => rm.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(rm.equals(usd)).toBe(false);
  });
});

describe('Money — multiplyRatio (the tax primitive)', () => {
  it('computes an 8% service tax on RM 1,000', () => {
    const net = Money.fromDecimal('1000.00', MYR);
    expect(net.multiplyRatio(8n, 100n).toDecimalString()).toBe('80.0000');
  });

  it('applies the requested rounding mode at the boundary', () => {
    const half = Money.fromUnits(5n, MYR); // 0.0005
    expect(half.roundToExponent(3, 'HALF_UP').toDecimalString()).toBe('0.0010');
    expect(half.roundToExponent(3, 'HALF_EVEN').toDecimalString()).toBe('0.0000');
    expect(half.roundToExponent(3, 'DOWN').toDecimalString()).toBe('0.0000');
  });

  it('rounds symmetrically for negative amounts', () => {
    const negative = Money.fromUnits(-5n, MYR);
    expect(negative.roundToExponent(3, 'HALF_UP').toDecimalString()).toBe('-0.0010');
    expect(negative.roundToExponent(3, 'DOWN').toDecimalString()).toBe('0.0000');
  });
});

describe('Money — allocate (proration without losing sen)', () => {
  it('splits RM 100 three ways with no residue', () => {
    const parts = Money.fromDecimal('100.00', MYR).allocate([1n, 1n, 1n]);
    expect(parts.map((p) => p.toDecimalString())).toEqual([
      '33.3334',
      '33.3333',
      '33.3333',
    ]);
    expect(sumMoney(parts, MYR).toDecimalString()).toBe('100.0000');
  });

  it('respects weighting', () => {
    const parts = Money.fromDecimal('100.00', MYR).allocate([70n, 30n]);
    expect(parts.map((p) => p.toDecimalString())).toEqual(['70.0000', '30.0000']);
  });

  it('always sums exactly back to the original (property)', () => {
    fc.assert(
      fc.property(
        arbMoney,
        fc.array(fc.bigInt({ min: 0n, max: 1_000n }), { minLength: 1, maxLength: 20 })
          .filter((rs) => rs.reduce((a, b) => a + b, 0n) > 0n),
        (total, ratios) => {
          const parts = total.allocate(ratios);
          expect(parts).toHaveLength(ratios.length);
          expect(sumMoney(parts, MYR).equals(total)).toBe(true);
        },
      ),
    );
  });

  it('is deterministic', () => {
    const a = Money.fromDecimal('10.00', MYR).allocate([1n, 1n, 1n]);
    const b = Money.fromDecimal('10.00', MYR).allocate([1n, 1n, 1n]);
    expect(a.map(String)).toEqual(b.map(String));
  });

  it('rejects degenerate ratios', () => {
    const m = Money.fromDecimal('10.00', MYR);
    expect(() => m.allocate([])).toThrow(RangeError);
    expect(() => m.allocate([0n, 0n])).toThrow(RangeError);
    expect(() => m.allocate([-1n, 2n])).toThrow(RangeError);
  });
});

describe('Money — Malaysian display formatting', () => {
  it('formats as RM with thousands grouping and two decimals', () => {
    expect(Money.fromDecimal('1234.56', MYR).toDisplayString()).toBe('RM 1,234.56');
    expect(Money.fromDecimal('1000000', MYR).toDisplayString()).toBe('RM 1,000,000.00');
    expect(Money.fromDecimal('0.5', MYR).toDisplayString()).toBe('RM 0.50');
    expect(Money.fromDecimal('-45.9', MYR).toDisplayString()).toBe('-RM 45.90');
    expect(Money.fromDecimal('999', MYR).toDisplayString()).toBe('RM 999.00');
  });

  it('rounds the stored 4dp value to 2dp for display', () => {
    expect(Money.fromDecimal('1.005', MYR).toDisplayString()).toBe('RM 1.01');
    expect(Money.fromDecimal('1.0049', MYR).toDisplayString()).toBe('RM 1.00');
  });

  it('can omit the symbol for use in table columns', () => {
    expect(Money.fromDecimal('1234.56', MYR).toDisplayString({ symbol: false })).toBe('1,234.56');
  });

  it('labels non-MYR currencies with their code', () => {
    expect(Money.fromDecimal('1234.56', 'USD').toDisplayString()).toBe('USD 1,234.56');
  });
});

describe('sumMoney', () => {
  it('returns zero for an empty list', () => {
    expect(sumMoney([], MYR).isZero()).toBe(true);
  });

  it('equals the fold of add (property)', () => {
    fc.assert(
      fc.property(fc.array(arbPositiveMoney, { maxLength: 50 }), (values) => {
        const expected = values.reduce((a, b) => a.add(b), Money.zero(MYR));
        expect(sumMoney(values, MYR).equals(expected)).toBe(true);
      }),
    );
  });
});
