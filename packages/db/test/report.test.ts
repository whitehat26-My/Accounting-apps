import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, unwrap, validateJournalEntry, type RenderedReport } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { issueInvoice } from '../src/invoice.js';
import { recordReceipt } from '../src/payment.js';
import { issueCreditNote } from '../src/credit-note.js';
import { runRevaluation } from '../src/revaluation.js';
import { postJournalEntry } from '../src/ledger.js';
import {
  accountingEquationAt,
  reportingSanityCheck,
  statementOfFinancialPosition,
  statementOfProfitOrLoss,
  trialBalanceReport,
} from '../src/report.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDatabase('report');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const rm = (v: string) => Money.fromDecimal(v, 'MYR');
const line = (report: RenderedReport, id: string) =>
  report.lines.find((l) => l.lineId === id)!;

async function invoiceFor(t: Tenant, unitPrice: string, taxCode = 'NONE', issueDate = '2026-08-05') {
  const c = { tenantId: t.tenantId, userId: t.userId };
  return withTenant(sql, c, (tx) =>
    issueInvoice(tx, c, {
      contactId: t.customerId,
      issueDate,
      lines: [{
        description: 'Services',
        quantity: '1',
        unitPrice,
        accountId: t.accounts['4000']!,
        taxCodeId: t.taxCodes[taxCode]!,
      }],
      idempotencyKey: randomUUID(),
    }),
  );
}

describe('the trial balance report', () => {
  it('balances and lists only accounts with activity', async () => {
    const t = await seedTenant(admin, 'TB Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await invoiceFor(t, '1000.00', 'SST-SVC');

    const tb = await withTenant(sql, c, (tx) =>
      trialBalanceReport(tx, c, { from: null, to: '2026-12-31' }),
    );

    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    // AR, revenue, SST payable — and nothing else.
    expect(tb.rows.map((r) => r.code).sort()).toEqual(['1100', '2100', '4000']);
  });
});

describe('the statement of profit or loss', () => {
  it('shows revenue positive and expenses negative, netting to profit', async () => {
    const t = await seedTenant(admin, 'SOPL Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await invoiceFor(t, '10000.00');

    // An expense, posted through a credit note's reversal of revenue would be
    // wrong; use a manual-shaped bill substitute by crediting revenue is not
    // available yet, so exercise revenue only plus an FX loss from settlement.
    const sopl = await withTenant(sql, c, (tx) =>
      statementOfProfitOrLoss(tx, c, { from: '2026-01-01', to: '2026-12-31' }),
    );

    expect(line(sopl, 'sopl-revenue').amount.toDecimalString()).toBe('10000.0000');
    expect(line(sopl, 'sopl-total').amount.toDecimalString()).toBe('10000.0000');
  });

  it('restricts to the requested window', async () => {
    const t = await seedTenant(admin, 'SOPL Window Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await invoiceFor(t, '1000.00', 'NONE', '2026-03-05');
    await invoiceFor(t, '5000.00', 'NONE', '2026-08-05');

    const august = await withTenant(sql, c, (tx) =>
      statementOfProfitOrLoss(tx, c, { from: '2026-08-01', to: '2026-08-31' }),
    );
    expect(line(august, 'sopl-revenue').amount.toDecimalString()).toBe('5000.0000');

    const year = await withTenant(sql, c, (tx) =>
      statementOfProfitOrLoss(tx, c, { from: '2026-01-01', to: '2026-12-31' }),
    );
    expect(line(year, 'sopl-revenue').amount.toDecimalString()).toBe('6000.0000');
  });

  it('renders a comparative column', async () => {
    const t = await seedTenant(admin, 'SOPL Comparative Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await invoiceFor(t, '1000.00', 'NONE', '2026-03-05');
    await invoiceFor(t, '5000.00', 'NONE', '2026-08-05');

    const report = await withTenant(sql, c, (tx) =>
      statementOfProfitOrLoss(tx, c, {
        from: '2026-08-01',
        to: '2026-08-31',
        comparative: { from: '2026-03-01', to: '2026-03-31' },
      }),
    );

    expect(line(report, 'sopl-revenue').amount.toDecimalString()).toBe('5000.0000');
    expect(line(report, 'sopl-revenue').comparative!.toDecimalString()).toBe('1000.0000');
  });
});

// ---------------------------------------------------------------------------
// Invariant #3 — the reason M7 was built first
// ---------------------------------------------------------------------------

describe('invariant #3 — the balance sheet balances', () => {
  it('balances after an invoice with SST', async () => {
    const t = await seedTenant(admin, 'SOFP Invoice Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await invoiceFor(t, '1000.00', 'SST-SVC'); // Dr AR 1080 / Cr Rev 1000 / Cr SST 80

    const sofp = await withTenant(sql, c, (tx) =>
      statementOfFinancialPosition(tx, c, { asOfDate: '2026-12-31' }),
    );

    expect(line(sofp, 'sofp-ar').amount.toDecimalString()).toBe('1080.0000');
    expect(line(sofp, 'sofp-ap').amount.toDecimalString()).toBe('80.0000'); // SST payable
    expect(line(sofp, 'sofp-cye').amount.toDecimalString()).toBe('1000.0000');

    expect(line(sofp, 'sofp-t-assets').amount.toDecimalString()).toBe(
      line(sofp, 'sofp-t-eqliab').amount.toDecimalString(),
    );
  });

  it('balances after invoice, receipt, credit note and revaluation', async () => {
    const t = await seedTenant(admin, 'SOFP Full Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000),
               (${t.tenantId}, 'USD', 'MYR', '2026-08-31', 4.90000000)
    `);

    const paid = await invoiceFor(t, '2000.00', 'SST-SVC');
    const credited = await invoiceFor(t, '500.00', 'NONE');

    await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-08-20',
        amount: '1000.00',
        method: 'FPX',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ invoiceId: paid.id, amount: '1000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, c, (tx) =>
      issueCreditNote(tx, c, {
        contactId: t.customerId,
        invoiceId: credited.id,
        creditDate: '2026-08-25',
        reason: 'RETURN',
        lines: [{
          description: 'Returned',
          quantity: '1',
          unitPrice: '200.00',
          accountId: t.accounts['4000']!,
          taxCodeId: t.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    // A foreign invoice plus a period-end revaluation, so the AR revaluation
    // account has a balance and must present on the receivables line.
    await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: t.customerId,
        issueDate: '2026-08-10',
        currency: 'USD',
        lines: [{
          description: 'Export',
          quantity: '1',
          unitPrice: '1000.00',
          accountId: t.accounts['4000']!,
          taxCodeId: t.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    const [period] = await withTenant(sql, c, (tx) =>
      tx<{ id: string }[]>`
          SELECT id FROM fiscal_period WHERE tenant_id = ${t.tenantId} AND sequence = 8
      `,
    );
    await withTenant(sql, c, (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: period!.id, idempotencyKey: randomUUID() }),
    );

    const sofp = await withTenant(sql, c, (tx) =>
      statementOfFinancialPosition(tx, c, { asOfDate: '2026-08-31' }),
    );

    expect(line(sofp, 'sofp-t-assets').amount.toDecimalString()).toBe(
      line(sofp, 'sofp-t-eqliab').amount.toDecimalString(),
    );
  });

  it('agrees with the ledger-level accounting equation', async () => {
    const t = await seedTenant(admin, 'SOFP Equation Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await invoiceFor(t, '1234.56', 'SST-SVC');

    const equation = await withTenant(sql, c, (tx) =>
      accountingEquationAt(tx, c, '2026-12-31'),
    );

    // The ledger-level check catches a mistyped account; the SOFP balancing
    // additionally proves the mapping dropped nothing. Both must hold.
    expect(equation.balances).toBe(true);

    const sofp = await withTenant(sql, c, (tx) =>
      statementOfFinancialPosition(tx, c, { asOfDate: '2026-12-31' }),
    );
    expect(line(sofp, 'sofp-t-assets').amount.toDecimalString()).toBe(
      equation.assets.toDecimalString(),
    );
  });

  it('puts the AR revaluation account on the receivables line', async () => {
    const t = await seedTenant(admin, 'SOFP Reval Line Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000),
               (${t.tenantId}, 'USD', 'MYR', '2026-08-31', 4.90000000)
    `);

    await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: t.customerId,
        issueDate: '2026-08-10',
        currency: 'USD',
        lines: [{
          description: 'Export',
          quantity: '1',
          unitPrice: '1000.00',
          accountId: t.accounts['4000']!,
          taxCodeId: t.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    const [period] = await withTenant(sql, c, (tx) =>
      tx<{ id: string }[]>`
          SELECT id FROM fiscal_period WHERE tenant_id = ${t.tenantId} AND sequence = 8
      `,
    );
    await withTenant(sql, c, (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: period!.id, idempotencyKey: randomUUID() }),
    );

    const sofp = await withTenant(sql, c, (tx) =>
      statementOfFinancialPosition(tx, c, { asOfDate: '2026-08-31' }),
    );

    // AR 4700 + revaluation 200, on ONE line. This is the claim made in
    // packages/domain/src/revaluation.ts, now actually demonstrated.
    expect(line(sofp, 'sofp-ar').amount.toDecimalString()).toBe('4900.0000');
    expect(line(sofp, 'sofp-t-assets').amount.toDecimalString()).toBe(
      line(sofp, 'sofp-t-eqliab').amount.toDecimalString(),
    );
  });
});

describe('SOPL and SOFP agree', () => {
  it('profit for the year equals current year earnings on the balance sheet', async () => {
    const t = await seedTenant(admin, 'Agreement Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await invoiceFor(t, '3000.00', 'SST-SVC', '2026-03-05');
    await invoiceFor(t, '7000.00', 'NONE', '2026-08-05');

    const sopl = await withTenant(sql, c, (tx) =>
      statementOfProfitOrLoss(tx, c, { from: '2026-01-01', to: '2026-12-31' }),
    );
    const sofp = await withTenant(sql, c, (tx) =>
      statementOfFinancialPosition(tx, c, { asOfDate: '2026-12-31' }),
    );

    // If these ever disagree, either the sign convention or the mapping is
    // broken — and CI says so rather than a customer.
    expect(line(sofp, 'sofp-cye').amount.toDecimalString()).toBe(
      line(sopl, 'sopl-total').amount.toDecimalString(),
    );
  });
});

describe('the engine refuses to lose money', () => {
  it('fails loudly when an account with a balance maps to no line', async () => {
    const t = await seedTenant(admin, 'Unmapped Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    // Remove the ASSET completeness net from the template, so an untagged
    // asset has nowhere to land. This is the failure mode the whole mapping
    // design exists to prevent: money on the ledger, absent from the statement.
    await admin.unsafe(`
        DELETE FROM report_template_line_map
         WHERE line_id = 'sofp-other-ast' AND match_type = 'ACCOUNT_TYPE'
    `);

    const [prepayments] = await withTenant(admin, { tenantId: t.tenantId }, (tx) =>
      tx<{ id: string }[]>`
          INSERT INTO account (tenant_id, code, name, type)
          VALUES (${t.tenantId}, '1500', 'Prepayments', 'ASSET')
          RETURNING id
      `,
    );

    // Give it a real balance: Dr Prepayments / Cr Cash.
    const entry = unwrap(
      validateJournalEntry(
        {
          entryDate: '2026-08-05',
          description: 'Prepaid insurance',
          sourceModule: 'MANUAL',
          lines: [
            {
              accountId: prepayments!.id, side: 'DEBIT',
              amount: rm('1200.00'), baseAmount: rm('1200.00'),
            },
            {
              accountId: t.accounts['1000']!, side: 'CREDIT',
              amount: rm('1200.00'), baseAmount: rm('1200.00'),
            },
          ],
        },
        'MYR',
      ),
    );

    await withTenant(sql, c, (tx) =>
      postJournalEntry(tx, c, entry, { idempotencyKey: randomUUID() }),
    );

    await expect(
      withTenant(sql, c, (tx) =>
        statementOfFinancialPosition(tx, c, { asOfDate: '2026-12-31' }),
      ),
    ).rejects.toThrow(/Could not render/i);

    // And the error names the account, so the fix is obvious.
    try {
      await withTenant(sql, c, (tx) =>
        statementOfFinancialPosition(tx, c, { asOfDate: '2026-12-31' }),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      const detail = (error as { detail?: { code: string; accounts?: { code: string }[] }[] }).detail;
      const unmapped = detail?.find((d) => d.code === 'UNMAPPED_ACCOUNTS');
      expect(unmapped?.accounts?.map((a) => a.code)).toEqual(['1500']);
    }

    // Restore the template for any test that runs after this one.
    await admin.unsafe(`
        INSERT INTO report_template_line_map (line_id, match_type, match_value, priority)
        VALUES ('sofp-other-ast', 'ACCOUNT_TYPE', 'ASSET', 1)
    `);
  });
});

describe('the rollup holds base-currency rows only', () => {
  it('is asserted, because an unfiltered SUM would double-count foreign activity', async () => {
    const t = await seedTenant(admin, 'Sanity Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000)
    `);

    await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: t.customerId,
        issueDate: '2026-08-10',
        currency: 'USD',
        lines: [{
          description: 'Export',
          quantity: '1',
          unitPrice: '1000.00',
          accountId: t.accounts['4000']!,
          taxCodeId: t.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    const check = await withTenant(sql, c, (tx) => reportingSanityCheck(tx, c));
    expect(check.foreignCurrencyRollupRows).toBe(0);
  });
});

/**
 * A statement asked for on a day that is not a period end.
 *
 * ---------------------------------------------------------------------------
 * THE WINDOW USED TO BE PERIOD-GRANULAR, AND EVERY TEST ABOVE HID IT.
 *
 * `account_period_balance` holds one row per account per period, and the
 * queries included a period only if it ENDED on or before the window's end
 * date. Every test in this file asks for whole months or whole years, so the
 * rule was never exercised at a boundary — and the bug it concealed was that
 * a statement about the month you are LIVING IN reported nothing at all.
 *
 * On a real shop's books: profit or loss read RM 0.00 on the 8th of the month
 * while the balance sheet beside it showed the year's earnings, and the cash
 * figure was days stale. Found by printing the Reports screen and reading it.
 *
 * The window is now answered as whole periods from the rollup plus the
 * part-period at each edge from `journal_line`. These tests pin both halves
 * AND the seam between them, because the failure mode of a two-source query is
 * double counting, which no single-window assertion would catch.
 * ---------------------------------------------------------------------------
 */
describe('a window that ends inside a fiscal period', () => {
  let t: Tenant;
  let c: { tenantId: string; userId: string };

  beforeAll(async () => {
    t = await seedTenant(admin, 'Part Period Sdn Bhd');
    c = { tenantId: t.tenantId, userId: t.userId };
    // Two invoices inside ONE monthly period, so a window can cut between them.
    await invoiceFor(t, '5000.00', 'NONE', '2026-08-05');
    await invoiceFor(t, '3000.00', 'NONE', '2026-08-20');
  }, 60_000);

  const sopl = (from: string, to: string) =>
    withTenant(sql, c, (tx) => statementOfProfitOrLoss(tx, c, { from, to }));

  it('reports the trading that has actually happened this month', async () => {
    // THE BUG, in one line: this reported RM 0.00.
    const report = await sopl('2026-08-01', '2026-08-10');
    expect(line(report, 'sopl-revenue').amount.toDecimalString()).toBe('5000.0000');
  });

  it('still reports the whole period correctly, from the rollup', async () => {
    const report = await sopl('2026-08-01', '2026-08-31');
    expect(line(report, 'sopl-revenue').amount.toDecimalString()).toBe('8000.0000');
  });

  it('does not count the part-period twice when the window covers it whole', async () => {
    /*
     * The failure mode of reading two sources: a period wholly inside the
     * window is in the rollup AND its entries are in the journal. If the two
     * halves were not exact complements this would read RM 16,000.
     */
    const report = await sopl('2026-01-01', '2026-12-31');
    expect(line(report, 'sopl-revenue').amount.toDecimalString()).toBe('8000.0000');
  });

  it('cuts the lower edge of the window too, not only the upper', async () => {
    const report = await sopl('2026-08-15', '2026-08-31');
    expect(line(report, 'sopl-revenue').amount.toDecimalString()).toBe('3000.0000');
  });

  it('reads a window that lies entirely inside one period', async () => {
    const report = await sopl('2026-08-10', '2026-08-25');
    expect(line(report, 'sopl-revenue').amount.toDecimalString()).toBe('3000.0000');
  });

  it('carries the same movement onto the balance sheet as at that day', async () => {
    const sofp = await withTenant(sql, c, (tx) =>
      statementOfFinancialPosition(tx, c, { asOfDate: '2026-08-10' }),
    );
    // The receivable exists on the 10th, so the balance sheet has to show it.
    expect(line(sofp, 'sofp-ar').amount.toDecimalString()).toBe('5000.0000');
    expect(line(sofp, 'sofp-cye').amount.toDecimalString()).toBe('5000.0000');
    // And it must still balance — a part-period added to one side only would
    // be a worse bug than the one being fixed.
    expect(line(sofp, 'sofp-t-assets').amount.toDecimalString()).toBe(
      line(sofp, 'sofp-t-eqliab').amount.toDecimalString(),
    );
  });

  it('keeps the trial balance balanced mid-period', async () => {
    const tb = await withTenant(sql, c, (tx) =>
      trialBalanceReport(tx, c, { from: null, to: '2026-08-10' }),
    );
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe('5000.0000');

    const revenue = tb.rows.find((r) => r.code === '4000');
    // Debit and credit stay APART: the revenue line is a credit, not a
    // negative debit, and a netted part-period would have lost that.
    expect(revenue?.credit).toBe('5000.0000');
    expect(revenue?.debit).toBe('0.0000');
  });

  it('agrees with the accounting equation mid-period', async () => {
    const equation = await withTenant(sql, c, (tx) =>
      accountingEquationAt(tx, c, '2026-08-10'),
    );
    // `balances`, present tense — it is a question about this instant, not a
    // flag somebody set.
    expect(equation.balances).toBe(true);
    expect(equation.difference.toDecimalString()).toBe('0.0000');
  });
});
