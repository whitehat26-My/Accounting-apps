/**
 * Money — exact decimal arithmetic for a financial ledger.
 *
 * Representation: a `bigint` count of minor units at a FIXED scale of 4
 * decimal places, matching `NUMERIC(19,4)` in PostgreSQL exactly. Four places
 * (not two) because unit prices, tax rates and FX conversions need more
 * precision than the two decimals a statement displays.
 *
 * There is no code path in this file that produces or consumes a JavaScript
 * `number` for a monetary value. That is deliberate and non-negotiable:
 * `0.1 + 0.2 !== 0.3` is not an acceptable property for a general ledger.
 */

/** Decimal places held internally. Mirrors NUMERIC(19,4). */
export const MONEY_SCALE = 4;

const SCALE_FACTOR = 10n ** BigInt(MONEY_SCALE);

/** ISO 4217 code. MYR is the base currency for this product. */
export type Currency = string;

/**
 * Display exponents (minor units actually used in circulation).
 * MYR is quoted to 2 dp even though we store 4.
 */
const DISPLAY_EXPONENT: Readonly<Record<string, number>> = {
  MYR: 2,
  USD: 2,
  SGD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  IDR: 2,
  THB: 2,
};

export type RoundingMode =
  /** Round half away from zero. The default convention for Malaysian tax. */
  | 'HALF_UP'
  /** Banker's rounding — half to even. Reduces cumulative bias. */
  | 'HALF_EVEN'
  /** Truncate toward zero. */
  | 'DOWN';

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export class CurrencyMismatchError extends Error {
  constructor(left: Currency, right: Currency) {
    super(
      `Cannot combine ${left} and ${right}. Convert to a common currency first ` +
        `— cross-currency arithmetic is never implicit.`,
    );
    this.name = 'CurrencyMismatchError';
  }
}

export class Money {
  /** Signed count of 10^-4 units. */
  readonly units: bigint;
  readonly currency: Currency;

  private constructor(units: bigint, currency: Currency) {
    this.units = units;
    this.currency = currency;
    Object.freeze(this);
  }

  // ---------------------------------------------------------------- factories

  static zero(currency: Currency): Money {
    return new Money(0n, currency);
  }

  /** Construct from a raw minor-unit count at MONEY_SCALE. */
  static fromUnits(units: bigint, currency: Currency): Money {
    return new Money(units, currency);
  }

  /**
   * Construct from a decimal string, e.g. "1234.56".
   *
   * Strings only — never a `number`. Accepting a float here would silently
   * admit representation error at the system's outermost boundary, which is
   * precisely where it is hardest to detect later.
   *
   * More than MONEY_SCALE decimal places is rejected rather than rounded: the
   * caller must make the rounding decision explicitly.
   */
  static fromDecimal(value: string, currency: Currency): Money {
    const trimmed = value.trim();
    if (!DECIMAL_PATTERN.test(trimmed)) {
      throw new TypeError(`Not a valid decimal string: "${value}"`);
    }

    const negative = trimmed.startsWith('-');
    const unsigned = negative ? trimmed.slice(1) : trimmed;
    const [whole = '0', fraction = ''] = unsigned.split('.');

    if (fraction.length > MONEY_SCALE) {
      throw new RangeError(
        `"${value}" has ${fraction.length} decimal places; Money holds at most ` +
          `${MONEY_SCALE}. Round explicitly before constructing.`,
      );
    }

    const padded = fraction.padEnd(MONEY_SCALE, '0');
    const units = BigInt(whole) * SCALE_FACTOR + BigInt(padded || '0');
    return new Money(negative ? -units : units, currency);
  }

  // -------------------------------------------------------------- arithmetic

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.units + other.units, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.units - other.units, this.currency);
  }

  negate(): Money {
    return new Money(-this.units, this.currency);
  }

  abs(): Money {
    return this.units < 0n ? this.negate() : this;
  }

  /** Multiply by an exact integer. No rounding required, so none is offered. */
  multiplyInt(factor: bigint): Money {
    return new Money(this.units * factor, this.currency);
  }

  /**
   * Multiply by the rational `numerator / denominator` with explicit rounding.
   *
   * This is the primitive behind tax and discount calculation. A percentage is
   * passed as a rational (8% -> 8n/100n) rather than as a float, so the only
   * place precision is lost is the rounding step the caller chose.
   */
  multiplyRatio(
    numerator: bigint,
    denominator: bigint,
    rounding: RoundingMode = 'HALF_UP',
  ): Money {
    if (denominator === 0n) throw new RangeError('Division by zero');
    return new Money(
      divideRounded(this.units * numerator, denominator, rounding),
      this.currency,
    );
  }

  /**
   * Split into `ratios.length` parts that sum EXACTLY back to this amount.
   *
   * Uses the largest-remainder method: distribute the floor share, then hand
   * the leftover minor units out one at a time to the parts with the largest
   * truncated remainder. Ties break toward the earlier index, so the result is
   * deterministic and reproducible in a report.
   *
   * This is how a document-level discount or tax is prorated across lines
   * without the parts failing to reconcile to the whole by a sen.
   */
  allocate(ratios: readonly bigint[]): Money[] {
    if (ratios.length === 0) throw new RangeError('allocate() needs at least one ratio');
    if (ratios.some((r) => r < 0n)) throw new RangeError('Ratios must be non-negative');

    const total = ratios.reduce((a, b) => a + b, 0n);
    if (total === 0n) throw new RangeError('Ratios must not sum to zero');

    const shares: bigint[] = [];
    const remainders: { index: number; remainder: bigint }[] = [];
    let distributed = 0n;

    for (let i = 0; i < ratios.length; i++) {
      const numerator = this.units * ratios[i]!;
      // Floor toward negative infinity so the leftover always has the same
      // sign as the total and the top-up loop below terminates correctly.
      const share = floorDiv(numerator, total);
      shares.push(share);
      remainders.push({ index: i, remainder: numerator - share * total });
      distributed += share;
    }

    let leftover = this.units - distributed;
    remainders.sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1,
    );

    for (let i = 0; leftover > 0n; i++, leftover--) {
      const target = remainders[i % remainders.length]!;
      shares[target.index] = shares[target.index]! + 1n;
    }

    return shares.map((s) => new Money(s, this.currency));
  }

  // -------------------------------------------------------------- comparison

  equals(other: Money): boolean {
    return this.currency === other.currency && this.units === other.units;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.units < other.units ? -1 : this.units > other.units ? 1 : 0;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  isPositive(): boolean {
    return this.units > 0n;
  }

  // ------------------------------------------------------------ presentation

  /** Exact decimal string at MONEY_SCALE — the form written to NUMERIC(19,4). */
  toDecimalString(): string {
    const negative = this.units < 0n;
    const abs = negative ? -this.units : this.units;
    const whole = abs / SCALE_FACTOR;
    const fraction = (abs % SCALE_FACTOR).toString().padStart(MONEY_SCALE, '0');
    return `${negative ? '-' : ''}${whole}.${fraction}`;
  }

  /**
   * Round to the currency's display exponent and format for a Malaysian user:
   * `RM 1,234.56`. Grouping is applied manually rather than via Intl so the
   * output is identical regardless of the host's locale data.
   */
  toDisplayString(options: { symbol?: boolean } = {}): string {
    const exponent = DISPLAY_EXPONENT[this.currency] ?? 2;
    const rounded = this.roundToExponent(exponent);

    const negative = rounded.units < 0n;
    const abs = negative ? -rounded.units : rounded.units;
    const whole = (abs / SCALE_FACTOR).toString();
    const fraction = (abs % SCALE_FACTOR)
      .toString()
      .padStart(MONEY_SCALE, '0')
      .slice(0, exponent);

    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const symbol = options.symbol === false ? '' : this.currency === 'MYR' ? 'RM ' : `${this.currency} `;
    const body = exponent > 0 ? `${grouped}.${fraction}` : grouped;

    return `${negative ? '-' : ''}${symbol}${body}`;
  }

  /** Round to `exponent` decimal places, still held at MONEY_SCALE. */
  roundToExponent(exponent: number, rounding: RoundingMode = 'HALF_UP'): Money {
    if (exponent >= MONEY_SCALE) return this;
    const step = 10n ** BigInt(MONEY_SCALE - exponent);
    return new Money(divideRounded(this.units, step, rounding) * step, this.currency);
  }

  toJSON(): { amount: string; currency: Currency } {
    return { amount: this.toDecimalString(), currency: this.currency };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  // ------------------------------------------------------------------ private

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

/** Sum a list, returning zero in `currency` when the list is empty. */
export function sumMoney(values: readonly Money[], currency: Currency): Money {
  return values.reduce((acc, v) => acc.add(v), Money.zero(currency));
}

// ------------------------------------------------------------------ internals

/** Floor division for bigints (JS `/` truncates toward zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && a < 0n !== b < 0n) ? q - 1n : q;
}

function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const absN = numerator < 0n ? -numerator : numerator;
  const absD = denominator < 0n ? -denominator : denominator;

  const quotient = absN / absD;
  const remainder = absN % absD;

  let result: bigint;
  switch (mode) {
    case 'DOWN':
      result = quotient;
      break;
    case 'HALF_UP':
      result = remainder * 2n >= absD ? quotient + 1n : quotient;
      break;
    case 'HALF_EVEN': {
      const twice = remainder * 2n;
      if (twice > absD) result = quotient + 1n;
      else if (twice < absD) result = quotient;
      else result = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    }
  }

  return negative ? -result : result;
}
