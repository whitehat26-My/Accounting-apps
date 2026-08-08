import { describe, expect, it } from 'vitest';
import { Money } from '../src/money.js';
import {
  classifyChange,
  diffBalances,
  type BalanceAtInstant,
} from '../src/time-machine.js';

const rm = (amount: string) => Money.fromDecimal(amount, 'MYR');

const at = (accountId: string, code: string, balance: string): BalanceAtInstant => ({
  accountId,
  code,
  name: `Account ${code}`,
  balance: rm(balance),
});

describe('diffBalances', () => {
  it('returns nothing at all when nothing moved', () => {
    const books = [at('a', '1000', '5000.00'), at('b', '4000', '-5000.00')];
    // Not "a list of zeroes" — a list somebody has to read before discovering
    // it says nothing. The empty array IS the answer.
    expect(diffBalances(books, books, 'MYR')).toEqual([]);
  });

  it('omits the accounts that did not move, keeps the ones that did', () => {
    const before = [at('a', '1000', '5000.00'), at('b', '4000', '-5000.00')];
    const after = [at('a', '1000', '7500.00'), at('b', '4000', '-7500.00')];

    const changes = diffBalances(before, after, 'MYR');
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.code).sort()).toEqual(['1000', '4000']);
  });

  it('treats a missing side as a genuine zero', () => {
    // 6200 did not exist at the earlier instant — it was created, or first
    // used, afterwards. Its "before" is zero, not absent-and-therefore-skipped.
    const changes = diffBalances([], [at('c', '6200', '1200.00')], 'MYR');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.before.toDecimalString()).toBe('0.0000');
    expect(changes[0]!.after.toDecimalString()).toBe('1200.0000');
    expect(changes[0]!.delta.toDecimalString()).toBe('1200.0000');
  });

  it('carries the identity of an account that vanished from the later side', () => {
    const changes = diffBalances([at('d', '1300', '900.00')], [], 'MYR');
    expect(changes[0]!.code).toBe('1300');
    expect(changes[0]!.name).toBe('Account 1300');
    expect(changes[0]!.delta.toDecimalString()).toBe('-900.0000');
  });

  it('sorts by the SIZE of the movement, not its direction', () => {
    const before = [at('a', '1000', '0'), at('b', '4000', '0'), at('c', '6000', '0')];
    const after = [
      at('a', '1000', '100.00'), // +100
      at('b', '4000', '-40000.00'), // −40,000: the biggest surprise
      at('c', '6000', '5000.00'), // +5,000
    ];

    // A RM 40,000 credit is exactly as surprising as a RM 40,000 debit, so the
    // ordering is by absolute value. Direction has no say in it.
    expect(diffBalances(before, after, 'MYR').map((c) => c.code)).toEqual([
      '4000',
      '6000',
      '1000',
    ]);
  });

  it('breaks a tie on account code so neither equal movement is buried', () => {
    const before = [at('a', '4000', '0'), at('b', '1000', '0')];
    const after = [at('a', '4000', '-9040.00'), at('b', '1000', '9040.00')];
    expect(diffBalances(before, after, 'MYR').map((c) => c.code)).toEqual(['1000', '4000']);
  });
});

describe('classifyChange', () => {
  const examined = { from: '2026-03-01', to: '2026-03-31' };

  it('calls a reversal a reversal, whatever it is dated', () => {
    expect(
      classifyChange({ entryDate: '2026-03-15', reversalOfId: 'x' }, examined),
    ).toBe('REVERSAL');
    expect(
      classifyChange({ entryDate: '2026-09-15', reversalOfId: 'x' }, examined),
    ).toBe('REVERSAL');
  });

  it('flags an entry DATED inside the window as backdated', () => {
    // The one worth a person's attention: March's reported profit changed
    // after somebody had already relied on it.
    expect(
      classifyChange({ entryDate: '2026-03-28', reversalOfId: null }, examined),
    ).toBe('BACKDATED');
  });

  it('includes the window boundaries, which is where the drawer invoices land', () => {
    expect(classifyChange({ entryDate: '2026-03-01', reversalOfId: null }, examined)).toBe(
      'BACKDATED',
    );
    expect(classifyChange({ entryDate: '2026-03-31', reversalOfId: null }, examined)).toBe(
      'BACKDATED',
    );
  });

  it('calls ordinary later trading LATER', () => {
    expect(
      classifyChange({ entryDate: '2026-04-02', reversalOfId: null }, examined),
    ).toBe('LATER');
  });

  it('claims nothing is backdated when no window was examined', () => {
    // Without a period under examination there is no "already reported" figure
    // to have moved, so BACKDATED would be an assertion the caller never made.
    expect(classifyChange({ entryDate: '2026-03-28', reversalOfId: null }, {})).toBe('LATER');
    expect(
      classifyChange({ entryDate: '2026-03-28', reversalOfId: null }, { from: '2026-03-01' }),
    ).toBe('LATER');
  });
});
