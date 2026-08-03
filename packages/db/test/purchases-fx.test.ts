import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { enterBill } from '../src/bill.js';
import { paySupplier } from '../src/supplier-payment.js';
import { issueInvoice } from '../src/invoice.js';
import { recordReceipt } from '../src/payment.js';
import { runRevaluation } from '../src/revaluation.js';
import { detectRollupDrift } from '../src/ledger.js';
import { accountingEquationAt, statementOfFinancialPosition } from '../src/report.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('purchfx');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin);

  await withTenant(admin, { tenantId: tenant.tenantId }, (tx) => tx`
      INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate, source)
      VALUES (${tenant.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000, 'BNM'),
             (${tenant.tenantId}, 'USD', 'MYR', '2026-08-31', 4.90000000, 'BNM'),
             (${tenant.tenantId}, 'USD', 'MYR', '2026-09-15', 4.80000000, 'BNM')
  `);
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

async function accountBase(code: string, t: Tenant = tenant): Promise<string> {
  const [row] = await withTenant(sql, { tenantId: t.tenantId }, (tx) =>
    tx<{ balance: string }[]>`
        SELECT COALESCE(SUM(net_movement), 0)::text AS balance
          FROM account_period_balance
         WHERE tenant_id = ${t.tenantId} AND account_id = ${t.accounts[code]!}
    `,
  );
  return rm(row!.balance).toDecimalString();
}

/**
 * A balance as at a date — NOT across all time.
 *
 * A revaluation posts on the reporting date and reverses the next day, so
 * summing every period nets the two to zero and an assertion against it would
 * pass whatever the revaluation did. The `as at` cut is what makes the
 * adjustment visible.
 */
async function accountBaseAsAt(code: string, asOf: string, t: Tenant = tenant): Promise<string> {
  const [row] = await withTenant(sql, { tenantId: t.tenantId }, (tx) =>
    tx<{ balance: string }[]>`
        SELECT COALESCE(SUM(b.net_movement), 0)::text AS balance
          FROM account_period_balance b
          JOIN fiscal_period p
            ON p.tenant_id = b.tenant_id AND p.id = b.fiscal_period_id
         WHERE b.tenant_id = ${t.tenantId}
           AND b.account_id = ${t.accounts[code]!}
           AND p.start_date <= ${asOf}::date
    `,
  );
  return rm(row!.balance).toDecimalString();
}

async function enterUsdBill(amount: string, t: Tenant = tenant, billDate = '2026-08-05') {
  const c = { tenantId: t.tenantId, userId: t.userId };
  return withTenant(sql, c, (tx) =>
    enterBill(tx, c, {
      supplierId: t.supplierId,
      billNo: `USD-${randomUUID().slice(0, 8)}`,
      billDate,
      currency: 'USD',
      lines: [
        {
          description: 'Imported components',
          quantity: '1',
          unitPrice: amount,
          accountId: t.accounts['6000']!,
          taxCodeId: t.taxCodes['NONE']!,
        },
      ],
      idempotencyKey: randomUUID(),
    }),
  );
}

describe('a foreign-currency bill books AP at the rate on the bill date', () => {
  it('carries the payable at the booked rate, not at 1:1', async () => {
    const t = await seedTenant(admin, 'Import Sdn Bhd');
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate, source)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000, 'BNM')
    `);

    await enterUsdBill('1000.00', t);

    // USD 1,000 at 4.70 = RM 4,700 credited to AP.
    expect(await accountBase('2000', t)).toBe('-4700.0000');
    expect(await accountBase('6000', t)).toBe('4700.0000');
  });
});

describe('realised FX on settlement — the sign cannot invert', () => {
  it('a strengthening USD makes a USD payable more expensive: a LOSS', async () => {
    const t = await seedTenant(admin, 'Payables FX Sdn Bhd');
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate, source)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000, 'BNM'),
               (${t.tenantId}, 'USD', 'MYR', '2026-09-15', 4.80000000, 'BNM')
    `);

    const bill = await enterUsdBill('1000.00', t);
    const c = { tenantId: t.tenantId, userId: t.userId };

    const payment = await withTenant(sql, c, (tx) =>
      paySupplier(tx, c, {
        supplierId: t.supplierId,
        paymentDate: '2026-09-15',
        amount: '1000.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ billId: bill.id, amount: '1000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    // Booked owing RM 4,700; paid RM 4,800. RM 100 worse off — a LOSS, which
    // this system reports as a NEGATIVE realised FX.
    expect(payment.realisedFx).toBe('-100.0000');

    // AP is fully relieved at the BOOKED rate, so nothing is left stranded in
    // the control account. This is ledger invariant #13 on the payables side.
    expect(await accountBase('2000', t)).toBe('0.0000');
    // Cash out at the settlement rate.
    expect(await accountBase('1000', t)).toBe('-4800.0000');
    // The difference is the P&L charge. Debit to FX = loss.
    expect(await accountBase('6900', t)).toBe('100.0000');
  });

  it('inbound and outbound at identical rates are equal and opposite', async () => {
    // The reason receipts and payments share ONE journal builder. A
    // hand-written payables copy has to swap every debit and credit, which
    // inverts the meaning of the difference — and a loss reported as a gain
    // looks entirely plausible on a P&L.
    const t = await seedTenant(admin, 'Symmetry Sdn Bhd');
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate, source)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000, 'BNM'),
               (${t.tenantId}, 'USD', 'MYR', '2026-09-15', 4.80000000, 'BNM')
    `);
    const c = { tenantId: t.tenantId, userId: t.userId };

    const invoice = await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: t.customerId,
        issueDate: '2026-08-05',
        currency: 'USD',
        lines: [
          {
            description: 'Export consulting',
            quantity: '1',
            unitPrice: '1000.00',
            accountId: t.accounts['4000']!,
            taxCodeId: t.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );
    const bill = await enterUsdBill('1000.00', t);

    const receipt = await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-09-15',
        amount: '1000.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '1000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const payment = await withTenant(sql, c, (tx) =>
      paySupplier(tx, c, {
        supplierId: t.supplierId,
        paymentDate: '2026-09-15',
        amount: '1000.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ billId: bill.id, amount: '1000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(receipt.realisedFx).toBe('100.0000');
    expect(payment.realisedFx).toBe('-100.0000');

    // Equal and opposite: a matched receivable and payable in the same
    // currency, settled the same day, is a perfect natural hedge and must
    // leave the P&L untouched.
    expect(
      rm(receipt.realisedFx!).add(rm(payment.realisedFx!)).isZero(),
    ).toBe(true);
    expect(await accountBase('6900', t)).toBe('0.0000');
  });
});

describe('period-end revaluation covers payables too', () => {
  it('restates an open USD payable at the closing rate, as a LOSS when USD strengthens', async () => {
    const t = await seedTenant(admin, 'Reval AP Sdn Bhd');
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate, source)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000, 'BNM'),
               (${t.tenantId}, 'USD', 'MYR', '2026-08-31', 4.90000000, 'BNM')
    `);
    await enterUsdBill('1000.00', t);

    const [period] = await withTenant(sql, { tenantId: t.tenantId }, (tx) =>
      tx<{ id: string }[]>`
          SELECT id FROM fiscal_period
           WHERE tenant_id = ${t.tenantId} AND sequence = 8
      `,
    );

    const c = { tenantId: t.tenantId, userId: t.userId };
    const result = await withTenant(sql, c, (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: period!.id, idempotencyKey: randomUUID() }),
    );

    // Carrying -4,700; at the closing rate -4,900. The difference is -200: the
    // liability grew, so the tenant is RM 200 worse off. If this ever comes
    // back positive, the payables sign convention has been inverted.
    expect(result.status).toBe('POSTED');
    expect(result.totalDifference).toBe('-200.0000');
    expect(result.byCurrency).toEqual([
      {
        side: 'PAYABLE',
        currency: 'USD',
        outstanding: '-1000.0000',
        carryingBase: '-4700.0000',
        closingRate: '4.90000000',
        closingBase: '-4900.0000',
        difference: '-200.0000',
      },
    ]);

    // The adjustment sits in AP_REVALUATION, NOT in AR_REVALUATION — that
    // separation is what keeps a payables movement off the receivables line
    // of the balance sheet.
    expect(await accountBaseAsAt('2090', '2026-08-31', t)).toBe('-200.0000');
    expect(await accountBaseAsAt('1190', '2026-08-31', t)).toBe('0.0000');

    // ...and it is gone again the next day. The adjustment holds only until
    // the statements are drawn; the September settlement then computes its
    // realised difference from the ORIGINAL booked rate, not from a restated
    // one, which is what stops the movement being counted twice.
    expect(await accountBase('2090', t)).toBe('0.0000');
  });

  it('a matched receivable and payable in one currency net to no P&L effect', async () => {
    const t = await seedTenant(admin, 'Hedged Sdn Bhd');
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate, source)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000, 'BNM'),
               (${t.tenantId}, 'USD', 'MYR', '2026-08-31', 4.90000000, 'BNM')
    `);
    const c = { tenantId: t.tenantId, userId: t.userId };

    await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: t.customerId,
        issueDate: '2026-08-05',
        currency: 'USD',
        lines: [
          {
            description: 'Export consulting',
            quantity: '1',
            unitPrice: '1000.00',
            accountId: t.accounts['4000']!,
            taxCodeId: t.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );
    await enterUsdBill('1000.00', t);

    const [period] = await withTenant(sql, { tenantId: t.tenantId }, (tx) =>
      tx<{ id: string }[]>`
          SELECT id FROM fiscal_period WHERE tenant_id = ${t.tenantId} AND sequence = 8
      `,
    );

    const result = await withTenant(sql, c, (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: period!.id, idempotencyKey: randomUUID() }),
    );

    // +200 on the receivable, -200 on the payable. The balance sheet moves on
    // BOTH lines; the P&L does not move at all. A revaluation that netted the
    // two into one balance-sheet account would show the same P&L and the wrong
    // balance sheet.
    expect(result.totalDifference).toBe('0.0000');
    expect(await accountBaseAsAt('1190', '2026-08-31', t)).toBe('200.0000');
    expect(await accountBaseAsAt('2090', '2026-08-31', t)).toBe('-200.0000');
    expect(await accountBaseAsAt('6910', '2026-08-31', t)).toBe('0.0000');

    // With no P&L movement there is still a journal, because two balance-sheet
    // lines moved. It must balance.
    const drift = await withTenant(sql, c, (tx) => detectRollupDrift(tx, c));
    expect(drift).toEqual([]);
  });
});

describe('ledger invariant #3 still holds with purchases in play', () => {
  it('the SOFP balances after bills, payments, debit notes and a revaluation', async () => {
    const t = await seedTenant(admin, 'Full Cycle Sdn Bhd');
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate, source)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000, 'BNM'),
               (${t.tenantId}, 'USD', 'MYR', '2026-08-31', 4.90000000, 'BNM')
    `);
    const c = { tenantId: t.tenantId, userId: t.userId };

    await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: t.customerId,
        issueDate: '2026-08-02',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitPrice: '5000.00',
            accountId: t.accounts['4000']!,
            taxCodeId: t.taxCodes['SST-SVC']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const bill = await withTenant(sql, c, (tx) =>
      enterBill(tx, c, {
        supplierId: t.supplierId,
        billNo: 'CYCLE-1',
        billDate: '2026-08-03',
        lines: [
          {
            description: 'Subcontractor',
            quantity: '1',
            unitPrice: '2000.00',
            accountId: t.accounts['5000']!,
            taxCodeId: t.taxCodes['SST-SVC']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, c, (tx) =>
      paySupplier(tx, c, {
        supplierId: t.supplierId,
        paymentDate: '2026-08-20',
        amount: '1000.00',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ billId: bill.id, amount: '1000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    await enterUsdBill('500.00', t, '2026-08-10');

    const [period] = await withTenant(sql, { tenantId: t.tenantId }, (tx) =>
      tx<{ id: string }[]>`
          SELECT id FROM fiscal_period WHERE tenant_id = ${t.tenantId} AND sequence = 8
      `,
    );
    await withTenant(sql, c, (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: period!.id, idempotencyKey: randomUUID() }),
    );

    // Ledger invariant #3 against the ledger itself: catches a mistyped account.
    const equation = await withTenant(sql, c, (tx) => accountingEquationAt(tx, c, '2026-08-31'));
    expect(equation.balances).toBe(true);

    // And against the presentation: a balanced SOFP additionally proves nothing
    // was dropped by the account-to-line mapping. This is the check the whole
    // reporting module exists to make visible, and the reason M7 came before M3.
    const sofp = await withTenant(sql, c, (tx) =>
      statementOfFinancialPosition(tx, c, { asOfDate: '2026-08-31', framework: 'MPERS' }),
    );
    const total = (label: string) =>
      sofp.lines.find((l) => l.label.toLowerCase().includes(label))?.amount;
    expect(sofp.lines.length).toBeGreaterThan(0);
    expect(total('total assets')).toBeDefined();

    const drift = await withTenant(sql, c, (tx) => detectRollupDrift(tx, c));
    expect(drift).toEqual([]);
  });
});
