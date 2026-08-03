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
 * Reads ONLY `account_period_balance`, never `journal_line`. The rollup exists
 * so a balance sheet does not scan millions of rows; going to the journal here
 * would give up the reason it exists.
 *
 * Two subtleties worth naming:
 *
 * 1. `account_period_balance` has `currency` in its primary key, and today
 *    `postJournalEntry()` only ever writes base-currency rows. Every query
 *    below filters on the base currency explicitly anyway. If a
 *    transaction-currency row is ever written, an unfiltered SUM would
 *    double-count every foreign transaction and the balance sheet would be
 *    quietly wrong. `reportingSanityCheck()` asserts that has not happened.
 *
 * 2. A cumulative balance is `SUM(net_movement)` over periods, because opening
 *    balances are real dated journal entries rather than a rollup column —
 *    see migration 0008.
 */

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
 * Account balances aggregated over a period window.
 *
 * `from = null` means since inception, which is what a balance sheet needs.
 * The window is period-based: `to` should be a fiscal period end date.
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
      SELECT a.id                                   AS account_id,
             a.code,
             a.name,
             a.type,
             -- Conditional sum, not a WHERE filter. With a LEFT JOIN, a rollup
             -- row whose period falls outside the window survives with p.*
             -- NULL and would otherwise still be summed.
             COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN b.net_movement ELSE 0 END), 0)::text
                                                    AS movement,
             COALESCE(
               ARRAY(SELECT t.tag FROM account_tag t
                      WHERE t.tenant_id = a.tenant_id AND t.account_id = a.id
                      ORDER BY t.tag),
               '{}'
             )                                      AS tags
        FROM account a
        LEFT JOIN account_period_balance b
               ON b.tenant_id = a.tenant_id
              AND b.account_id = a.id
              AND b.currency = ${baseCurrency}
        LEFT JOIN fiscal_period p
               ON p.tenant_id = b.tenant_id
              AND p.id = b.fiscal_period_id
              AND p.end_date <= ${window.to}::date
              AND (${window.from}::date IS NULL OR p.start_date >= ${window.from}::date)
       WHERE a.tenant_id = ${ctx.tenantId}
       GROUP BY a.id, a.code, a.name, a.type, a.tenant_id
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
        JOIN fiscal_period p
          ON p.tenant_id = e.tenant_id AND p.id = e.fiscal_period_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND e.source_document_type = 'YEAR_END_CLOSE'
         -- REVERSED included on purpose. A reopened year's closing entry and
         -- its reversal both stand in the ledger and cancel; dropping one would
         -- leave the other subtracted from the P&L on its own.
         AND e.status IN ('POSTED', 'REVERSED')
         AND p.end_date <= ${window.to}::date
         AND (${window.from}::date IS NULL OR p.start_date >= ${window.from}::date)
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
      SELECT a.id AS account_id, a.code, a.name, a.type,
             COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN b.debit_total  ELSE 0 END), 0)::text AS debit,
             COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN b.credit_total ELSE 0 END), 0)::text AS credit
        FROM account a
        LEFT JOIN account_period_balance b
               ON b.tenant_id = a.tenant_id AND b.account_id = a.id
              AND b.currency = ${baseCurrency}
        LEFT JOIN fiscal_period p
               ON p.tenant_id = b.tenant_id AND p.id = b.fiscal_period_id
              AND p.end_date <= ${window.to}::date
              AND (${window.from}::date IS NULL OR p.start_date >= ${window.from}::date)
       WHERE a.tenant_id = ${ctx.tenantId}
       GROUP BY a.id, a.code, a.name, a.type
       HAVING COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN b.debit_total  ELSE 0 END), 0) <> 0
           OR COALESCE(SUM(CASE WHEN p.id IS NOT NULL THEN b.credit_total ELSE 0 END), 0) <> 0
       ORDER BY a.code
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
