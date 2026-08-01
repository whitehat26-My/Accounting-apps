/**
 * The financial statement engine — M7, domain layer.
 *
 * Turns account balances into a rendered statement according to a
 * `ReportDefinition`, which is DATA. MPERS and MFRS presentations, and
 * industry variants, are configuration rather than code.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION THAT MATTERS: an account→line mapping that can silently drop an
 * account is exactly how a balance sheet stops balancing.
 *
 * So the engine refuses to render a statement that does not account for every
 * balance it was given. An account with a non-zero balance that matches no
 * line is an ERROR listing the offending codes — never a silent omission that
 * leaves the reader to wonder why the totals are off by RM 4,700.
 * ---------------------------------------------------------------------------
 *
 * Structure, not formulas. A SUBTOTAL or TOTAL line is the PARENT of the lines
 * it aggregates, and equals the sum of its DETAIL descendants. Display order
 * comes from `sequence` and is independent of the tree, so a total still
 * prints below its children. This buys the aggregation behaviour of formulas
 * with no parser, no circular-reference class of bug, and a structure a
 * database can hold as rows.
 *
 * Pure: balances are fetched by the caller and passed in.
 */

import { Money, sumMoney, type Currency } from './money.js';
import { err, ok, type Result } from './result.js';
import { isProfitOrLossAccount, type AccountType } from './account.js';

export type ReportType = 'TRIAL_BALANCE' | 'SOPL' | 'SOFP';
export type ReportFramework = 'MPERS' | 'MFRS';

export type LineType = 'HEADER' | 'DETAIL' | 'SUBTOTAL' | 'TOTAL' | 'CALC';

/**
 * How a line's internal (debit-positive) amount is presented.
 *
 *  - `NATURAL`  — shown as computed. Assets and expenses.
 *  - `INVERTED` — sign flipped. Income, liabilities and equity carry credit
 *                 balances, and a reader expects revenue to read positive.
 */
export type SignConvention = 'NATURAL' | 'INVERTED';

/**
 * Values the engine cannot derive from a chart of accounts because they depend
 * on the fiscal calendar. Supplied by the caller.
 */
export type CalcKey = 'CURRENT_YEAR_EARNINGS' | 'RETAINED_EARNINGS_BROUGHT_FORWARD';

/**
 * How a line claims accounts.
 *
 * Deliberately NO code ranges. `account.code` is TEXT, so a `4000-4999` range
 * is a string comparison and `'10000' < '4000'` lexically. Malaysian SMEs
 * migrating from AutoCount, SQL Account or UBS routinely bring a five-digit
 * chart, and a range would then silently swallow or drop accounts. Losing an
 * account is the one failure this whole mechanism exists to prevent, so the
 * mechanism must not itself be a way to lose one.
 *
 *  - `ACCOUNT_ID`   — one specific account. Per-tenant, so system templates
 *                     cannot use it.
 *  - `TAG`          — a label on the account. How system templates address a
 *                     tenant's chart without knowing its ids or codes.
 *  - `ACCOUNT_TYPE` — the completeness net, so an account created after
 *                     onboarding still lands somewhere.
 */
export type AccountMatchType = 'ACCOUNT_ID' | 'TAG' | 'ACCOUNT_TYPE';

export interface AccountMap {
  readonly matchType: AccountMatchType;
  /** An account id, a tag, or an `AccountType`. */
  readonly matchValue: string;
  /** Higher wins. Ties break toward the more specific match type. */
  readonly priority: number;
}

export interface ReportLine {
  readonly id: string;
  readonly sequence: number;
  readonly label: string;
  /** Indentation for presentation only. The tree comes from `parentLineId`. */
  readonly level: number;
  readonly lineType: LineType;
  /** The SUBTOTAL/TOTAL line this line rolls up into. */
  readonly parentLineId?: string;
  readonly calcKey?: CalcKey;
  readonly signConvention: SignConvention;
  readonly accountMaps?: readonly AccountMap[];
}

export interface ReportDefinition {
  readonly reportType: ReportType;
  readonly framework: ReportFramework;
  readonly name: string;
  readonly lines: readonly ReportLine[];
}

/** One account's balance, expressed DEBIT-POSITIVE in the base currency. */
export interface AccountBalance {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  /**
   * Labels a system template can address without knowing this tenant's ids or
   * codes — e.g. `trade_receivables` on BOTH the AR control account and the AR
   * revaluation account, so they present on one line with no per-tenant
   * configuration. See packages/domain/src/revaluation.ts.
   */
  readonly tags: readonly string[];
  readonly amount: Money;
}

export interface RenderedLine {
  readonly lineId: string;
  readonly sequence: number;
  readonly label: string;
  readonly level: number;
  readonly lineType: LineType;
  /** Presentation amount, sign convention already applied. */
  readonly amount: Money;
  readonly comparative?: Money;
  /** Accounts contributing to this line — the drill-down hook. */
  readonly accountIds: readonly string[];
}

export interface RenderedReport {
  readonly reportType: ReportType;
  readonly framework: ReportFramework;
  readonly name: string;
  readonly currency: Currency;
  readonly lines: readonly RenderedLine[];
}

export type ReportViolation =
  | { readonly code: 'UNMAPPED_ACCOUNTS'; readonly accounts: readonly { code: string; name: string; amount: string }[] }
  | { readonly code: 'AMBIGUOUS_MAPPING'; readonly code_: string; readonly lineIds: readonly string[] }
  | { readonly code: 'MISSING_CALC_VALUE'; readonly calcKey: CalcKey }
  | { readonly code: 'CYCLIC_LINE_TREE'; readonly lineId: string }
  | { readonly code: 'UNKNOWN_PARENT_LINE'; readonly lineId: string; readonly parentLineId: string }
  | { readonly code: 'ACCOUNTS_ON_NON_DETAIL_LINE'; readonly lineId: string }
  | {
      readonly code: 'WRONG_ACCOUNT_TYPE_FOR_REPORT';
      readonly reportType: ReportType;
      readonly accounts: readonly { code: string; type: AccountType; lineId: string }[];
    };

export interface EvaluateOptions {
  readonly baseCurrency: Currency;
  /** Values for CALC lines. Missing ones the definition uses are an error. */
  readonly calcValues?: Readonly<Partial<Record<CalcKey, Money>>>;
  /** Prior-period balances, to render a comparative column. */
  readonly comparative?: readonly AccountBalance[];
}

const MATCH_SPECIFICITY: Record<AccountMatchType, number> = {
  ACCOUNT_ID: 3,
  TAG: 2,
  ACCOUNT_TYPE: 1,
};

/**
 * Resolve which line an account belongs to.
 *
 * Exported because the same resolution answers "why is this account on that
 * line?" for a user staring at a statement, and because it is worth testing
 * on its own.
 */
export function resolveLineForAccount(
  account: AccountBalance,
  lines: readonly ReportLine[],
): ReportLine | undefined {
  let best: { line: ReportLine; priority: number; specificity: number } | undefined;

  for (const line of lines) {
    if (line.lineType !== 'DETAIL' || !line.accountMaps) continue;

    for (const map of line.accountMaps) {
      if (!matches(account, map)) continue;

      const candidate = {
        line,
        priority: map.priority,
        specificity: MATCH_SPECIFICITY[map.matchType],
      };

      if (
        !best ||
        candidate.priority > best.priority ||
        (candidate.priority === best.priority && candidate.specificity > best.specificity)
      ) {
        best = candidate;
      }
    }
  }

  return best?.line;
}

function matches(account: AccountBalance, map: AccountMap): boolean {
  switch (map.matchType) {
    case 'ACCOUNT_ID':
      return account.accountId === map.matchValue;

    case 'ACCOUNT_TYPE':
      return account.type === map.matchValue;

    case 'TAG':
      return account.tags.includes(map.matchValue);
  }
}

/**
 * Render a statement.
 *
 * Refuses rather than guesses: an unmapped account with a balance, a CALC line
 * with no supplied value, or a broken line tree all produce violations.
 */
export function evaluateReport(
  definition: ReportDefinition,
  balances: readonly AccountBalance[],
  options: EvaluateOptions,
): Result<RenderedReport, ReportViolation[]> {
  const violations: ReportViolation[] = [];
  const { baseCurrency } = options;

  // --- structural checks ---------------------------------------------------
  const byId = new Map(definition.lines.map((l) => [l.id, l]));

  for (const line of definition.lines) {
    if (line.accountMaps?.length && line.lineType !== 'DETAIL') {
      violations.push({ code: 'ACCOUNTS_ON_NON_DETAIL_LINE', lineId: line.id });
    }
    if (line.parentLineId && !byId.has(line.parentLineId)) {
      violations.push({
        code: 'UNKNOWN_PARENT_LINE',
        lineId: line.id,
        parentLineId: line.parentLineId,
      });
    }
  }

  for (const line of definition.lines) {
    const seen = new Set<string>([line.id]);
    let cursor = line.parentLineId;
    while (cursor) {
      if (seen.has(cursor)) {
        violations.push({ code: 'CYCLIC_LINE_TREE', lineId: line.id });
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentLineId;
    }
  }

  if (violations.length > 0) return err(violations);

  // --- map accounts to lines -----------------------------------------------
  const assign = (
    source: readonly AccountBalance[],
  ): { byLine: Map<string, AccountBalance[]>; unmapped: AccountBalance[] } => {
    const byLine = new Map<string, AccountBalance[]>();
    const unmapped: AccountBalance[] = [];

    for (const account of source) {
      const line = resolveLineForAccount(account, definition.lines);
      if (!line) {
        // A zero-balance account that maps nowhere is harmless — it is
        // usually a chart entry the tenant never used. One with a balance is
        // money that would vanish from the statement.
        if (!account.amount.isZero()) unmapped.push(account);
        continue;
      }
      const bucket = byLine.get(line.id) ?? [];
      bucket.push(account);
      byLine.set(line.id, bucket);
    }

    return { byLine, unmapped };
  };

  const current = assign(balances);

  // A SOFP that maps a profit-and-loss account double-counts it: the same
  // money appears once in its own right and again inside current-year
  // earnings. A SOPL that maps a balance-sheet account is the mirror error.
  // Both are definition bugs a tenant can introduce by editing a layout, so
  // they are caught here rather than trusted not to happen.
  const misplaced: { code: string; type: AccountType; lineId: string }[] = [];

  for (const [lineId, accounts] of current.byLine) {
    for (const account of accounts) {
      const isPL = isProfitOrLossAccount(account.type);
      const wrong =
        (definition.reportType === 'SOFP' && isPL) ||
        (definition.reportType === 'SOPL' && !isPL);
      if (wrong) misplaced.push({ code: account.code, type: account.type, lineId });
    }
  }

  if (misplaced.length > 0) {
    violations.push({
      code: 'WRONG_ACCOUNT_TYPE_FOR_REPORT',
      reportType: definition.reportType,
      accounts: misplaced,
    });
  }

  if (violations.length > 0) return err(violations);

  if (current.unmapped.length > 0) {
    return err([
      {
        code: 'UNMAPPED_ACCOUNTS',
        accounts: current.unmapped.map((a) => ({
          code: a.code,
          name: a.name,
          amount: a.amount.toDecimalString(),
        })),
      },
    ]);
  }

  const comparative = options.comparative ? assign(options.comparative) : undefined;

  // --- compute -------------------------------------------------------------
  const compute = (
    byLine: Map<string, AccountBalance[]>,
  ): Result<Map<string, Money>, ReportViolation[]> => {
    const amounts = new Map<string, Money>();

    // DETAIL lines hold accounts directly.
    for (const line of definition.lines) {
      if (line.lineType === 'DETAIL') {
        const accounts = byLine.get(line.id) ?? [];
        amounts.set(line.id, sumMoney(accounts.map((a) => a.amount), baseCurrency));
      }
    }

    // CALC lines come from the caller — they depend on the fiscal calendar,
    // which the engine deliberately knows nothing about.
    for (const line of definition.lines) {
      if (line.lineType !== 'CALC') continue;
      const value = line.calcKey ? options.calcValues?.[line.calcKey] : undefined;
      if (value === undefined) {
        return err([{ code: 'MISSING_CALC_VALUE', calcKey: line.calcKey ?? 'CURRENT_YEAR_EARNINGS' }]);
      }
      amounts.set(line.id, value);
    }

    // SUBTOTAL/TOTAL lines aggregate their descendants. Walk children upward
    // so a total of totals resolves correctly regardless of declaration order.
    const childrenOf = new Map<string, string[]>();
    for (const line of definition.lines) {
      if (!line.parentLineId) continue;
      const siblings = childrenOf.get(line.parentLineId) ?? [];
      siblings.push(line.id);
      childrenOf.set(line.parentLineId, siblings);
    }

    const resolve = (lineId: string): Money => {
      const existing = amounts.get(lineId);
      if (existing) return existing;

      const total = (childrenOf.get(lineId) ?? []).reduce(
        (acc, childId) => acc.add(resolve(childId)),
        Money.zero(baseCurrency),
      );
      amounts.set(lineId, total);
      return total;
    };

    for (const line of definition.lines) {
      if (line.lineType === 'SUBTOTAL' || line.lineType === 'TOTAL' || line.lineType === 'HEADER') {
        resolve(line.id);
      }
    }

    return ok(amounts);
  };

  const computed = compute(current.byLine);
  if (!computed.ok) return err(computed.error);

  const computedComparative = comparative ? compute(comparative.byLine) : undefined;
  if (computedComparative && !computedComparative.ok) return err(computedComparative.error);

  // --- present -------------------------------------------------------------
  const present = (line: ReportLine, amount: Money): Money =>
    line.signConvention === 'INVERTED' ? amount.negate() : amount;

  const lines: RenderedLine[] = [...definition.lines]
    .sort((a, b) => a.sequence - b.sequence)
    .map((line) => {
      const raw = computed.value.get(line.id) ?? Money.zero(baseCurrency);
      const rawComparative = computedComparative?.ok
        ? computedComparative.value.get(line.id)
        : undefined;

      return {
        lineId: line.id,
        sequence: line.sequence,
        label: line.label,
        level: line.level,
        lineType: line.lineType,
        amount: present(line, raw),
        ...(rawComparative ? { comparative: present(line, rawComparative) } : {}),
        accountIds: (current.byLine.get(line.id) ?? []).map((a) => a.accountId),
      };
    });

  return ok({
    reportType: definition.reportType,
    framework: definition.framework,
    name: definition.name,
    currency: baseCurrency,
    lines,
  });
}

// ---------------------------------------------------------------------------
// Invariant #3
// ---------------------------------------------------------------------------

export interface AccountingEquation {
  readonly assets: Money;
  /** Liabilities and equity, expressed positively. */
  readonly liabilitiesAndEquity: Money;
  readonly difference: Money;
  readonly balances: boolean;
}

/**
 * Ledger invariant #3: `SUM(assets) = SUM(liabilities) + SUM(equity)`.
 *
 * Equity here INCLUDES the current year's profit or loss. Before year-end
 * close, income and expense accounts still hold the current year while
 * retained earnings holds only prior years — so folding profit or loss into
 * equity is not an adjustment, it is what makes the equation true. Omitting it
 * is the single most common reason a balance sheet does not balance.
 *
 * Takes ALL balances, including income and expense, and expects them
 * debit-positive.
 */
export function checkAccountingEquation(
  balances: readonly AccountBalance[],
  baseCurrency: Currency,
): AccountingEquation {
  const sumOf = (predicate: (b: AccountBalance) => boolean) =>
    sumMoney(balances.filter(predicate).map((b) => b.amount), baseCurrency);

  const assets = sumOf((b) => b.type === 'ASSET');
  const liabilities = sumOf((b) => b.type === 'LIABILITY');
  const equity = sumOf((b) => b.type === 'EQUITY');
  const profitOrLoss = sumOf((b) => isProfitOrLossAccount(b.type));

  // Liabilities, equity and P&L are credit-natured, so they are negative in
  // debit-positive terms. Negating expresses them the way a reader sees them.
  const liabilitiesAndEquity = liabilities.add(equity).add(profitOrLoss).negate();

  const difference = assets.subtract(liabilitiesAndEquity);

  return {
    assets,
    liabilitiesAndEquity,
    difference,
    balances: difference.isZero(),
  };
}

/**
 * Current-year earnings: the profit or loss sitting in income and expense
 * accounts that has not yet been closed to retained earnings.
 *
 * Returned DEBIT-POSITIVE, like every other amount the engine handles, so a
 * profit is negative here and an `INVERTED` equity line presents it positive.
 */
export function currentYearEarnings(
  profitAndLossBalances: readonly AccountBalance[],
  baseCurrency: Currency,
): Money {
  return sumMoney(
    profitAndLossBalances.filter((b) => isProfitOrLossAccount(b.type)).map((b) => b.amount),
    baseCurrency,
  );
}
