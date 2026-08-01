import {
  buildCashFlowStatement,
  buildEquityStatement,
  checkCashFlow,
  checkEquityStatement,
  Money,
  type AccountBalance,
  type AccountType,
  type CashFlowActivity,
  type CashFlowAccount,
  type CashFlowCheck,
  type CashFlowEntry,
  type CashFlowStatement,
  type EquityStatement,
  type EquityStatementCheck,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { loadBaseCurrency } from './invoice.js';
import { accountBalances, ReportError } from './report.js';

/**
 * Cash flow and changes in equity — the two primary statements M7 did not
 * produce.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE READS `journal_line`, AND THAT IS A DELIBERATE DEPARTURE.
 *
 * `report.ts` reads only `account_period_balance` and says so loudly: the
 * rollup exists so a balance sheet does not scan millions of rows, and going to
 * the journal there would give up the reason it exists.
 *
 * A direct-method cash flow statement cannot be built that way. The whole
 * question it answers — what was the money FOR — lives in the relationship
 * between a cash line and the other lines of the same entry, and a per-account
 * per-period rollup has thrown that relationship away. No amount of cleverness
 * recovers it.
 *
 * The scan is bounded rather than unbounded, which is what makes it acceptable:
 * only entries that TOUCH a cash account are read, found through
 * `journal_line_account_idx`. For a business that does not journal against its
 * bank account thousands of times a month, that is a small fraction of the
 * ledger. If it ever stops being small, the fix is a materialised
 * classification per entry — not a reconstruction from the rollup, which would
 * be guessing.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Classification — the configuration the statement needs
// ---------------------------------------------------------------------------

export interface CashFlowClassificationRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly classification: CashFlowActivity;
  readonly note: string | null;
  readonly decidedAt: string;
}

export async function listCashFlowClassifications(
  tx: Tx,
  ctx: TenantContext,
): Promise<CashFlowClassificationRow[]> {
  const rows = await tx<
    {
      account_id: string; code: string; name: string; type: AccountType;
      classification: CashFlowActivity; note: string | null; decided_at: Date;
    }[]
  >`
      SELECT c.account_id, a.code, a.name, a.type,
             c.classification, c.note, c.decided_at
        FROM cash_flow_classification c
        JOIN account a ON a.tenant_id = c.tenant_id AND a.id = c.account_id
       WHERE c.tenant_id = ${ctx.tenantId}
       ORDER BY a.code
  `;

  return rows.map((r) => ({
    accountId: r.account_id,
    code: r.code,
    name: r.name,
    type: r.type,
    classification: r.classification,
    note: r.note,
    decidedAt: r.decided_at.toISOString(),
  }));
}

/**
 * Record — or change — how an account's movements are classified.
 *
 * Written as a financial event, because changing one retrospectively changes
 * every cash flow statement the business has ever produced, including ones
 * already sent to a bank. That is a configuration change an auditor asks about
 * by name, and it is logged the same way a statutory rate change is.
 */
export async function setCashFlowClassification(
  tx: Tx,
  ctx: TenantContext,
  input: {
    accountId: string;
    classification: CashFlowActivity;
    note?: string;
  },
): Promise<CashFlowClassificationRow> {
  const [account] = await tx<{ id: string; code: string; name: string; type: AccountType }[]>`
      SELECT id, code, name, type FROM account
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.accountId}
  `;

  // 404, not 403, and not a distinct "wrong tenant" answer — see CLAUDE.md §9.
  if (!account) {
    throw new ReportError('ACCOUNT_NOT_FOUND', `No account ${input.accountId}`);
  }

  // Income, expense and equity resolve from their type alone. Storing a row for
  // one is not wrong, but it is a lever with nothing on the end of it, and a
  // user who sets it will reasonably expect it to have done something.
  if (account.type !== 'ASSET' && account.type !== 'LIABILITY') {
    throw new ReportError(
      'REPORT_INVALID',
      `Account ${account.code} is ${account.type}; its cash flow activity follows from its type ` +
        'and cannot be overridden. Only assets and liabilities need a decision.',
    );
  }

  // `decided_by` is NOT NULL by design: a classification is a judgement, and a
  // judgement with nobody attached to it is the thing an auditor cannot follow
  // up. There is no system path that sets one, so there is no case to allow.
  if (!ctx.userId) {
    throw new ReportError(
      'REPORT_INVALID',
      'A cash flow classification records who decided it; this call has no user',
    );
  }

  const [previous] = await tx<{ classification: CashFlowActivity }[]>`
      SELECT classification FROM cash_flow_classification
       WHERE tenant_id = ${ctx.tenantId} AND account_id = ${input.accountId}
  `;

  const [row] = await tx<{ decided_at: Date }[]>`
      INSERT INTO cash_flow_classification
             (tenant_id, account_id, classification, note, decided_by)
      VALUES (${ctx.tenantId}, ${input.accountId}, ${input.classification},
              ${input.note ?? null}, ${ctx.userId})
      ON CONFLICT (tenant_id, account_id) DO UPDATE
         SET classification = EXCLUDED.classification,
             note           = EXCLUDED.note,
             decided_by     = EXCLUDED.decided_by,
             decided_at     = now()
      RETURNING decided_at
  `;

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
              ${ctx.tenantId}, 'CASH_FLOW_CLASSIFICATION_CHANGED', ${ctx.userId},
              'org.manage', 'account', ${input.accountId},
              ${tx.json({
                code: account.code,
                from: previous?.classification ?? null,
                to: input.classification,
                ...(input.note !== undefined ? { note: input.note } : {}),
              })})
  `;

  return {
    accountId: input.accountId,
    code: account.code,
    name: account.name,
    type: account.type,
    classification: input.classification,
    note: input.note ?? null,
    decidedAt: row!.decided_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

export interface CashFlowOptions {
  readonly from: string;
  readonly to: string;
}

export interface CashFlowResult {
  readonly statement: CashFlowStatement;
  readonly check: CashFlowCheck;
  /**
   * Whether the rollup agrees with the journal about closing cash.
   *
   * The statement is built from `journal_line` while the balance sheet is built
   * from `account_period_balance`. If they disagree, one of the two statements
   * a reader is holding is wrong, and this says so instead of leaving them to
   * discover it by subtraction.
   */
  readonly rollupAgrees: boolean;
  readonly rollupClosingCash: string;
}

export async function cashFlowStatement(
  tx: Tx,
  ctx: TenantContext,
  options: CashFlowOptions,
): Promise<CashFlowResult> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const cashRows = await tx<{ account_id: string }[]>`
      SELECT account_id FROM cash_account WHERE tenant_id = ${ctx.tenantId}
  `;
  const cashAccountIds = new Set(cashRows.map((r) => r.account_id));

  if (cashAccountIds.size === 0) {
    // Refusing beats returning a statement of nothing. An empty pool means no
    // bank account has been set up and no account carries `cash_and_bank`, and
    // a cash flow statement of RM 0.00 would read as "no cash moved" rather
    // than "nothing was configured".
    throw new ReportError(
      'REPORT_INVALID',
      'No cash or bank accounts are configured, so there is no cash to report a flow of. ' +
        'Add a bank account, or tag the relevant GL accounts `cash_and_bank`.',
    );
  }

  const accounts = await loadCashFlowAccounts(tx, ctx);
  const overrides = await loadOverrides(tx, ctx);

  // Every line of every entry that touched cash in the window. All the lines,
  // not just the non-cash ones: the decomposition identity is only true for a
  // complete entry, and `checkCashFlow` verifies that rather than trusting it.
  const lineRows = await tx<
    {
      entry_id: string; entry_no: string; entry_date: Date; description: string | null;
      account_id: string; amount: string;
    }[]
  >`
      WITH touching AS (
          SELECT DISTINCT e.id
            FROM journal_entry e
            JOIN journal_line l
              ON l.tenant_id = e.tenant_id AND l.journal_entry_id = e.id
           WHERE e.tenant_id = ${ctx.tenantId}
             AND e.status IN ('POSTED', 'REVERSED')
             AND e.entry_date BETWEEN ${options.from}::date AND ${options.to}::date
             AND l.account_id IN (SELECT account_id FROM cash_account
                                   WHERE tenant_id = ${ctx.tenantId})
      )
      SELECT e.id                              AS entry_id,
             e.entry_no,
             e.entry_date,
             e.description,
             l.account_id,
             (l.base_debit - l.base_credit)::text AS amount
        FROM touching t
        JOIN journal_entry e ON e.tenant_id = ${ctx.tenantId} AND e.id = t.id
        JOIN journal_line  l ON l.tenant_id = ${ctx.tenantId} AND l.journal_entry_id = e.id
       ORDER BY e.entry_date, e.entry_no, l.line_no
  `;

  const entryById = new Map<string, { entry: CashFlowEntry; lines: CashFlowEntry['lines'][number][] }>();

  for (const r of lineRows) {
    const existing = entryById.get(r.entry_id);
    const line = { accountId: r.account_id, amount: Money.fromDecimal(r.amount, baseCurrency) };

    if (existing) {
      existing.lines.push(line);
      continue;
    }

    entryById.set(r.entry_id, {
      entry: {
        entryId: r.entry_id,
        entryNo: r.entry_no,
        entryDate: isoDate(r.entry_date),
        ...(r.description ? { description: r.description } : {}),
        lines: [],
      },
      lines: [line],
    });
  }

  const entries: CashFlowEntry[] = [...entryById.values()].map((v) => ({
    ...v.entry,
    lines: v.lines,
  }));

  const openingCash = await cashAt(tx, ctx, options.from, baseCurrency, 'BEFORE');
  const closingCash = await cashAt(tx, ctx, options.to, baseCurrency, 'THROUGH');

  const statement = buildCashFlowStatement({
    periodStart: options.from,
    periodEnd: options.to,
    baseCurrency,
    cashAccountIds,
    accounts,
    overrides,
    entries,
    openingCash,
    closingCash,
  });

  // The rollup's opinion of the same figure, from the other side of the system.
  const rollup = await accountBalances(tx, ctx, { from: null, to: options.to }, baseCurrency);
  const rollupClosingCash = rollup
    .filter((b) => cashAccountIds.has(b.accountId))
    .reduce((acc, b) => acc.add(b.amount), Money.zero(baseCurrency));

  return {
    statement,
    check: checkCashFlow(statement, entries),
    rollupAgrees: rollupClosingCash.equals(closingCash),
    rollupClosingCash: rollupClosingCash.toDecimalString(),
  };
}

// ---------------------------------------------------------------------------
// Changes in equity
// ---------------------------------------------------------------------------

export interface EquityStatementOptions {
  readonly from: string;
  readonly to: string;
}

export interface EquityStatementResult {
  readonly statement: EquityStatement;
  readonly check: EquityStatementCheck;
}

/**
 * The statement of changes in equity, tied to the balance sheet.
 *
 * `balanceSheetEquity` is assets less liabilities at `to` — computed here from
 * the ledger rather than from the statement itself, so the check is a genuine
 * cross-check rather than an identity restated.
 */
export async function equityStatement(
  tx: Tx,
  ctx: TenantContext,
  options: EquityStatementOptions,
): Promise<EquityStatementResult> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  // The last period boundary before the window opens. `accountBalances` windows
  // on whole fiscal periods, so "the day before `from`" has to be expressed as
  // "through the period that ended before `from`".
  const [priorEnd] = await tx<{ end_date: Date | null }[]>`
      SELECT MAX(end_date) AS end_date FROM fiscal_period
       WHERE tenant_id = ${ctx.tenantId} AND end_date < ${options.from}::date
  `;

  const openingThrough = priorEnd?.end_date ? isoDate(priorEnd.end_date) : null;

  const openingAll = openingThrough
    ? await accountBalances(tx, ctx, { from: null, to: openingThrough }, baseCurrency)
    : [];
  const closingAll = await accountBalances(tx, ctx, { from: null, to: options.to }, baseCurrency);
  const periodAll = await accountBalances(
    tx,
    ctx,
    { from: options.from, to: options.to },
    baseCurrency,
  );

  const equityOnly = (rows: readonly AccountBalance[]) => rows.filter((b) => b.type === 'EQUITY');
  const profitOnly = (rows: readonly AccountBalance[]) =>
    rows.filter((b) => b.type === 'INCOME' || b.type === 'EXPENSE');

  const sum = (rows: readonly AccountBalance[]) =>
    rows.reduce((acc, b) => acc.add(b.amount), Money.zero(baseCurrency));

  const statement = buildEquityStatement({
    periodStart: options.from,
    periodEnd: options.to,
    baseCurrency,
    openingBalances: equityOnly(openingAll),
    closingBalances: equityOnly(closingAll),
    openingUnclosedProfit: sum(profitOnly(openingAll)),
    profitForPeriod: sum(profitOnly(periodAll)),
  });

  /*
   * Assets less liabilities, credit-positive: what the balance sheet says
   * equity must be, arrived at without reference to any equity account.
   *
   * NO negation, and the sign is worth spelling out because getting it backwards
   * is easy and the integration test is what caught it. Debit-positive, the
   * ledger sums to zero:
   *
   *     assets + liabilities + equity + profit/loss = 0
   *
   * Liabilities are credit-natured and therefore already negative here, so
   * `assets + liabilities` IS net assets. And rearranging gives
   * `-(equity + P&L) = assets + liabilities` — the left-hand side being exactly
   * the credit-positive equity the statement reports. So the sum is the answer
   * as it stands.
   */
  const balanceSheetEquity = sum(closingAll.filter((b) => b.type === 'ASSET'))
    .add(sum(closingAll.filter((b) => b.type === 'LIABILITY')));

  return {
    statement,
    check: checkEquityStatement(statement, balanceSheetEquity),
  };
}

// ------------------------------------------------------------------ internals

async function loadCashFlowAccounts(
  tx: Tx,
  ctx: TenantContext,
): Promise<Map<string, CashFlowAccount>> {
  const rows = await tx<
    { id: string; code: string; name: string; type: AccountType; tags: string[] }[]
  >`
      SELECT a.id, a.code, a.name, a.type,
             COALESCE(
               ARRAY(SELECT t.tag FROM account_tag t
                      WHERE t.tenant_id = a.tenant_id AND t.account_id = a.id
                      ORDER BY t.tag),
               '{}'
             ) AS tags
        FROM account a
       WHERE a.tenant_id = ${ctx.tenantId}
  `;

  return new Map(
    rows.map((r) => [
      r.id,
      { accountId: r.id, code: r.code, name: r.name, type: r.type, tags: r.tags ?? [] },
    ]),
  );
}

async function loadOverrides(
  tx: Tx,
  ctx: TenantContext,
): Promise<Map<string, CashFlowActivity>> {
  const rows = await tx<{ account_id: string; classification: CashFlowActivity }[]>`
      SELECT account_id, classification FROM cash_flow_classification
       WHERE tenant_id = ${ctx.tenantId}
  `;
  return new Map(rows.map((r) => [r.account_id, r.classification]));
}

/**
 * Cash held at a boundary, from the journal.
 *
 * From `journal_line` rather than the rollup on purpose: the statement's
 * movement side comes from the journal, and an opening balance from a different
 * source would make the reconciliation check compare two systems instead of
 * checking one. The rollup's answer is fetched separately and compared, which
 * is the more useful version of the same question.
 */
async function cashAt(
  tx: Tx,
  ctx: TenantContext,
  boundary: string,
  baseCurrency: string,
  mode: 'BEFORE' | 'THROUGH',
): Promise<Money> {
  // One comparison with a day offset rather than two SQL fragments: `<= from - 1`
  // is `< from`, and a single shape cannot drift between the two call sites.
  const offsetDays = mode === 'BEFORE' ? 1 : 0;

  const [row] = await tx<{ amount: string }[]>`
      SELECT COALESCE(SUM(l.base_debit - l.base_credit), 0)::text AS amount
        FROM journal_line l
        JOIN journal_entry e
          ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND e.status IN ('POSTED', 'REVERSED')
         AND e.entry_date <= (${boundary}::date - ${offsetDays}::int)
         AND l.account_id IN (SELECT account_id FROM cash_account
                               WHERE tenant_id = ${ctx.tenantId})
  `;

  return Money.fromDecimal(row!.amount, baseCurrency);
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
