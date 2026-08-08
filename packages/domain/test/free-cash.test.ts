import { describe, expect, it } from 'vitest';
import { Money, freeCashPosition, type HeldForOthers } from '../src/index.js';

const rm = (amount: string) => Money.fromDecimal(amount, 'MYR');

const holding = (key: string, amount: string, dueDate: string | null = null): HeldForOthers => ({
  key,
  label: key,
  owedTo: 'someone else',
  amount: rm(amount),
  dueDate,
});

describe('the free cash verdict', () => {
  it('COMFORTABLE when what is left over covers the holdings again', () => {
    const position = freeCashPosition({
      bankBalance: rm('18400.00'),
      held: [holding('EPF', '2000.00'), holding('PCB', '890.00')],
      currency: 'MYR',
    });
    expect(position.totalHeld.toDecimalString()).toBe('2890.0000');
    expect(position.freeCash.toDecimalString()).toBe('15510.0000');
    expect(position.verdict).toBe('COMFORTABLE');
  });

  it('TIGHT when it can all be paid but most of the bank is not yours', () => {
    const position = freeCashPosition({
      bankBalance: rm('5000.00'),
      held: [holding('EPF', '3000.00')],
      currency: 'MYR',
    });
    // 2,000 free against 3,000 held: payable, but the float is doing the work.
    expect(position.verdict).toBe('TIGHT');
  });

  it('SHORT when the money held for others exceeds the bank — already spent', () => {
    const position = freeCashPosition({
      bankBalance: rm('1200.00'),
      held: [holding('EPF', '2000.00'), holding('PCB', '500.00')],
      currency: 'MYR',
    });
    expect(position.freeCash.toDecimalString()).toBe('-1300.0000');
    expect(position.verdict).toBe('SHORT');
  });

  it('is COMFORTABLE, not SHORT, when nothing is being held', () => {
    const position = freeCashPosition({
      bankBalance: rm('500.00'),
      held: [],
      currency: 'MYR',
    });
    expect(position.verdict).toBe('COMFORTABLE');
    expect(position.soonest).toBeNull();
  });
});

describe('presentation decisions', () => {
  it('drops zero holdings — a line reading RM 0.00 is noise', () => {
    const position = freeCashPosition({
      bankBalance: rm('1000.00'),
      held: [holding('EPF', '100.00'), holding('WHT', '0.00')],
      currency: 'MYR',
    });
    expect(position.held.map((h) => h.key)).toEqual(['EPF']);
  });

  it('the soonest obligation is the earliest DATED one, not merely the first', () => {
    const position = freeCashPosition({
      bankBalance: rm('9000.00'),
      held: [
        holding('NET_WAGES', '3000.00', null), // undated, listed first
        holding('SST', '1400.00', '2026-09-30'),
        holding('EPF', '900.00', '2026-09-15'),
      ],
      currency: 'MYR',
    });
    expect(position.soonest?.key).toBe('EPF');
  });

  it('falls back to an undated holding when nothing carries a date', () => {
    const position = freeCashPosition({
      bankBalance: rm('9000.00'),
      held: [holding('NET_WAGES', '3000.00', null)],
      currency: 'MYR',
    });
    expect(position.soonest?.key).toBe('NET_WAGES');
  });
});
