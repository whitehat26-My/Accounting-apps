import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { enterBill, outstandingPayables } from '../src/bill.js';
import { issueInvoice } from '../src/invoice.js';
import { agedPayables, paySupplier } from '../src/supplier-payment.js';
import { issueDebitNote } from '../src/debit-note.js';
import { detectRollupDrift } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('bill');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin);
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });
const rm = (v: string) => Money.fromDecimal(v, 'MYR');

async function enter(
  unitPrice: string,
  over: {
    billNo?: string;
    billDate?: string;
    dueDate?: string;
    taxCode?: string;
    supplierId?: string;
    accountId?: string;
  } = {},
) {
  return withTenant(sql, ctx(), (tx) =>
    enterBill(tx, ctx(), {
      supplierId: over.supplierId ?? tenant.supplierId,
      billNo: over.billNo ?? `SUP-${randomUUID().slice(0, 8)}`,
      billDate: over.billDate ?? '2026-08-05',
      ...(over.dueDate ? { dueDate: over.dueDate } : {}),
      lines: [
        {
          description: 'Office supplies',
          quantity: '1',
          unitPrice,
          accountId: over.accountId ?? tenant.accounts['6000']!,
          taxCodeId: over.taxCode ?? tenant.taxCodes['NONE']!,
        },
      ],
      idempotencyKey: randomUUID(),
    }),
  );
}

/** A control account's balance from the rollup, sign-corrected for reading. */
async function controlBalance(code: string): Promise<string> {
  const [row] = await withTenant(sql, ctx(), (tx) =>
    tx<{ balance: string }[]>`
        SELECT COALESCE(SUM(net_movement), 0)::text AS balance
          FROM account_period_balance
         WHERE tenant_id = ${tenant.tenantId} AND account_id = ${tenant.accounts[code]!}
    `,
  );
  return Money.fromDecimal(row!.balance, 'MYR').toDecimalString();
}

describe('entering a bill', () => {
  it('posts Dr Expense / Cr AP and leaves the bill ENTERED', async () => {
    const bill = await enter('1000.00');

    expect(bill.total).toBe('1000.0000');
    expect(bill.journalEntryId).not.toBeNull();
    expect(bill.internalRef).toMatch(/^BILL-\d{5}$/);

    const lines = await withTenant(sql, ctx(), (tx) =>
      tx<{ account_id: string; debit: string; credit: string }[]>`
          SELECT account_id, debit, credit FROM journal_line
           WHERE tenant_id = ${tenant.tenantId} AND journal_entry_id = ${bill.journalEntryId}
      `,
    );

    const expense = lines.find((l) => l.account_id === tenant.accounts['6000'])!;
    const ap = lines.find((l) => l.account_id === tenant.accounts['2000'])!;
    expect(rm(expense.debit).toDecimalString()).toBe('1000.0000');
    expect(rm(ap.credit).toDecimalString()).toBe('1000.0000');
  });

  it('allocates a gapless internal reference independent of the supplier number', async () => {
    const first = await enter('10.00');
    const second = await enter('10.00');
    expect(Number(second.internalRef.slice(5))).toBe(Number(first.internalRef.slice(5)) + 1);
  });

  it('accepts the same bill number from two different suppliers', async () => {
    // The most common AP modelling mistake: making the SUPPLIER's number
    // unique per tenant. Two suppliers both numbering their invoices INV-001
    // is entirely normal, and rejecting the second is a customer who cannot
    // enter a bill.
    const [other] = await withTenant(sql, ctx(), (tx) =>
      tx<{ id: string }[]>`
          INSERT INTO contact (tenant_id, name, is_supplier)
          VALUES (${tenant.tenantId}, 'Penang Trading Sdn Bhd', TRUE)
          RETURNING id
      `,
    );

    const a = await enter('50.00', { billNo: 'INV-001' });
    const b = await enter('50.00', { billNo: 'INV-001', supplierId: other!.id });

    expect(a.billNo).toBe('INV-001');
    expect(b.billNo).toBe('INV-001');
    expect(a.id).not.toBe(b.id);
  });

  it('refuses the same bill number twice from ONE supplier', async () => {
    // Duplicate-bill prevention is the point of the per-supplier constraint —
    // paying the same supplier invoice twice is the failure it exists to stop.
    await enter('50.00', { billNo: 'DUP-001' });
    await expect(enter('50.00', { billNo: 'DUP-001' })).rejects.toThrow(/duplicate key/i);
  });

  it('replays an idempotent re-entry without posting twice', async () => {
    const key = randomUUID();
    const input = {
      supplierId: tenant.supplierId,
      billNo: `IDEM-${randomUUID().slice(0, 6)}`,
      billDate: '2026-08-05',
      lines: [
        {
          description: 'Retainer',
          quantity: '1',
          unitPrice: '400.00',
          accountId: tenant.accounts['6000']!,
          taxCodeId: tenant.taxCodes['NONE']!,
        },
      ],
      idempotencyKey: key,
    };

    const first = await withTenant(sql, ctx(), (tx) => enterBill(tx, ctx(), input));
    const second = await withTenant(sql, ctx(), (tx) => enterBill(tx, ctx(), input));

    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.journalEntryId).toBe(first.journalEntryId);
  });

  it('rejects a contact that is not flagged as a supplier', async () => {
    await expect(enter('10.00', { supplierId: tenant.customerId })).rejects.toThrow(
      /not flagged as a supplier/i,
    );
  });

  it('does not confirm that another tenant’s contact exists', async () => {
    // CLAUDE.md rule 9: a cross-tenant id is indistinguishable from a
    // non-existent one. RLS has already filtered the row out before we look.
    await expect(enter('10.00', { supplierId: randomUUID() })).rejects.toThrow(/not found/i);
  });

  it('writes INPUT tax evidence', async () => {
    const bill = await enter('1000.00', { taxCode: tenant.taxCodes['SST-SVC']! });

    const rows = await withTenant(sql, ctx(), (tx) =>
      tx<{ direction: string; tax_amount: string }[]>`
          SELECT direction, tax_amount FROM tax_transaction
           WHERE tenant_id = ${tenant.tenantId} AND source_document_id = ${bill.id}
      `,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe('INPUT');
    expect(rm(rows[0]!.tax_amount).toDecimalString()).toBe('80.0000');
  });
});

describe('SST input tax is a cost, not an asset', () => {
  it('absorbs a COST-treatment tax into the expense account', async () => {
    const bill = await enter('1000.00', { taxCode: tenant.taxCodes['SST-SVC']! });

    const lines = await withTenant(sql, ctx(), (tx) =>
      tx<{ account_id: string; debit: string; credit: string }[]>`
          SELECT account_id, debit, credit FROM journal_line
           WHERE tenant_id = ${tenant.tenantId} AND journal_entry_id = ${bill.journalEntryId}
      `,
    );

    // The whole RM 1,080 lands in the expense. Under a VAT regime RM 80 would
    // have gone to a claimable asset instead; that difference is the reason
    // SST is modelled separately rather than localised from a VAT product.
    const expense = lines.find((l) => l.account_id === tenant.accounts['6000'])!;
    expect(rm(expense.debit).toDecimalString()).toBe('1080.0000');
    expect(lines.some((l) => l.account_id === tenant.accounts['1150'])).toBe(false);
  });

  it('books a RECOVERABLE tax to the claimable account instead', async () => {
    const bill = await enter('1000.00', { taxCode: tenant.taxCodes['SST-REC']! });

    const lines = await withTenant(sql, ctx(), (tx) =>
      tx<{ account_id: string; debit: string }[]>`
          SELECT account_id, debit FROM journal_line
           WHERE tenant_id = ${tenant.tenantId} AND journal_entry_id = ${bill.journalEntryId}
      `,
    );

    expect(
      rm(lines.find((l) => l.account_id === tenant.accounts['6000'])!.debit).toDecimalString(),
    ).toBe('1000.0000');
    expect(
      rm(lines.find((l) => l.account_id === tenant.accounts['1150'])!.debit).toDecimalString(),
    ).toBe('60.0000');
  });

  it('names the missing role when RECOVERABLE tax has no claimable account', async () => {
    // A tenant that has never claimed input tax has no SST_CLAIMABLE account.
    // Before the guard, the journal line was pushed with `accountId: undefined`
    // and surfaced as a NOT NULL violation naming a column — which says nothing
    // about the configuration that is actually missing.
    const other = await seedTenant(admin, 'No Claimable Sdn Bhd');
    const otherCtx = { tenantId: other.tenantId, userId: other.userId };

    await withTenant(sql, otherCtx, (tx) =>
      tx`DELETE FROM posting_account_map
          WHERE tenant_id = ${other.tenantId} AND role = 'SST_CLAIMABLE'`,
    );

    await expect(
      withTenant(sql, otherCtx, (tx) =>
        enterBill(tx, otherCtx, {
          supplierId: other.supplierId,
          billNo: 'REC-001',
          billDate: '2026-08-05',
          lines: [
            {
              description: 'Recoverable purchase',
              quantity: '1',
              unitPrice: '1000.00',
              accountId: other.accounts['6000']!,
              taxCodeId: other.taxCodes['SST-REC']!,
            },
          ],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/SST_CLAIMABLE/);
  });
});

describe('an entered bill is immutable', () => {
  it('refuses to change the amount', async () => {
    const bill = await enter('100.00');
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          UPDATE bill SET total = total + 1
           WHERE tenant_id = ${tenant.tenantId} AND id = ${bill.id}
      `),
    ).rejects.toThrow(/immutable|debit note/i);
  });

  it('refuses deletion', async () => {
    const bill = await enter('100.00');
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          DELETE FROM bill WHERE tenant_id = ${tenant.tenantId} AND id = ${bill.id}
      `),
    ).rejects.toThrow(/cannot be deleted|debit note/i);
  });

  it('refuses to change a line', async () => {
    const bill = await enter('100.00');
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          UPDATE bill_line SET unit_price = 1
           WHERE tenant_id = ${tenant.tenantId} AND bill_id = ${bill.id}
      `),
    ).rejects.toThrow(/immutable/i);
  });

  it('still allows the settlement columns to move', async () => {
    // The immutability trigger guards the AMOUNTS. Settlement state has to
    // stay writable or a bill could never be paid.
    const bill = await enter('100.00');
    await withTenant(sql, ctx(), (tx) => tx`
        UPDATE bill SET status = 'PART_PAID', amount_paid = 10
         WHERE tenant_id = ${tenant.tenantId} AND id = ${bill.id}
    `);

    // ...and put it back. A payment recorded this way has no journal entry
    // behind it, so leaving it would make the AP subledger disagree with the
    // control account and fail the invariant-#7 test further down — which is
    // exactly what that test is for.
    await withTenant(sql, ctx(), (tx) => tx`
        UPDATE bill SET status = 'ENTERED', amount_paid = 0
         WHERE tenant_id = ${tenant.tenantId} AND id = ${bill.id}
    `);
  });
});

describe('paying a supplier', () => {
  it('posts Dr AP / Cr Bank and settles the bill', async () => {
    const bill = await enter('600.00', { billNo: `PAY-${randomUUID().slice(0, 6)}` });

    const payment = await withTenant(sql, ctx(), (tx) =>
      paySupplier(tx, ctx(), {
        supplierId: tenant.supplierId,
        paymentDate: '2026-08-20',
        amount: '600.00',
        method: 'TRANSFER',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ billId: bill.id, amount: '600.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(payment.settledBills[0]).toMatchObject({ billId: bill.id, status: 'PAID' });

    const lines = await withTenant(sql, ctx(), (tx) =>
      tx<{ account_id: string; debit: string; credit: string }[]>`
          SELECT account_id, debit, credit FROM journal_line
           WHERE tenant_id = ${tenant.tenantId} AND journal_entry_id = ${payment.journalEntryId}
      `,
    );

    expect(
      rm(lines.find((l) => l.account_id === tenant.accounts['2000'])!.debit).toDecimalString(),
    ).toBe('600.0000');
    expect(
      rm(lines.find((l) => l.account_id === tenant.accounts['1000'])!.credit).toDecimalString(),
    ).toBe('600.0000');
  });

  it('leaves a part-paid bill PART_PAID', async () => {
    const bill = await enter('500.00');
    const payment = await withTenant(sql, ctx(), (tx) =>
      paySupplier(tx, ctx(), {
        supplierId: tenant.supplierId,
        paymentDate: '2026-08-21',
        amount: '200.00',
        method: 'TRANSFER',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ billId: bill.id, amount: '200.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(payment.settledBills[0]).toMatchObject({
      status: 'PART_PAID',
      amountDue: '300.0000',
    });
  });

  it('refuses to allocate more than the bill owes', async () => {
    const bill = await enter('100.00');
    await expect(
      withTenant(sql, ctx(), (tx) =>
        paySupplier(tx, ctx(), {
          supplierId: tenant.supplierId,
          paymentDate: '2026-08-22',
          amount: '900.00',
          method: 'TRANSFER',
          depositAccountId: tenant.accounts['1000']!,
          allocations: [{ billId: bill.id, amount: '900.00' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/failed validation/i);
  });

  it('is enforced by the database too, not only the service', async () => {
    const bill = await enter('100.00');
    const payment = await withTenant(sql, ctx(), (tx) =>
      paySupplier(tx, ctx(), {
        supplierId: tenant.supplierId,
        paymentDate: '2026-08-23',
        amount: '100.00',
        method: 'TRANSFER',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ billId: bill.id, amount: '100.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    // Write straight into the allocation table, bypassing every service check.
    // The constraint trigger rewritten in 0010 has to branch on the bill arm.
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          INSERT INTO payment_allocation (tenant_id, payment_id, bill_id, amount)
          VALUES (${tenant.tenantId}, ${payment.id}, ${bill.id}, 100)
      `),
    ).rejects.toThrow(/over-allocated|duplicate key/i);
  });

  it('refuses an allocation pointing at both a bill and an invoice', async () => {
    // The exclusive arc. A polymorphic target_id would have made this state
    // representable and left it to application code to avoid.
    const bill = await enter('100.00');
    const invoice = await withTenant(sql, ctx(), (tx) =>
      issueInvoice(tx, ctx(), {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitPrice: '100.00',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    await expect(
      withTenant(sql, ctx(), async (tx) => {
        const [payment] = await tx<{ id: string }[]>`
            SELECT id FROM payment WHERE tenant_id = ${tenant.tenantId} LIMIT 1
        `;
        await tx`
            INSERT INTO payment_allocation (tenant_id, payment_id, bill_id, invoice_id, amount)
            VALUES (${tenant.tenantId}, ${payment!.id}, ${bill.id}, ${invoice.id}, 1)
        `;
      }),
    ).rejects.toThrow(/exclusive_arc/i);
  });

  it('refuses an allocation pointing at neither', async () => {
    await expect(
      withTenant(sql, ctx(), async (tx) => {
        const [payment] = await tx<{ id: string }[]>`
            SELECT id FROM payment WHERE tenant_id = ${tenant.tenantId} LIMIT 1
        `;
        await tx`
            INSERT INTO payment_allocation (tenant_id, payment_id, amount)
            VALUES (${tenant.tenantId}, ${payment!.id}, 1)
        `;
      }),
    ).rejects.toThrow(/exclusive_arc/i);
  });
});

describe('debit notes', () => {
  it('posts Dr AP / Cr Expense and reduces what is owed', async () => {
    const bill = await enter('800.00');

    const note = await withTenant(sql, ctx(), (tx) =>
      issueDebitNote(tx, ctx(), {
        supplierId: tenant.supplierId,
        billId: bill.id,
        debitDate: '2026-08-25',
        reason: 'RETURN',
        lines: [
          {
            description: 'Returned goods',
            quantity: '1',
            unitPrice: '300.00',
            accountId: tenant.accounts['6000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(note.debitNoteNo).toMatch(/^DN-\d{5}$/);
    expect(note.affectedBills[0]).toMatchObject({ billId: bill.id, amountDue: '500.0000' });

    const lines = await withTenant(sql, ctx(), (tx) =>
      tx<{ account_id: string; debit: string; credit: string }[]>`
          SELECT account_id, debit, credit FROM journal_line
           WHERE tenant_id = ${tenant.tenantId} AND journal_entry_id = ${note.journalEntryId}
      `,
    );

    expect(
      rm(lines.find((l) => l.account_id === tenant.accounts['2000'])!.debit).toDecimalString(),
    ).toBe('300.0000');
    expect(
      rm(lines.find((l) => l.account_id === tenant.accounts['6000'])!.credit).toDecimalString(),
    ).toBe('300.0000');
  });

  it('credits back the tax that was absorbed as a cost, not just the net', async () => {
    // If the original bill's tax went into the expense, the reversal has to
    // come back out of the expense. Crediting only the net leaves the absorbed
    // tax in the P&L forever — a debit note that balances perfectly and
    // overstates the year's costs by exactly the tax.
    const bill = await enter('1000.00', { taxCode: tenant.taxCodes['SST-SVC']! });

    const note = await withTenant(sql, ctx(), (tx) =>
      issueDebitNote(tx, ctx(), {
        supplierId: tenant.supplierId,
        billId: bill.id,
        debitDate: '2026-08-26',
        reason: 'RETURN',
        lines: [
          {
            description: 'Full return',
            quantity: '1',
            unitPrice: '1000.00',
            accountId: tenant.accounts['6000']!,
            taxCodeId: tenant.taxCodes['SST-SVC']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const lines = await withTenant(sql, ctx(), (tx) =>
      tx<{ account_id: string; debit: string; credit: string }[]>`
          SELECT account_id, debit, credit FROM journal_line
           WHERE tenant_id = ${tenant.tenantId} AND journal_entry_id = ${note.journalEntryId}
      `,
    );

    expect(
      rm(lines.find((l) => l.account_id === tenant.accounts['6000'])!.credit).toDecimalString(),
    ).toBe('1080.0000');
    expect(
      rm(lines.find((l) => l.account_id === tenant.accounts['2000'])!.debit).toDecimalString(),
    ).toBe('1080.0000');
  });

  it('writes NEGATIVE input tax evidence so the period nets', async () => {
    const bill = await enter('1000.00', { taxCode: tenant.taxCodes['SST-SVC']! });
    const note = await withTenant(sql, ctx(), (tx) =>
      issueDebitNote(tx, ctx(), {
        supplierId: tenant.supplierId,
        billId: bill.id,
        debitDate: '2026-08-27',
        reason: 'OVERCHARGE',
        lines: [
          {
            description: 'Overcharge',
            quantity: '1',
            unitPrice: '100.00',
            accountId: tenant.accounts['6000']!,
            taxCodeId: tenant.taxCodes['SST-SVC']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const [row] = await withTenant(sql, ctx(), (tx) =>
      tx<{ direction: string; tax_amount: string }[]>`
          SELECT direction, tax_amount FROM tax_transaction
           WHERE tenant_id = ${tenant.tenantId} AND source_document_id = ${note.id}
      `,
    );

    expect(row!.direction).toBe('INPUT');
    expect(rm(row!.tax_amount).toDecimalString()).toBe('-8.0000');
  });

  it('refuses a debit note larger than the bill it corrects', async () => {
    const bill = await enter('100.00');
    await expect(
      withTenant(sql, ctx(), (tx) =>
        issueDebitNote(tx, ctx(), {
          supplierId: tenant.supplierId,
          billId: bill.id,
          debitDate: '2026-08-28',
          reason: 'RETURN',
          lines: [
            {
              description: 'Too much',
              quantity: '1',
              unitPrice: '500.00',
              accountId: tenant.accounts['6000']!,
              taxCodeId: tenant.taxCodes['NONE']!,
            },
          ],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/failed validation/i);
  });

  it('an issued debit note is immutable', async () => {
    // 0010 gives debit notes their OWN trigger function. Reusing the credit
    // note's would have referenced OLD.credit_note_no — a column debit_note
    // does not have — and failed at runtime on the very path meant to guard it.
    const bill = await enter('200.00');
    const note = await withTenant(sql, ctx(), (tx) =>
      issueDebitNote(tx, ctx(), {
        supplierId: tenant.supplierId,
        billId: bill.id,
        debitDate: '2026-08-29',
        reason: 'DISCOUNT',
        lines: [
          {
            description: 'Settlement discount',
            quantity: '1',
            unitPrice: '20.00',
            accountId: tenant.accounts['6000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          UPDATE debit_note SET total = total + 1
           WHERE tenant_id = ${tenant.tenantId} AND id = ${note.id}
      `),
    ).rejects.toThrow(/issued|immutable/i);
  });
});

describe('ledger invariant #7 — AP control equals the bill subledger', () => {
  it('holds after entry, partial payment and a debit note', async () => {
    const subledger = await withTenant(sql, ctx(), (tx) => outstandingPayables(tx, ctx()));
    const control = await controlBalance('2000');

    // AP is credit-natured, so the rollup carries it negative under the
    // debit-positive convention. The subledger reports the positive amount owed.
    expect(rm(subledger.total).negate().toDecimalString()).toBe(control);
  });

  it('leaves the rollup in agreement with the raw journal', async () => {
    const drift = await withTenant(sql, ctx(), (tx) => detectRollupDrift(tx, ctx()));
    expect(drift).toEqual([]);
  });
});

describe('aged payables', () => {
  it('buckets by how overdue each bill is and reconciles to the subledger', async () => {
    const report = await withTenant(sql, ctx(), (tx) => agedPayables(tx, ctx(), '2026-12-31'));

    expect(report.buckets.map((b) => b.key)).toEqual([
      'CURRENT',
      '1_30',
      '31_60',
      '61_90',
      '90_PLUS',
    ]);

    const subledger = await withTenant(sql, ctx(), (tx) => outstandingPayables(tx, ctx()));
    const bucketed = report.buckets.reduce((acc, b) => acc.add(b.total), Money.zero('MYR'));
    expect(bucketed.toDecimalString()).toBe(
      Money.fromDecimal(subledger.total, 'MYR').toDecimalString(),
    );
  });

  it('is genuinely as-at: a bill entered later does not appear in an earlier report', async () => {
    const before = await withTenant(sql, ctx(), (tx) => agedPayables(tx, ctx(), '2026-08-01'));
    await enter('750.00', { billDate: '2026-09-10', dueDate: '2026-10-10' });
    const after = await withTenant(sql, ctx(), (tx) => agedPayables(tx, ctx(), '2026-08-01'));

    expect(after.total.toDecimalString()).toBe(before.total.toDecimalString());

    const later = await withTenant(sql, ctx(), (tx) => agedPayables(tx, ctx(), '2026-09-30'));
    expect(later.total.compare(before.total)).toBeGreaterThan(0);
  });
});

describe('withholding tax — the mechanism ships, the rates do not', () => {
  it('refuses to withhold when no rate is configured, rather than withholding zero', async () => {
    // `wht_rate` ships EMPTY on purpose: Malaysian withholding rates depend on
    // payment type and on any applicable double taxation treaty, and must be
    // verified against LHDN. Falling back to zero would silently under-withhold
    // — and the payer, not the supplier, carries that liability.
    const bill = await enter('1000.00');

    await expect(
      withTenant(sql, ctx(), (tx) =>
        paySupplier(tx, ctx(), {
          supplierId: tenant.supplierId,
          paymentDate: '2026-09-01',
          amount: '1000.00',
          method: 'TRANSFER',
          depositAccountId: tenant.accounts['1000']!,
          allocations: [{ billId: bill.id, amount: '1000.00' }],
          withholding: { paymentType: 'ROYALTY', countryCode: 'SG' },
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/No withholding rate configured.*LHDN/is);
  });

  it('ships with no rates at all', async () => {
    const [row] = await withTenant(sql, ctx(), (tx) =>
      tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM wht_rate WHERE tenant_id = ${tenant.tenantId}
      `,
    );
    expect(row!.count).toBe('0');
  });

  it('debits AP with the GROSS once a rate is supplied', async () => {
    // A FICTIONAL rate, loaded by this test only. It asserts the mechanism,
    // not the statutory number.
    const t = await seedTenant(admin, 'Withholding Sdn Bhd');
    const c = { tenantId: t.tenantId, userId: t.userId };

    await withTenant(admin, { tenantId: t.tenantId }, (tx) => tx`
        INSERT INTO wht_rate (tenant_id, payment_type, country_code,
                              rate_basis_points, valid_from, legislation_ref)
        VALUES (${t.tenantId}, 'ROYALTY', NULL, 1000, '2026-01-01',
                'FIXTURE ONLY — not a statutory rate')
    `);

    const bill = await withTenant(sql, c, (tx) =>
      enterBill(tx, c, {
        supplierId: t.supplierId,
        billNo: 'WHT-1',
        billDate: '2026-08-05',
        lines: [
          {
            description: 'Licence fee',
            quantity: '1',
            unitPrice: '10000.00',
            accountId: t.accounts['6000']!,
            taxCodeId: t.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const payment = await withTenant(sql, c, (tx) =>
      paySupplier(tx, c, {
        supplierId: t.supplierId,
        paymentDate: '2026-09-01',
        amount: '10000.00',
        method: 'TRANSFER',
        depositAccountId: t.accounts['1000']!,
        allocations: [{ billId: bill.id, amount: '10000.00' }],
        withholding: { paymentType: 'ROYALTY' },
        idempotencyKey: randomUUID(),
      }),
    );

    expect(payment.withheld).toBe('1000.0000');
    expect(payment.settledBills[0]).toMatchObject({ status: 'PAID', amountDue: '0.0000' });

    const lines = await withTenant(sql, c, (tx) =>
      tx<{ account_id: string; debit: string; credit: string }[]>`
          SELECT account_id, debit, credit FROM journal_line
           WHERE tenant_id = ${t.tenantId} AND journal_entry_id = ${payment.journalEntryId}
      `,
    );

    const amount = (code: string, side: 'debit' | 'credit') =>
      Money.fromDecimal(
        lines.find((l) => l.account_id === t.accounts[code])![side],
        'MYR',
      ).toDecimalString();

    // AP is discharged in FULL. The supplier's claim is settled; the withheld
    // portion is a liability transferred to LHDN, not a shortfall. Debiting
    // only the net would leave the bill permanently part-paid and break
    // invariant #7 forever.
    expect(amount('2000', 'debit')).toBe('10000.0000');
    expect(amount('1000', 'credit')).toBe('9000.0000');
    expect(amount('2200', 'credit')).toBe('1000.0000');

    // And the evidence row an eventual CP37 is built from.
    const [evidence] = await withTenant(sql, c, (tx) =>
      tx<{ withheld_amount: string; rate_basis_points: number; remitted_at: string | null }[]>`
          SELECT withheld_amount, rate_basis_points, remitted_at
            FROM withholding_transaction
           WHERE tenant_id = ${t.tenantId} AND payment_id = ${payment.id}
      `,
    );
    expect(evidence!.withheld_amount).toBe('1000.0000');
    expect(evidence!.rate_basis_points).toBe(1000);
    expect(evidence!.remitted_at).toBeNull();
  });

  it('withholding evidence is append-only', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          UPDATE withholding_transaction SET withheld_amount = 0
           WHERE tenant_id = ${tenant.tenantId}
      `),
    ).rejects.toThrow(/append-only|permission denied/i);
  });
});
