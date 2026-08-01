/**
 * Foreign exchange — rates, conversion, and realised gain/loss on settlement.
 *
 * The rule that makes multi-currency accounting work:
 *
 *   ACCOUNTS RECEIVABLE IS RELIEVED AT THE RATE IT WAS BOOKED AT.
 *
 * An invoice for USD 1,000 raised when the rate was 4.70 puts RM 4,700 into
 * AR. When the customer pays and the rate is 4.75, the bank receives RM 4,750
 * — but AR must be cleared by exactly RM 4,700, or the control account never
 * returns to zero. The RM 50 difference is a realised exchange gain, and it
 * is the *result* of the two rates, not an input to be plugged.
 *
 * Getting this backwards — relieving AR at the settlement rate — leaves a
 * residue in the control account for every foreign invoice ever settled, and
 * the balance drifts in a way nobody can explain later.
 *
 * Pure: no IO, no rate fetching. Rates are supplied by the caller.
 */

import { Money, type Currency, type RoundingMode } from './money.js';

/** Decimal places held for a rate. Mirrors NUMERIC(19,8). */
export const RATE_SCALE = 8;

const RATE_FACTOR = 10n ** BigInt(RATE_SCALE);

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/**
 * An exchange rate, expressed as "how many units of the base currency one
 * unit of the foreign currency buys". USD/MYR at 4.7050 is `4.7050`.
 *
 * Exact, held as a bigint at scale 8. Never a float — a rate multiplied by a
 * large amount magnifies representation error into real money.
 */
export class Rate {
  readonly units: bigint;

  private constructor(units: bigint) {
    this.units = units;
    Object.freeze(this);
  }

  static one(): Rate {
    return new Rate(RATE_FACTOR);
  }

  static fromUnits(units: bigint): Rate {
    if (units <= 0n) throw new RangeError('An exchange rate must be positive');
    return new Rate(units);
  }

  static fromDecimal(value: string): Rate {
    const trimmed = value.trim();
    if (!DECIMAL_PATTERN.test(trimmed)) {
      throw new TypeError(`Not a valid rate: "${value}"`);
    }

    const [whole = '0', fraction = ''] = trimmed.split('.');
    if (fraction.length > RATE_SCALE) {
      throw new RangeError(
        `"${value}" has ${fraction.length} decimal places; a rate holds at most ${RATE_SCALE}.`,
      );
    }

    const units = BigInt(whole) * RATE_FACTOR + BigInt(fraction.padEnd(RATE_SCALE, '0') || '0');
    if (units <= 0n) throw new RangeError('An exchange rate must be positive');
    return new Rate(units);
  }

  isOne(): boolean {
    return this.units === RATE_FACTOR;
  }

  equals(other: Rate): boolean {
    return this.units === other.units;
  }

  toDecimalString(): string {
    const whole = this.units / RATE_FACTOR;
    const fraction = (this.units % RATE_FACTOR).toString().padStart(RATE_SCALE, '0');
    return `${whole}.${fraction}`;
  }

  toString(): string {
    return this.toDecimalString();
  }
}

/**
 * Convert an amount into the base currency at `rate`.
 *
 * Rounding is explicit and defaults to HALF_UP, matching the tax engine, so a
 * document does not round one way for tax and another for FX.
 */
export function toBase(
  amount: Money,
  rate: Rate,
  baseCurrency: Currency,
  rounding: RoundingMode = 'HALF_UP',
): Money {
  if (amount.currency === baseCurrency) return amount;
  // multiplyRatio carries the tested rounding; only the currency label changes.
  const scaled = amount.multiplyRatio(rate.units, RATE_FACTOR, rounding);
  return Money.fromUnits(scaled.units, baseCurrency);
}

/** A conversion function of the shape the posting builders expect. */
export function converter(
  rate: Rate,
  baseCurrency: Currency,
  rounding: RoundingMode = 'HALF_UP',
): (amount: Money) => Money {
  return (amount) => toBase(amount, rate, baseCurrency, rounding);
}

// ---------------------------------------------------------------------------
// Realised gain / loss
// ---------------------------------------------------------------------------

export interface SettlementLeg {
  /** Amount applied, in the transaction currency. */
  readonly amount: Money;
  /** The rate at which this amount was originally booked into AR or AP. */
  readonly bookedRate: Rate;
}

export interface RealisedFx {
  /** Base-currency value of the money actually received or paid. */
  readonly settlementBase: Money;
  /** Base-currency value at which the receivable/payable was carried. */
  readonly bookedBase: Money;
  /**
   * Positive = gain, negative = loss, from the perspective of a RECEIVABLE.
   * For a payable the sign convention flips at the posting layer, not here.
   */
  readonly difference: Money;
}

/**
 * Work out the realised difference when `legs` are settled at `settlementRate`.
 *
 * Each leg carries its own booked rate because one receipt can settle several
 * invoices raised on different days at different rates. Averaging them would
 * be wrong, and the error would be invisible until someone reconciled AR.
 */
export function realisedFx(
  legs: readonly SettlementLeg[],
  settlementRate: Rate,
  baseCurrency: Currency,
  rounding: RoundingMode = 'HALF_UP',
): RealisedFx {
  let settlementBase = Money.zero(baseCurrency);
  let bookedBase = Money.zero(baseCurrency);

  for (const leg of legs) {
    settlementBase = settlementBase.add(toBase(leg.amount, settlementRate, baseCurrency, rounding));
    bookedBase = bookedBase.add(toBase(leg.amount, leg.bookedRate, baseCurrency, rounding));
  }

  return {
    settlementBase,
    bookedBase,
    difference: settlementBase.subtract(bookedBase),
  };
}

/**
 * Which side an FX difference posts on, for a receivable being settled.
 *
 * Receiving more base currency than the receivable was carried at is a gain,
 * and a gain is a credit. The FX account is a single gain/loss account rather
 * than a pair, so the side carries the meaning.
 */
export function fxPostingSide(difference: Money): 'DEBIT' | 'CREDIT' {
  return difference.isNegative() ? 'DEBIT' : 'CREDIT';
}
