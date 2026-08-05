import { Money, type Currency } from './money.js';

/**
 * Free cash — how much of the bank balance is actually the shop's.
 *
 * ---------------------------------------------------------------------------
 * THE BANK BALANCE IS THE MOST MISREAD NUMBER IN A SMALL BUSINESS.
 *
 * A shop that has deducted RM 660 of EPF, RM 208 of PCB and RM 74 of SOCSO
 * from its staff, and charged RM 1,400 of SST to its customers, is HOLDING
 * that money. It sits in the same account as the takings and looks exactly
 * like it. On the 15th and at period end it leaves, whether or not the shop
 * spent it on stock in between — and the shop that spent it discovers this
 * at the worst possible moment, with a statutory deadline and a penalty
 * attached.
 *
 * Every other accounting package shows the balance. This subtracts what is
 * not yours and shows the remainder, because the remainder is the number the
 * owner is actually reasoning with when they decide whether to buy stock.
 *
 * NOTHING HERE IS ESTIMATED. Each held amount is the balance of a real
 * liability account in the ledger — the same rows the balance sheet prints.
 * The arithmetic is subtraction; the insight is knowing which accounts to
 * subtract.
 * ---------------------------------------------------------------------------
 */

export type FreeCashVerdict = 'COMFORTABLE' | 'TIGHT' | 'SHORT';

export interface HeldForOthers {
  /** Stable key: 'EPF', 'SOCSO_EIS', 'PCB', 'SST', 'WHT', 'NET_WAGES'. */
  readonly key: string;
  readonly label: string;
  /** Who the money actually belongs to — the sentence that makes it land. */
  readonly owedTo: string;
  readonly amount: Money;
  /** When it must leave, when a statutory rule fixes that. */
  readonly dueDate: string | null;
  /** Any caveat about the figure itself, shown with it rather than hidden. */
  readonly note?: string;
}

export interface FreeCashPosition {
  readonly bankBalance: Money;
  /** Only non-zero holdings; a line reading RM 0.00 is noise. */
  readonly held: readonly HeldForOthers[];
  readonly totalHeld: Money;
  /** Bank minus held. NEGATIVE means it has already been spent. */
  readonly freeCash: Money;
  readonly verdict: FreeCashVerdict;
  /** The next obligation to leave, for the one-line summary. */
  readonly soonest: HeldForOthers | null;
}

/**
 * The verdict, in the order an owner needs to hear it:
 *
 *   SHORT       — the bank holds less than what is owed to others. The money
 *                 has already been spent; the next deadline will overdraw.
 *   TIGHT       — it can all be paid, but most of the bank is not the shop's.
 *                 Spending against this balance is spending the float.
 *   COMFORTABLE — after every holding leaves, at least as much again remains.
 */
export function freeCashPosition(input: {
  readonly bankBalance: Money;
  readonly held: readonly HeldForOthers[];
  readonly currency: Currency;
}): FreeCashPosition {
  const held = input.held.filter((h) => !h.amount.isZero());

  const totalHeld = held.reduce(
    (sum, h) => sum.add(h.amount),
    Money.zero(input.currency),
  );
  const freeCash = input.bankBalance.subtract(totalHeld);

  const verdict: FreeCashVerdict = freeCash.isNegative()
    ? 'SHORT'
    : freeCash.compare(totalHeld) < 0
      ? 'TIGHT'
      : 'COMFORTABLE';

  // Undated holdings (wages owed, withholding) sort last: they are due, but
  // no statute fixes the day, so they cannot be "soonest".
  const dated = held.filter((h) => h.dueDate !== null);
  dated.sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));

  return {
    bankBalance: input.bankBalance,
    held,
    totalHeld,
    freeCash,
    verdict,
    soonest: dated[0] ?? held[0] ?? null,
  };
}
