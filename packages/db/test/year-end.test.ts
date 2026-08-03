import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, unwrap, validateJournalEntry } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { postJournalEntry } from '../src/ledger.js';
import { changePeriodStatus, listPeriods } from '../src/period.js';
import { closeFiscalYear, listFiscalYears, reopenFiscalYear } from '../src/year-end.js';
import {
  accountingEquationAt,
  statementOfFinancialPosition,
  statementOfProfitOrLoss,
} from '../src/report.js';
import { detectRollupDrift } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The year-end close, against a real PostgreSQL.
 *
 * What the domain tests cannot reach: the trigger that makes `fiscal_year.status`
 * mean something, the reversal path, and the property the whole feature is for —
 * the balance sheet is IDENTICAL either side of a close.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };
let fiscalYearId: string;

beforeAll(async () => {
  const db = await createTestDatabase('year_end');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Year End Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

  const [year] = await withTenant(sql, ctx, (tx) =>
    tx<{ id: string }[]>`SELECT id FROM fiscal_year WHERE tenant_id = ${ctx.tenantId}`,
  );
  fiscalYearId = year!.id;

  // January is LOCKED in the fixture, and the close refuses a year with a
  // locked period — the closing entry would need an override, which is a
  // decision to make explicitly rather than have a year-end close make for you.
  const periods = await withTenant(sql, ctx, (tx) => listPeriods(tx, ctx));
  const january = periods.find((p) => p.sequence === 1)!;
  await withTenant(sql, ctx, (tx) =>
    changePeriodStatus(tx, ctx, {
      periodId: january.id,
      status: 'OPEN',
      reason: 'so the year can be closed in this suite',
    }),
  );
}, 60_000);

afterAll(async () => {
  await drop?.();
});

/** Trade: revenue credited, expense debited, both in the open year. */
async function trade(date: string, revenue: string, expense: string) {
  const draft = {
    entryDate: date,
    description: 'trading',
    sourceModule: 'MANUAL' as const,
    lines: [
      line('1000', 'DEBIT', revenue),
      line('4000', 'CREDIT', revenue),
      line('6000', 'DEBIT', expense),
      line('1000', 'CREDIT', expense),
    ],
  };

  const valid = unwrap(validateJournalEntry(draft, 'MYR'));
  return withTenant(sql, ctx, (tx) =>
    postJournalEntry(tx, ctx, valid, { idempotencyKey: randomUUID() }),
  );
}

function line(code: string, side: 'DEBIT' | 'CREDIT', amount: string) {
  return {
    accountId: tenant.accounts[code]!,
    side,
    amount: Money.fromDecimal(amount, 'MYR'),
    baseAmount: Money.fromDecimal(amount, 'MYR'),
  };
}

describe('closing a fiscal year', () => {
  it('transfers the profit to retained earnings and leaves the balance sheet unchanged', async () => {
    await trade('2026-03-15', '100000.00', '60000.00');
    await trade('2026-07-20', '50000.00', '20000.00');

    // Profit: revenue 150,000 less expenses 80,000 = 70,000.
    const equationBefore = await withTenant(sql, ctx, (tx) =>
      accountingEquationAt(tx, ctx, '2026-12-31'),
    );
    const sofpBefore = await withTenant(sql, ctx, (tx) =>
      statementOfFinancialPosition(tx, ctx, { asOfDate: '2026-12-31' }),
    );
    const soplBefore = await withTenant(sql, ctx, (tx) =>
      statementOfProfitOrLoss(tx, ctx, { from: '2026-01-01', to: '2026-12-31' }),
    );

    const closed = await withTenant(sql, ctx, (tx) =>
      closeFiscalYear(tx, ctx, { fiscalYearId, idempotencyKey: randomUUID() }),
    );

    expect(closed.status).toBe('CLOSED');
    expect(closed.profitForYear).toBe('70000.0000');
    expect(closed.accountsClosed).toBe(2);
    expect(closed.closingEntryId).not.toBeNull();

    /*
     * THE POINT OF THE WHOLE FEATURE.
     *
     * A close moves where profit is CARRIED; it must not change what the
     * profit WAS, and it must not change a single figure on the balance sheet.
     * `checkAccountingEquation` treats equity as equity accounts plus unclosed
     * profit precisely so that this holds — asserted here rather than trusted.
     */
    const equationAfter = await withTenant(sql, ctx, (tx) =>
      accountingEquationAt(tx, ctx, '2026-12-31'),
    );

    expect(equationAfter.balances).toBe(true);
    expect(equationAfter.assets.toDecimalString()).toBe(equationBefore.assets.toDecimalString());
    expect(equationAfter.liabilitiesAndEquity.toDecimalString()).toBe(
      equationBefore.liabilitiesAndEquity.toDecimalString(),
    );

    /*
     * The balance sheet's TOTAL lines are unchanged.
     *
     * Not every line: the profit moves from "current year earnings" to
     * "retained earnings", which is exactly what a close is for. What must not
     * move is any subtotal or total — if one does, the close has restated the
     * business's position rather than reorganised it.
     */
    const sofpAfter = await withTenant(sql, ctx, (tx) =>
      statementOfFinancialPosition(tx, ctx, { asOfDate: '2026-12-31' }),
    );
    expect(totals(sofpAfter)).toEqual(totals(sofpBefore));

    /*
     * And the income statement for the CLOSED year still reads what it read.
     *
     * This is the assertion that caught a real defect. The closing entry is
     * dated 31 December — inside the window this statement asks for — and it
     * exists to zero exactly these accounts, so before `excludeYearEndClose`
     * a closed year reported no trading at all.
     */
    const soplAfter = await withTenant(sql, ctx, (tx) =>
      statementOfProfitOrLoss(tx, ctx, { from: '2026-01-01', to: '2026-12-31' }),
    );
    expect(soplAfter.lines).toEqual(soplBefore.lines);
  });

  it('leaves the rollup consistent with the journal', async () => {
    const drift = await withTenant(sql, ctx, (tx) => detectRollupDrift(tx, ctx));
    expect(drift).toEqual([]);
  });

  it('refuses to post into the closed year — the status now binds', async () => {
    /*
     * The defect this migration fixes. `assert_period_open()` only ever looked
     * at `fiscal_period.status`, so a year marked CLOSED accepted postings for
     * as long as any of its periods was open — which was every year, because
     * nothing closes periods automatically.
     */
    await expect(trade('2026-06-01', '1000.00', '0.01')).rejects.toThrow(/year .* is CLOSED/i);
  });

  it('replays a retried close rather than erroring', async () => {
    const key = randomUUID();
    const year = await freshYear('FY2027', '2027-01-01', '2027-12-31');
    await tradeIn(year.periodId, '2027-05-05', '9000.00', '4000.00');

    const first = await withTenant(sql, ctx, (tx) =>
      closeFiscalYear(tx, ctx, { fiscalYearId: year.id, idempotencyKey: key }),
    );
    const second = await withTenant(sql, ctx, (tx) =>
      closeFiscalYear(tx, ctx, { fiscalYearId: year.id, idempotencyKey: key }),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.closingEntryId).toBe(first.closingEntryId);
    expect(second.profitForYear).toBe(first.profitForYear);
    expect(second.accountsClosed).toBe(first.accountsClosed);

    // And exactly one closing entry exists, not two.
    const [count] = await withTenant(sql, ctx, (tx) =>
      tx<{ n: string }[]>`
          SELECT COUNT(*)::text AS n FROM journal_entry
           WHERE tenant_id = ${ctx.tenantId} AND source_document_type = 'YEAR_END_CLOSE'
             AND entry_date = '2027-12-31'
      `,
    );
    expect(count!.n).toBe('1');
  });

  it('refuses a different key against an already-closed year', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        closeFiscalYear(tx, ctx, { fiscalYearId, idempotencyKey: randomUUID() }),
      ),
    ).rejects.toThrow(/already CLOSED/i);
  });

  it('refuses a year with a locked period', async () => {
    const year = await freshYear('FY2028', '2028-01-01', '2028-12-31');
    await tradeIn(year.periodId, '2028-04-04', '500.00', '100.00');

    // Set directly rather than through `changePeriodStatus`, which refuses to
    // lock a period while an EARLIER one is open — a rule about ordering that
    // this suite deliberately leaves violated so FY2026 stays postable. What is
    // under test here is what `closeFiscalYear` does when it meets a locked
    // period, not how the period came to be locked.
    await withTenant(sql, ctx, (tx) =>
      tx`UPDATE fiscal_period SET status = 'LOCKED'
          WHERE tenant_id = ${ctx.tenantId} AND id = ${year.periodId}`,
    );

    await expect(
      withTenant(sql, ctx, (tx) =>
        closeFiscalYear(tx, ctx, { fiscalYearId: year.id, idempotencyKey: randomUUID() }),
      ),
    ).rejects.toThrow(/LOCKED period/);
  });

  it('closes a year with no trading without posting an entry', async () => {
    const year = await freshYear('FY2029', '2029-01-01', '2029-12-31');

    const closed = await withTenant(sql, ctx, (tx) =>
      closeFiscalYear(tx, ctx, { fiscalYearId: year.id, idempotencyKey: randomUUID() }),
    );

    // An entry that moves nothing still consumes a document number an auditor
    // will later ask about.
    expect(closed.status).toBe('CLOSED');
    expect(closed.closingEntryId).toBeNull();
    expect(closed.accountsClosed).toBe(0);
  });

  it('writes a YEAR_END_CLOSED financial event', async () => {
    const events = await withTenant(sql, ctx, (tx) =>
      tx<{ entity_id: string; detail: Record<string, unknown> }[]>`
          SELECT entity_id, detail FROM financial_event_log
           WHERE tenant_id = ${ctx.tenantId} AND event_type = 'YEAR_END_CLOSED'
             AND entity_id = ${fiscalYearId}
      `,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.detail['profitForYear']).toBe('70000.0000');
  });

  it('records who closed it and when', async () => {
    const [row] = await withTenant(sql, ctx, (tx) =>
      tx<{ closed_by: string; closed_at: Date }[]>`
          SELECT closed_by, closed_at FROM fiscal_year
           WHERE tenant_id = ${ctx.tenantId} AND id = ${fiscalYearId}
      `,
    );

    expect(row!.closed_by).toBe(ctx.userId);
    expect(row!.closed_at).toBeInstanceOf(Date);
  });
});

describe('reopening a closed year', () => {
  it('reverses the closing entry rather than deleting it', async () => {
    const [before] = await withTenant(sql, ctx, (tx) =>
      tx<{ closing_entry_id: string }[]>`
          SELECT closing_entry_id FROM fiscal_year
           WHERE tenant_id = ${ctx.tenantId} AND id = ${fiscalYearId}
      `,
    );
    const closingEntryId = before!.closing_entry_id;

    const reopened = await withTenant(sql, ctx, (tx) =>
      reopenFiscalYear(tx, ctx, {
        fiscalYearId,
        reason: 'a late supplier invoice arrived',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(reopened.reversalEntryId).not.toBeNull();

    // Rule 1: the original is still there, and the reversal REFERENCES it.
    // `journal_entry.reversal_of_id` has had a foreign key since 0001 and was
    // written by nothing until now.
    const [reversal] = await withTenant(sql, ctx, (tx) =>
      tx<{ reversal_of_id: string; status: string }[]>`
          SELECT reversal_of_id, status FROM journal_entry
           WHERE tenant_id = ${ctx.tenantId} AND id = ${reopened.reversalEntryId}
      `,
    );
    expect(reversal!.reversal_of_id).toBe(closingEntryId);

    const [original] = await withTenant(sql, ctx, (tx) =>
      tx<{ status: string }[]>`
          SELECT status FROM journal_entry
           WHERE tenant_id = ${ctx.tenantId} AND id = ${closingEntryId}
      `,
    );
    expect(original!.status).toBe('REVERSED');
  });

  it('leaves the reversed close with no net effect on retained earnings', async () => {
    /*
     * Close then reopen is a round trip. Retained earnings carries the closing
     * entry AND its reversal, which cancel exactly.
     *
     * Scoped to FY2026's own entries — other years in this suite are closed and
     * still carry their profit in the same account, and summing the whole
     * account would net their profit in as though this reversal had failed.
     */
    const [retained] = await withTenant(sql, ctx, (tx) =>
      tx<{ net: string }[]>`
          SELECT COALESCE(SUM(l.base_debit - l.base_credit), 0)::text AS net
            FROM journal_line l
            JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
           WHERE l.tenant_id = ${ctx.tenantId}
             AND l.account_id = ${tenant.accounts['3000']!}
             AND e.source_document_type = 'YEAR_END_CLOSE'
             AND e.entry_date = '2026-12-31'
             AND e.status IN ('POSTED', 'REVERSED')
      `,
    );

    expect(Number(retained!.net)).toBe(0);
  });

  it('accepts postings again once reopened', async () => {
    const posted = await trade('2026-06-01', '1000.00', '400.00');
    expect(posted.id).toBeTruthy();
  });

  it('refuses a reopen with no reason', async () => {
    const year = await freshYear('FY2030', '2030-01-01', '2030-12-31');
    await withTenant(sql, ctx, (tx) =>
      closeFiscalYear(tx, ctx, { fiscalYearId: year.id, idempotencyKey: randomUUID() }),
    );

    await expect(
      withTenant(sql, ctx, (tx) =>
        reopenFiscalYear(tx, ctx, {
          fiscalYearId: year.id,
          reason: '   ',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/requires a reason/);
  });

  it('refuses to reopen a year that is already open', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        reopenFiscalYear(tx, ctx, {
          fiscalYearId,
          reason: 'again',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/already open/);
  });

  it('writes a YEAR_END_REOPENED event carrying the reason', async () => {
    const events = await withTenant(sql, ctx, (tx) =>
      tx<{ detail: Record<string, unknown> }[]>`
          SELECT detail FROM financial_event_log
           WHERE tenant_id = ${ctx.tenantId} AND event_type = 'YEAR_END_REOPENED'
             AND entity_id = ${fiscalYearId}
      `,
    );

    expect(events).toHaveLength(1);
    expect(events[0]!.detail['reason']).toBe('a late supplier invoice arrived');
  });
});

describe('cross-tenant isolation', () => {
  it('reports another tenant’s fiscal year as not found, never as forbidden', async () => {
    const other = await seedTenant(admin, 'Somebody Else Sdn Bhd');
    const [theirYear] = await withTenant(sql, { tenantId: other.tenantId }, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM fiscal_year WHERE tenant_id = ${other.tenantId}`,
    );

    // Rule 9: never confirm that another tenant's record exists.
    await expect(
      withTenant(sql, ctx, (tx) =>
        closeFiscalYear(tx, ctx, {
          fiscalYearId: theirYear!.id,
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/not found/i);
  });
});

describe('listFiscalYears', () => {
  it('reports status and the closing entry', async () => {
    const years = await withTenant(sql, ctx, (tx) => listFiscalYears(tx, ctx));

    const fy2029 = years.find((y) => y.label === 'FY2029');
    expect(fy2029?.status).toBe('CLOSED');
    expect(fy2029?.closingEntryId).toBeNull();
    expect(fy2029?.closedAt).not.toBeNull();

    const fy2026 = years.find((y) => y.label === 'FY2026');
    expect(fy2026?.status).toBe('OPEN');
  });
});

// ----------------------------------------------------------------- helpers

/**
 * Every subtotal and total line, keyed by label.
 *
 * SUBTOTAL and TOTAL only. A CALC line is deliberately excluded: "Current year
 * earnings" is a CALC, and it is SUPPOSED to fall to zero when a year is closed
 * — the profit is in retained earnings now. The totals are what must not move.
 */
function totals(report: {
  lines: readonly { label: string; lineType: string; amount: { toDecimalString(): string } }[];
}): Record<string, string> {
  return Object.fromEntries(
    report.lines
      .filter((l) => l.lineType === 'SUBTOTAL' || l.lineType === 'TOTAL')
      .map((l) => [l.label, l.amount.toDecimalString()]),
  );
}

/** A year with a single twelve-month period, so each test gets a clean one. */
async function freshYear(
  label: string,
  startDate: string,
  endDate: string,
): Promise<{ id: string; periodId: string }> {
  return withTenant(sql, ctx, async (tx) => {
    const [year] = await tx<{ id: string }[]>`
        INSERT INTO fiscal_year (tenant_id, label, start_date, end_date)
        VALUES (${ctx.tenantId}, ${label}, ${startDate}, ${endDate})
        RETURNING id
    `;
    const [period] = await tx<{ id: string }[]>`
        INSERT INTO fiscal_period (tenant_id, fiscal_year_id, sequence, start_date, end_date, status)
        VALUES (${ctx.tenantId}, ${year!.id}, 1, ${startDate}, ${endDate}, 'OPEN')
        RETURNING id
    `;
    return { id: year!.id, periodId: period!.id };
  });
}

async function tradeIn(_periodId: string, date: string, revenue: string, expense: string) {
  const draft = {
    entryDate: date,
    description: 'trading',
    sourceModule: 'MANUAL' as const,
    lines: [
      line('1000', 'DEBIT', revenue),
      line('4000', 'CREDIT', revenue),
      line('6000', 'DEBIT', expense),
      line('1000', 'CREDIT', expense),
    ],
  };

  const valid = unwrap(validateJournalEntry(draft, 'MYR'));
  return withTenant(sql, ctx, (tx) =>
    postJournalEntry(tx, ctx, valid, { idempotencyKey: randomUUID() }),
  );
}
