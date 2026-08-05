import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { freeCash } from '../src/free-cash.js';
import { confirmPayRun, createEmployee, preparePayRun } from '../src/pay-run.js';
import { recordCashSale } from '../src/pos.js';
import { createItem } from '../src/item.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';
import { randomUUID } from 'node:crypto';

/**
 * Free cash against the real ledger.
 *
 * The property under test: the held amounts ARE liability balances, so
 * confirming a pay run — which credits EPF_PAYABLE, PCB_PAYABLE and the rest
 * — must move this figure by exactly what it credited. No modelling, no
 * estimate: if the two ever disagree, one of them is reading the books wrong.
 */

let sql: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

beforeAll(async () => {
  const db = await createTestDatabase('freecash');
  sql = db.sql;
  drop = db.drop;
  tenant = await seedTenant(db.admin, 'Free Cash Sdn Bhd');
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('a shop holding nothing', () => {
  it('reports the whole balance as its own', async () => {
    const position = await withTenant(sql, ctx(), (tx) => freeCash(tx, ctx()));
    expect(position.held).toHaveLength(0);
    expect(position.verdict).toBe('COMFORTABLE');
    expect(position.freeCash.toDecimalString()).toBe(
      position.bankBalance.toDecimalString(),
    );
  });
});

describe('after a pay run is confirmed', () => {
  let beforeBank: string;

  it('the statutory deductions become money the shop is only holding', async () => {
    // Ring some takings first so the bank has something in it.
    const item = await withTenant(sql, ctx(), (tx) =>
      createItem(tx, ctx(), {
        code: 'SVC-1',
        name: 'Bench work',
        itemType: 'SERVICE',
        isSold: true,
        sale: {
          unitPrice: '4000.00',
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['NONE']!,
        },
      }),
    );
    await withTenant(sql, ctx(), (tx) =>
      recordCashSale(tx, ctx(), {
        saleDate: '2026-08-05',
        lines: [{ itemId: item.id, quantity: '2' }],
        method: 'CASH',
        depositAccountId: tenant.accounts['1000']!,
        idempotencyKey: randomUUID(),
      }),
    );

    const before = await withTenant(sql, ctx(), (tx) => freeCash(tx, ctx()));
    beforeBank = before.bankBalance.toDecimalString();
    expect(before.held).toHaveLength(0);

    await withTenant(sql, ctx(), (tx) =>
      createEmployee(tx, ctx(), {
        fullName: 'Nurul Huda binti Ahmad',
        employeeNo: 'SGT-004',
        dateOfBirth: '1991-03-15',
        citizenship: 'CITIZEN',
        taxResident: true,
        taxCategory: 1,
        qualifyingChildren: 0,
        monthlyWage: '6000.00',
        hiredOn: '2026-08-01',
        // TP3 openings, so the month lands in a taxable band and PCB is the
        // RM 207.50 this suite has pinned three ways elsewhere.
        ytdYear: 2026,
        ytdGrossBefore: '42000.00',
        ytdEpfBefore: '4620.00',
        ytdMtdBefore: '1452.50',
      }),
    );
    const run = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), { payMonth: '2026-08-01', idempotencyKey: 'fc-aug' }),
    );
    await withTenant(sql, ctx(), (tx) => confirmPayRun(tx, ctx(), run.id, 'fc-aug-confirm'));

    const after = await withTenant(sql, ctx(), (tx) => freeCash(tx, ctx()));

    // Confirming posts the liabilities but moves no cash — the bank is
    // untouched and the ENTIRE change lands in "not yours".
    expect(after.bankBalance.toDecimalString()).toBe(beforeBank);
    const keys = after.held.map((h) => h.key);
    expect(keys).toContain('EPF');
    expect(keys).toContain('SOCSO_EIS');
    expect(keys).toContain('PCB');
    // Net wages sit here too: confirmed, owed, not yet paid out.
    expect(keys).toContain('NET_WAGES');

    // EPF held is employee + employer share: 660 + 720 for this wage.
    const epf = after.held.find((h) => h.key === 'EPF')!;
    expect(epf.amount.toDecimalString()).toBe('1380.0000');
    // PCB is the figure this suite has pinned three ways elsewhere.
    expect(after.held.find((h) => h.key === 'PCB')!.amount.toDecimalString()).toBe('207.5000');

    // Free cash fell by exactly the total now being held.
    expect(after.freeCash.toDecimalString()).toBe(
      after.bankBalance.subtract(after.totalHeld).toDecimalString(),
    );
  });

  it('carries the statutory deadline onto the money it applies to', async () => {
    const position = await withTenant(sql, ctx(), (tx) => freeCash(tx, ctx()));
    const epf = position.held.find((h) => h.key === 'EPF')!;
    /*
     * The NEXT date money of this kind must leave — 15 August, today being
     * the 5th — not the date August's own wages fall due. That is the right
     * semantic: the balance is a running total that may span months, and the
     * deadline the owner actually faces is the soonest one. It comes from the
     * same rule row the compliance calendar reads.
     */
    expect(epf.dueDate).toBe('2026-08-15');
    expect(position.soonest?.dueDate).toBe('2026-08-15');

    // Wages owed carry no statutory date: no statute fixes a pay day.
    expect(position.held.find((h) => h.key === 'NET_WAGES')!.dueDate).toBeNull();
  });

  it('says SHORT when the holdings exceed what is in the bank', async () => {
    /*
     * Spend the takings on stock — the classic mistake, made deliberately.
     * The bank drains, the statutory liabilities do not, and the verdict must
     * turn red rather than merely smaller.
     */
    await withTenant(sql, ctx(), (tx) =>
      tx`
        UPDATE account_period_balance
           SET net_movement = 100.0000
         WHERE tenant_id = ${ctx().tenantId}
           AND account_id = ${tenant.accounts['1000']!}
      `,
    );

    const position = await withTenant(sql, ctx(), (tx) => freeCash(tx, ctx()));
    expect(position.verdict).toBe('SHORT');
    expect(position.freeCash.isNegative()).toBe(true);
  });
});
