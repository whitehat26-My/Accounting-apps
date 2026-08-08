import {
  checkAccountingEquation,
  currentYearEarnings,
  evaluateReport,
  isErr,
  Money,
  type AccountBalance,
  type AccountType,
  type RenderedReport,
  type ReportDefinition,
  type ReportFramework,
  type ReportLine,
  type ReportType,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { loadBaseCurrency } from './invoice.js';

/**
 * Financial statements — M7, persistence layer.
 *
 * ---------------------------------------------------------------------------
 * THE ROLLUP FOR WHOLE PERIODS, THE JOURNAL FOR THE PART-PERIOD AT EACH EDGE.
 *
 * `account_period_balance` holds ONE ROW PER ACCOUNT PER PERIOD. It cannot
 * express "the first eight days of August", and for a long time these queries
 * pretended that did not matter: a period was included only if it ended on or
 * before the window's end date.
 *
 * Every statement asked for on a date that is not a period end was therefore
 * missing the period in flight — which is to say, every statement anybody runs
 * about the month they are living in. Run the profit and loss on the 8th and it
 * reported RM 0.00 of revenue while the balance sheet beside it showed the
 * year's earnings; run the balance sheet and the cash figure was days stale and
 * disagreed with the dashboard. Found by printing the Reports screen and
 * reading it, not by a failing test — there was no test that asked for a
 * mid-month window.
 *
 * So the window is now answered in two parts, and the split is the whole idea:
 *
 *   - Periods lying ENTIRELY inside the window come from the rollup. This is
 *     the overwhelming majority of any window and the reason the rollup exists;
 *     a year of history stays a handful of rows per account.
 *   - The period straddling either EDGE of the window is summed from
 *     `journal_line` by entry date. That is at most two periods — a month or a
 *     quarter of entries for one shop — and it is the only source that can
 *     answer a partial period at all.
 *
 * The two sets are exact complements (`NOT` of the same predicate) so nothing
 * is counted twice and nothing is dropped, and `journal_entry.fiscal_period_id`
 * is NOT NULL with every entry dated inside its own period, which is what makes
 * that true rather than merely likely.
 * ---------------------------------------------------------------------------
 *
 * Two further subtleties worth naming:
 *
 * 1. `account_period_balance` has `currency` in its primary key, and today
 *    `postJournalEntry()` only ever writes base-currency rows. Every rollup
 *    query below filters on the base currency explicitly anyway. If a
 *    transaction-currency row is ever written, an unfiltered SUM would
 *    double-count every foreign transaction and the balance sheet would be
 *    quietly wrong. `reportingSanityCheck()` asserts that has not happened.
 *    The journal side needs no such filter: `base_debit` / `base_credit` are
 *    already base-currency amounts, which is exactly what the rollup stores.
 *
 * 2. A cumulative balance is `SUM(net_movement)` over periods, because opening
 *    balances are real dated journal entries rather than a rollup column —
 *    see migration 0008.
 */

/**
 * A fiscal period lying ENTIRELY within the window, so its rollup row is an
 * exact answer for it. `from = null` means since inception, so only the upper
 * edge constrains it.
 *
 * Defined once and used by every statement: the whole-period rule and the
 * part-period rule below must stay exact complements, and two copies of a
 * predicate is how they stop being.
 */
function wholePeriodsIn(tx: Tx, window: { from: string | null; to: string }) {
  return tx`
        p.end_date <= ${window.to}::date
    AND (${window.from}::date IS NULL OR p.start_date >= ${window.from}::date)
  `;
}

/**
 * The part-period at each edge: entries dated inside the window, belonging to a
 * period that is NOT wholly inside it.
 *
 * ---------------------------------------------------------------------------
 * THE PERIOD BOUNDS ARE WHAT KEEP THIS CHEAP, AND THEY ARE NOT REDUNDANT.
 *
 * `NOT (wholePeriodsIn)` alone is correct but not selective: for a balance
 * sheet, `from` is null, so "entries dated on or before `to`" is the ENTIRE
 * history, and PostgreSQL would read every journal line ever posted before
 * discarding all but the current month. That is precisely the scan the rollup
 * exists to avoid, so the fix would have quietly undone the reason for the
 * table it was fixing.
 *
 * Adding "and the period overlaps the window at all" bounds the driving set to
 * AT MOST TWO periods — the one straddling each edge — which are then reached
 * through `journal_entry_period_idx` and `journal_line_entry_idx`. The query
 * plans as an index scan over one month of a shop's entries rather than a
 * sequential scan over its life.
 * ---------------------------------------------------------------------------
 *
 * `REVERSED` is included alongside `POSTED` because that is what the rollup
 * itself counts (see `detectRollupDrift`): the ledger is append-only, so a
 * reversed entry's lines still stand and are cancelled by the reversing entry's
 * own lines rather than by deletion. Counting only `POSTED` here would make the
 * journal disagree with the rollup at the seam between them.
 */
function partPeriodEntriesIn(tx: Tx, window: { from: string | null; to: string }) {
  return tx`
        NOT (${wholePeriodsIn(tx, window)})
    AND p.start_date <= ${window.to}::date
    AND (${window.from}::date IS NULL OR p.end_date >= ${window.from}::date)
    AND e.status IN ('POSTED', 'REVERSED')
    AND e.entry_date <= ${window.to}::date
    AND (${window.from}::date IS NULL OR e.entry_date >= ${window.from}::date)
  `;
}

export class ReportError extends Error {
  constructor(
    /*
     * `ACCOUNT_NOT_FOUND` is not decoration. The API's exception filter maps
     * any code ending `_NOT_FOUND` to a 404, and CLAUDE.md §9 requires that a
     * record belonging to another tenant answers 404 rather than 403 or 422 —
     * confirming it exists is what leaks. RLS has already filtered the row out
     * before this layer sees it, so "absent" and "not yours" are genuinely the
     * same case here, and they must stay the same answer.
     */
    readonly code: 'NO_TEMPLATE' | 'REPORT_INVALID' | 'NO_FISCAL_YEAR' | 'ACCOUNT_NOT_FOUND',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ReportError';
  }
}

/**
 * Account balances aggregated over a date window.
 *
 * `from = null` means since inception, which is what a balance sheet needs.
 *
 * The window is by DATE, and `to` may fall anywhere — mid-month is the normal
 * case, not the exceptional one. This docstring used to say "`to` should be a
 * fiscal period end date", which was not a contract so much as a description of
 * the bug: every caller passed today's date, and today is almost never a period
 * end. See the note at the top of this file.
 */
export async function accountBalances(
  tx: Tx,
  ctx: TenantContext,
  window: { from: string | null; to: string },
  baseCurrency: string,
  options: { readonly excludeYearEndClose?: boolean } = {},
): Promise<AccountBalance[]> {
  const rows = await tx<
    { account_id: string; code: string; name: string; type: AccountType; movement: string; tags: string[] }[]
  >`
      WITH whole AS (
          -- Periods entirely inside the window: the rollup, doing its job.
          SELECT b.account_id, SUM(b.net_movement) AS movement
            FROM account_period_balance b
            JOIN fiscal_period p
              ON p.tenant_id = b.tenant_id AND p.id = b.fiscal_period_id
           WHERE b.tenant_id = ${ctx.tenantId}
             AND b.currency = ${baseCurrency}
             AND ${wholePeriodsIn(tx, window)}
           GROUP BY b.account_id
      ),
      part AS (
          -- The period in flight at either edge, which the rollup cannot cut.
          -- Driven FROM fiscal_period: see partPeriodEntriesIn.
          SELECT l.account_id, SUM(l.base_debit - l.base_credit) AS movement
            FROM fiscal_period p
            JOIN journal_entry e
              ON e.tenant_id = p.tenant_id AND e.fiscal_period_id = p.id
            JOIN journal_line l
              ON l.tenant_id = e.tenant_id AND l.journal_entry_id = e.id
           WHERE p.tenant_id = ${ctx.tenantId}
             AND ${partPeriodEntriesIn(tx, window)}
           GROUP BY l.account_id
      )
      SELECT a.id                                   AS account_id,
             a.code,
             a.name,
             a.type,
             (COALESCE(w.movement, 0) + COALESCE(pt.movement, 0))::text
                                                    AS movement,
             COALESCE(
               ARRAY(SELECT t.tag FROM account_tag t
                      WHERE t.tenant_id = a.tenant_id AND t.account_id = a.id
                      ORDER BY t.tag),
               '{}'
             )                                      AS tags
        FROM account a
        LEFT JOIN whole w  ON w.account_id  = a.id
        LEFT JOIN part  pt ON pt.account_id = a.id
       WHERE a.tenant_id = ${ctx.tenantId}
       ORDER BY a.code
  `;

  const closing = options.excludeYearEndClose
    ? await yearEndCloseMovement(tx, ctx, window, baseCurrency)
    : new Map<string, Money>();

  return rows.map((r) => {
    const total = Money.fromDecimal(r.movement, baseCurrency);
    const closingPart = closing.get(r.account_id);

    return {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      tags: r.tags ?? [],
      amount: closingPart ? total.subtract(closingPart) : total,
    };
  });
}

/**
 * Movement contributed by year-end closing entries, so the income statement can
 * take it back out.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL.
 *
 * The closing entry is dated the LAST DAY of the year it closes — it has to be,
 * or the profit moves out of the year that earned it and every comparative
 * reading movement by date disagrees with the accounts.
 *
 * But that puts it INSIDE the window an income statement for that year asks
 * for. Run the SOPL for a closed year and the closing entry, which exists
 * precisely to zero those accounts, zeroes them in the report too: a year that
 * made RM 70,000 reports nothing. The figures are not wrong, the question is —
 * "movement in the year" and "trading in the year" stopped being the same thing
 * the moment a close was posted.
 *
 * So the P&L subtracts it and the balance sheet does not, which is exactly
 * right: the balance sheet WANTS the transfer, because that is where the profit
 * now lives.
 *
 * Read from `journal_line` rather than the rollup, deliberately. The rollup is
 * one number per account per period and cannot say which part of it came from a
 * close; adding a second column to carry that would be a denormalisation that
 * drifts. The scan is bounded by closing entries — one per year, a few lines
 * each — and hits `journal_entry_source_idx`.
 * ---------------------------------------------------------------------------
 */
async function yearEndCloseMovement(
  tx: Tx,
  ctx: TenantContext,
  window: { from: string | null; to: string },
  baseCurrency: string,
): Promise<Map<string, Money>> {
  const rows = await tx<{ account_id: string; movement: string }[]>`
      SELECT l.account_id,
             SUM(l.base_debit - l.base_credit)::text AS movement
        FROM journal_line l
        JOIN journal_entry e
          ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND e.source_document_type = 'YEAR_END_CLOSE'
         -- REVERSED included on purpose. A reopened year's closing entry and
         -- its reversal both stand in the ledger and cancel; dropping one would
         -- leave the other subtracted from the P&L on its own.
         AND e.status IN ('POSTED', 'REVERSED')
         /*
          * By ENTRY DATE, not by period containment — and this must match how
          * accountBalances decides what is in the window, or the two disagree.
          *
          * It used to ask for whole periods, which was invisible while windows
          * were always whole years: a close dated 31/12 sits in December, and
          * December is wholly inside 01/01–31/12 either way. Now that a window
          * can end mid-period, a close could be ADDED by the balance query and
          * not SUBTRACTED here, which would report a closed year's trading as
          * negative. Same rule on both sides, so they cannot drift apart.
          */
         AND e.entry_date <= ${window.to}::date
         AND (${window.from}::date IS NULL OR e.entry_date >= ${window.from}::date)
       GROUP BY l.account_id
  `;

  return new Map(rows.map((r) => [r.account_id, Money.fromDecimal(r.movement, baseCurrency)]));
}

/** Load a global statement template into the pure domain shape. */
export async function loadTemplate(
  tx: Tx,
  reportType: ReportType,
  framework: ReportFramework = 'MPERS',
): Promise<ReportDefinition> {
  const [template] = await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM report_template
       WHERE report_type = ${reportType} AND framework = ${framework} AND is_active
       ORDER BY version DESC
       LIMIT 1
  `;

  if (!template) {
    throw new ReportError('NO_TEMPLATE', `No ${framework} template for ${reportType}`);
  }

  const lineRows = await tx<
    {
      id: string; sequence: number; label: string; level: number;
      line_type: ReportLine['lineType']; parent_line_id: string | null;
      calc_key: ReportLine['calcKey'] | null;
      sign_convention: ReportLine['signConvention'];
    }[]
  >`
      SELECT id, sequence, label, level, line_type, parent_line_id, calc_key, sign_convention
        FROM report_template_line
       WHERE template_id = ${template.id}
       ORDER BY sequence
  `;

  const mapRows = await tx<
    { line_id: string; match_type: string; match_value: string; priority: number }[]
  >`
      SELECT m.line_id, m.match_type, m.match_value, m.priority
        FROM report_template_line_map m
        JOIN report_template_line l ON l.id = m.line_id
       WHERE l.template_id = ${template.id}
  `;

  type Maps = NonNullable<ReportLine['accountMaps']>;
  const mapsByLine = new Map<string, Maps[number][]>();
  for (const m of mapRows) {
    const bucket = mapsByLine.get(m.line_id) ?? [];
    bucket.push({
      matchType: m.match_type as Maps[number]['matchType'],
      matchValue: m.match_value,
      priority: m.priority,
    });
    mapsByLine.set(m.line_id, bucket);
  }

  return {
    reportType,
    framework,
    name: template.name,
    lines: lineRows.map((r) => ({
      id: r.id,
      sequence: r.sequence,
      label: r.label,
      level: r.level,
      lineType: r.line_type,
      ...(r.parent_line_id ? { parentLineId: r.parent_line_id } : {}),
      ...(r.calc_key ? { calcKey: r.calc_key } : {}),
      signConvention: r.sign_convention,
      accountMaps: mapsByLine.get(r.id) ?? [],
    })),
  };
}

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

export interface SoplOptions {
  readonly from: string;
  readonly to: string;
  readonly comparative?: { from: string; to: string };
  readonly framework?: ReportFramework;
}

export async function statementOfProfitOrLoss(
  tx: Tx,
  ctx: TenantContext,
  options: SoplOptions,
): Promise<RenderedReport> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const definition = await loadTemplate(tx, 'SOPL', options.framework ?? 'MPERS');

  // `excludeYearEndClose` — see `yearEndCloseMovement`. Without it, running
  // this statement for a year that has been CLOSED reports zero trading,
  // because the closing entry is dated inside the window and exists to zero
  // exactly these accounts.
  const all = await accountBalances(
    tx, ctx, { from: options.from, to: options.to }, baseCurrency,
    { excludeYearEndClose: true },
  );
  const profitAndLoss = all.filter((b) => b.type === 'INCOME' || b.type === 'EXPENSE');

  const comparative = options.comparative
    ? (
        await accountBalances(tx, ctx, options.comparative, baseCurrency, {
          excludeYearEndClose: true,
        })
      ).filter((b) => b.type === 'INCOME' || b.type === 'EXPENSE')
    : undefined;

  const rendered = evaluateReport(definition, profitAndLoss, {
    baseCurrency,
    ...(comparative ? { comparative } : {}),
  });

  if (isErr(rendered)) {
    throw new ReportError('REPORT_INVALID', 'Could not render the SOPL', rendered.error);
  }
  return rendered.value;
}

export interface SofpOptions {
  readonly asOfDate: string;
  readonly comparativeAsOfDate?: string;
  readonly framework?: ReportFramework;
}

/**
 * The balance sheet.
 *
 * Current-year earnings is computed from profit-and-loss MOVEMENT since the
 * start of the fiscal year containing `asOfDate` — never from an account
 * balance. That is what makes the statement balance whether or not a year-end
 * close has been posted, which for an SME product is most of the time.
 */
export async function statementOfFinancialPosition(
  tx: Tx,
  ctx: TenantContext,
  options: SofpOptions,
): Promise<RenderedReport> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const definition = await loadTemplate(tx, 'SOFP', options.framework ?? 'MPERS');

  const render = async (asOf: string) => {
    const cumulative = await accountBalances(tx, ctx, { from: null, to: asOf }, baseCurrency);
    const balanceSheet = cumulative.filter((b) => b.type !== 'INCOME' && b.type !== 'EXPENSE');

    const fiscalYearStart = await fiscalYearStartFor(tx, ctx, asOf);
    const yearToDate = await accountBalances(
      tx, ctx, { from: fiscalYearStart, to: asOf }, baseCurrency,
    );

    return {
      balanceSheet,
      earnings: currentYearEarnings(yearToDate, baseCurrency),
      // Retained: everything before the current fiscal year, already sitting in
      // the equity accounts' cumulative movement plus prior-year P&L that was
      // never closed. Both are in `cumulative`, so nothing extra is needed here
      // beyond keeping prior-year P&L OUT of the current-year figure above.
      cumulative,
    };
  };

  const current = await render(options.asOfDate);
  const comparative = options.comparativeAsOfDate
    ? await render(options.comparativeAsOfDate)
    : undefined;

  const rendered = evaluateReport(definition, current.balanceSheet, {
    baseCurrency,
    calcValues: { CURRENT_YEAR_EARNINGS: current.earnings },
    ...(comparative ? { comparative: comparative.balanceSheet } : {}),
  });

  if (isErr(rendered)) {
    throw new ReportError('REPORT_INVALID', 'Could not render the SOFP', rendered.error);
  }
  return rendered.value;
}

/**
 * Ledger invariant #3, checked against the ledger rather than a presentation.
 *
 * Distinct from the SOFP balancing: this catches a mistyped account, while a
 * balanced SOFP additionally proves nothing was dropped by the mapping.
 */
export async function accountingEquationAt(
  tx: Tx,
  ctx: TenantContext,
  asOfDate: string,
): Promise<ReturnType<typeof checkAccountingEquation>> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const balances = await accountBalances(tx, ctx, { from: null, to: asOfDate }, baseCurrency);
  return checkAccountingEquation(balances, baseCurrency);
}

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly debit: string;
  readonly credit: string;
}

/**
 * The report trial balance: debit and credit totals over a window.
 *
 * Distinct from `trialBalance()` in ledger.ts, which is the ledger's own
 * single-period diagnostic. Overloading one function with both would make each
 * caller guess which semantics it got.
 */
export async function trialBalanceReport(
  tx: Tx,
  ctx: TenantContext,
  window: { from: string | null; to: string },
): Promise<{ rows: TrialBalanceRow[]; totalDebit: string; totalCredit: string; balanced: boolean }> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const rows = await tx<
    { account_id: string; code: string; name: string; type: AccountType; debit: string; credit: string }[]
  >`
      WITH whole AS (
          SELECT b.account_id,
                 SUM(b.debit_total)  AS debit,
                 SUM(b.credit_total) AS credit
            FROM account_period_balance b
            JOIN fiscal_period p
              ON p.tenant_id = b.tenant_id AND p.id = b.fiscal_period_id
           WHERE b.tenant_id = ${ctx.tenantId}
             AND b.currency = ${baseCurrency}
             AND ${wholePeriodsIn(tx, window)}
           GROUP BY b.account_id
      ),
      part AS (
          /*
           * Debit and credit kept APART, never netted. A trial balance whose
           * two columns were derived from one signed movement could not show
           * an account that took RM 500 in and RM 500 out — and "both columns
           * are zero" is a different fact from "nothing happened here".
           */
          SELECT l.account_id,
                 SUM(l.base_debit)  AS debit,
                 SUM(l.base_credit) AS credit
            FROM fiscal_period p
            JOIN journal_entry e
              ON e.tenant_id = p.tenant_id AND e.fiscal_period_id = p.id
            JOIN journal_line l
              ON l.tenant_id = e.tenant_id AND l.journal_entry_id = e.id
           WHERE p.tenant_id = ${ctx.tenantId}
             AND ${partPeriodEntriesIn(tx, window)}
           GROUP BY l.account_id
      ),
      totals AS (
          SELECT a.id AS account_id, a.code, a.name, a.type,
                 COALESCE(w.debit,  0) + COALESCE(pt.debit,  0) AS debit,
                 COALESCE(w.credit, 0) + COALESCE(pt.credit, 0) AS credit
            FROM account a
            LEFT JOIN whole w  ON w.account_id  = a.id
            LEFT JOIN part  pt ON pt.account_id = a.id
           WHERE a.tenant_id = ${ctx.tenantId}
      )
      SELECT account_id, code, name, type, debit::text, credit::text
        FROM totals
       WHERE debit <> 0 OR credit <> 0
       ORDER BY code
  `;

  const totalDebit = rows.reduce(
    (acc, r) => acc.add(Money.fromDecimal(r.debit, baseCurrency)),
    Money.zero(baseCurrency),
  );
  const totalCredit = rows.reduce(
    (acc, r) => acc.add(Money.fromDecimal(r.credit, baseCurrency)),
    Money.zero(baseCurrency),
  );

  return {
    rows: rows.map((r) => ({
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      debit: r.debit,
      credit: r.credit,
    })),
    totalDebit: totalDebit.toDecimalString(),
    totalCredit: totalCredit.toDecimalString(),
    balanced: totalDebit.equals(totalCredit),
  };
}

/**
 * Guards the assumption every query here rests on: the rollup holds
 * base-currency rows only.
 *
 * If a transaction-currency row is ever written, every statement double-counts
 * foreign activity silently. Cheap to check, catastrophic to miss.
 */
export async function reportingSanityCheck(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ foreignCurrencyRollupRows: number }> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const [row] = await tx<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
        FROM account_period_balance
       WHERE tenant_id = ${ctx.tenantId} AND currency <> ${baseCurrency}
  `;
  return { foreignCurrencyRollupRows: Number(row!.count) };
}

// ------------------------------------------------------------------ internals

async function fiscalYearStartFor(
  tx: Tx,
  ctx: TenantContext,
  date: string,
): Promise<string> {
  const [row] = await tx<{ start_date: Date }[]>`
      SELECT start_date FROM fiscal_year
       WHERE tenant_id = ${ctx.tenantId}
         AND ${date}::date BETWEEN start_date AND end_date
  `;

  if (!row) {
    throw new ReportError(
      'NO_FISCAL_YEAR',
      `No fiscal year covers ${date}. Current-year earnings cannot be determined without one.`,
    );
  }

  return row.start_date.toISOString().slice(0, 10);
}
