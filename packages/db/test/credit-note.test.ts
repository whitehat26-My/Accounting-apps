import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { issueInvoice, outstandingReceivables } from '../src/invoice.js';
import { recordReceipt } from '../src/payment.js';
import { issueCreditNote, outputTaxForPeriod } from '../src/credit-note.js';
import { detectRollupDrift } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('creditnote');
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

async function issue(unitPrice: string, taxCode = 'SST-SVC', t: Tenant = tenant) {
  const c = { tenantId: t.tenantId, userId: t.userId };
  return withTenant(sql, c, (tx) =>
    issueInvoice(tx, c, {
      contactId: t.customerId,
      issueDate: '2026-08-05',
      lines: [
        {
          description: 'Consulting services',
          quantity: '1',
          unitPrice,
          accountId: t.accounts['4000']!,
          taxCodeId: t.taxCodes[taxCode]!,
        },
      ],
      idempotencyKey: randomUUID(),
    }),
  );
}

function creditInput(over: Partial<Parameters<typeof issueCreditNote>[2]> = {}) {
  return {
    contactId: tenant.customerId,
    creditDate: '2026-08-20',
    reason: 'RETURN' as const,
    lines: [
      {
        description: 'Returned consulting hours',
        quantity: '1',
        unitPrice: '1000.00',
        accountId: tenant.accounts['4000']!,
        taxCodeId: tenant.taxCodes['SST-SVC']!,
      },
    ],
    idempotencyKey: randomUUID(),
    ...over,
  };
}

describe('issuing a credit note', () => {
  it('posts Dr Revenue / Dr SST Payable / Cr AR', async () => {
    const invoice = await issue('1000.00');

    const credit = await withTenant(sql, ctx(), (tx) =>
      issueCreditNote(tx, ctx(), creditInput({ invoiceId: invoice.id })),
    );

    expect(credit.creditNoteNo).toMatch(/^CN-\d{5}$/);
    expect(credit.subtotal).toBe('1000.0000');
    expect(credit.taxTotal).toBe('80.0000');
    expect(credit.total).toBe('1080.0000');

    const lines = await withTenant(sql, ctx(), (tx) =>
      tx<{ code: string; debit: string; credit: string }[]>`
          SELECT a.code, l.base_debit AS debit, l.base_credit AS credit
            FROM journal_line l
            JOIN account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
           WHERE l.tenant_id = ${tenant.tenantId}
             AND l.journal_entry_id = ${credit.journalEntryId!}
           ORDER BY a.code
      `,
    );

    expect(lines).toEqual([
      { code: '1100', debit: '0.0000', credit: '1080.0000' }, // AR credited
      { code: '2100', debit: '80.0000', credit: '0.0000' },   // SST reversed
      { code: '4000', debit: '1000.0000', credit: '0.0000' }, // revenue reversed
    ]);
  });

  it('marks the invoice CREDITED and clears the amount due', async () => {
    const invoice = await issue('500.00');

    const credit = await withTenant(sql, ctx(), (tx) =>
      issueCreditNote(tx, ctx(), creditInput({
        invoiceId: invoice.id,
        lines: [
          {
            description: 'Full cancellation',
            quantity: '1',
            unitPrice: '500.00',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['SST-SVC']!,
          },
        ],
        reason: 'CANCELLATION',
      })),
    );

    expect(credit.affectedInvoices[0]).toMatchObject({
      status: 'CREDITED',
      amountDue: '0.0000',
    });

    const [row] = await withTenant(sql, ctx(), (tx) =>
      tx<{ status: string; amount_due: string; amount_credited: string }[]>`
          SELECT status, amount_due, amount_credited FROM invoice
           WHERE tenant_id = ${tenant.tenantId} AND id = ${invoice.id}
      `,
    );
    expect(row!.status).toBe('CREDITED');
    expect(row!.amount_due).toBe('0.0000');
  });

  it('supports a partial credit, leaving the balance PART_PAID', async () => {
    const invoice = await issue('1000.00');

    const credit = await withTenant(sql, ctx(), (tx) =>
      issueCreditNote(tx, ctx(), creditInput({
        invoiceId: invoice.id,
        reason: 'DISCOUNT',
        lines: [
          {
            description: 'Goodwill discount',
            quantity: '1',
            unitPrice: '200.00',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['SST-SVC']!,
          },
        ],
      })),
    );

    // 1080 invoice, 216 credited -> 864 still due.
    expect(credit.affectedInvoices[0]).toMatchObject({
      status: 'PART_PAID',
      amountDue: '864.0000',
    });
  });

  it('records negative tax evidence so the SST return nets correctly', async () => {
    const solo = await seedTenant(admin, 'Net Tax Sdn Bhd');
    const soloCtx = { tenantId: solo.tenantId, userId: solo.userId };

    await issue('1000.00', 'SST-SVC', solo); // +80 output tax

    await withTenant(sql, soloCtx, (tx) =>
      issueCreditNote(tx, soloCtx, {
        contactId: solo.customerId,
        creditDate: '2026-08-20',
        reason: 'RETURN',
        lines: [
          {
            description: 'Returned',
            quantity: '1',
            unitPrice: '250.00',
            accountId: solo.accounts['4000']!,
            taxCodeId: solo.taxCodes['SST-SVC']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const net = await withTenant(sql, soloCtx, (tx) =>
      outputTaxForPeriod(tx, soloCtx, '2026-08-01', '2026-08-31'),
    );

    // 80 charged less 20 credited = 60 net output tax.
    expect(Money.fromDecimal(net.taxAmount, 'MYR').toDecimalString()).toBe('60.0000');
    expect(Money.fromDecimal(net.taxableAmount, 'MYR').toDecimalString()).toBe('750.0000');
  });

  it('is idempotent', async () => {
    const invoice = await issue('300.00');
    const input = creditInput({
      invoiceId: invoice.id,
      lines: [
        {
          description: 'Return',
          quantity: '1',
          unitPrice: '100.00',
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['SST-SVC']!,
        },
      ],
    });

    const first = await withTenant(sql, ctx(), (tx) => issueCreditNote(tx, ctx(), input));
    const second = await withTenant(sql, ctx(), (tx) => issueCreditNote(tx, ctx(), input));

    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);

    const [row] = await withTenant(sql, ctx(), (tx) =>
      tx<{ amount_credited: string }[]>`
          SELECT amount_credited FROM invoice
           WHERE tenant_id = ${tenant.tenantId} AND id = ${invoice.id}
      `,
    );
    expect(row!.amount_credited).toBe('108.0000');
  });

  it('supports a standalone credit with no invoice reference', async () => {
    const credit = await withTenant(sql, ctx(), (tx) =>
      issueCreditNote(tx, ctx(), creditInput({
        reason: 'OTHER',
        lines: [
          {
            description: 'Goodwill credit',
            quantity: '1',
            unitPrice: '50.00',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
      })),
    );

    expect(credit.allocatedTotal).toBe('0.0000');
    expect(credit.unallocated).toBe('50.0000');
    expect(credit.affectedInvoices).toHaveLength(0);
  });
});

describe('credit and payment interact correctly', () => {
  it('a partly paid invoice can be credited for the remainder', async () => {
    const invoice = await issue('1000.00', 'NONE');

    await withTenant(sql, ctx(), (tx) =>
      recordReceipt(tx, ctx(), {
        contactId: tenant.customerId,
        paymentDate: '2026-08-15',
        amount: '400.00',
        method: 'FPX',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '400.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const credit = await withTenant(sql, ctx(), (tx) =>
      issueCreditNote(tx, ctx(), creditInput({
        invoiceId: invoice.id,
        reason: 'BAD_DEBT',
        lines: [
          {
            description: 'Written off',
            quantity: '1',
            unitPrice: '600.00',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
      })),
    );

    // Partly paid AND partly credited: settled in full, but money was
    // collected, so PAID rather than CREDITED.
    expect(credit.affectedInvoices[0]).toMatchObject({ status: 'PAID', amountDue: '0.0000' });
  });

  it('refuses to credit back more than was ever charged', async () => {
    const invoice = await issue('100.00', 'NONE');

    await expect(
      withTenant(sql, ctx(), (tx) =>
        issueCreditNote(tx, ctx(), creditInput({
          invoiceId: invoice.id,
          lines: [
            {
              description: 'Too much',
              quantity: '1',
              unitPrice: '500.00',
              accountId: tenant.accounts['4000']!,
              taxCodeId: tenant.taxCodes['NONE']!,
            },
          ],
        })),
      ),
    ).rejects.toThrow(/failed validation/i);
  });

  it('refuses over-settlement at the database level too', async () => {
    const invoice = await issue('100.00', 'NONE');

    await withTenant(sql, ctx(), (tx) =>
      recordReceipt(tx, ctx(), {
        contactId: tenant.customerId,
        paymentDate: '2026-08-15',
        amount: '100.00',
        method: 'CASH',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '100.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    // Fully paid; writing an allocation row directly must still be refused.
    await expect(
      withTenant(sql, ctx(), async (tx) => {
        const [cn] = await tx<{ id: string }[]>`
            SELECT id FROM credit_note WHERE tenant_id = ${tenant.tenantId} LIMIT 1
        `;
        await tx`
            INSERT INTO credit_note_allocation (tenant_id, credit_note_id, invoice_id, amount)
            VALUES (${tenant.tenantId}, ${cn!.id}, ${invoice.id}, 100)
        `;
      }),
    ).rejects.toThrow(/over-settled/i);
  });
});

describe('issued credit notes are immutable', () => {
  it('refuses to change the total', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          UPDATE credit_note SET total = total + 1
           WHERE tenant_id = ${tenant.tenantId} AND status = 'ISSUED'
      `),
    ).rejects.toThrow(/immutable/i);
  });

  it('refuses deletion', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          DELETE FROM credit_note WHERE tenant_id = ${tenant.tenantId} AND status = 'ISSUED'
      `),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('refuses to alter lines', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          UPDATE credit_note_line SET unit_price = unit_price + 1
           WHERE tenant_id = ${tenant.tenantId}
      `),
    ).rejects.toThrow(/immutable/i);
  });
});

describe('ledger invariants still hold', () => {
  it('AR control agrees with the subledger after credits', async () => {
    const subledger = await withTenant(sql, ctx(), (tx) => outstandingReceivables(tx, ctx()));

    const [control] = await withTenant(sql, ctx(), (tx) =>
      tx<{ balance: string }[]>`
          SELECT COALESCE(SUM(closing_balance), 0)::text AS balance
            FROM account_period_balance
           WHERE tenant_id = ${tenant.tenantId} AND account_id = ${tenant.accounts['1100']!}
      `,
    );

    // Standalone (unallocated) credits reduce the AR control account without
    // touching any invoice, so the customer sits in credit. Subledger plus
    // that credit balance is what must reconcile.
    const [unallocated] = await withTenant(sql, ctx(), (tx) =>
      tx<{ total: string }[]>`
          SELECT COALESCE(SUM(total - allocated_amount), 0)::text AS total
            FROM credit_note
           WHERE tenant_id = ${tenant.tenantId} AND status = 'ISSUED'
      `,
    );

    const expected = Money.fromDecimal(subledger.total, 'MYR')
      .subtract(Money.fromDecimal(unallocated!.total, 'MYR'));

    expect(Money.fromDecimal(control!.balance, 'MYR').toDecimalString()).toBe(
      expected.toDecimalString(),
    );
  });

  it('the rollup still agrees with the raw journal', async () => {
    const drift = await withTenant(sql, ctx(), (tx) => detectRollupDrift(tx, ctx()));
    expect(drift).toEqual([]);
  });

  it('crediting an invoice in full nets every account to zero', async () => {
    const solo = await seedTenant(admin, 'Full Reversal Sdn Bhd');
    const soloCtx = { tenantId: solo.tenantId, userId: solo.userId };

    const invoice = await issue('777.77', 'SST-SVC', solo);

    await withTenant(sql, soloCtx, (tx) =>
      issueCreditNote(tx, soloCtx, {
        contactId: solo.customerId,
        creditDate: '2026-08-20',
        reason: 'CANCELLATION',
        lines: [
          {
            description: 'Cancelled in full',
            quantity: '1',
            unitPrice: '777.77',
            accountId: solo.accounts['4000']!,
            taxCodeId: solo.taxCodes['SST-SVC']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    void invoice;

    const balances = await withTenant(sql, soloCtx, (tx) =>
      tx<{ code: string; balance: string }[]>`
          SELECT a.code, SUM(b.closing_balance)::text AS balance
            FROM account_period_balance b
            JOIN account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
           WHERE b.tenant_id = ${solo.tenantId}
           GROUP BY a.code
      `,
    );

    for (const row of balances) {
      expect(rm(row.balance).isZero(), `${row.code} did not net to zero: ${row.balance}`).toBe(true);
    }
  });
});
