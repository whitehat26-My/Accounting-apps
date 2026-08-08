/**
 * The second pair of eyes — audit techniques, running on a five-person shop.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND THE THING IT MUST NEVER BECOME.
 *
 * These are the tests an external auditor runs on a sample and a fraud
 * examiner runs on a population: does the leading-digit distribution look
 * like real trading, has the same amount been paid to the same supplier
 * twice, are amounts clustering just under an approval threshold, is
 * somebody posting into last month at two in the morning.
 *
 * NONE OF THEM PROVE ANYTHING. Every one has an innocent explanation that is
 * usually the right one: a shop selling one product at RM 89 breaks Benford's
 * Law by trading honestly; a duplicate payment is usually a genuine second
 * invoice; a late-night entry is usually the owner catching up on a Sunday.
 * So every finding carries its innocent explanation ALONGSIDE the suspicion,
 * and the language never accuses. A tool that cries fraud at ordinary
 * bookkeeping gets switched off in a week, and then it is there for none of
 * the cases that mattered.
 *
 * The honest framing is "worth a look", and that is what the labels say.
 * ---------------------------------------------------------------------------
 */

export type FindingSeverity = 'NOTE' | 'LOOK' | 'CHECK';

export interface Finding {
  readonly code: string;
  readonly severity: FindingSeverity;
  /** One sentence, in the shop's language, saying what was noticed. */
  readonly headline: string;
  /** Why it might be nothing — stated with the same weight as the suspicion. */
  readonly innocentExplanation: string;
  readonly detail?: Record<string, string | number>;
}

// ---------------------------------------------------------------------------
// Benford's Law
// ---------------------------------------------------------------------------

/**
 * Expected share of each leading digit in naturally-occurring amounts:
 * log10(1 + 1/d). Real invoice populations follow it closely; invented
 * numbers usually do not, because people inventing figures spread them
 * evenly and avoid starting with 1.
 */
const BENFORD = [
  0.30103, 0.17609, 0.12494, 0.09691, 0.07918, 0.06695, 0.05799, 0.05115, 0.04576,
] as const;

export interface BenfordResult {
  readonly sampleSize: number;
  readonly observed: readonly number[];
  readonly expected: readonly number[];
  /** Chi-squared statistic across the nine digits. */
  readonly chiSquared: number;
  /**
   * Whether the sample is big enough to say anything at all. Below ~200
   * amounts the test has no power and reports nothing rather than noise.
   */
  readonly conclusive: boolean;
  readonly finding: Finding | null;
}

export function leadingDigit(decimal: string): number | null {
  for (const char of decimal.replace('-', '')) {
    if (char >= '1' && char <= '9') return Number(char);
    if (char === '0' || char === '.') continue;
    return null;
  }
  return null;
}

/**
 * A conventional chi-squared test at 8 degrees of freedom. 20.09 is the
 * 99% critical value; beyond it, the distribution is unusual enough to
 * mention — and only to mention.
 */
const CHI_SQUARED_99 = 20.09;
const MINIMUM_SAMPLE = 200;

export function benford(amounts: readonly string[]): BenfordResult {
  const digits = amounts
    .map(leadingDigit)
    .filter((d): d is number => d !== null);

  const counts = new Array(9).fill(0) as number[];
  for (const digit of digits) counts[digit - 1]! += 1;

  const n = digits.length;
  const observed = counts.map((c) => (n === 0 ? 0 : c / n));
  const conclusive = n >= MINIMUM_SAMPLE;

  let chiSquared = 0;
  if (n > 0) {
    for (let i = 0; i < 9; i++) {
      const expected = BENFORD[i]! * n;
      chiSquared += (counts[i]! - expected) ** 2 / expected;
    }
  }

  const finding: Finding | null =
    conclusive && chiSquared > CHI_SQUARED_99
      ? {
          code: 'BENFORD',
          severity: 'NOTE',
          headline:
            `The spread of first digits across ${n} amounts is unusual for naturally ` +
            'occurring figures.',
          innocentExplanation:
            'Very common and usually innocent: a shop selling a handful of products at ' +
            'fixed prices, or lots of round-number services, breaks this pattern simply ' +
            'by trading normally. It is only worth a thought if the amounts are supposed ' +
            'to vary freely.',
          detail: { sampleSize: n, chiSquared: Math.round(chiSquared * 100) / 100 },
        }
      : null;

  return { sampleSize: n, observed, expected: [...BENFORD], chiSquared, conclusive, finding };
}

// ---------------------------------------------------------------------------
// Round numbers
// ---------------------------------------------------------------------------

/**
 * Real prices have sen. Invented ones are round. A shop whose sales are all
 * RM 50.00 and RM 100.00 is either selling round-priced services or being
 * given round-numbered figures by somebody.
 */
export function roundNumberShare(amounts: readonly string[]): {
  readonly share: number;
  readonly round: number;
  readonly total: number;
  readonly finding: Finding | null;
} {
  const total = amounts.length;
  const round = amounts.filter((a) => /\.0{1,4}$/.test(a) && Number(a.split('.')[0]) % 100 === 0)
    .length;
  const share = total === 0 ? 0 : round / total;

  const finding: Finding | null =
    total >= 20 && share > 0.6
      ? {
          code: 'ROUND_NUMBERS',
          severity: 'NOTE',
          headline: `${Math.round(share * 100)}% of these amounts are exact multiples of RM 100.`,
          innocentExplanation:
            'Normal for a shop that prices services in round figures — deposits, ' +
            'flat-rate labour, monthly retainers. Worth a look only if these are ' +
            'supposed to be itemised amounts that happened to land round.',
          detail: { round, total },
        }
      : null;

  return { share, round, total, finding };
}

// ---------------------------------------------------------------------------
// Duplicate payments
// ---------------------------------------------------------------------------

export interface PossibleDuplicate {
  readonly party: string;
  readonly amount: string;
  readonly documents: readonly string[];
  readonly daysApart: number;
}

/**
 * The same amount to the same party twice within a short window — the single
 * most common way a small business loses money, and it is almost never fraud:
 * it is a supplier sending a statement that gets paid alongside the invoice.
 */
export function duplicatePayments(
  payments: readonly {
    readonly party: string;
    readonly amount: string;
    readonly document: string;
    readonly date: string;
  }[],
  windowDays = 45,
): { readonly duplicates: readonly PossibleDuplicate[]; readonly finding: Finding | null } {
  const byKey = new Map<string, typeof payments[number][]>();
  for (const payment of payments) {
    const key = `${payment.party}|${payment.amount}`;
    byKey.set(key, [...(byKey.get(key) ?? []), payment]);
  }

  const duplicates: PossibleDuplicate[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i++) {
      const days = daysApart(sorted[i - 1]!.date, sorted[i]!.date);
      if (days <= windowDays) {
        duplicates.push({
          party: sorted[i]!.party,
          amount: sorted[i]!.amount,
          documents: [sorted[i - 1]!.document, sorted[i]!.document],
          daysApart: days,
        });
      }
    }
  }

  const finding: Finding | null =
    duplicates.length > 0
      ? {
          code: 'DUPLICATE_PAYMENT',
          severity: 'CHECK',
          headline:
            `${duplicates.length} payment${duplicates.length === 1 ? '' : 's'} of the same ` +
            `amount went to the same supplier twice within ${windowDays} days.`,
          innocentExplanation:
            'Often genuine — a monthly retainer, rent, or two identical deliveries. But ' +
            'this is also the most common way a small business pays the same invoice ' +
            'twice, and the money is usually recoverable if it is caught early.',
          detail: { pairs: duplicates.length },
        }
      : null;

  return { duplicates, finding };
}

function daysApart(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round(Math.abs(b - a) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Threshold hugging
// ---------------------------------------------------------------------------

/**
 * Amounts landing just under an approval limit. If bills need approval above
 * RM 5,000 and a supplier's invoices cluster at RM 4,900, somebody may be
 * splitting them — or the limit was set where the business naturally sits.
 */
export function thresholdHugging(
  amounts: readonly string[],
  threshold: string,
  /** Fraction below the limit that counts as "just under". */
  band = 0.05,
): { readonly justUnder: number; readonly finding: Finding | null } {
  const limit = Number(threshold);
  if (!Number.isFinite(limit) || limit <= 0) return { justUnder: 0, finding: null };

  const floor = limit * (1 - band);
  const justUnder = amounts.filter((a) => {
    const value = Number(a);
    return Number.isFinite(value) && value >= floor && value < limit;
  }).length;

  const finding: Finding | null =
    justUnder >= 3
      ? {
          code: 'THRESHOLD_HUGGING',
          severity: 'LOOK',
          headline:
            `${justUnder} bills landed within ${Math.round(band * 100)}% just below the ` +
            `RM ${threshold} approval limit.`,
          innocentExplanation:
            'Approval limits are usually set near where a business naturally spends, so ' +
            'clustering under one is expected. It matters only if the same supplier keeps ' +
            'arriving just below it while their work gets bigger.',
          detail: { justUnder, threshold },
        }
      : null;

  return { justUnder, finding };
}

// ---------------------------------------------------------------------------
// When things were posted
// ---------------------------------------------------------------------------

/**
 * Entries posted outside working hours, or dated well before the day they
 * were entered. Both are ordinary for a shop owner doing the books on a
 * Sunday — and both are what a person moving money quietly looks like.
 */
export function oddTimings(
  entries: readonly {
    readonly reference: string;
    readonly entryDate: string;
    readonly postedAtHourKl: number;
    readonly backdatedDays: number;
  }[],
): { readonly finding: Finding | null; readonly lateNight: number; readonly heavilyBackdated: number } {
  const lateNight = entries.filter(
    (e) => e.postedAtHourKl >= 0 && e.postedAtHourKl < 5,
  ).length;
  const heavilyBackdated = entries.filter((e) => e.backdatedDays > 45).length;

  const finding: Finding | null =
    lateNight + heavilyBackdated > 0
      ? {
          code: 'ODD_TIMING',
          severity: 'LOOK',
          headline:
            [
              lateNight > 0 ? `${lateNight} entr${lateNight === 1 ? 'y' : 'ies'} posted between midnight and 5am` : null,
              heavilyBackdated > 0 ? `${heavilyBackdated} dated more than 45 days before being entered` : null,
            ]
              .filter(Boolean)
              .join('; ') + '.',
          innocentExplanation:
            'Usually the owner catching up at the weekend, or a pile of old receipts ' +
            'finally being entered. Worth a look only if the person and the hour are ' +
            'both unexpected.',
          detail: { lateNight, heavilyBackdated },
        }
      : null;

  return { finding, lateNight, heavilyBackdated };
}
