/**
 * The bank reconciliation matching engine — M4.
 *
 * Specified in full in `docs/architecture/07-prompt-engineering-guidelines.md`
 * §7.4, including the scoring weights. The weights are the highest-leverage
 * detail in the whole module: pick them arbitrarily and you inherit them
 * forever without knowing why a match scored what it did.
 *
 * ---------------------------------------------------------------------------
 * THREE NON-GOALS, ALL LOAD-BEARING.
 *
 * 1. **This function never writes and never auto-confirms.** It returns
 *    suggestions. A confidence of 100 still requires a human click. Auto-apply
 *    is a later feature behind a per-tenant flag, and building it in now would
 *    mean a scoring bug silently posts to the ledger.
 *
 * 2. **No ML.** Deterministic, explainable scoring. A user has to be able to
 *    tell an auditor why a match was suggested, and "the model said so" is not
 *    an answer an auditor accepts.
 *
 * 3. **No IO.** Candidates are passed in. That is what makes the combinatorial
 *    bound testable and the whole engine runnable against 500 × 2,000 fixtures
 *    in a unit test.
 * ---------------------------------------------------------------------------
 *
 * Every suggestion carries a human-readable `reason`. That is a product
 * requirement, not a debugging aid — users will not accept a match they cannot
 * explain.
 */

import { Money, type Currency } from './money.js';
import { daysBetween } from './ageing.js';
import {
  counterpartyFromNarrative,
  indexNarrative,
  jaroWinkler,
  normaliseName,
  normalisedSimilarity,
  referenceMatchIndexed,
  type NarrativeIndex,
} from './text.js';

/** Which way the money moved on the bank statement. */
export type BankDirection = 'INFLOW' | 'OUTFLOW';

export interface BankTransactionView {
  readonly id: string;
  readonly bankAccountId: string;
  readonly txnDate: string;
  /** Signed: positive is money in, negative is money out. */
  readonly amount: Money;
  readonly description: string;
  readonly reference?: string;
}

/** What a bank line can be matched against. */
export type CandidateKind = 'PAYMENT' | 'INVOICE' | 'BILL' | 'JOURNAL' | 'TRANSFER';

export interface MatchCandidate {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly documentNo: string;
  readonly documentDate: string;
  /** Positive. `direction` says which way it points. */
  readonly amount: Money;
  /**
   * `INFLOW` for something that should appear as money IN on the statement — a
   * customer receipt, an unsettled sales invoice. `OUTFLOW` for a supplier
   * payment or an open bill.
   */
  readonly direction: BankDirection;
  readonly contactId?: string;
  readonly contactName?: string;
  /** Trading name, if it differs from the registered name. */
  readonly tradingName?: string;
}

export type MatchMethod = 'AUTO' | 'RULE' | 'MANUAL';

export interface MatchSuggestion {
  readonly bankTransactionId: string;
  /** One id for a simple match; several for a one-to-many settlement. */
  readonly candidateIds: readonly string[];
  readonly kind: CandidateKind;
  /** 0–100. Only suggestions at or above `MINIMUM_CONFIDENCE` are returned. */
  readonly confidence: number;
  /** Why this was suggested, in words a user can repeat to their auditor. */
  readonly reason: string;
  /** Absolute difference between the bank amount and the candidate total. */
  readonly amountDifference: Money;
  /** Whole days between the bank date and the candidate date; negative when the bank date is earlier. */
  readonly dayDifference: number;
}

export interface LearnedAlias {
  /** A normalised narrative fragment seen before. */
  readonly pattern: string;
  readonly contactId: string;
}

export interface MatchContext {
  readonly baseCurrency: Currency;
  /** Narrative patterns previously confirmed against a contact. */
  readonly learnedAliases?: readonly LearnedAlias[];
  /** Overrides for tuning against a real statement set. Defaults are the spec's. */
  readonly weights?: Partial<MatchWeights>;
}

export interface MatchWeights {
  readonly exactAmount: number;
  readonly amountTolerance: number;
  readonly dateProximity: number;
  readonly reference: number;
  readonly contactName: number;
  readonly learnedAlias: number;
}

/** The weights from docs/architecture/07-prompt-engineering-guidelines.md §7.4. */
export const DEFAULT_WEIGHTS: MatchWeights = {
  exactAmount: 40,
  amountTolerance: 30,
  dateProximity: 20,
  reference: 25,
  contactName: 15,
  learnedAlias: 10,
};

/** Below this a suggestion is noise and is not returned at all. */
export const MINIMUM_CONFIDENCE = 40;

/** Fuzzy name matches below this do not count as a name signal. */
export const NAME_SIMILARITY_THRESHOLD = 0.85;

/** Amount tolerance: the greater of RM 0.50 and 0.5% — bank charges, FX rounding. */
const ABSOLUTE_TOLERANCE_UNITS = 5000n; // RM 0.50 at scale 4
const TOLERANCE_BASIS_POINTS = 50n; // 0.5%

/** Date proximity decays to nothing at two weeks. */
const DATE_DECAY_DAYS = 14;

/**
 * Bounds on the one-to-many search.
 *
 * A customer settling several invoices in one transfer is the case users care
 * most about, and it is also a subset-sum problem. Left unbounded, a statement
 * line against 30 open invoices is 2^30 combinations and the request never
 * returns. The engine explores a bounded slice and says so via `truncated`
 * rather than timing out — a partial answer a user can act on beats a spinner.
 */
export const MAX_COMBINATION_CANDIDATES = 6;
export const MAX_COMBINATIONS = 200;

/**
 * Suggest matches for one bank line, ranked best first.
 *
 * Ordering: confidence descending, then smallest date difference, then
 * smallest amount difference, then oldest document. The tie-breaks matter —
 * with round amounts and a regular customer, exact ties are common, and a
 * stable order is what stops the suggested match jumping around between page
 * loads.
 */
export function suggestMatches(
  bankTxn: BankTransactionView,
  candidates: readonly MatchCandidate[],
  context: MatchContext,
): MatchSuggestion[] {
  return suggestForLine(bankTxn, prepareCandidates(candidates), context);
}

/**
 * Suggest matches for a whole statement at once.
 *
 * Reconciling a statement is the real operation — a single line in isolation
 * is the exception. Doing it as a batch lets each candidate's name be
 * normalised ONCE for the run instead of once per line: for the 500 × 2,000
 * case in the performance budget that is a million redundant regex passes
 * removed, and it is most of the difference between meeting the 3-second
 * target and missing it.
 */
export function suggestMatchesForStatement(
  bankTxns: readonly BankTransactionView[],
  candidates: readonly MatchCandidate[],
  context: MatchContext,
): Map<string, MatchSuggestion[]> {
  const prepared = prepareCandidates(candidates);
  const byLine = new Map<string, MatchSuggestion[]>();

  for (const bankTxn of bankTxns) {
    byLine.set(bankTxn.id, suggestForLine(bankTxn, prepared, context));
  }

  return byLine;
}

/** A candidate with its name normalisation done up front. */
interface PreparedCandidate {
  readonly candidate: MatchCandidate;
  /** Normalised contact and trading names, empty ones dropped. */
  readonly names: readonly string[];
}

function prepareCandidates(candidates: readonly MatchCandidate[]): PreparedCandidate[] {
  return candidates.map((candidate) => ({
    candidate,
    names: [candidate.contactName, candidate.tradingName]
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .map(normaliseName)
      .filter((n) => n.length > 0),
  }));
}

function suggestForLine(
  bankTxn: BankTransactionView,
  candidates: readonly PreparedCandidate[],
  context: MatchContext,
): MatchSuggestion[] {
  const weights = { ...DEFAULT_WEIGHTS, ...context.weights };
  const direction: BankDirection = bankTxn.amount.isNegative() ? 'OUTFLOW' : 'INFLOW';
  const bankAmount = bankTxn.amount.abs();

  // Direction disagreement is DISQUALIFYING, not a penalty. A credit on the
  // bank cannot settle a supplier bill no matter how well the amount, date and
  // reference line up — and those three agreeing is exactly what happens when
  // a customer and a supplier are the same company.
  const eligible = candidates.filter((c) => c.candidate.direction === direction);

  // Derived from the bank line ONCE, not once per candidate. Narrative
  // normalisation is a dozen regex passes; against 2,000 candidates that is
  // the difference between meeting the 3-second budget for a 500-line
  // statement and missing it by 40%.
  const narrative = narrativeOf(bankTxn);

  const suggestions: MatchSuggestion[] = [];

  for (const prepared of eligible) {
    const scored = scoreOne(bankTxn, bankAmount, prepared, weights, context, narrative);
    if (scored !== null) suggestions.push(scored);
  }

  suggestions.push(
    ...suggestCombinations(bankTxn, bankAmount, eligible, weights, context, narrative),
  );

  return sortSuggestions(suggestions);
}

/** The bank line's narrative, normalised once for reuse across candidates. */
interface Narrative {
  readonly index: NarrativeIndex;
  readonly counterparty: string;
  readonly descriptionCounterparty: string;
}

function narrativeOf(bankTxn: BankTransactionView): Narrative {
  const raw = `${bankTxn.description} ${bankTxn.reference ?? ''}`;
  return {
    index: indexNarrative(raw),
    counterparty: counterpartyFromNarrative(raw),
    descriptionCounterparty: counterpartyFromNarrative(bankTxn.description),
  };
}

function sortSuggestions(suggestions: MatchSuggestion[]): MatchSuggestion[] {
  return suggestions
    .filter((s) => s.confidence >= MINIMUM_CONFIDENCE)
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        Math.abs(a.dayDifference) - Math.abs(b.dayDifference) ||
        a.amountDifference.compare(b.amountDifference) ||
        a.dayDifference - b.dayDifference ||
        (a.candidateIds[0] ?? '').localeCompare(b.candidateIds[0] ?? ''),
    );
}

interface Signals {
  score: number;
  reasons: string[];
}

function scoreOne(
  bankTxn: BankTransactionView,
  bankAmount: Money,
  prepared: PreparedCandidate,
  weights: MatchWeights,
  context: MatchContext,
  narrative: Narrative,
): MatchSuggestion | null {
  const candidate = prepared.candidate;
  const difference = bankAmount.subtract(candidate.amount).abs();

  const signals: Signals = { score: 0, reasons: [] };

  // The amount gate runs FIRST and everything else is deferred behind it.
  // Against a 2,000-candidate pool almost every candidate fails here, and
  // parsing two dates for each one before finding that out was most of the
  // cost of a 500-line statement.
  scoreAmount(signals, bankAmount, candidate, difference, weights);
  if (signals.score === 0) return null; // outside tolerance: not a match at all

  const days = daysBetween(candidate.documentDate, bankTxn.txnDate);
  scoreDate(signals, days, weights);
  scoreReference(signals, narrative, candidate, weights);
  scoreContact(signals, narrative, prepared, weights, context);

  const confidence = Math.min(100, Math.round(signals.score));

  return {
    bankTransactionId: bankTxn.id,
    candidateIds: [candidate.id],
    kind: candidate.kind,
    confidence,
    reason: signals.reasons.join('; '),
    amountDifference: difference,
    dayDifference: days,
  };
}

function scoreAmount(
  signals: Signals,
  bankAmount: Money,
  candidate: MatchCandidate,
  difference: Money,
  weights: MatchWeights,
): void {
  if (difference.isZero()) {
    signals.score += weights.exactAmount;
    signals.reasons.push(`Amount matches exactly (${bankAmount.toDisplayString()})`);
    return;
  }

  const tolerance = toleranceFor(candidate.amount);
  if (difference.compare(tolerance) > 0) return;

  // Linear decay across the tolerance band: a one-sen difference keeps almost
  // the full weight, a difference at the edge of tolerance keeps almost none.
  const ratio = ratioOf(difference, tolerance);
  const awarded = weights.amountTolerance * (1 - ratio);
  signals.score += awarded;
  signals.reasons.push(
    `Amount within tolerance — ${bankAmount.toDisplayString()} against ` +
      `${candidate.amount.toDisplayString()}, a difference of ${difference.toDisplayString()}`,
  );
}

function scoreDate(signals: Signals, days: number, weights: MatchWeights): void {
  if (Math.abs(days) > DATE_DECAY_DAYS) return;

  const decayed = weights.dateProximity * (1 - Math.abs(days) / DATE_DECAY_DAYS);

  // A bank date BEFORE the document date is penalised harder than the same
  // gap after it. Money normally reaches the bank on or after the day the
  // document is raised; the reverse means a prepayment or the wrong document,
  // and both deserve more scepticism than a late payment does.
  const awarded = days < 0 ? decayed / 2 : decayed;
  signals.score += awarded;

  if (days === 0) {
    signals.reasons.push('Same day as the document');
  } else if (days > 0) {
    signals.reasons.push(`${days} day${days === 1 ? '' : 's'} after the document date`);
  } else {
    signals.reasons.push(
      `${-days} day${days === -1 ? '' : 's'} BEFORE the document date, which is unusual`,
    );
  }
}

function scoreReference(
  signals: Signals,
  narrative: Narrative,
  candidate: MatchCandidate,
  weights: MatchWeights,
): void {
  const match = referenceMatchIndexed(candidate.documentNo, narrative.index);

  if (match === 'EXACT') {
    signals.score += weights.reference;
    signals.reasons.push(`Reference '${candidate.documentNo}' appears in the bank narrative`);
    return;
  }

  if (match === 'NUMERIC') {
    // A bare number is weaker evidence than the full document reference: it
    // collides with dates, amounts and account fragments that happen to sit in
    // the narrative. Worth something, not worth the full weight.
    signals.score += weights.reference * 0.6;
    signals.reasons.push(
      `The number in '${candidate.documentNo}' appears in the bank narrative`,
    );
  }
}

function scoreContact(
  signals: Signals,
  narrative: Narrative,
  prepared: PreparedCandidate,
  weights: MatchWeights,
  context: MatchContext,
): void {
  const candidate = prepared.candidate;
  const counterparty = narrative.counterparty;

  // A narrative that was pure rail noise leaves nothing to compare. Scoring an
  // empty remainder would give every DuitNow line a name match.
  if (counterparty.length > 0) {
    let best = 0;
    let bestName = '';
    for (const name of prepared.names) {
      const score = normalisedSimilarity(counterparty, name);
      if (score > best) {
        best = score;
        bestName = name;
      }
    }

    if (best >= NAME_SIMILARITY_THRESHOLD) {
      signals.score += weights.contactName;
      signals.reasons.push(
        `Bank narrative names ${bestName} (${Math.round(best * 100)}% name match)`,
      );
    }
  }

  const aliases = context.learnedAliases ?? [];
  if (candidate.contactId !== undefined && aliases.length > 0) {
    const normalised = narrative.descriptionCounterparty;
    const learned = aliases.some(
      (a) =>
        a.contactId === candidate.contactId &&
        (normalised.includes(a.pattern) || jaroWinkler(normalised, a.pattern) >= 0.95),
    );
    if (learned) {
      signals.score += weights.learnedAlias;
      signals.reasons.push('This narrative has been matched to the same contact before');
    }
  }
}

/**
 * One bank line settling SEVERAL documents — the DuitNow lump sum.
 *
 * Only exact-sum combinations are proposed. A near-miss combination is not
 * worth suggesting: with enough candidates something will always land within
 * tolerance by coincidence, and a wrong multi-document match is far more work
 * to unpick than no suggestion at all.
 */
function suggestCombinations(
  bankTxn: BankTransactionView,
  bankAmount: Money,
  candidates: readonly PreparedCandidate[],
  weights: MatchWeights,
  context: MatchContext,
  narrative: Narrative,
): MatchSuggestion[] {
  if (candidates.length < 2) return [];

  // Only candidates smaller than the bank amount can be part of a sum that
  // reaches it, and only the oldest few are worth exploring — favouring older
  // documents is how settlements actually work, and it keeps the choice
  // deterministic.
  //
  // Selected in a single pass rather than by sorting the whole pool: sorting
  // 2,000 candidates once per bank line is 500 sorts of 2,000 items to keep
  // six of them.
  const usable = oldestFew(
    candidates.filter(
      (c) => c.candidate.amount.compare(bankAmount) < 0 && c.candidate.amount.isPositive(),
    ),
    MAX_COMBINATION_CANDIDATES,
  );

  if (usable.length < 2) return [];

  const found: PreparedCandidate[][] = [];
  let explored = 0;
  let truncated = false;

  const walk = (index: number, chosen: PreparedCandidate[], total: Money): void => {
    if (explored >= MAX_COMBINATIONS) {
      truncated = true;
      return;
    }
    if (chosen.length >= 2 && total.equals(bankAmount)) {
      found.push([...chosen]);
      return; // a superset cannot also sum exactly with positive amounts
    }
    if (index >= usable.length || total.compare(bankAmount) >= 0) return;

    for (let i = index; i < usable.length; i++) {
      explored++;
      if (explored > MAX_COMBINATIONS) {
        truncated = true;
        return;
      }
      const candidate = usable[i]!;
      chosen.push(candidate);
      walk(i + 1, chosen, total.add(candidate.candidate.amount));
      chosen.pop();
    }
  };

  walk(0, [], Money.zero(bankAmount.currency));

  return found.map((combination) => {
    const days = Math.max(
      ...combination.map((c) => daysBetween(c.candidate.documentDate, bankTxn.txnDate)),
    );
    const numbers = combination.map((c) => c.candidate.documentNo).join(', ');
    const reasons = [
      `Exactly settles ${combination.length} documents (${numbers}) totalling ` +
        `${bankAmount.toDisplayString()}`,
    ];

    // The combination sums exactly, so the amount signal is full weight. The
    // other signals are scored against the group as a whole.
    let score = weights.exactAmount;

    const dateSignals: Signals = { score: 0, reasons: [] };
    scoreDate(dateSignals, days, weights);
    score += dateSignals.score;
    reasons.push(...dateSignals.reasons);

    const referenced = combination.filter(
      (c) => referenceMatchIndexed(c.candidate.documentNo, narrative.index) !== 'NONE',
    );
    if (referenced.length > 0) {
      score += weights.reference * (referenced.length / combination.length);
      reasons.push(
        `${referenced.length} of ${combination.length} references appear in the narrative`,
      );
    }

    const contactSignals: Signals = { score: 0, reasons: [] };
    scoreContact(contactSignals, narrative, combination[0]!, weights, context);
    score += contactSignals.score;
    reasons.push(...contactSignals.reasons);

    if (truncated) {
      reasons.push(
        `Search truncated at ${MAX_COMBINATIONS} combinations — there may be other groupings`,
      );
    }

    return {
      bankTransactionId: bankTxn.id,
      candidateIds: combination.map((c) => c.candidate.id),
      kind: combination[0]!.candidate.kind,
      confidence: Math.min(100, Math.round(score)),
      reason: reasons.join('; '),
      amountDifference: Money.zero(bankAmount.currency),
      dayDifference: days,
    };
  });
}

// ---------------------------------------------------------------------------
// Transfers between the tenant's own accounts
// ---------------------------------------------------------------------------

export interface TransferSuggestion {
  readonly outflowId: string;
  readonly inflowId: string;
  readonly amount: Money;
  readonly dayDifference: number;
  readonly confidence: number;
  readonly reason: string;
}

/** An outflow and its mirror inflow must appear within this many days. */
export const TRANSFER_WINDOW_DAYS = 3;

/**
 * Detect money moved between the tenant's OWN accounts.
 *
 * ---------------------------------------------------------------------------
 * This is a distinct case, not a special kind of match, and getting it wrong
 * is expensive. An own-account transfer that is reconciled as two unrelated
 * transactions books an expense on one side and income on the other: the
 * balance sheet still balances, and the P&L is overstated on both lines by the
 * transfer amount. It looks completely normal on a trial balance.
 * ---------------------------------------------------------------------------
 *
 * Pairs are matched greedily by closeness in time, and each line is used at
 * most once — a round-sum sweep between three accounts on one day would
 * otherwise produce every cross-pairing.
 */
export function suggestTransfers(
  transactions: readonly BankTransactionView[],
  window: number = TRANSFER_WINDOW_DAYS,
): TransferSuggestion[] {
  const outflows = transactions
    .filter((t) => t.amount.isNegative())
    .sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.id.localeCompare(b.id));
  const inflows = transactions
    .filter((t) => t.amount.isPositive())
    .sort((a, b) => a.txnDate.localeCompare(b.txnDate) || a.id.localeCompare(b.id));

  const used = new Set<string>();
  const suggestions: TransferSuggestion[] = [];

  for (const out of outflows) {
    const amount = out.amount.abs();

    const partner = inflows
      .filter(
        (inflow) =>
          !used.has(inflow.id) &&
          inflow.bankAccountId !== out.bankAccountId &&
          inflow.amount.equals(amount) &&
          Math.abs(daysBetween(out.txnDate, inflow.txnDate)) <= window,
      )
      .sort(
        (a, b) =>
          Math.abs(daysBetween(out.txnDate, a.txnDate)) -
            Math.abs(daysBetween(out.txnDate, b.txnDate)) || a.id.localeCompare(b.id),
      )[0];

    if (!partner) continue;

    used.add(partner.id);
    const days = daysBetween(out.txnDate, partner.txnDate);

    suggestions.push({
      outflowId: out.id,
      inflowId: partner.id,
      amount,
      dayDifference: days,
      // Same day is unambiguous; a lag costs a little certainty because a
      // same-amount payment to a third party could coincide.
      confidence: days === 0 ? 95 : Math.max(70, 95 - Math.abs(days) * 8),
      reason:
        `${amount.toDisplayString()} left one account and the same amount arrived in another ` +
        (days === 0 ? 'the same day' : `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} later`) +
        ' — this looks like a transfer between your own accounts, not two separate transactions',
    });
  }

  return suggestions;
}

// ------------------------------------------------------------------ internals

/**
 * The `limit` oldest candidates, by document date then id.
 *
 * An insertion pass over a `limit`-sized window: O(n · limit) with limit fixed
 * at 6, against O(n log n) for a full sort of a list we throw almost all of
 * away.
 */
function oldestFew(
  candidates: readonly PreparedCandidate[],
  limit: number,
): PreparedCandidate[] {
  const kept: PreparedCandidate[] = [];

  for (const candidate of candidates) {
    let index = kept.length;
    while (index > 0 && isOlder(candidate, kept[index - 1]!)) index--;
    if (index >= limit) continue;
    kept.splice(index, 0, candidate);
    if (kept.length > limit) kept.pop();
  }

  return kept;
}

function isOlder(a: PreparedCandidate, b: PreparedCandidate): boolean {
  return a.candidate.documentDate === b.candidate.documentDate
    ? a.candidate.id < b.candidate.id
    : a.candidate.documentDate < b.candidate.documentDate;
}

function toleranceFor(amount: Money): Money {
  const proportional = amount.abs().multiplyRatio(TOLERANCE_BASIS_POINTS, 10_000n);
  const absolute = Money.fromUnits(ABSOLUTE_TOLERANCE_UNITS, amount.currency);
  return proportional.compare(absolute) > 0 ? proportional : absolute;
}

/** Where `value` sits in [0, limit], as a number in [0, 1]. */
function ratioOf(value: Money, limit: Money): number {
  if (limit.isZero()) return 1;
  // Both are small, bounded amounts by construction — this is the one place a
  // float is acceptable, because the result is a display weight and never
  // money. It is never added to a ledger amount.
  return Number(value.units) / Number(limit.units);
}

