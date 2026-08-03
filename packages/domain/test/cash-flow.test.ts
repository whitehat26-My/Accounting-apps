import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import {
  buildCashFlowStatement,
  checkCashFlow,
  classifyAccount,
  operatingCashFlow,
  type CashFlowAccount,
  type CashFlowActivity,
  type CashFlowEntry,
} from '../src/cash-flow.js';
import type { AccountType } from '../src/account.js';

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

// A tiny chart, enough to exercise every classification path.
const CHART: Record<string, { type: AccountType; name: string; tags?: string[] }> = {
  '1000': { type: 'ASSET', name: 'Bank', tags: ['cash_and_bank'] },
  '1010': { type: 'ASSET', name: 'Second bank', tags: ['cash_and_bank'] },
  '1100': { type: 'ASSET', name: 'Trade receivables', tags: ['trade_receivables'] },
  '1500': { type: 'ASSET', name: 'Motor vehicles' },
  '2000': { type: 'LIABILITY', name: 'Trade payables', tags: ['trade_payables'] },
  '2500': { type: 'LIABILITY', name: 'Term loan' },
  '3000': { type: 'EQUITY', name: 'Share capital' },
  '4000': { type: 'INCOME', name: 'Sales' },
  '6000': { type: 'EXPENSE', name: 'Rent' },
};

const accounts = new Map<string, CashFlowAccount>(
  Object.entries(CHART).map(([code, v]) => [
    code,
    { accountId: code, code, name: v.name, type: v.type, tags: v.tags ?? [] },
  ]),
);

const CASH = new Set(['1000', '1010']);

/** An entry from `[accountCode, debitPositiveAmount]` pairs. */
const entry = (
  entryNo: string,
  entryDate: string,
  lines: readonly [string, string][],
): CashFlowEntry => ({
  entryId: entryNo,
  entryNo,
  entryDate,
  lines: lines.map(([accountId, amount]) => ({ accountId, amount: rm(amount) })),
});

const build = (
  entries: readonly CashFlowEntry[],
  over: { opening?: string; closing?: string; overrides?: Record<string, CashFlowActivity> } = {},
) =>
  buildCashFlowStatement({
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    baseCurrency: 'MYR',
    cashAccountIds: CASH,
    accounts,
    overrides: new Map(Object.entries(over.overrides ?? {})),
    entries,
    openingCash: rm(over.opening ?? '0.00'),
    closingCash: rm(
      over.closing ??
        entries
          .flatMap((e) => e.lines)
          .filter((l) => CASH.has(l.accountId))
          .reduce((acc, l) => acc.add(l.amount), rm(over.opening ?? '0.00'))
          .toDecimalString(),
    ),
  });

const section = (s: ReturnType<typeof build>, activity: string) =>
  s.sections.find((x) => x.activity === activity)!;

// ---------------------------------------------------------------------------
// The property the whole design rests on
// ---------------------------------------------------------------------------

describe('the decomposition is an identity, not an approximation', () => {
  it('PROPERTY: opening + net cash flow = closing, for any set of balanced entries', () => {
    const codes = Object.keys(CHART);

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            // A cash line and a contra line: the smallest balanced entry.
            cash: fc.constantFrom('1000', '1010'),
            contra: fc.constantFrom(...codes.filter((c) => !CASH.has(c))),
            amount: fc.integer({ min: -500_000, max: 500_000 }),
          }),
          { maxLength: 60 },
        ),
        (rows) => {
          const entries = rows
            .filter((r) => r.amount !== 0)
            .map((r, i) => {
              const amount = (r.amount / 100).toFixed(2);
              return entry(`JE-${i}`, '2026-06-01', [
                [r.cash, amount],
                [r.contra, (-r.amount / 100).toFixed(2)],
              ]);
            });

          const opening = rm('1234.56');
          const closing = entries
            .flatMap((e) => e.lines)
            .filter((l) => CASH.has(l.accountId))
            .reduce((acc, l) => acc.add(l.amount), opening);

          const statement = buildCashFlowStatement({
            periodStart: '2026-01-01',
            periodEnd: '2026-12-31',
            baseCurrency: 'MYR',
            cashAccountIds: CASH,
            accounts,
            overrides: new Map(),
            entries,
            openingCash: opening,
            closingCash: closing,
          });

          const check = checkCashFlow(statement, entries);

          // Reconciles for EVERY input, which is what "by construction" means.
          expect(check.reconciles, JSON.stringify(check.violations)).toBe(true);
          expect(statement.netCashFlow.equals(closing.subtract(opening))).toBe(true);
        },
      ),
    );
  });

  it('handles an entry with several contra lines exactly, with no proration', () => {
    // Dr Bank 1,080 / Cr Sales 1,000 / Cr SST payable 80 — the ordinary invoice
    // receipt, and the case an apportioning implementation gets nearly right.
    const e = entry('JE-1', '2026-03-01', [
      ['1000', '1080.00'],
      ['4000', '-1000.00'],
      ['2000', '-80.00'],
    ]);

    const statement = build([e]);

    expect(section(statement, 'OPERATING').subtotal.equals(rm('1080.00'))).toBe(true);
    expect(statement.netCashFlow.equals(rm('1080.00'))).toBe(true);
    expect(checkCashFlow(statement, [e]).reconciles).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The one-pool rule
// ---------------------------------------------------------------------------

describe('cash and cash equivalents are one pool', () => {
  it('a transfer between two bank accounts is not a cash flow', () => {
    /*
     * The classic overstatement. Sweeping RM 50,000 from the current account to
     * the savings account is not income, not financing, and not a cash flow of
     * any kind — but an implementation that reports per bank account shows an
     * outflow on one and an inflow on the other, and a reader who looks at only
     * one sees a business that spent RM 50,000.
     */
    const e = entry('JE-1', '2026-05-01', [
      ['1010', '50000.00'],
      ['1000', '-50000.00'],
    ]);

    const statement = build([e]);

    expect(statement.netCashFlow.isZero()).toBe(true);
    for (const s of statement.sections) expect(s.subtotal.isZero()).toBe(true);
    expect(checkCashFlow(statement, [e]).reconciles).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('classification refuses to guess', () => {
  const classify = (code: string, overrides: Record<string, CashFlowActivity> = {}) =>
    classifyAccount(accounts.get(code)!, new Map(Object.entries(overrides)));

  it('resolves income, expense and equity from the type alone', () => {
    expect(classify('4000')).toBe('OPERATING');
    expect(classify('6000')).toBe('OPERATING');
    expect(classify('3000')).toBe('FINANCING');
  });

  it('resolves trade receivables and payables from their tags', () => {
    expect(classify('1100')).toBe('OPERATING');
    expect(classify('2000')).toBe('OPERATING');
  });

  it('leaves an unlabelled asset or liability UNCLASSIFIED rather than assuming operating', () => {
    // A lorry is not operating and a term loan is not operating, and nothing in
    // `account.type` says which is which. Defaulting them to operating is the
    // standard shortcut, and it misstates the exact figure a lender reads.
    expect(classify('1500')).toBe('UNCLASSIFIED');
    expect(classify('2500')).toBe('UNCLASSIFIED');
  });

  it('an explicit decision wins over every inference', () => {
    expect(classify('1500', { '1500': 'INVESTING' })).toBe('INVESTING');
    expect(classify('2500', { '2500': 'FINANCING' })).toBe('FINANCING');
    // Even against a tag, because a tenant's judgement about their own books
    // beats a label this system attached.
    expect(classify('1100', { '1100': 'INVESTING' })).toBe('INVESTING');
  });
});

describe('unclassified movement', () => {
  const buyVan = entry('JE-1', '2026-02-01', [
    ['1500', '80000.00'],
    ['1000', '-80000.00'],
  ]);
  const sales = entry('JE-2', '2026-02-02', [
    ['1000', '30000.00'],
    ['4000', '-30000.00'],
  ]);

  it('keeps the money in the total so the statement still reconciles', () => {
    const statement = build([buyVan, sales]);
    const check = checkCashFlow(statement, [buyVan, sales]);

    expect(check.reconciles).toBe(true);
    expect(section(statement, 'UNCLASSIFIED').subtotal.equals(rm('-80000.00'))).toBe(true);
    expect(statement.netCashFlow.equals(rm('-50000.00'))).toBe(true);
  });

  it('names the accounts that need a decision, and says operating is incomplete', () => {
    const statement = build([buyVan, sales]);

    expect(statement.unclassifiedAccounts).toEqual([{ code: '1500', name: 'Motor vehicles' }]);
    expect(checkCashFlow(statement, [buyVan, sales]).violations).toContainEqual({
      code: 'UNCLASSIFIED_MOVEMENT',
      accounts: ['1500 Motor vehicles'],
    });

    const operating = operatingCashFlow(statement);
    expect(operating.amount.equals(rm('30000.00'))).toBe(true);
    expect(operating.complete).toBe(false);
    expect(operating.unclassified.equals(rm('-80000.00'))).toBe(true);
  });

  it('moves into investing once the decision is recorded, unchanged in total', () => {
    const statement = build([buyVan, sales], { overrides: { '1500': 'INVESTING' } });

    expect(section(statement, 'INVESTING').subtotal.equals(rm('-80000.00'))).toBe(true);
    expect(section(statement, 'UNCLASSIFIED').subtotal.isZero()).toBe(true);
    expect(statement.netCashFlow.equals(rm('-50000.00'))).toBe(true);
    expect(operatingCashFlow(statement).complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What the check catches
// ---------------------------------------------------------------------------

describe('checkCashFlow', () => {
  it('catches a closing balance that does not follow from the movements', () => {
    // Rollup drift, a missing entry, or a posting outside the journal: whatever
    // the cause, the reader must not be handed a statement that looks fine.
    const e = entry('JE-1', '2026-03-01', [
      ['1000', '1000.00'],
      ['4000', '-1000.00'],
    ]);

    const statement = build([e], { opening: '0.00', closing: '1500.00' });
    const check = checkCashFlow(statement, [e]);

    expect(check.reconciles).toBe(false);
    expect(check.difference.equals(rm('500.00'))).toBe(true);
    expect(check.violations[0]).toMatchObject({ code: 'DOES_NOT_RECONCILE' });
  });

  it('catches an entry whose lines were not all supplied', () => {
    // The failure mode a query filtering out cash lines would produce: the
    // decomposition identity silently stops holding, and every figure below it
    // is wrong in a way nothing else would reveal.
    const partial: CashFlowEntry = {
      entryId: 'JE-1',
      entryNo: 'JE-1',
      entryDate: '2026-03-01',
      lines: [{ accountId: '1000', amount: rm('1000.00') }],
    };

    const check = checkCashFlow(build([partial], { closing: '1000.00' }), [partial]);

    expect(check.violations).toContainEqual({
      code: 'UNBALANCED_ENTRY',
      entryNo: 'JE-1',
      difference: '1000.0000',
    });
  });

  it('throws when a line references an account the caller did not supply', () => {
    const e = entry('JE-1', '2026-03-01', [
      ['1000', '100.00'],
      ['9999', '-100.00'],
    ]);

    expect(() => build([e])).toThrow(/unknown account 9999/);
  });
});

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

describe('presentation', () => {
  it('states inflows positive and outflows negative', () => {
    const receipt = entry('JE-1', '2026-03-01', [
      ['1000', '5000.00'],
      ['1100', '-5000.00'],
    ]);
    const rent = entry('JE-2', '2026-03-02', [
      ['6000', '2000.00'],
      ['1000', '-2000.00'],
    ]);

    const statement = build([receipt, rent]);
    const operating = section(statement, 'OPERATING');

    expect(operating.lines.find((l) => l.code === '1100')!.amount.equals(rm('5000.00'))).toBe(true);
    expect(operating.lines.find((l) => l.code === '6000')!.amount.equals(rm('-2000.00'))).toBe(true);
    expect(operating.subtotal.equals(rm('3000.00'))).toBe(true);
  });

  it('drops a contra account whose movements net to nothing', () => {
    const paid = entry('JE-1', '2026-03-01', [
      ['1000', '1000.00'],
      ['1100', '-1000.00'],
    ]);
    const refunded = entry('JE-2', '2026-03-02', [
      ['1100', '1000.00'],
      ['1000', '-1000.00'],
    ]);

    const statement = build([paid, refunded]);

    expect(section(statement, 'OPERATING').lines).toHaveLength(0);
    expect(statement.netCashFlow.isZero()).toBe(true);
  });

  it('counts only entries that actually moved cash', () => {
    const cashEntry = entry('JE-1', '2026-03-01', [
      ['1000', '1000.00'],
      ['4000', '-1000.00'],
    ]);
    // An accrual swept up because it shared an entry id would inflate the
    // count; one with a zero cash line should not count as a cash movement.
    const zeroCash = entry('JE-2', '2026-03-02', [
      ['1000', '0.00'],
      ['1100', '500.00'],
      ['4000', '-500.00'],
    ]);

    expect(build([cashEntry, zeroCash]).entryCount).toBe(1);
  });
});
