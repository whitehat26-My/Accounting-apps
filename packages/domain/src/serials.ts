/**
 * Serial numbers: which unit went where.
 *
 * ---------------------------------------------------------------------------
 * SERIALS ANSWER IDENTITY. THEY NEVER TOUCH VALUATION.
 *
 * A computer shop's disputes turn on "which unit": the warranty claim, the
 * RMA, the customer insisting the laptop they are holding is the one on the
 * invoice. Serial tracking exists to answer that with a document trail —
 * received on bill X, sold on invoice Y — and it deliberately changes NOTHING
 * about cost. The pool stays weighted-average; two units of one item are
 * financially interchangeable even though they are physically distinct. A
 * per-serial cost layer would be specific identification, a different (and for
 * a shop, worse) valuation method smuggled in through a tracking feature.
 * ---------------------------------------------------------------------------
 *
 * Pure: normalisation and set validation. The database owns uniqueness and
 * the unit lifecycle.
 */

import { STOCK_QUANTITY_SCALE } from './inventory.js';

const QTY_FACTOR = 10n ** BigInt(STOCK_QUANTITY_SCALE);

/**
 * Uppercase, trimmed, internal whitespace collapsed.
 *
 * The same reasoning as `normaliseItemCode`: "sn-001" typed at goods-in and
 * "SN-001" scanned at the till are the same physical unit, and a lookup that
 * misses because of case is a warranty argument the shop loses.
 */
export function normaliseSerial(serial: string): string {
  return serial.trim().replace(/\s+/g, ' ').toUpperCase();
}

export type SerialSetViolation =
  | {
      /**
       * 2.5 laptops do not exist. A serialised item's quantity must be a whole
       * number of units, because each unit is one serial.
       */
      readonly code: 'FRACTIONAL_QUANTITY';
      readonly quantity: string;
    }
  | {
      readonly code: 'COUNT_MISMATCH';
      readonly quantity: string;
      readonly serialCount: number;
    }
  | { readonly code: 'EMPTY_SERIAL'; readonly index: number }
  | { readonly code: 'DUPLICATE_SERIAL'; readonly serial: string };

/**
 * Validate that a set of serials matches a movement's quantity: whole units,
 * one serial each, none blank, none repeated. Returns the NORMALISED serials
 * in input order when valid.
 */
export function validateSerialSet(
  quantityUnits: bigint,
  serials: readonly string[],
): { serials: string[]; violations: SerialSetViolation[] } {
  const violations: SerialSetViolation[] = [];

  if (quantityUnits % QTY_FACTOR !== 0n) {
    violations.push({
      code: 'FRACTIONAL_QUANTITY',
      quantity: quantityString(quantityUnits),
    });
  }

  const wholeUnits = quantityUnits / QTY_FACTOR;
  if (BigInt(serials.length) !== wholeUnits) {
    violations.push({
      code: 'COUNT_MISMATCH',
      quantity: quantityString(quantityUnits),
      serialCount: serials.length,
    });
  }

  const normalised: string[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of serials.entries()) {
    const serial = normaliseSerial(raw);
    if (serial.length === 0) {
      violations.push({ code: 'EMPTY_SERIAL', index });
      continue;
    }
    if (seen.has(serial)) {
      // The same physical unit cannot be received or sold twice in one
      // movement. A duplicate here is a mis-scan, and booking it would create
      // two records claiming to be one machine.
      violations.push({ code: 'DUPLICATE_SERIAL', serial });
      continue;
    }
    seen.add(serial);
    normalised.push(serial);
  }

  return { serials: normalised, violations };
}

function quantityString(units: bigint): string {
  const whole = units / QTY_FACTOR;
  const fraction = (units % QTY_FACTOR).toString().padStart(STOCK_QUANTITY_SCALE, '0');
  return `${whole}.${fraction}`;
}
