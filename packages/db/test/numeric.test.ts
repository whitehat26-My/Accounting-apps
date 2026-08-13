/**
 * Guards the single most dangerous silent failure in a financial application:
 * a NUMERIC column being parsed into a JavaScript `number` somewhere between
 * PostgreSQL and the domain layer.
 *
 * It would not throw. It would not fail a type check. It would quietly round
 * one transaction in ten million and the trial balance would stop balancing
 * for reasons nobody could reproduce.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@emil/domain';
import type { Sql } from '../src/client.js';
import { createTestDatabase } from './helpers.js';
import { isZeroAmount } from '../src/internal.js';

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDatabase('numeric');
  sql = db.admin;
  drop = db.drop;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('NUMERIC never becomes a JS number', () => {
  it('returns NUMERIC(19,4) as a string', async () => {
    const [row] = await sql<{ value: unknown }[]>`SELECT 1234.5678::numeric(19,4) AS value`;
    expect(typeof row!.value).toBe('string');
    expect(row!.value).toBe('1234.5678');
  });

  it('preserves a value that IEEE 754 cannot represent', async () => {
    // 0.1 + 0.2 in float64 is 0.30000000000000004.
    const [row] = await sql<{ value: string }[]>`
        SELECT (0.1::numeric(19,4) + 0.2::numeric(19,4)) AS value
    `;
    expect(row!.value).toBe('0.3000');
    expect(Money.fromDecimal(row!.value, 'MYR').toDecimalString()).toBe('0.3000');
  });

  it('survives a magnitude that float64 cannot represent', async () => {
    // 19 significant digits — the full width of NUMERIC(19,4). Passing this
    // through a JS number yields 1000000000000000, silently inventing a sen
    // and losing a ringgit.
    const big = '999999999999999.9999';
    const [row] = await sql<{ value: string }[]>`SELECT ${big}::numeric(19,4) AS value`;

    expect(row!.value).toBe(big);
    expect(Money.fromDecimal(row!.value, 'MYR').toDecimalString()).toBe(big);
    // The same value via Number() would lose the last digit.
    expect(String(Number(big))).not.toBe(big);
  });

  it('round-trips Money through the database without drift', async () => {
    const values = ['0.0001', '1080.0000', '123456.7891', '-45.9900'];

    for (const value of values) {
      const money = Money.fromDecimal(value, 'MYR');
      const [row] = await sql<{ value: string }[]>`
          SELECT ${money.toDecimalString()}::numeric(19,4) AS value
      `;
      expect(Money.fromDecimal(row!.value, 'MYR').equals(money)).toBe(true);
    }
  });
});

describe('a zero test on an amount is still Money', () => {
  /*
   * Three call sites asked `Number(row.some_amount) !== 0` — one to decide
   * which side a reversing line takes, two to refuse untracking an item that
   * still has stock. None could be made to give a wrong answer: `!== 0`
   * survives double rounding, because no non-zero decimal inside NUMERIC(19,4)
   * rounds to exactly 0 in IEEE 754.
   *
   * They were replaced anyway. CLAUDE.md rule 2 is absolute, and a rule with
   * three documented exceptions is one the next person reasonably assumes has
   * four — the next `Number()` on an amount will not be a comparison against
   * zero, and whoever waves it through will point at these.
   */
  it('agrees with the float comparison on every value that reaches it', () => {
    const values = [
      '0', '0.0000', '-0.0000', '0.0001', '-0.0001',
      '1.0000', '-1.0000', '0.5000', '999999999999999.9999',
      // The values a float would round: still not zero, and still not claimed to be.
      '0.00005', '0.0000000001',
    ];

    for (const value of values) {
      let expected: boolean;
      try {
        expected = Money.fromDecimal(value, 'MYR').isZero();
      } catch {
        // More than four decimals: Money refuses rather than rounding, which is
        // itself the behaviour rule 2 wants. Nothing from NUMERIC(19,4) can
        // look like this, so the call sites never see it.
        expect(() => isZeroAmount(value)).toThrow();
        continue;
      }
      expect(isZeroAmount(value), value).toBe(expected);
    }
  });

  it('is exact where a float would not be', () => {
    // The largest value NUMERIC(19,4) holds. As a double this loses its last
    // digits entirely; as integer minor units it does not.
    const huge = '999999999999999.9999';
    expect(isZeroAmount(huge)).toBe(false);
    expect(Money.fromDecimal(huge, 'MYR').toDecimalString()).toBe(huge);
  });
});
