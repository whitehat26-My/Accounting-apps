import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { issueInvoice, outstandingReceivables } from '../src/invoice.js';
import { recordReceipt } from '../src/payment.js';
import { receivablesAtClosingRate, runRevaluation } from '../src/revaluation.js';
import { detectRollupDrift } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDatabase('revaluation');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

/** A tenant with USD rates: 4.70 in August, 4.90 at the end of August. */
async function tenantWithRates(name: string): Promise<Tenant> {
  const t = await seedTenant(admin, name);
  await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
      INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate)
      VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000),
             (${t.tenantId}, 'USD', 'MYR', '2026-08-31', 4.90000000),
             (${t.tenantId}, 'USD', 'MYR', '2026-09-30', 4.60000000),
             (${t.tenantId}, 'SGD', 'MYR', '2026-08-01', 3.50000000),
             (${t.tenantId}, 'SGD', 'MYR', '2026-08-31', 3.40000000)
  `);
  return t;
}

async function issueUsd(t: Tenant, amount: string, issueDate = '2026-08-05', currency = 'USD') {
  const c = { tenantId: t.tenantId, userId: t.userId };
  return withTenant(sql, c, (tx) =>
    issueInvoice(tx, c, {
      contactId: t.customerId,
      issueDate,
      currency,
      lines: [{
        description: 'Export consulting',
        quantity: '1',
        unitPrice: amount,
        accountId: t.accounts['4000']!,
        taxCodeId: t.taxCodes['NONE']!,
      }],
      idempotencyKey: randomUUID(),
    }),
  );
}

async function periodId(t: Tenant, month: number): Promise<string> {
  const [row] = await withTenant(sql, { tenantId: t.tenantId }, (tx) =>
    tx<{ id: string }[]>`
        SELECT id FROM fiscal_period
         WHERE tenant_id = ${t.tenantId} AND sequence = ${month}
    `,
  );
  return row!.id;
}

async function accountBase(t: Tenant, code: string): Promise<string> {
  const [row] = await withTenant(sql, { tenantId: t.tenantId }, (tx) =>
    tx<{ balance: string }[]>`
        SELECT COALESCE(SUM(net_movement), 0)::text AS balance
          FROM account_period_balance
         WHERE tenant_id = ${t.tenantId} AND account_id = ${t.accounts[code]!}
    `,
  );
  return rm(row!.balance).toDecimalString();
}

/** Balance on an account restricted to a single fiscal period. */
async function accountBaseInPeriod(t: Tenant, code: string, month: number): Promise<string> {
  const [row] = await withTenant(sql, { tenantId: t.tenantId }, (tx) =>
    tx<{ balance: string }[]>`
        SELECT COALESCE(SUM(b.net_movement), 0)::text AS balance
          FROM account_period_balance b
          JOIN fiscal_period p ON p.tenant_id = b.tenant_id AND p.id = b.fiscal_period_id
         WHERE b.tenant_id = ${t.tenantId}
           AND b.account_id = ${t.accounts[code]!}
           AND p.sequence = ${month}
    `,
  );
  return rm(row!.balance).toDecimalString();
}

describe('running a revaluation', () => {
  it('restates an open USD receivable at the closing rate', async () => {
    const t = await tenantWithRates('Reval Basic Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd(t, '1000.00'); // AR carried at 4.70 -> RM 4,700

    const result = await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    expect(result.asOfDate).toBe('2026-08-31');
    expect(result.status).toBe('POSTED');
    expect(result.totalDifference).toBe('200.0000'); // 4900 - 4700
    expect(result.byCurrency).toEqual([
      {
        currency: 'USD',
        outstanding: '1000.0000',
        carryingBase: '4700.0000',
        closingRate: '4.90000000',
        closingBase: '4900.0000',
        difference: '200.0000',
      },
    ]);
  });

  it('posts the adjustment in August and its reversal in September', async () => {
    const t = await tenantWithRates('Reval Reversal Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd(t, '1000.00');
    await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    // At the reporting date the adjustment is present...
    expect(await accountBaseInPeriod(t, '1190', 8)).toBe('200.0000');
    expect(await accountBaseInPeriod(t, '6910', 8)).toBe('-200.0000'); // credit = gain

    // ...and it is undone the very next day.
    expect(await accountBaseInPeriod(t, '1190', 9)).toBe('-200.0000');
    expect(await accountBaseInPeriod(t, '6910', 9)).toBe('200.0000');

    // Net across both periods: nothing. That is what makes the subsequent
    // realised gain correct rather than double-counted.
    expect(await accountBase(t, '1190')).toBe('0.0000');
    expect(await accountBase(t, '6910')).toBe('0.0000');
  });

  it('leaves the AR control account untouched', async () => {
    const t = await tenantWithRates('Reval AR Intact Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd(t, '1000.00');
    const before = await accountBase(t, '1100');

    await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    // The adjustment sits in its own account, so invariant #6 survives.
    expect(await accountBase(t, '1100')).toBe(before);
  });

  it('keeps invariant #6 true across the reporting date', async () => {
    const t = await tenantWithRates('Reval Invariant Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd(t, '1000.00');
    await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    const subledger = await withTenant(sql, c, (tx) => outstandingReceivables(tx, c));
    expect(Money.fromDecimal(subledger.total, 'MYR').toDecimalString()).toBe(
      await accountBase(t, '1100'),
    );
  });

  it('handles several currencies in one run', async () => {
    const t = await tenantWithRates('Reval Multi Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd(t, '1000.00', '2026-08-05', 'USD'); // +200 at 4.90
    await issueUsd(t, '1000.00', '2026-08-06', 'SGD'); // -100 at 3.40

    const result = await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    expect(result.byCurrency.map((l) => l.currency)).toEqual(['SGD', 'USD']);
    expect(result.totalDifference).toBe('100.0000'); // 200 - 100
  });

  it('posts nothing when no rate moved', async () => {
    const t = await seedTenant(admin, 'Reval Flat Sdn Bhd');
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000)
    `);
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd(t, '1000.00');

    const result = await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    expect(result.status).toBe('NO_ADJUSTMENT');
    expect(result.journalEntryId).toBeNull();
    expect(result.reversalEntryId).toBeNull();
    expect(result.totalDifference).toBe('0.0000');
  });

  it('ignores base-currency invoices', async () => {
    const t = await tenantWithRates('Reval Local Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await withTenant(sql, c, (tx) =>
      issueInvoice(tx, c, {
        contactId: t.customerId,
        issueDate: '2026-08-05',
        lines: [{
          description: 'Local work',
          quantity: '1',
          unitPrice: '5000.00',
          accountId: t.accounts['4000']!,
          taxCodeId: t.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    const result = await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    expect(result.status).toBe('NO_ADJUSTMENT');
    expect(result.byCurrency).toHaveLength(0);
  });

  it('excludes invoices issued after the reporting date', async () => {
    const t = await tenantWithRates('Reval Cutoff Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd(t, '1000.00', '2026-08-05');
    await issueUsd(t, '9999.00', '2026-09-15'); // not an asset at 31 August

    const result = await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    expect(result.byCurrency[0]!.outstanding).toBe('1000.0000');
  });

  it('excludes settled invoices', async () => {
    const t = await tenantWithRates('Reval Settled Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    const invoice = await issueUsd(t, '1000.00');
    await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-08-20',
        amount: '1000.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '1000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const result = await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    expect(result.status).toBe('NO_ADJUSTMENT');
  });

  it('revalues only the unsettled portion of a part-paid invoice', async () => {
    const t = await tenantWithRates('Reval Partial Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    const invoice = await issueUsd(t, '1000.00');
    await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-08-20',
        amount: '600.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '600.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const result = await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    // USD 400 left: carried at 1880, worth 1960 at 4.90.
    expect(result.byCurrency[0]!.outstanding).toBe('400.0000');
    expect(result.totalDifference).toBe('80.0000');
  });
});

describe('revaluation does not corrupt the subsequent realised gain', () => {
  it('settling after a revaluation still measures from the ORIGINAL rate', async () => {
    const t = await tenantWithRates('Reval Then Settle Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    const invoice = await issueUsd(t, '1000.00'); // booked at 4.70

    await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    // Settled in September at 4.60.
    const receipt = await withTenant(sql, c, (tx) =>
      recordReceipt(tx, c, {
        contactId: t.customerId,
        paymentDate: '2026-09-30',
        amount: '1000.00',
        currency: 'USD',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '1000.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    // The realised loss is measured against 4.70, the rate AR was booked at —
    // NOT against 4.90, the revalued rate. The revaluation reversed on
    // 1 September, so there is nothing left of it to double-count.
    expect(receipt.realisedFx).toBe('-100.0000');
    expect(await accountBase(t, '1100')).toBe('0.0000');
    expect(await accountBase(t, '6900')).toBe('100.0000'); // realised loss
    expect(await accountBase(t, '1190')).toBe('0.0000');   // revaluation gone
    expect(await accountBase(t, '6910')).toBe('0.0000');   // unrealised gone
  });
});

describe('idempotency and re-runs', () => {
  it('replays rather than double-posting', async () => {
    const t = await tenantWithRates('Reval Idempotent Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };
    const period = await periodId(t, 8);

    await issueUsd(t, '1000.00');
    const key = randomUUID();

    const first = await withTenant(sql, c, (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: period, idempotencyKey: key }),
    );
    const second = await withTenant(sql, c, (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: period, idempotencyKey: key }),
    );

    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.byCurrency).toEqual(first.byCurrency);
    expect(await accountBaseInPeriod(t, '1190', 8)).toBe('200.0000');
  });

  it('refuses a second run for the same period even under a new key', async () => {
    const t = await tenantWithRates('Reval Once Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };
    const period = await periodId(t, 8);

    await issueUsd(t, '1000.00');

    const first = await withTenant(sql, c, (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: period, idempotencyKey: randomUUID() }),
    );
    const second = await withTenant(sql, c, (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: period, idempotencyKey: randomUUID() }),
    );

    // A revaluation is a period-end event. Running it twice would post the
    // adjustment twice, so the period — not just the key — is the identity.
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
  });
});

describe('failure cases', () => {
  it('refuses when no closing rate exists', async () => {
    const t = await seedTenant(admin, 'Reval No Rate Sdn Bhd');
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO exchange_rate (tenant_id, currency_from, currency_to, rate_date, rate)
        VALUES (${t.tenantId}, 'USD', 'MYR', '2026-08-01', 4.70000000)
    `);
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd(t, '1000.00');

    // Delete the only rate, leaving the invoice with no closing rate to use.
    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        DELETE FROM exchange_rate WHERE tenant_id = ${t.tenantId}
    `);

    await expect(
      withTenant(sql, c, async (tx) =>
        runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
      ),
    ).rejects.toThrow(/closing rate/i);
  });

  it('accepts an explicitly supplied closing rate', async () => {
    const t = await tenantWithRates('Reval Explicit Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd(t, '1000.00');

    const result = await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, {
        fiscalPeriodId: await periodId(t, 8),
        closingRates: { USD: '5.00000000' },
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result.totalDifference).toBe('300.0000'); // 5000 - 4700
  });

  it('refuses when the next period does not exist to reverse into', async () => {
    const t = await tenantWithRates('Reval No Next Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd(t, '1000.00', '2026-12-05');

    // December's reversal falls on 1 January 2027, which has no period.
    await expect(
      withTenant(sql, c, async (tx) =>
        runRevaluation(tx, c, {
          fiscalPeriodId: await periodId(t, 12),
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/no fiscal period covers/i);
  });

  it('keeps the run record append-only', async () => {
    await expect(
      admin.unsafe(`UPDATE revaluation_run SET total_difference = 0`),
    ).rejects.toThrow(/append-only/i);
  });
});

describe('closing-rate reporting', () => {
  it('reports carrying and closing values side by side', async () => {
    const t = await tenantWithRates('Reval Report Sdn Bhd');
    const c = { tenantId: t.tenantId };

    await issueUsd(t, '1000.00');

    const view = await withTenant(sql, c, (tx) =>
      receivablesAtClosingRate(tx, c, '2026-08-31'),
    );

    expect(view.carryingBase).toBe('4700.0000');
    expect(view.closingBase).toBe('4900.0000');
    expect(view.difference).toBe('200.0000');
  });

  it('returns zeroes when there is nothing in foreign currency', async () => {
    const t = await tenantWithRates('Reval Empty Sdn Bhd');
    const c = { tenantId: t.tenantId };

    const view = await withTenant(sql, c, (tx) =>
      receivablesAtClosingRate(tx, c, '2026-08-31'),
    );
    expect(view.difference).toBe('0.0000');
  });

  it('leaves the rollup in agreement with the raw journal', async () => {
    const t = await tenantWithRates('Reval Drift Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await issueUsd(t, '1234.56');
    await withTenant(sql, c, async (tx) =>
      runRevaluation(tx, c, { fiscalPeriodId: await periodId(t, 8), idempotencyKey: randomUUID() }),
    );

    const drift = await withTenant(sql, c, (tx) => detectRollupDrift(tx, c));
    expect(drift).toEqual([]);
  });
});
