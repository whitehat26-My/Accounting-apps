import { Money, toCsv, type AccountType } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { loadBaseCurrency } from './invoice.js';
import { ReportError } from './report.js';

/**
 * The general ledger detail report, and the journal report.
 *
 * ---------------------------------------------------------------------------
 * THE REPORT AN AUDITOR ASKS FOR FIRST, AND THE ONE THIS SYSTEM COULD NOT
 * PRODUCE.
 *
 * Trial balance, profit and loss and balance sheet all summarise. The question
 * that follows every one of them is "show me what is IN that figure" — and
 * until now the only answer was a database query. An accounting product whose
 * general ledger can only be read with `psql` is not one an accountant can
 * defend in a review.
 *
 * Two shapes, because two different questions get asked:
 *
 *   * GENERAL LEDGER — one account, every posting, in date order, with a
 *     RUNNING BALANCE. Answers "how did this account get to RM 47,300?"
 *   * JOURNAL — every entry in a window, grouped, both sides shown. Answers
 *     "what was posted on the 14th, and by whom?"
 *
 * The running balance is computed here rather than in the client, because it
 * has to start from the balance brought forward — a client that only received
 * the window's rows would produce a running balance that starts at zero and is
 * wrong on every line.
 * ---------------------------------------------------------------------------
 */

export interface GeneralLedgerRow {
  readonly entryId: string;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly description: string | null;
  readonly lineDescription: string | null;
  readonly sourceModule: string;
  readonly sourceDocumentType: string | null;
  readonly sourceDocumentId: string | null;
  readonly contactName: string | null;
  /** The other accounts in the same entry — what this posting was against. */
  readonly contraAccounts: readonly string[];
  readonly debit: string;
  readonly credit: string;
  /** Balance after this line, debit-positive. */
  readonly balance: string;
  readonly reversed: boolean;
}

export interface GeneralLedger {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly from: string;
  readonly to: string;
  readonly openingBalance: string;
  readonly closingBalance: string;
  readonly totalDebit: string;
  readonly totalCredit: string;
  readonly rows: readonly GeneralLedgerRow[];
  /** True when `rows` was truncated by `limit`; the totals still cover all. */
  readonly truncated: boolean;
}

export interface GeneralLedgerOptions {
  readonly accountId: string;
  readonly from: string;
  readonly to: string;
  /** Defaults to 5,000 — enough for a year of a busy account, bounded. */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 5_000;

export async function generalLedger(
  tx: Tx,
  ctx: TenantContext,
  options: GeneralLedgerOptions,
): Promise<GeneralLedger> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT);

  const [account] = await tx<{ id: string; code: string; name: string; type: AccountType }[]>`
      SELECT id, code, name, type FROM account
       WHERE tenant_id = ${ctx.tenantId} AND id = ${options.accountId}
  `;

  // 404 rather than a distinguishable "not yours" — CLAUDE.md §9.
  if (!account) {
    throw new ReportError('ACCOUNT_NOT_FOUND', `No account ${options.accountId}`);
  }

  const [opening] = await tx<{ amount: string }[]>`
      SELECT COALESCE(SUM(l.base_debit - l.base_credit), 0)::text AS amount
        FROM journal_line l
        JOIN journal_entry e
          ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND l.account_id = ${options.accountId}
         AND e.status IN ('POSTED', 'REVERSED')
         AND e.entry_date < ${options.from}::date
  `;

  // Totals over the whole window, computed independently of the row page so a
  // truncated report still foots. A report whose total is the sum of the rows
  // it happened to return is worse than no total.
  const [totals] = await tx<{ debit: string; credit: string; count: string }[]>`
      SELECT COALESCE(SUM(l.base_debit), 0)::text  AS debit,
             COALESCE(SUM(l.base_credit), 0)::text AS credit,
             COUNT(*)::text                        AS count
        FROM journal_line l
        JOIN journal_entry e
          ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND l.account_id = ${options.accountId}
         AND e.status IN ('POSTED', 'REVERSED')
         AND e.entry_date BETWEEN ${options.from}::date AND ${options.to}::date
  `;

  const rows = await tx<
    {
      entry_id: string; entry_no: string; entry_date: Date;
      description: string | null; line_description: string | null;
      source_module: string; source_document_type: string | null;
      source_document_id: string | null; contact_name: string | null;
      contra: string[]; debit: string; credit: string; status: string;
    }[]
  >`
      SELECT e.id AS entry_id, e.entry_no, e.entry_date,
             e.description, l.description AS line_description,
             e.source_module, e.source_document_type, e.source_document_id,
             c.name AS contact_name,
             e.status,
             l.base_debit::text  AS debit,
             l.base_credit::text AS credit,
             -- What the posting was against. The single most useful column on
             -- a general ledger and the one a raw journal_line query lacks.
             COALESCE(ARRAY(
                 SELECT DISTINCT oa.code || ' ' || oa.name
                   FROM journal_line ol
                   JOIN account oa
                     ON oa.tenant_id = ol.tenant_id AND oa.id = ol.account_id
                  WHERE ol.tenant_id = l.tenant_id
                    AND ol.journal_entry_id = l.journal_entry_id
                    AND ol.account_id <> l.account_id
                  ORDER BY oa.code || ' ' || oa.name
             ), '{}') AS contra
        FROM journal_line l
        JOIN journal_entry e
          ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
        LEFT JOIN contact c
          ON c.tenant_id = l.tenant_id AND c.id = l.contact_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND l.account_id = ${options.accountId}
         AND e.status IN ('POSTED', 'REVERSED')
         AND e.entry_date BETWEEN ${options.from}::date AND ${options.to}::date
       ORDER BY e.entry_date, e.entry_no, l.line_no
       LIMIT ${limit}
  `;

  const openingBalance = Money.fromDecimal(opening!.amount, baseCurrency);
  let running = openingBalance;

  const detail: GeneralLedgerRow[] = rows.map((r) => {
    running = running
      .add(Money.fromDecimal(r.debit, baseCurrency))
      .subtract(Money.fromDecimal(r.credit, baseCurrency));

    return {
      entryId: r.entry_id,
      entryNo: r.entry_no,
      entryDate: isoDate(r.entry_date),
      description: r.description,
      lineDescription: r.line_description,
      sourceModule: r.source_module,
      sourceDocumentType: r.source_document_type,
      sourceDocumentId: r.source_document_id,
      contactName: r.contact_name,
      contraAccounts: r.contra ?? [],
      debit: r.debit,
      credit: r.credit,
      balance: running.toDecimalString(),
      // Surfaced rather than filtered out: a reversed entry and its reversal
      // are both real history, and hiding the original is how a ledger stops
      // explaining itself.
      reversed: r.status === 'REVERSED',
    };
  });

  const totalDebit = Money.fromDecimal(totals!.debit, baseCurrency);
  const totalCredit = Money.fromDecimal(totals!.credit, baseCurrency);

  return {
    accountId: account.id,
    code: account.code,
    name: account.name,
    type: account.type,
    currency: baseCurrency,
    from: options.from,
    to: options.to,
    openingBalance: openingBalance.toDecimalString(),
    closingBalance: openingBalance.add(totalDebit).subtract(totalCredit).toDecimalString(),
    totalDebit: totalDebit.toDecimalString(),
    totalCredit: totalCredit.toDecimalString(),
    rows: detail,
    truncated: Number(totals!.count) > detail.length,
  };
}

// ---------------------------------------------------------------------------
// The journal report
// ---------------------------------------------------------------------------

export interface JournalReportLine {
  readonly accountCode: string;
  readonly accountName: string;
  readonly description: string | null;
  readonly debit: string;
  readonly credit: string;
}

export interface JournalReportEntry {
  readonly entryId: string;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly description: string | null;
  readonly sourceModule: string;
  readonly sourceDocumentType: string | null;
  readonly status: string;
  readonly postedBy: string | null;
  readonly postedAt: string | null;
  readonly reversalOfId: string | null;
  readonly lines: readonly JournalReportLine[];
  readonly totalDebit: string;
  readonly totalCredit: string;
}

export interface JournalReportOptions {
  readonly from: string;
  readonly to: string;
  readonly sourceModule?: string;
  readonly limit?: number;
}

/** Entries in a window, both sides shown. Bounded by ENTRY, never mid-entry. */
export async function journalReport(
  tx: Tx,
  ctx: TenantContext,
  options: JournalReportOptions,
): Promise<{ entries: JournalReportEntry[]; truncated: boolean }> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const limit = Math.min(options.limit ?? 500, 2_000);

  // Entry ids first, so the LIMIT cuts between entries. Limiting the joined
  // rows instead would return an entry with some of its lines — a journal
  // report that shows a one-sided entry is a bug report waiting to happen.
  const entryRows = await tx<
    {
      id: string; entry_no: string; entry_date: Date; description: string | null;
      source_module: string; source_document_type: string | null; status: string;
      posted_by: string | null; posted_at: Date | null; reversal_of_id: string | null;
    }[]
  >`
      SELECT id, entry_no, entry_date, description, source_module,
             source_document_type, status, posted_by, posted_at, reversal_of_id
        FROM journal_entry
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('POSTED', 'REVERSED')
         AND entry_date BETWEEN ${options.from}::date AND ${options.to}::date
         AND (${options.sourceModule ?? null}::text IS NULL
              OR source_module = ${options.sourceModule ?? null})
       ORDER BY entry_date, entry_no
       LIMIT ${limit + 1}
  `;

  const truncated = entryRows.length > limit;
  const page = entryRows.slice(0, limit);
  if (page.length === 0) return { entries: [], truncated: false };

  const ids = page.map((e) => e.id);

  const lineRows = await tx<
    {
      journal_entry_id: string; code: string; name: string;
      description: string | null; debit: string; credit: string;
    }[]
  >`
      SELECT l.journal_entry_id, a.code, a.name, l.description,
             l.base_debit::text AS debit, l.base_credit::text AS credit
        FROM journal_line l
        JOIN account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND l.journal_entry_id IN ${tx(ids)}
       ORDER BY l.journal_entry_id, l.line_no
  `;

  const linesByEntry = new Map<string, JournalReportLine[]>();
  for (const r of lineRows) {
    const bucket = linesByEntry.get(r.journal_entry_id) ?? [];
    bucket.push({
      accountCode: r.code,
      accountName: r.name,
      description: r.description,
      debit: r.debit,
      credit: r.credit,
    });
    linesByEntry.set(r.journal_entry_id, bucket);
  }

  const entries = page.map((e) => {
    const lines = linesByEntry.get(e.id) ?? [];
    const sum = (pick: (l: JournalReportLine) => string) =>
      lines
        .reduce((acc, l) => acc.add(Money.fromDecimal(pick(l), baseCurrency)), Money.zero(baseCurrency))
        .toDecimalString();

    return {
      entryId: e.id,
      entryNo: e.entry_no,
      entryDate: isoDate(e.entry_date),
      description: e.description,
      sourceModule: e.source_module,
      sourceDocumentType: e.source_document_type,
      status: e.status,
      postedBy: e.posted_by,
      postedAt: e.posted_at ? e.posted_at.toISOString() : null,
      reversalOfId: e.reversal_of_id,
      lines,
      totalDebit: sum((l) => l.debit),
      totalCredit: sum((l) => l.credit),
    };
  });

  return { entries, truncated };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * The general ledger as CSV.
 *
 * Every cell goes through `escapeCsvCell`, which neutralises the formula
 * injection a contact name or an entry description can carry — see
 * packages/domain/src/csv.ts. That is why exports are rendered here rather than
 * assembled ad hoc at each route.
 */
export function generalLedgerCsv(ledger: GeneralLedger): string {
  const rows: string[][] = [
    [`General ledger — ${ledger.code} ${ledger.name}`],
    [`Period`, `${display(ledger.from)} to ${display(ledger.to)}`],
    [`Currency`, ledger.currency],
    [],
    [
      'Date',
      'Entry',
      'Description',
      'Contact',
      'Contra accounts',
      'Debit',
      'Credit',
      'Balance',
      'Status',
    ],
    ['', '', 'Balance brought forward', '', '', '', '', ledger.openingBalance, ''],
  ];

  for (const r of ledger.rows) {
    rows.push([
      display(r.entryDate),
      r.entryNo,
      r.lineDescription ?? r.description ?? '',
      r.contactName ?? '',
      r.contraAccounts.join('; '),
      r.debit,
      r.credit,
      r.balance,
      r.reversed ? 'REVERSED' : 'POSTED',
    ]);
  }

  if (ledger.truncated) {
    // Stated, never silent. A user who exports 5,000 of 12,000 lines and is not
    // told has a file that looks complete and is not.
    rows.push([
      '',
      '',
      `TRUNCATED — only the first ${ledger.rows.length} lines are listed; the totals below cover the whole period`,
    ]);
  }

  rows.push([
    '',
    '',
    'Totals for the period',
    '',
    '',
    ledger.totalDebit,
    ledger.totalCredit,
    ledger.closingBalance,
    '',
  ]);

  return toCsv(rows);
}

/** A trial balance as CSV. Same escaping discipline. */
export function trialBalanceCsv(
  report: { rows: readonly { code: string; name: string; type: string; debit: string; credit: string }[]; totalDebit: string; totalCredit: string },
  window: { from: string; to: string },
): string {
  const rows: string[][] = [
    ['Trial balance'],
    ['Period', `${display(window.from)} to ${display(window.to)}`],
    [],
    ['Code', 'Account', 'Type', 'Debit', 'Credit'],
  ];

  for (const r of report.rows) {
    rows.push([r.code, r.name, r.type, r.debit, r.credit]);
  }

  rows.push(['', 'Totals', '', report.totalDebit, report.totalCredit]);

  return toCsv(rows);
}

export interface JournalCounterAccountSuggestion {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  /** How many past two-line entries paired these accounts this way. */
  readonly occurrences: number;
}

/**
 * The account most often paired with this one on the OTHER side of a
 * two-line posted entry — the manual journal form's "auto-fill the other
 * line" feature.
 *
 * ---------------------------------------------------------------------------
 * MINED FROM THE TENANT'S OWN POSTING HISTORY, NEVER GUESSED.
 *
 * "Rent is usually paid from Cash and Bank" is not a rule this system knows —
 * it is a fact about how THIS shop has posted before, and the query below
 * reads exactly that fact back. A hardcoded table of "sensible" pairs would
 * be a plausible-looking guess for a tenant whose actual chart of accounts
 * doesn't work that way, which is the same failure CLAUDE.md's rule against
 * guessing statutory values exists to prevent — just for a UX default instead
 * of a tax rate.
 *
 * Restricted to entries with EXACTLY two lines: a multi-line accrual would
 * otherwise pollute the count with every account it happens to share an
 * entry with, not the one it was actually paired against.
 * ---------------------------------------------------------------------------
 */
export async function suggestJournalCounterAccount(
  tx: Tx,
  ctx: TenantContext,
  accountId: string,
  side: 'DEBIT' | 'CREDIT',
): Promise<JournalCounterAccountSuggestion | null> {
  // `journal_line` has no single "side" column — a line's side is which of
  // its `debit`/`credit` amounts is non-zero (0001_ledger_core.sql). The
  // `side <> 'X' OR column > 0` pairs below are a parameter-bound way to pick
  // the right column per call without interpolating an identifier: when
  // `side` is the OTHER value the clause is vacuously true, so only the
  // matching branch actually constrains anything.
  const [row] = await tx<
    { account_id: string; code: string; name: string; occurrences: string }[]
  >`
      SELECT other.account_id, a.code, a.name, COUNT(*)::text AS occurrences
        FROM journal_line l
        JOIN journal_entry e
          ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
        JOIN journal_line other
          ON other.tenant_id = l.tenant_id
         AND other.journal_entry_id = l.journal_entry_id
         AND other.id <> l.id
        JOIN account a ON a.tenant_id = other.tenant_id AND a.id = other.account_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND l.account_id = ${accountId}
         AND (${side} <> 'DEBIT' OR l.debit > 0)
         AND (${side} <> 'CREDIT' OR l.credit > 0)
         AND (${side} <> 'DEBIT' OR other.credit > 0)
         AND (${side} <> 'CREDIT' OR other.debit > 0)
         AND e.status IN ('POSTED', 'REVERSED')
         AND (
           SELECT COUNT(*) FROM journal_line jl2
            WHERE jl2.tenant_id = e.tenant_id AND jl2.journal_entry_id = e.id
         ) = 2
       GROUP BY other.account_id, a.code, a.name
       ORDER BY COUNT(*) DESC, other.account_id
       LIMIT 1
  `;

  if (!row) return null;
  return { accountId: row.account_id, code: row.code, name: row.name, occurrences: Number(row.occurrences) };
}

// ------------------------------------------------------------------ internals

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** DD/MM/YYYY — the display format, per CLAUDE.md §8. */
function display(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
