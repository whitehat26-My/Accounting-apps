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
