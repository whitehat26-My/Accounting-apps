import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  countAdjustment,
  emptyPool,
  isErr,
  isOk,
  issueStock,
  Money,
  quantityToUnits,
  receiveStock,
  unitsToQuantity,
  weightedAverageCost,
  type StockPool,
} from '../src/index.js';

const MYR = 'MYR';

const qty = (q: string) => quantityToUnits(q)!;
const rm = (v: string) => Money.fromDecimal(v, MYR);

function poolOf(quantity: string, value: string): StockPool {
  return { quantityUnits: qty(quantity), value: rm(value) };
}

describe('quantity units', () => {
  it('round-trips decimal strings', () => {
    expect(unitsToQuantity(qty('2.5'))).toBe('2.5000');
    expect(unitsToQuantity(qty('0'))).toBe('0.0000');
    expect(unitsToQuantity(qty('1000'))).toBe('1000.0000');
  });

  it('rejects garbage rather than truncating', () => {
    expect(quantityToUnits('1.23456')).toBeNull(); // more precision than held
    expect(quantityToUnits('two')).toBeNull();
    expect(quantityToUnits('')).toBeNull();
  });
});

describe('receiveStock', () => {
  it('accumulates quantity and value', () => {
    // Five SSDs at RM 280, then five more at RM 265: the pool carries both
    // deliveries and the average settles between the two prices.
    const first = receiveStock(emptyPool(MYR), qty('5'), rm('1400.00'));
    expect(isOk(first)).toBe(true);
    if (!isOk(first)) return;

    const second = receiveStock(first.value.pool, qty('5'), rm('1325.00'));
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;

    expect(unitsToQuantity(second.value.pool.quantityUnits)).toBe('10.0000');
    expect(second.value.pool.value.toDecimalString()).toBe('2725.0000');
    expect(weightedAverageCost(second.value.pool).toDecimalString()).toBe('272.5000');
  });

  it('accepts free stock, which lowers the average', () => {
    // A bundled mouse, a warranty replacement: quantity in, no cost.
    const paid = receiveStock(emptyPool(MYR), qty('2'), rm('100.00'));
    if (!isOk(paid)) throw new Error('unreachable');
    const free = receiveStock(paid.value.pool, qty('2'), rm('0'));
    expect(isOk(free)).toBe(true);
    if (!isOk(free)) return;

    expect(weightedAverageCost(free.value.pool).toDecimalString()).toBe('25.0000');
  });

  it('refuses a negative cost', () => {
    const result = receiveStock(emptyPool(MYR), qty('1'), rm('-5.00'));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('NEGATIVE_COST');
  });
});

describe('issueStock', () => {
  it('costs an issue at the weighted average', () => {
    const result = issueStock(poolOf('10', '2725.00'), qty('3'));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    // 3/10 of RM 2,725.
    expect(result.value.movementValue.toDecimalString()).toBe('-817.5000');
    expect(result.value.pool.value.toDecimalString()).toBe('1907.5000');
  });

  it('relieves EXACTLY the whole pool when the last unit goes', () => {
    /*
     * The reason relief is proportional. RM 100 across 3 units is a unit WAC
     * of 33.3333…; three issues at the rounded unit cost would relieve
     * 99.9999 and leave RM 0.0001 on the balance sheet with nothing on the
     * shelf — forever. The ratio form cannot do that.
     */
    const pool = poolOf('3', '100.00');

    const one = issueStock(pool, qty('1'));
    if (!isOk(one)) throw new Error('unreachable');
    const two = issueStock(one.value.pool, qty('1'));
    if (!isOk(two)) throw new Error('unreachable');
    const three = issueStock(two.value.pool, qty('1'));
    if (!isOk(three)) throw new Error('unreachable');

    expect(unitsToQuantity(three.value.pool.quantityUnits)).toBe('0.0000');
    expect(three.value.pool.value.toDecimalString()).toBe('0.0000');
  });

  it('refuses to issue more than is on hand, and says how much there is', () => {
    const result = issueStock(poolOf('2', '500.00'), qty('3'));
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;

    expect(result.error.code).toBe('INSUFFICIENT_STOCK');
    if (result.error.code !== 'INSUFFICIENT_STOCK') return;
    expect(result.error.onHand).toBe('2.0000');
  });

  it('refuses a zero or negative issue', () => {
    expect(isErr(issueStock(poolOf('5', '100.00'), 0n))).toBe(true);
    expect(isErr(issueStock(poolOf('5', '100.00'), qty('1').valueOf() * -1n))).toBe(true);
  });
});

describe('countAdjustment', () => {
  it('writes down to the counted quantity at the average', () => {
    // System says 10 worth RM 2,725; the shelf says 8. The two missing cost
    // what the average says: 2/10 of the pool.
    const result = countAdjustment(poolOf('10', '2725.00'), qty('8'));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(unitsToQuantity(result.value.deltaUnits)).toBe('-2.0000');
    expect(result.value.movementValue.toDecimalString()).toBe('-545.0000');
    expect(result.value.pool.value.toDecimalString()).toBe('2180.0000');
  });

  it('counts up at the current average when no cost is supplied', () => {
    const result = countAdjustment(poolOf('4', '1000.00'), qty('5'));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.movementValue.toDecimalString()).toBe('250.0000');
    expect(weightedAverageCost(result.value.pool).toDecimalString()).toBe('250.0000');
  });

  it('is a no-op when the count agrees', () => {
    const pool = poolOf('7', '700.00');
    const result = countAdjustment(pool, qty('7'));
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.deltaUnits).toBe(0n);
    expect(result.value.movementValue.isZero()).toBe(true);
  });
});

describe('the pool never lies', () => {
  /**
   * Whatever sequence of receipts and issues occurs, the pool's value is
   * exactly the sum of what went in minus what was relieved, quantity is
   * exactly in minus out, and neither is ever negative. This is the invariant
   * `item_stock`'s CHECK constraints assert at the database — proven here so
   * a violation there means the arithmetic was bypassed, not wrong.
   */
  it('conserves value and quantity across any movement sequence', () => {
    const operation = fc.oneof(
      fc.record({
        kind: fc.constant('receive' as const),
        quantity: fc.integer({ min: 1, max: 500 }),
        // Cost in sen, including zero (free stock).
        cost: fc.integer({ min: 0, max: 5_000_000 }),
      }),
      fc.record({
        kind: fc.constant('issue' as const),
        quantity: fc.integer({ min: 1, max: 500 }),
      }),
    );

    fc.assert(
      fc.property(fc.array(operation, { maxLength: 40 }), (ops) => {
        let pool = emptyPool(MYR);
        let valueIn = Money.zero(MYR);
        let valueOut = Money.zero(MYR);

        for (const op of ops) {
          const units = qty(String(op.kind === 'receive' ? op.quantity : op.quantity));

          if (op.kind === 'receive') {
            const cost = Money.fromUnits(BigInt(op.cost), MYR);
            const result = receiveStock(pool, units, cost);
            if (!isOk(result)) throw new Error('receive cannot fail here');
            pool = result.value.pool;
            valueIn = valueIn.add(cost);
          } else {
            const result = issueStock(pool, units);
            if (isErr(result)) {
              // Only legitimate refusal: more than on hand.
              expect(result.error.code).toBe('INSUFFICIENT_STOCK');
              continue;
            }
            pool = result.value.pool;
            valueOut = valueOut.subtract(result.value.movementValue);
          }

          // The running invariants, checked after EVERY movement.
          expect(pool.quantityUnits >= 0n).toBe(true);
          expect(pool.value.isNegative()).toBe(false);
          expect(pool.value.equals(valueIn.subtract(valueOut))).toBe(true);

          // An empty shelf carries no value; value implies stock.
          if (pool.quantityUnits === 0n) {
            expect(pool.value.isZero()).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
