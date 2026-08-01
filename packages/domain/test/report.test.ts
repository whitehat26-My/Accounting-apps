import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import { isErr, unwrap } from '../src/result.js';
import type { AccountType } from '../src/account.js';
import {
  checkAccountingEquation,
  currentYearEarnings,
  evaluateReport,
  resolveLineForAccount,
  type AccountBalance,
  type RenderedReport,
  type ReportDefinition,
  type ReportLine,
} from '../src/report.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);

const balance = (
  code: string,
  type: AccountType,
  amount: string,
  tags: string[] = [],
  name = `Account ${code}`,
): AccountBalance => ({ accountId: `acc-${code}`, code, name, type, tags, amount: rm(amount) });

/**
 * A minimal SOFP definition over the seeded chart.
 * Trade receivables deliberately carries TWO account maps — the AR control
 * account and the AR revaluation account must land on one line.
 */
const SOFP: ReportDefinition = {
  reportType: 'SOFP',
  framework: 'MPERS',
  name: 'Statement of Financial Position',
  lines: [
    { id: 'h-assets', sequence: 10, label: 'ASSETS', level: 0, lineType: 'HEADER', signConvention: 'NATURAL' },
    {
      id: 'd-cash', sequence: 20, label: 'Cash and bank', level: 1, lineType: 'DETAIL',
      parentLineId: 't-assets', signConvention: 'NATURAL',
      accountMaps: [{ matchType: 'TAG', matchValue: 'cash_and_bank', priority: 10 }],
    },
    {
      id: 'd-ar', sequence: 30, label: 'Trade receivables', level: 1, lineType: 'DETAIL',
      parentLineId: 't-assets', signConvention: 'NATURAL',
      accountMaps: [
        { matchType: 'TAG', matchValue: 'trade_receivables', priority: 10 },
      ],
    },
    { id: 't-assets', sequence: 40, label: 'Total assets', level: 0, lineType: 'TOTAL', signConvention: 'NATURAL' },

    { id: 'h-liab', sequence: 50, label: 'LIABILITIES', level: 0, lineType: 'HEADER', signConvention: 'NATURAL' },
    {
      id: 'd-ap', sequence: 60, label: 'Trade and other payables', level: 1, lineType: 'DETAIL',
      parentLineId: 't-liab-equity', signConvention: 'INVERTED',
      accountMaps: [{ matchType: 'ACCOUNT_TYPE', matchValue: 'LIABILITY', priority: 1 }],
    },
    {
      id: 'd-equity', sequence: 70, label: 'Retained earnings', level: 1, lineType: 'DETAIL',
      parentLineId: 't-liab-equity', signConvention: 'INVERTED',
      accountMaps: [{ matchType: 'ACCOUNT_TYPE', matchValue: 'EQUITY', priority: 1 }],
    },
    {
      id: 'c-cye', sequence: 80, label: 'Current year earnings', level: 1, lineType: 'CALC',
      parentLineId: 't-liab-equity', calcKey: 'CURRENT_YEAR_EARNINGS', signConvention: 'INVERTED',
    },
    {
      id: 't-liab-equity', sequence: 90, label: 'Total liabilities and equity', level: 0,
      lineType: 'TOTAL', signConvention: 'INVERTED',
    },
  ],
};

const SOPL: ReportDefinition = {
  reportType: 'SOPL',
  framework: 'MPERS',
  name: 'Statement of Profit or Loss',
  lines: [
    {
      id: 'd-revenue', sequence: 10, label: 'Revenue', level: 1, lineType: 'DETAIL',
      parentLineId: 't-profit', signConvention: 'INVERTED',
      accountMaps: [{ matchType: 'ACCOUNT_TYPE', matchValue: 'INCOME', priority: 1 }],
    },
    {
      id: 'd-expenses', sequence: 20, label: 'Expenses', level: 1, lineType: 'DETAIL',
      parentLineId: 't-profit', signConvention: 'INVERTED',
      accountMaps: [{ matchType: 'ACCOUNT_TYPE', matchValue: 'EXPENSE', priority: 1 }],
    },
    { id: 't-profit', sequence: 30, label: 'Profit for the period', level: 0, lineType: 'TOTAL', signConvention: 'INVERTED' },
  ],
};

const line = (report: RenderedReport, id: string) =>
  report.lines.find((l) => l.lineId === id)!;

describe('account to line resolution', () => {
  it('matches by tag', () => {
    const resolved = resolveLineForAccount(
      balance('1100', 'ASSET', '100', ['trade_receivables']),
      SOFP.lines,
    );
    expect(resolved?.id).toBe('d-ar');
  });

  it('matches by account type', () => {
    const resolved = resolveLineForAccount(balance('2000', 'LIABILITY', '100'), SOFP.lines);
    expect(resolved?.id).toBe('d-ap');
  });

  it('prefers the higher-priority map', () => {
    const lines: ReportLine[] = [
      {
        id: 'broad', sequence: 1, label: 'Broad', level: 1, lineType: 'DETAIL', signConvention: 'NATURAL',
        accountMaps: [{ matchType: 'ACCOUNT_TYPE', matchValue: 'ASSET', priority: 1 }],
      },
      {
        id: 'specific', sequence: 2, label: 'Specific', level: 1, lineType: 'DETAIL', signConvention: 'NATURAL',
        accountMaps: [{ matchType: 'ACCOUNT_ID', matchValue: 'acc-1100', priority: 50 }],
      },
    ];
    expect(resolveLineForAccount(balance('1100', 'ASSET', '1'), lines)?.id).toBe('specific');
  });

  it('breaks a priority tie toward the more specific match type', () => {
    const lines: ReportLine[] = [
      {
        id: 'by-type', sequence: 1, label: 'By type', level: 1, lineType: 'DETAIL', signConvention: 'NATURAL',
        accountMaps: [{ matchType: 'ACCOUNT_TYPE', matchValue: 'ASSET', priority: 10 }],
      },
      {
        id: 'by-tag', sequence: 2, label: 'By tag', level: 1, lineType: 'DETAIL', signConvention: 'NATURAL',
        accountMaps: [{ matchType: 'TAG', matchValue: 'trade_receivables', priority: 10 }],
      },
    ];
    expect(
      resolveLineForAccount(balance('1100', 'ASSET', '1', ['trade_receivables']), lines)?.id,
    ).toBe('by-tag');
  });

  it('returns nothing when no line matches', () => {
    expect(resolveLineForAccount(balance('9999', 'ASSET', '1'), SOPL.lines)).toBeUndefined();
  });
});

describe('rendering', () => {
  const balances: AccountBalance[] = [
    balance('1000', 'ASSET', '5000.00', ['cash_and_bank']),
    balance('1100', 'ASSET', '4700.00', ['trade_receivables']),
    // The AR revaluation account carries the SAME tag, so it presents on the
    // same line with no per-tenant configuration.
    balance('1190', 'ASSET', '200.00', ['trade_receivables']),
    balance('2000', 'LIABILITY', '-2000.00'),
    balance('3000', 'EQUITY', '-1000.00'),
  ];

  it('sums a DETAIL line from its mapped accounts', () => {
    const report = unwrap(
      evaluateReport(SOFP, balances, {
        baseCurrency: MYR,
        calcValues: { CURRENT_YEAR_EARNINGS: rm('-6900.00') },
      }),
    );
    // AR control 4700 plus AR revaluation 200 on ONE line, which is the claim
    // made in packages/domain/src/revaluation.ts about presentation.
    expect(line(report, 'd-ar').amount.toDecimalString()).toBe('4900.0000');
    expect(line(report, 'd-ar').accountIds).toEqual(['acc-1100', 'acc-1190']);
  });

  it('rolls DETAIL lines up into their parent TOTAL', () => {
    const report = unwrap(
      evaluateReport(SOFP, balances, {
        baseCurrency: MYR,
        calcValues: { CURRENT_YEAR_EARNINGS: rm('-6900.00') },
      }),
    );
    expect(line(report, 't-assets').amount.toDecimalString()).toBe('9900.0000');
  });

  it('applies the sign convention so credits read positive', () => {
    const report = unwrap(
      evaluateReport(SOFP, balances, {
        baseCurrency: MYR,
        calcValues: { CURRENT_YEAR_EARNINGS: rm('-6900.00') },
      }),
    );
    // Liabilities are -2000 debit-positive; presented as 2000.
    expect(line(report, 'd-ap').amount.toDecimalString()).toBe('2000.0000');
    expect(line(report, 'd-equity').amount.toDecimalString()).toBe('1000.0000');
    expect(line(report, 'c-cye').amount.toDecimalString()).toBe('6900.0000');
  });

  it('renders a SOFP that balances', () => {
    const report = unwrap(
      evaluateReport(SOFP, balances, {
        baseCurrency: MYR,
        calcValues: { CURRENT_YEAR_EARNINGS: rm('-6900.00') },
      }),
    );
    expect(line(report, 't-assets').amount.toDecimalString()).toBe(
      line(report, 't-liab-equity').amount.toDecimalString(),
    );
  });

  it('orders lines by sequence, not by tree position', () => {
    const report = unwrap(
      evaluateReport(SOFP, balances, {
        baseCurrency: MYR,
        calcValues: { CURRENT_YEAR_EARNINGS: rm('-6900.00') },
      }),
    );
    // The total prints after its children even though it is their parent.
    const sequences = report.lines.map((l) => l.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(report.lines.findIndex((l) => l.lineId === 't-assets'))
      .toBeGreaterThan(report.lines.findIndex((l) => l.lineId === 'd-ar'));
  });

  it('renders a comparative column', () => {
    const prior = [
      balance('1000', 'ASSET', '1000.00', ['cash_and_bank']),
      balance('1100', 'ASSET', '500.00', ['trade_receivables']),
    ];
    const report = unwrap(
      evaluateReport(SOFP, balances, {
        baseCurrency: MYR,
        calcValues: { CURRENT_YEAR_EARNINGS: rm('-6900.00') },
        comparative: prior,
      }),
    );
    expect(line(report, 't-assets').comparative!.toDecimalString()).toBe('1500.0000');
  });

  it('computes a SOPL', () => {
    const report = unwrap(
      evaluateReport(
        SOPL,
        [balance('4000', 'INCOME', '-10000.00'), balance('5000', 'EXPENSE', '3000.00')],
        { baseCurrency: MYR },
      ),
    );
    expect(line(report, 'd-revenue').amount.toDecimalString()).toBe('10000.0000');
    expect(line(report, 'd-expenses').amount.toDecimalString()).toBe('-3000.0000');
    expect(line(report, 't-profit').amount.toDecimalString()).toBe('7000.0000');
  });
});

describe('the engine refuses to lose money', () => {
  it('errors on an account with a balance that maps nowhere', () => {
    const result = evaluateReport(
      SOFP,
      [
        balance('1000', 'ASSET', '100.00', ['cash_and_bank']),
        balance('9999', 'ASSET', '4700.00', [], 'Orphan'),
      ],
      { baseCurrency: MYR, calcValues: { CURRENT_YEAR_EARNINGS: rm('0') } },
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      const violation = result.error[0]!;
      expect(violation.code).toBe('UNMAPPED_ACCOUNTS');
      if (violation.code === 'UNMAPPED_ACCOUNTS') {
        // The message names the offending account, so the fix is obvious.
        expect(violation.accounts).toEqual([
          { code: '9999', name: 'Orphan', amount: '4700.0000' },
        ]);
      }
    }
  });

  it('tolerates an unmapped account with a ZERO balance', () => {
    // An unused chart entry is not money going missing.
    const result = evaluateReport(
      SOFP,
      [balance('1000', 'ASSET', '100.00', ['cash_and_bank']), balance('9999', 'ASSET', '0')],
      { baseCurrency: MYR, calcValues: { CURRENT_YEAR_EARNINGS: rm('0') } },
    );
    expect(result.ok).toBe(true);
  });

  it('errors when a CALC line has no supplied value', () => {
    const result = evaluateReport(SOFP, [balance('1000', 'ASSET', '100.00', ['cash_and_bank'])], {
      baseCurrency: MYR,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]!.code).toBe('MISSING_CALC_VALUE');
  });

  it('rejects a cyclic line tree', () => {
    const cyclic: ReportDefinition = {
      ...SOPL,
      lines: [
        { id: 'a', sequence: 1, label: 'A', level: 0, lineType: 'TOTAL', parentLineId: 'b', signConvention: 'NATURAL' },
        { id: 'b', sequence: 2, label: 'B', level: 0, lineType: 'TOTAL', parentLineId: 'a', signConvention: 'NATURAL' },
      ],
    };
    const result = evaluateReport(cyclic, [], { baseCurrency: MYR });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.some((v) => v.code === 'CYCLIC_LINE_TREE')).toBe(true);
  });

  it('rejects a parent line that does not exist', () => {
    const broken: ReportDefinition = {
      ...SOPL,
      lines: [
        { id: 'a', sequence: 1, label: 'A', level: 0, lineType: 'DETAIL', parentLineId: 'ghost', signConvention: 'NATURAL' },
      ],
    };
    const result = evaluateReport(broken, [], { baseCurrency: MYR });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]!.code).toBe('UNKNOWN_PARENT_LINE');
  });

  it('rejects a SOFP definition that CLAIMS a profit-and-loss account', () => {
    // The same money would appear once in its own right and again inside
    // current-year earnings. A tenant can introduce this by editing a layout,
    // so it is caught rather than trusted not to happen.
    //
    // (An income account that no SOFP line claims is a different failure —
    // UNMAPPED_ACCOUNTS — and is covered above.)
    const wrong: ReportDefinition = {
      ...SOFP,
      lines: [
        ...SOFP.lines,
        {
          id: 'd-oops', sequence: 35, label: 'Revenue on the balance sheet', level: 1,
          lineType: 'DETAIL', parentLineId: 't-assets', signConvention: 'NATURAL',
          accountMaps: [{ matchType: 'ACCOUNT_TYPE', matchValue: 'INCOME', priority: 5 }],
        },
      ],
    };

    const result = evaluateReport(wrong, [balance('4000', 'INCOME', '-1000.00')], {
      baseCurrency: MYR,
      calcValues: { CURRENT_YEAR_EARNINGS: rm('-1000.00') },
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      const violation = result.error.find((v) => v.code === 'WRONG_ACCOUNT_TYPE_FOR_REPORT');
      expect(violation).toBeDefined();
      if (violation?.code === 'WRONG_ACCOUNT_TYPE_FOR_REPORT') {
        expect(violation.accounts).toEqual([
          { code: '4000', type: 'INCOME', lineId: 'd-oops' },
        ]);
      }
    }
  });

  it('rejects a SOPL definition that CLAIMS a balance-sheet account', () => {
    const wrong: ReportDefinition = {
      ...SOPL,
      lines: [
        ...SOPL.lines,
        {
          id: 'd-oops', sequence: 15, label: 'Cash in the P&L', level: 1,
          lineType: 'DETAIL', parentLineId: 't-profit', signConvention: 'NATURAL',
          accountMaps: [{ matchType: 'ACCOUNT_TYPE', matchValue: 'ASSET', priority: 5 }],
        },
      ],
    };

    const result = evaluateReport(wrong, [balance('1000', 'ASSET', '1000.00')], {
      baseCurrency: MYR,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'WRONG_ACCOUNT_TYPE_FOR_REPORT')).toBe(true);
    }
  });

  it('rejects accounts attached to a non-DETAIL line', () => {
    const broken: ReportDefinition = {
      ...SOPL,
      lines: [
        {
          id: 'a', sequence: 1, label: 'A', level: 0, lineType: 'TOTAL', signConvention: 'NATURAL',
          accountMaps: [{ matchType: 'ACCOUNT_TYPE', matchValue: 'ASSET', priority: 1 }],
        },
      ],
    };
    const result = evaluateReport(broken, [], { baseCurrency: MYR });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]!.code).toBe('ACCOUNTS_ON_NON_DETAIL_LINE');
  });
});

// ---------------------------------------------------------------------------
// Invariant #3
// ---------------------------------------------------------------------------

describe('invariant #3 — Assets = Liabilities + Equity', () => {
  it('holds for a simple balanced set', () => {
    const equation = checkAccountingEquation(
      [
        balance('1100', 'ASSET', '1080.00'),
        balance('2100', 'LIABILITY', '-80.00'),
        balance('4000', 'INCOME', '-1000.00'),
      ],
      MYR,
    );
    expect(equation.assets.toDecimalString()).toBe('1080.0000');
    expect(equation.liabilitiesAndEquity.toDecimalString()).toBe('1080.0000');
    expect(equation.balances).toBe(true);
  });

  it('folds the current year profit into equity', () => {
    // Without including income and expense, this would look unbalanced by
    // exactly the year's profit — the classic broken balance sheet.
    const equation = checkAccountingEquation(
      [
        balance('1000', 'ASSET', '5000.00'),
        balance('3000', 'EQUITY', '-1000.00'),
        balance('4000', 'INCOME', '-6000.00'),
        balance('5000', 'EXPENSE', '2000.00'),
      ],
      MYR,
    );
    expect(equation.balances).toBe(true);
    expect(equation.liabilitiesAndEquity.toDecimalString()).toBe('5000.0000');
  });

  it('detects an imbalance', () => {
    const equation = checkAccountingEquation(
      [balance('1000', 'ASSET', '100.00'), balance('2000', 'LIABILITY', '-90.00')],
      MYR,
    );
    expect(equation.balances).toBe(false);
    expect(equation.difference.toDecimalString()).toBe('10.0000');
  });

  it('holds for any set of balanced journal movements (property)', () => {
    // Model a ledger: generate arbitrary debit/credit pairs across account
    // types. Every pair is balanced, so the accounting equation must hold no
    // matter which types the money moved between.
    const types: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            debitType: fc.constantFrom(...types),
            creditType: fc.constantFrom(...types),
            units: fc.bigInt({ min: 1n, max: 1_000_000_0000n }),
          }),
          { maxLength: 40 },
        ),
        (movements) => {
          const totals = new Map<AccountType, bigint>(types.map((t) => [t, 0n]));
          for (const m of movements) {
            totals.set(m.debitType, totals.get(m.debitType)! + m.units);
            totals.set(m.creditType, totals.get(m.creditType)! - m.units);
          }

          const balances: AccountBalance[] = types.map((type, i) => ({
            accountId: `acc-${i}`,
            code: `${i}000`,
            name: type,
            type,
            tags: [],
            amount: Money.fromUnits(totals.get(type)!, MYR),
          }));

          expect(checkAccountingEquation(balances, MYR).balances).toBe(true);
        },
      ),
    );
  });
});

describe('currentYearEarnings', () => {
  it('sums income and expense, debit-positive', () => {
    const earnings = currentYearEarnings(
      [
        balance('4000', 'INCOME', '-10000.00'),
        balance('5000', 'EXPENSE', '3000.00'),
        balance('1000', 'ASSET', '99999.00'), // ignored
      ],
      MYR,
    );
    // A RM 7,000 profit is -7000 debit-positive; an INVERTED equity line
    // presents it as +7000.
    expect(earnings.toDecimalString()).toBe('-7000.0000');
  });

  it('is zero with no profit and loss activity', () => {
    expect(currentYearEarnings([balance('1000', 'ASSET', '100')], MYR).isZero()).toBe(true);
  });
});

describe('SOPL and SOFP agree', () => {
  it('profit on the SOPL equals current year earnings on the SOFP', () => {
    const plBalances = [
      balance('4000', 'INCOME', '-10000.00'),
      balance('5000', 'EXPENSE', '3000.00'),
    ];
    const sopl = unwrap(evaluateReport(SOPL, plBalances, { baseCurrency: MYR }));

    const earnings = currentYearEarnings(plBalances, MYR);
    const sofp = unwrap(
      evaluateReport(
        SOFP,
        [balance('1000', 'ASSET', '7000.00', ['cash_and_bank'])],
        { baseCurrency: MYR, calcValues: { CURRENT_YEAR_EARNINGS: earnings } },
      ),
    );

    expect(line(sopl, 't-profit').amount.toDecimalString()).toBe(
      line(sofp, 'c-cye').amount.toDecimalString(),
    );
    // ...and the balance sheet balances as a result.
    expect(line(sofp, 't-assets').amount.toDecimalString()).toBe(
      line(sofp, 't-liab-equity').amount.toDecimalString(),
    );
  });
});
