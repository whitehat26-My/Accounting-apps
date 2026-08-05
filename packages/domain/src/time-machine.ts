import { Money, type Currency } from './money.js';

/**
 * The time machine — the books as they stood at a past instant, and the
 * difference between two instants.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS EXACT RATHER THAN RECONSTRUCTED.
 *
 * The ledger is append-only (CLAUDE.md rule 1). A posted entry is stamped with
 * `posted_at` and never edited; a correction is a NEW entry with its own
 * `posted_at` pointing back at the original. A draft has no `posted_at` at
 * all. So "the books as they stood at instant T" is not an inference or a
 * replay — it is a single predicate over rows that still exist:
 *
 *     posted_at IS NOT NULL AND posted_at <= T
 *
 * Nothing has to be undone, no snapshot has to have been taken in advance,
 * and the answer is the same whoever asks and whenever. That is a property of
 * the data model, not of this file: a system that UPDATEs its ledger cannot
 * offer it at all, which is why no other package for a shop this size does.
 *
 * The arithmetic below is the small part. It lives here so it can be tested
 * without a database, and so the sorting decision — biggest movement first —
 * is stated once rather than in whichever query happened to need it.
 * ---------------------------------------------------------------------------
 */

/**
 * One account's balance AS AT an instant.
 *
 * Deliberately not `report.ts`'s `AccountBalance`, which carries the account
 * type and its presentation tags: this is a raw ledger position, and asking
 * the point-in-time query to fetch tags it will never use — or worse, to
 * report an empty tag list as if that were the truth — would be reuse for its
 * own sake.
 */
export interface BalanceAtInstant {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  /** Debit-positive, like `account_period_balance.net_movement`. */
  readonly balance: Money;
}

export interface BalanceChange {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly before: Money;
  readonly after: Money;
  readonly delta: Money;
}

/**
 * What moved between two points in time.
 *
 * Accounts that did not move are ABSENT, not present with a zero: a list of
 * zeroes is a list somebody has to read before discovering it says nothing.
 * Sorted by the size of the movement regardless of direction, because the
 * question behind this report is "what is the biggest surprise", and a
 * RM 40,000 credit is exactly as surprising as a RM 40,000 debit.
 */
export function diffBalances(
  before: readonly BalanceAtInstant[],
  after: readonly BalanceAtInstant[],
  currency: Currency,
): BalanceChange[] {
  const beforeById = new Map(before.map((b) => [b.accountId, b]));
  const afterById = new Map(after.map((a) => [a.accountId, a]));

  const changes: BalanceChange[] = [];
  for (const accountId of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const from = beforeById.get(accountId);
    const to = afterById.get(accountId);
    // An account can appear on one side only — created, or first used, after
    // the earlier instant. Its missing side is genuinely zero.
    const fromBalance = from?.balance ?? Money.zero(currency);
    const toBalance = to?.balance ?? Money.zero(currency);
    const delta = toBalance.subtract(fromBalance);
    if (delta.isZero()) continue;

    const identity = to ?? from!;
    changes.push({
      accountId,
      code: identity.code,
      name: identity.name,
      before: fromBalance,
      after: toBalance,
      delta,
    });
  }

  return changes.sort((a, b) => {
    const magnitude = absUnits(b.delta) - absUnits(a.delta);
    return magnitude !== 0n ? (magnitude > 0n ? 1 : -1) : a.code.localeCompare(b.code);
  });
}

function absUnits(money: Money): bigint {
  return money.units < 0n ? -money.units : money.units;
}

// ---------------------------------------------------------------------------
// Why an entry appeared
// ---------------------------------------------------------------------------

export type ChangeKind = 'REVERSAL' | 'BACKDATED' | 'LATER';

export interface ChangedEntry {
  readonly entryNo: string;
  readonly entryDate: string;
  readonly postedAt: string;
  readonly description: string | null;
  readonly sourceModule: string;
  readonly reversalOfId: string | null;
  readonly postedByName: string | null;
  readonly kind: ChangeKind;
}

/**
 * Why this entry is in the diff at all.
 *
 *   REVERSAL  — it undoes an earlier entry. Explains itself.
 *   BACKDATED — its accounting date falls inside the window being examined,
 *               but it was POSTED after that window's figures were read.
 *               This is the one worth a person's attention: last month's
 *               reported profit changed after somebody had already relied on
 *               it.
 *   LATER     — ordinary trading that happened after the earlier instant, and
 *               is dated after it too. Expected, and listed for completeness.
 */
export function classifyChange(
  entry: { readonly entryDate: string; readonly reversalOfId: string | null },
  examined: { readonly from?: string | undefined; readonly to?: string | undefined },
): ChangeKind {
  if (entry.reversalOfId !== null) return 'REVERSAL';

  const insideExaminedPeriod =
    (examined.from === undefined || entry.entryDate >= examined.from) &&
    (examined.to === undefined || entry.entryDate <= examined.to);

  return insideExaminedPeriod && examined.to !== undefined ? 'BACKDATED' : 'LATER';
}
