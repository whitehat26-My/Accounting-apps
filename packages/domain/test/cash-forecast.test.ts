import { describe, expect, it } from 'vitest';
import { forecastCash, Money } from '../src/index.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);
const dated = (dueDate: string, amount: string) => ({ dueDate, amount: rm(amount) });

describe('forecastCash', () => {
  it('buckets dated commitments into cumulative 30/60/90 windows', () => {
    const forecast = forecastCash({
      asOf: '2026-08-01',
      openingCash: rm('10000.00'),
      receivables: [
        dated('2026-08-15', '5000.00'), // in 30
        dated('2026-09-20', '3000.00'), // in 60
        dated('2026-10-25', '2000.00'), // in 90
      ],
      payables: [
        dated('2026-08-10', '4000.00'), // in 30
        dated('2026-10-01', '1000.00'), // in 90
      ],
      currency: MYR,
    });

    const [d30, d60, d90] = forecast.horizons;
    expect(d30!.closing.toDecimalString()).toBe('11000.0000'); // 10k +5k −4k
    expect(d60!.closing.toDecimalString()).toBe('14000.0000'); // +3k more
    expect(d90!.closing.toDecimalString()).toBe('15000.0000'); // +2k −1k
    // Cumulative: each window contains the previous.
    expect(d90!.inflows.toDecimalString()).toBe('10000.0000');
  });

  it('never spends late payers — overdue AR is reported, not forecast', () => {
    const forecast = forecastCash({
      asOf: '2026-08-01',
      openingCash: rm('1000.00'),
      receivables: [dated('2026-07-01', '9999.00')], // a month late
      payables: [],
      currency: MYR,
    });

    // The RM 9,999 appears in NO window: a customer who missed the date has
    // demonstrated their timing is unknown.
    expect(forecast.horizons[0]!.inflows.isZero()).toBe(true);
    expect(forecast.horizons[2]!.closing.toDecimalString()).toBe('1000.0000');
    expect(forecast.overdueReceivables.total.toDecimalString()).toBe('9999.0000');
    expect(forecast.overdueReceivables.count).toBe(1);
  });

  it('counts overdue payables in EVERY window — the debt exists now', () => {
    const forecast = forecastCash({
      asOf: '2026-08-01',
      openingCash: rm('5000.00'),
      receivables: [],
      payables: [dated('2026-07-15', '2000.00')],
      currency: MYR,
    });

    for (const horizon of forecast.horizons) {
      expect(horizon.outflows.toDecimalString()).toBe('2000.0000');
      expect(horizon.closing.toDecimalString()).toBe('3000.0000');
    }
    expect(forecast.overduePayables.count).toBe(1);
  });

  it('can go negative, because that is the warning the owner needs', () => {
    const forecast = forecastCash({
      asOf: '2026-08-01',
      openingCash: rm('1000.00'),
      receivables: [],
      payables: [dated('2026-08-20', '4000.00')],
      currency: MYR,
    });
    expect(forecast.horizons[0]!.closing.toDecimalString()).toBe('-3000.0000');
  });

  it('a due-today invoice counts; the window boundary is inclusive', () => {
    const forecast = forecastCash({
      asOf: '2026-08-01',
      openingCash: rm('0.00'),
      receivables: [dated('2026-08-01', '100.00'), dated('2026-08-31', '200.00')],
      payables: [],
      currency: MYR,
    });
    // 2026-08-31 is exactly asOf+30.
    expect(forecast.horizons[0]!.inflows.toDecimalString()).toBe('300.0000');
  });
});
