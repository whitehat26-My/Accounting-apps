/**
 * "The other line usually goes to…" — the part that is bookkeeping, not history.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TABLE IS ALLOWED TO EXIST, WHEN THE FIRST ANSWER WAS THAT IT SHOULD NOT.
 *
 * The manual-journal form already suggests the other account, mined from what
 * this tenant has actually posted before (`suggestJournalCounterAccount`). That
 * was built deliberately INSTEAD of a table like this one, and the reason is
 * recorded in the settlement register: a hardcoded "rent usually means cash"
 * rule is a guess about somebody else's books, and a brand-new tenant getting
 * no suggestion is the honest answer rather than a confident wrong one.
 *
 * That reasoning still holds, and this table does not overturn it — it sits
 * BEHIND it. History wins wherever history has anything to say. This only fills
 * the silence, and only for entries where the pairing is not a habit but an
 * identity: depreciation is credited to accumulated depreciation because that is
 * what depreciation IS, not because this shop tends to do it that way.
 *
 * WHICH IS ALSO THE LINE THIS FILE MUST NOT CROSS. Every rule below is
 * double-entry bookkeeping, true of any set of books anywhere. None of it is a
 * Malaysian statutory value — no rate, no threshold, no filing rule — because
 * those are effective-dated data per CLAUDE.md rule 7 and would be wrong here in
 * a way that a wrong suggestion never is. If a proposed rule needs a citation to
 * LHDN or RMCD to justify it, it does not belong in this file.
 *
 * PURE, AND IT MATTERS: no IO, no database, no framework. The tenant's chart is
 * resolved by the caller in `packages/db`, which is the only layer that knows
 * whether this tenant even has an account with that code.
 * ---------------------------------------------------------------------------
 */

export type PairingSide = 'DEBIT' | 'CREDIT';

export interface PairingRule {
  /** The account the user picked, and the side they put it on. */
  readonly when: { readonly code: string; readonly side: PairingSide };
  /** The account the other line goes to. Its side is the opposite, necessarily. */
  readonly then: { readonly code: string };
  /**
   * Why this pair, in the words an accountant would use — shown on the form
   * beside the suggestion.
   *
   * Not decoration. A suggestion a person cannot evaluate is one they either
   * accept blindly or ignore entirely, and both are worse than typing it. This
   * sentence is what lets them tell at a glance that the machine understood the
   * entry they were in the middle of.
   */
  readonly because: string;
}

/**
 * The standard adjustments, keyed on the account AND the side.
 *
 * The side is half the key because the same account means different entries on
 * different sides: 1400 debited is money paid in advance, 1400 credited is that
 * prepayment being consumed, and they pair with different accounts.
 *
 * Codes are the ones `DEFAULT_CHART` seeds (packages/db/src/onboarding.ts). A
 * tenant who renamed or renumbered their chart simply gets no rule, which is the
 * same silence as having no history — never a suggestion pointing at an account
 * that means something else here.
 */
export const STANDARD_ADJUSTMENTS: readonly PairingRule[] = [
  {
    when: { code: '6300', side: 'DEBIT' },
    then: { code: '1590' },
    because: 'Depreciation charged for the period accumulates against the asset.',
  },
  {
    when: { code: '1590', side: 'CREDIT' },
    then: { code: '6300' },
    because: 'Accumulated depreciation grows by the depreciation charged this period.',
  },
  {
    when: { code: '6400', side: 'DEBIT' },
    then: { code: '1000' },
    because: 'A bank charge leaves the bank account it was taken from.',
  },
  {
    when: { code: '1400', side: 'DEBIT' },
    then: { code: '1000' },
    because: 'Something paid in advance is paid out of the bank.',
  },
  {
    when: { code: '1400', side: 'CREDIT' },
    then: { code: '6000' },
    because: 'A prepayment is released into expense as the period it covers is used up.',
  },
  {
    when: { code: '6000', side: 'DEBIT' },
    then: { code: '2400' },
    because: 'An expense incurred but not yet billed is accrued as a liability.',
  },
  {
    when: { code: '2400', side: 'DEBIT' },
    then: { code: '1000' },
    because: 'Settling an accrued expense once the bill arrives and is paid.',
  },
];

/*
 * A note on the one collision that had to be decided rather than discovered.
 *
 * `6000 DEBIT` could reasonably pair with either 2400 (accruing an expense) or
 * 1400 (releasing a prepayment into it). Only one rule may own a key, or the
 * lookup stops being a function and starts being a coin toss that changes with
 * array order. Accrual wins because it is the commoner month-end entry; the
 * prepayment release stays reachable from the other end, `1400 CREDIT`, which is
 * the side an accountant working through prepayments starts from anyway.
 */

/**
 * The rule for an account on a side, or `null` where bookkeeping has no opinion.
 *
 * `null` is the normal answer. Most accounts pair with whatever the transaction
 * happened to involve, and inventing a rule for those is exactly the guessing
 * this file exists to avoid.
 */
export function standardCounterAccount(code: string, side: PairingSide): PairingRule | null {
  return (
    STANDARD_ADJUSTMENTS.find((rule) => rule.when.code === code && rule.when.side === side) ?? null
  );
}

/** Every account code this table mentions, either side. Used to test the seed covers it. */
export function pairingAccountCodes(): readonly string[] {
  return [
    ...new Set(STANDARD_ADJUSTMENTS.flatMap((rule) => [rule.when.code, rule.then.code])),
  ].sort();
}
