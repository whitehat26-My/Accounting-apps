/**
 * Cash forecast: 30/60/90 days, from what is actually known.
 *
 * ---------------------------------------------------------------------------
 * NO GUESSING — AND ONE DELIBERATE ASYMMETRY.
 *
 * This forecast counts only dated commitments: invoices due in the window come
 * IN, bills due in the window go OUT. It does not model probability of
 * payment, seasonality, or "usually they pay eventually" — a plausible wrong
 * forecast is worse than an explicit gap, the same rule the tax engine lives
 * by.
 *
 * The asymmetry: OVERDUE payables are counted as immediate outflows — money
 * you already owe leaves the moment the supplier insists — but OVERDUE
 * receivables are NOT counted as inflows in any window, because a customer who
 * has already missed the date has told you their timing is unknown. They are
 * reported separately, as upside with unknown timing, which is what they are.
 * A forecast that spends late payers' money is how a business dies solvent on
 * paper.
 * ---------------------------------------------------------------------------
 *
 * Pure: dated amounts in, horizon table out. Everything in BASE currency.
 */

import { Money, sumMoney, type Currency } from './money.js';

export interface DatedAmount {
  /** ISO due date. */
  readonly dueDate: string;
  /** Base-currency amount, positive. */
  readonly amount: Money;
}

export interface CashHorizon {
  readonly days: number;
  /** Window end, ISO. */
  readonly until: string;
  /** Cumulative from today to the window end. */
  readonly inflows: Money;
  readonly outflows: Money;
  readonly net: Money;
  /** Opening cash plus cumulative net. The number the owner reads. */
  readonly closing: Money;
}

export interface CashForecast {
  readonly asOf: string;
  readonly openingCash: Money;
  readonly horizons: readonly CashHorizon[];
  /** Late money, counted nowhere above — timing unknown by demonstration. */
  readonly overdueReceivables: { readonly total: Money; readonly count: number };
  /** Already counted in every window's outflows; surfaced so it is not missed. */
  readonly overduePayables: { readonly total: Money; readonly count: number };
}

export const FORECAST_HORIZONS = [30, 60, 90] as const;

export function forecastCash(input: {
  readonly asOf: string;
  readonly openingCash: Money;
  readonly receivables: readonly DatedAmount[];
  readonly payables: readonly DatedAmount[];
  readonly currency: Currency;
}): CashForecast {
  const { asOf, currency } = input;

  const overdueAr = input.receivables.filter((r) => r.dueDate < asOf);
  const futureAr = input.receivables.filter((r) => r.dueDate >= asOf);
  const overdueAp = input.payables.filter((p) => p.dueDate < asOf);
  const futureAp = input.payables.filter((p) => p.dueDate >= asOf);

  const overduePayableTotal = sumMoney(overdueAp.map((p) => p.amount), currency);

  const horizons: CashHorizon[] = FORECAST_HORIZONS.map((days) => {
    const until = addDays(asOf, days);

    const inflows = sumMoney(
      futureAr.filter((r) => r.dueDate <= until).map((r) => r.amount),
      currency,
    );
    // Overdue payables land in EVERY window: the debt exists now.
    const outflows = sumMoney(
      futureAp.filter((p) => p.dueDate <= until).map((p) => p.amount),
      currency,
    ).add(overduePayableTotal);

    const net = inflows.subtract(outflows);
    return {
      days,
      until,
      inflows,
      outflows,
      net,
      closing: input.openingCash.add(net),
    };
  });

  return {
    asOf,
    openingCash: input.openingCash,
    horizons,
    overdueReceivables: {
      total: sumMoney(overdueAr.map((r) => r.amount), currency),
      count: overdueAr.length,
    },
    overduePayables: { total: overduePayableTotal, count: overdueAp.length },
  };
}

/** Calendar arithmetic in UTC — accounting dates carry no timezone (rule 8). */
function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
