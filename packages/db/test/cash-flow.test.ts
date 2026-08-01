import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, unwrap, validateJournalEntry } from '@emil/domain';
import { withTenant, type Sql, type TenantContext } from '../src/client.js';
import { postJournalEntry } from '../src/ledger.js';
import { issueInvoice } from '../src/invoice.js';
import { recordReceipt } from '../src/payment.js';
import {
  cashFlowStatement,
  equityStatement,
  listCashFlowClassifications,
  setCashFlowClassification,
} from '../src/cash-flow.js';
import { accountingEquationAt } from '../src/report.js';
import { generalLedger, generalLedgerCsv, journalReport } from '../src/general-ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDatabase('cashflow');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

const ctxOf = (t: Tenant): TenantContext => ({ tenantId: t.tenantId, userId: t.userId });

/** Post a manual entry from `[accountId, 'DEBIT'|'CREDIT', amount]` triples. */
async function post(
  t: Tenant,
  entryDate: string,
  description: string,
  lines: readonly [string, 'DEBIT' | 'CREDIT', string][],
) {
  const c = ctxOf(t);
  const entry = unwrap(
    validateJournalEntry(
      {
        entryDate,
        description,
        sourceModule: 'MANUAL',
        lines: lines.map(([accountId, side, amount]) => ({
          accountId,
          side,
          amount: rm(amount),
          baseAmount: rm(amount),
        })),
      },
      'MYR',
    ),
  );

  return withTenant(sql, c, (tx) =>
    postJournalEntry(tx, c, entry, { idempotencyKey: randomUUID() }),
  );
}

async function newAccount(t: Tenant, code: string, name: string, type: string): Promise<string> {
  const [row] = await withTenant(admin, ctxOf(t), (tx) =>
    tx<{ id: string }[]>`
        INSERT INTO account (tenant_id, code, name, type)
        VALUES (${t.tenantId}, ${code}, ${name}, ${type})
        RETURNING id
    `,
  );
  return row!.id;
}

const cashFlow = (t: Tenant, from = '2026-01-01', to = '2026-12-31') =>
  withTenant(sql, ctxOf(t), (tx) => cashFlowStatement(tx, ctxOf(t), { from, to }));

const section = (
  result: Awaited<ReturnType<typeof cashFlow>>,
  activity: string,
) => result.statement.sections.find((s) => s.activity === activity)!;

// ---------------------------------------------------------------------------
// The cash pool
// ---------------------------------------------------------------------------

describe('the cash pool', () => {
  it('picks up the tagged account AND a bank account’s GL account', async () => {
    const t = await seedTenant(admin, 'Pool Sdn Bhd');
    const petty = await newAccount(t, '1005', 'Petty cash', 'ASSET');

    // A second cash account reached the pool via `bank_account`, with no tag.
    await admin`
        INSERT INTO bank_account (tenant_id, name, bank_name, currency, gl_account_id, account_type)
        VALUES (${t.tenantId}, 'Petty tin', 'Cash', 'MYR', ${petty}, 'CASH')
    `;

    await post(t, '2026-03-01', 'Sale for cash', [
      [petty, 'DEBIT', '500.00'],
      [t.accounts['4000']!, 'CREDIT', '500.00'],
    ]);

    const result = await cashFlow(t);

    expect(result.check.reconciles).toBe(true);
    expect(result.statement.closingCash.equals(rm('500.00'))).toBe(true);
  });

  it('excludes a credit card, because a card is a liability and not cash', async () => {
    const t = await seedTenant(admin, 'Card Sdn Bhd');
    const card = await newAccount(t, '2300', 'Corporate card', 'LIABILITY');

    await admin`
        INSERT INTO bank_account (tenant_id, name, bank_name, currency, gl_account_id, account_type)
        VALUES (${t.tenantId}, 'Amex', 'Amex', 'MYR', ${card}, 'CREDIT_CARD')
    `;

    // Office expenses charged to the card. Not a cash movement at all — folding
    // the card into the pool would report an operating outflow that never
    // happened and would understate borrowings by the same amount.
    await post(t, '2026-03-01', 'Stationery on the card', [
      [t.accounts['6000']!, 'DEBIT', '300.00'],
      [card, 'CREDIT', '300.00'],
    ]);

    const result = await cashFlow(t);

    expect(result.statement.closingCash.isZero()).toBe(true);
    expect(result.statement.netCashFlow.isZero()).toBe(true);
    expect(result.statement.entryCount).toBe(0);
  });

  it('never sees another tenant’s cash', async () => {
    // `cash_account` is a VIEW, and a view runs as its OWNER unless it is
    // created `WITH (security_invoker = true)`. Without that setting the pool
    // would be every tenant's cash accounts at once — and the statement would
    // still reconcile, because it would be internally consistent about the
    // wrong pool. rls.test.ts asserts the setting exists; this asserts what it
    // does, through the report.
    const mine = await seedTenant(admin, 'Isolated Sdn Bhd');
    const theirs = await seedTenant(admin, 'Neighbour Sdn Bhd');

    await post(theirs, '2026-03-01', 'Their sale', [
      [theirs.accounts['1000']!, 'DEBIT', '99999.00'],
      [theirs.accounts['4000']!, 'CREDIT', '99999.00'],
    ]);
    await post(mine, '2026-03-01', 'My sale', [
      [mine.accounts['1000']!, 'DEBIT', '100.00'],
      [mine.accounts['4000']!, 'CREDIT', '100.00'],
    ]);

    const result = await cashFlow(mine);

    expect(result.statement.closingCash.equals(rm('100.00'))).toBe(true);
    expect(result.check.reconciles).toBe(true);
  });

  it('refuses rather than reporting a cash flow of nothing when no cash exists', async () => {
    const t = await seedTenant(admin, 'Nocash Sdn Bhd');
    await admin`DELETE FROM account_tag WHERE tenant_id = ${t.tenantId} AND tag = 'cash_and_bank'`;

    await expect(cashFlow(t)).rejects.toThrow(/No cash or bank accounts are configured/);
  });
});

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

describe('the statement reconciles against real postings', () => {
  it('opening + net cash flow = closing, through invoice → receipt → expenses', async () => {
    const t = await seedTenant(admin, 'Recon Sdn Bhd');
    const c = ctxOf(t);
    const bank = t.accounts['1000']!;

    // Opening cash brought in before the window. February, not December 2025:
    // the fixture's fiscal calendar is FY2026 only, and January is LOCKED.
    await post(t, '2026-02-01', 'Capital introduced', [
      [bank, 'DEBIT', '50000.00'],
      [t.accounts['3000']!, 'CREDIT', '50000.00'],
    ]);

    const invoice = await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: t.customerId,
        issueDate: '2026-03-01',
        lines: [{
          description: 'Consulting',
          quantity: '1',
          unitPrice: '10000.00',
          accountId: t.accounts['4000']!,
          taxCodeId: t.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-04-01',
        amount: '10000.00',
        depositAccountId: bank,
        method: 'FPX',
        allocations: [{ invoiceId: invoice.id, amount: '10000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    await post(t, '2026-05-01', 'Office rent', [
      [t.accounts['6000']!, 'DEBIT', '2400.00'],
      [bank, 'CREDIT', '2400.00'],
    ]);

    const result = await cashFlow(t, '2026-03-01', '2026-12-31');

    expect(result.check.violations.filter((v) => v.code !== 'UNCLASSIFIED_MOVEMENT')).toEqual([]);
    expect(result.check.reconciles).toBe(true);
    expect(result.statement.openingCash.equals(rm('50000.00'))).toBe(true);
    expect(result.statement.closingCash.equals(rm('57600.00'))).toBe(true);
    expect(result.statement.netCashFlow.equals(rm('7600.00'))).toBe(true);

    // The receipt landed against trade receivables, which the tag settles as
    // operating; the rent is an expense, likewise.
    expect(section(result, 'OPERATING').subtotal.equals(rm('7600.00'))).toBe(true);
    expect(section(result, 'UNCLASSIFIED').subtotal.isZero()).toBe(true);

    // And it agrees with the other side of the system.
    expect(result.rollupAgrees).toBe(true);
  });

  it('agrees with the rollup, which is the cross-check the rollup exists for', async () => {
    const t = await seedTenant(admin, 'Rollup Sdn Bhd');

    await post(t, '2026-02-01', 'Cash sale', [
      [t.accounts['1000']!, 'DEBIT', '1234.56'],
      [t.accounts['4000']!, 'CREDIT', '1234.56'],
    ]);

    const result = await cashFlow(t);

    expect(result.rollupAgrees).toBe(true);
    expect(result.rollupClosingCash).toBe(result.statement.closingCash.toDecimalString());
  });

  it('a reversal nets out rather than vanishing', async () => {
    const t = await seedTenant(admin, 'Reversal Sdn Bhd');
    const c = ctxOf(t);

    const entry = await post(t, '2026-02-01', 'Mistaken payment', [
      [t.accounts['6000']!, 'DEBIT', '900.00'],
      [t.accounts['1000']!, 'CREDIT', '900.00'],
    ]);

    // Reverse it by hand: the original stays REVERSED and both sets of lines
    // remain. A statement that read only POSTED entries would show the outflow
    // and not its reversal.
    await post(t, '2026-02-02', 'Reversal of the mistaken payment', [
      [t.accounts['1000']!, 'DEBIT', '900.00'],
      [t.accounts['6000']!, 'CREDIT', '900.00'],
    ]);
    await admin`
        UPDATE journal_entry SET status = 'REVERSED'
         WHERE tenant_id = ${t.tenantId} AND id = ${entry.id}
    `;

    const result = await cashFlow(t);

    expect(result.check.reconciles).toBe(true);
    expect(result.statement.netCashFlow.isZero()).toBe(true);
    expect(section(result, 'OPERATING').lines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classification', () => {
  it('reports an unclassified movement rather than assuming it is operating', async () => {
    const t = await seedTenant(admin, 'Unclass Sdn Bhd');
    const van = await newAccount(t, '1500', 'Motor vehicles', 'ASSET');

    await post(t, '2026-03-01', 'Bought a van', [
      [van, 'DEBIT', '80000.00'],
      [t.accounts['1000']!, 'CREDIT', '80000.00'],
    ]);

    const before = await cashFlow(t);

    expect(before.check.reconciles).toBe(true);
    expect(before.statement.unclassifiedAccounts).toEqual([
      { code: '1500', name: 'Motor vehicles' },
    ]);
    expect(section(before, 'OPERATING').subtotal.isZero()).toBe(true);
    expect(section(before, 'UNCLASSIFIED').subtotal.equals(rm('-80000.00'))).toBe(true);

    // Record the decision, and it moves — with the total untouched.
    const c = ctxOf(t);
    await withTenant(sql, c, (tx) =>
      setCashFlowClassification(tx, c, {
        accountId: van,
        classification: 'INVESTING',
        note: 'Delivery vehicle, capitalised',
      }),
    );

    const after = await cashFlow(t);

    expect(after.statement.unclassifiedAccounts).toEqual([]);
    expect(section(after, 'INVESTING').subtotal.equals(rm('-80000.00'))).toBe(true);
    expect(after.statement.netCashFlow.equals(before.statement.netCashFlow)).toBe(true);
  });

  it('writes a financial event, because it changes every statement retroactively', async () => {
    const t = await seedTenant(admin, 'Event Sdn Bhd');
    const c = ctxOf(t);
    const loan = await newAccount(t, '2500', 'Term loan', 'LIABILITY');

    await withTenant(sql, c, (tx) =>
      setCashFlowClassification(tx, c, { accountId: loan, classification: 'FINANCING' }),
    );
    await withTenant(sql, c, (tx) =>
      setCashFlowClassification(tx, c, { accountId: loan, classification: 'OPERATING' }),
    );

    const events = await withTenant(sql, c, (tx) =>
      tx<{ detail: { from: string | null; to: string } }[]>`
          SELECT detail FROM financial_event_log
           WHERE tenant_id = ${t.tenantId}
             AND event_type = 'CASH_FLOW_CLASSIFICATION_CHANGED'
           ORDER BY id
      `,
    );

    expect(events).toHaveLength(2);
    expect(events[0]!.detail).toMatchObject({ from: null, to: 'FINANCING' });
    // The transition, not just the new value: "who changed this, from what" is
    // the question, and a row holding only the destination cannot answer it.
    expect(events[1]!.detail).toMatchObject({ from: 'FINANCING', to: 'OPERATING' });
  });

  it('refuses to classify an account whose type already decides it', async () => {
    const t = await seedTenant(admin, 'Typed Sdn Bhd');
    const c = ctxOf(t);

    await expect(
      withTenant(sql, c, (tx) =>
        setCashFlowClassification(tx, c, {
          accountId: t.accounts['4000']!,
          classification: 'FINANCING',
        }),
      ),
    ).rejects.toThrow(/follows from its type/);
  });

  it('does not confirm that another tenant’s account exists', async () => {
    const mine = await seedTenant(admin, 'Mine Sdn Bhd');
    const theirs = await seedTenant(admin, 'Theirs Sdn Bhd');
    const c = ctxOf(mine);

    // 404-shaped, and indistinguishable from a made-up id — CLAUDE.md §9.
    const other = theirs.accounts['1100']!;
    await expect(
      withTenant(sql, c, (tx) =>
        setCashFlowClassification(tx, c, { accountId: other, classification: 'OPERATING' }),
      ),
    ).rejects.toThrow(new RegExp(`No account ${other}`));

    expect(await withTenant(sql, c, (tx) => listCashFlowClassifications(tx, c))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Changes in equity
// ---------------------------------------------------------------------------

describe('the statement of changes in equity', () => {
  it('agrees with the balance sheet when profit has NOT been closed', async () => {
    const t = await seedTenant(admin, 'Equity Sdn Bhd');
    const c = ctxOf(t);
    const capital = await newAccount(t, '3100', 'Share capital', 'EQUITY');

    await post(t, '2026-02-01', 'Capital introduced', [
      [t.accounts['1000']!, 'DEBIT', '100000.00'],
      [capital, 'CREDIT', '100000.00'],
    ]);

    // A profit that is still sitting in income and expense.
    await post(t, '2026-03-01', 'Cash sale', [
      [t.accounts['1000']!, 'DEBIT', '30000.00'],
      [t.accounts['4000']!, 'CREDIT', '30000.00'],
    ]);
    await post(t, '2026-04-01', 'Wages', [
      [t.accounts['6000']!, 'DEBIT', '5000.00'],
      [t.accounts['1000']!, 'CREDIT', '5000.00'],
    ]);

    const result = await withTenant(sql, c, (tx) =>
      equityStatement(tx, c, { from: '2026-01-01', to: '2026-12-31' }),
    );

    expect(result.statement.openingEquity.isZero()).toBe(true);
    expect(result.statement.otherMovements.equals(rm('100000.00'))).toBe(true);
    expect(result.statement.profitForPeriod.equals(rm('25000.00'))).toBe(true);
    expect(result.statement.closingEquity.equals(rm('125000.00'))).toBe(true);

    // The check that matters: it ties to the ledger, not only to itself.
    expect(result.check.consistent, JSON.stringify(result.check.violations)).toBe(true);

    // And the ledger agrees independently.
    const equation = await withTenant(sql, c, (tx) => accountingEquationAt(tx, c, '2026-12-31'));
    expect(equation.balances).toBe(true);
  });

  it('carries a prior period’s equity forward as an opening balance', async () => {
    const t = await seedTenant(admin, 'Carry Sdn Bhd');
    const c = ctxOf(t);
    const capital = await newAccount(t, '3100', 'Share capital', 'EQUITY');

    await post(t, '2026-02-15', 'Capital introduced', [
      [t.accounts['1000']!, 'DEBIT', '60000.00'],
      [capital, 'CREDIT', '60000.00'],
    ]);

    // A window that opens AFTER the capital was introduced.
    const result = await withTenant(sql, c, (tx) =>
      equityStatement(tx, c, { from: '2026-04-01', to: '2026-12-31' }),
    );

    expect(result.statement.openingEquity.equals(rm('60000.00'))).toBe(true);
    expect(result.statement.otherMovements.isZero()).toBe(true);
    expect(result.statement.closingEquity.equals(rm('60000.00'))).toBe(true);
    expect(result.check.consistent, JSON.stringify(result.check.violations)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The general ledger
// ---------------------------------------------------------------------------

describe('the general ledger report', () => {
  it('runs a balance forward from the opening, not from zero', async () => {
    const t = await seedTenant(admin, 'GL Sdn Bhd');
    const c = ctxOf(t);
    const bank = t.accounts['1000']!;

    await post(t, '2026-02-01', 'Before the window', [
      [bank, 'DEBIT', '1000.00'],
      [t.accounts['3000']!, 'CREDIT', '1000.00'],
    ]);
    await post(t, '2026-04-01', 'Sale', [
      [bank, 'DEBIT', '500.00'],
      [t.accounts['4000']!, 'CREDIT', '500.00'],
    ]);
    await post(t, '2026-05-01', 'Rent', [
      [t.accounts['6000']!, 'DEBIT', '200.00'],
      [bank, 'CREDIT', '200.00'],
    ]);

    const ledger = await withTenant(sql, c, (tx) =>
      generalLedger(tx, c, { accountId: bank, from: '2026-03-01', to: '2026-12-31' }),
    );

    expect(ledger.openingBalance).toBe('1000.0000');
    expect(ledger.rows.map((r) => r.balance)).toEqual(['1500.0000', '1300.0000']);
    expect(ledger.closingBalance).toBe('1300.0000');
    expect(ledger.totalDebit).toBe('500.0000');
    expect(ledger.totalCredit).toBe('200.0000');
    expect(ledger.truncated).toBe(false);

    // The contra column: the single most useful thing a raw journal_line query
    // does not give you.
    expect(ledger.rows[0]!.contraAccounts).toEqual(['4000 Sales Revenue']);
    expect(ledger.rows[1]!.contraAccounts).toEqual(['6000 Office Expenses']);
  });

  it('foots even when the row list is truncated', async () => {
    const t = await seedTenant(admin, 'Trunc Sdn Bhd');
    const c = ctxOf(t);
    const bank = t.accounts['1000']!;

    for (let i = 0; i < 5; i++) {
      await post(t, '2026-02-01', `Sale ${i}`, [
        [bank, 'DEBIT', '100.00'],
        [t.accounts['4000']!, 'CREDIT', '100.00'],
      ]);
    }

    const ledger = await withTenant(sql, c, (tx) =>
      generalLedger(tx, c, { accountId: bank, from: '2026-01-01', to: '2026-12-31', limit: 2 }),
    );

    expect(ledger.rows).toHaveLength(2);
    expect(ledger.truncated).toBe(true);
    // The totals cover the whole period, not the page — a report whose total is
    // the sum of the rows it happened to return is worse than no total.
    expect(ledger.totalDebit).toBe('500.0000');
    expect(ledger.closingBalance).toBe('500.0000');

    // And the CSV says so on its face.
    expect(generalLedgerCsv(ledger)).toContain('TRUNCATED');
  });

  it('neutralises a formula smuggled in through an entry description', async () => {
    const t = await seedTenant(admin, 'Inject Sdn Bhd');
    const c = ctxOf(t);
    const bank = t.accounts['1000']!;

    // A description is free text a user controls end to end.
    await post(t, '2026-02-01', '=HYPERLINK("https://evil.example","Click")', [
      [bank, 'DEBIT', '100.00'],
      [t.accounts['4000']!, 'CREDIT', '100.00'],
    ]);

    const ledger = await withTenant(sql, c, (tx) =>
      generalLedger(tx, c, { accountId: bank, from: '2026-01-01', to: '2026-12-31' }),
    );
    const csv = generalLedgerCsv(ledger);

    expect(csv).toContain(`"'=HYPERLINK`);
    // The amounts stay numbers, which is the whole point of the export.
    expect(csv).toContain(',100.0000,');
  });

  it('does not confirm that another tenant’s account exists', async () => {
    const mine = await seedTenant(admin, 'GLMine Sdn Bhd');
    const theirs = await seedTenant(admin, 'GLTheirs Sdn Bhd');
    const c = ctxOf(mine);

    await expect(
      withTenant(sql, c, (tx) =>
        generalLedger(tx, c, {
          accountId: theirs.accounts['1000']!,
          from: '2026-01-01',
          to: '2026-12-31',
        }),
      ),
    ).rejects.toThrow(/No account/);
  });
});

describe('the journal report', () => {
  it('never returns an entry with only some of its lines', async () => {
    const t = await seedTenant(admin, 'Journal Sdn Bhd');
    const c = ctxOf(t);

    for (let i = 0; i < 4; i++) {
      await post(t, '2026-02-0' + (i + 1), `Entry ${i}`, [
        [t.accounts['1000']!, 'DEBIT', '100.00'],
        [t.accounts['4000']!, 'CREDIT', '60.00'],
        [t.accounts['2100']!, 'CREDIT', '40.00'],
      ]);
    }

    // The limit cuts between entries. Limiting joined ROWS instead would return
    // an entry showing two of its three lines, which reads as an unbalanced
    // journal and is a bug report waiting to happen.
    const report = await withTenant(sql, c, (tx) =>
      journalReport(tx, c, { from: '2026-01-01', to: '2026-12-31', limit: 2 }),
    );

    expect(report.entries).toHaveLength(2);
    expect(report.truncated).toBe(true);
    for (const entry of report.entries) {
      expect(entry.lines).toHaveLength(3);
      expect(entry.totalDebit).toBe(entry.totalCredit);
    }
  });

  it('filters by source module', async () => {
    const t = await seedTenant(admin, 'Module Sdn Bhd');
    const c = ctxOf(t);

    await post(t, '2026-02-01', 'Manual', [
      [t.accounts['1000']!, 'DEBIT', '100.00'],
      [t.accounts['4000']!, 'CREDIT', '100.00'],
    ]);
    await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: t.customerId,
        issueDate: '2026-02-02',
        lines: [{
          description: 'Services',
          quantity: '1',
          unitPrice: '500.00',
          accountId: t.accounts['4000']!,
          taxCodeId: t.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    const manual = await withTenant(sql, c, (tx) =>
      journalReport(tx, c, { from: '2026-01-01', to: '2026-12-31', sourceModule: 'MANUAL' }),
    );
    const sales = await withTenant(sql, c, (tx) =>
      journalReport(tx, c, { from: '2026-01-01', to: '2026-12-31', sourceModule: 'SALES' }),
    );

    expect(manual.entries.map((e) => e.description)).toEqual(['Manual']);
    expect(sales.entries).toHaveLength(1);
  });
});
