/**
 * Perpetual inventory at weighted-average cost.
 *
 * ---------------------------------------------------------------------------
 * WHY WEIGHTED AVERAGE, AND WHY THE ARITHMETIC IS SHAPED THE WAY IT IS.
 *
 * A computer shop buys the same SSD at RM 280 in March and RM 265 in May. When
 * one sells, the cost of the sale has to come from somewhere. FIFO tracks
 * which *layer* each unit came from; weighted average carries one pool value
 * and relieves it proportionally. For a shop where stock turns fast and units
 * of the same item are interchangeable, weighted average is the standard
 * choice, it is what MPERS s13 permits, and it needs no layer bookkeeping that
 * can drift.
 *
 * The one subtlety worth stating: an issue is costed as
 *
 *     cost = pool value × (quantity issued / quantity on hand)
 *
 * — a RATIO of the pool, not `unit WAC × quantity` with the WAC rounded first.
 * Rounding the unit cost and multiplying leaves a residue: sell the last unit
 * and the quantity reaches zero while a few sen of value stay behind, forever,
 * on the balance sheet. The proportional form guarantees that issuing
 * everything relieves exactly everything. `Money.multiplyRatio` does the
 * bigint arithmetic without ever touching a float.
 * ---------------------------------------------------------------------------
 *
 * Pure: state in, state out. The database owns sequencing and concurrency.
 */

import { Money, type Currency } from './money.js';
import { err, ok, type Result } from './result.js';

/** Quantities are held as bigints at four decimal places, like `credit-note.ts`. */
export const STOCK_QUANTITY_SCALE = 4;
const QTY_FACTOR = 10n ** BigInt(STOCK_QUANTITY_SCALE);

/** Parse a decimal quantity string to scaled units. Null when malformed. */
export function quantityToUnits(quantity: string): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(quantity.trim());
  if (!match) return null;
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > STOCK_QUANTITY_SCALE) return null;
  const units = BigInt(`${whole}${fraction.padEnd(STOCK_QUANTITY_SCALE, '0')}`);
  return sign === '-' ? -units : units;
}

export function unitsToQuantity(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / QTY_FACTOR;
  const fraction = (abs % QTY_FACTOR).toString().padStart(STOCK_QUANTITY_SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** The pool: how many are on hand and what they cost, in total. */
export interface StockPool {
  readonly quantityUnits: bigint;
  readonly value: Money;
}

export function emptyPool(currency: Currency): StockPool {
  return { quantityUnits: 0n, value: Money.zero(currency) };
}

/**
 * Unit cost as a display figure. DERIVED, never stored, never used in the
 * issue arithmetic — see the module comment for why.
 */
export function weightedAverageCost(pool: StockPool): Money {
  if (pool.quantityUnits <= 0n) return Money.zero(pool.value.currency);
  return pool.value.multiplyRatio(QTY_FACTOR, pool.quantityUnits);
}

export type StockViolation =
  | { readonly code: 'NON_POSITIVE_QUANTITY'; readonly quantity: string }
  | { readonly code: 'NEGATIVE_COST'; readonly cost: string }
  | {
      /**
       * Selling what the system says you do not have is refused, not booked.
       *
       * Allowing it would make the pool value negative and the next WAC
       * meaningless. When the shelf disagrees with the system, the honest fix
       * is entering the purchase bill that was skipped, or a counted
       * adjustment — both of which say WHY the number moved. An automatic
       * negative just hides that one of those two things happened.
       */
      readonly code: 'INSUFFICIENT_STOCK';
      readonly requested: string;
      readonly onHand: string;
    };

export interface StockMovementResult {
  readonly pool: StockPool;
  /** What this movement did to the pool value. Positive for a receipt. */
  readonly movementValue: Money;
}

/** Receive stock into the pool at what it actually cost (base currency). */
export function receiveStock(
  pool: StockPool,
  quantityUnits: bigint,
  totalCost: Money,
): Result<StockMovementResult, StockViolation> {
  if (quantityUnits <= 0n) {
    return err({ code: 'NON_POSITIVE_QUANTITY', quantity: unitsToQuantity(quantityUnits) });
  }
  if (totalCost.isNegative()) {
    // A negative-cost receipt would be a rebate wearing a delivery's clothes.
    // Free stock (zero cost) is legitimate — a bundled mouse, a warranty
    // replacement — and simply lowers the average.
    return err({ code: 'NEGATIVE_COST', cost: totalCost.toDecimalString() });
  }

  return ok({
    pool: {
      quantityUnits: pool.quantityUnits + quantityUnits,
      value: pool.value.add(totalCost),
    },
    movementValue: totalCost,
  });
}

/** Issue stock out of the pool, costed proportionally. */
export function issueStock(
  pool: StockPool,
  quantityUnits: bigint,
): Result<StockMovementResult, StockViolation> {
  if (quantityUnits <= 0n) {
    return err({ code: 'NON_POSITIVE_QUANTITY', quantity: unitsToQuantity(quantityUnits) });
  }
  if (quantityUnits > pool.quantityUnits) {
    return err({
      code: 'INSUFFICIENT_STOCK',
      requested: unitsToQuantity(quantityUnits),
      onHand: unitsToQuantity(pool.quantityUnits),
    });
  }

  // Proportional relief. Issuing the whole pool relieves exactly the whole
  // value — no residue survives the last unit.
  const cost =
    quantityUnits === pool.quantityUnits
      ? pool.value
      : pool.value.multiplyRatio(quantityUnits, pool.quantityUnits);

  return ok({
    pool: {
      quantityUnits: pool.quantityUnits - quantityUnits,
      value: pool.value.subtract(cost),
    },
    movementValue: cost.negate(),
  });
}

/**
 * A counted adjustment: the shelf says N, the system says M, and the shelf
 * wins. Returns the movement that makes the system agree.
 *
 * Shrinkage DOWN is costed proportionally like a sale (the missing units cost
 * what the average says they cost). A count UP re-enters stock at the current
 * average, because there is no purchase document to take a cost from — if
 * there IS one, the right fix is entering that bill, not counting.
 */
export function countAdjustment(
  pool: StockPool,
  countedUnits: bigint,
): Result<StockMovementResult & { readonly deltaUnits: bigint }, StockViolation> {
  if (countedUnits < 0n) {
    return err({ code: 'NON_POSITIVE_QUANTITY', quantity: unitsToQuantity(countedUnits) });
  }

  const deltaUnits = countedUnits - pool.quantityUnits;

  if (deltaUnits === 0n) {
    return ok({ pool, movementValue: Money.zero(pool.value.currency), deltaUnits });
  }

  if (deltaUnits < 0n) {
    const issued = issueStock(pool, -deltaUnits);
    if (!issued.ok) return issued;
    return ok({ ...issued.value, deltaUnits });
  }

  const unitCost = weightedAverageCost(pool);
  const received = receiveStock(
    pool,
    deltaUnits,
    unitCost.multiplyRatio(deltaUnits, QTY_FACTOR),
  );
  if (!received.ok) return received;
  return ok({ ...received.value, deltaUnits });
}
