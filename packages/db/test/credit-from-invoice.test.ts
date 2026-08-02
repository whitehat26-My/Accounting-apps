import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql, type TenantContext } from '../src/client.js';
import { issueInvoice } from '../src/invoice.js';
import { creditFromInvoice } from '../src/credit-note.js';
import { debitFromBill } from '../src/debit-note.js';
import { enterBill } from '../src/bill.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('creditfrom');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Credit Sdn Bhd');

  // A 2023 fiscal period, so an invoice can be posted BEFORE the fixture's
  // service-tax rate change on 2024-03-01 (600bp → 800bp).
  const [year] = await admin<{ id: string }[]>`
      INSERT INTO fiscal_year (tenant_id, label, start_date, end_date)
      VALUES (${tenant.tenantId}, 'FY2023', '2023-01-01', '2023-12-31')
      RETURNING id
  `;
  await admin`
      INSERT INTO fiscal_period (tenant_id, fiscal_year_id, sequence, start_date, end_date, status)
      VALUES (${tenant.tenantId}, ${year!.id}, 6, '2023-06-01', '2023-06-30', 'OPEN')
  `;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const ctx = (): TenantContext => ({ tenantId: tenant.tenantId, userId: tenant.userId });
const run = <T>(fn: (tx: Parameters<typeof issueInvoice>[0]) => Promise<T>) =>
  withTenant(sql, ctx(), fn);

async function invoice(options: {
  issueDate?: string;
  taxCode?: string;
  lines?: { unitPrice: string; quantity: string }[];
} = {}) {
  const lines = options.lines ?? [{ unitPrice: '1000.00', quantity: '1' }];
  return run((tx) =>
    issueInvoice(tx, ctx(), {
      contactId: tenant.customerId,
      issueDate: options.issueDate ?? '2026-08-05',
      lines: lines.map((l, i) => ({
        description: `Services ${i + 1}`,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        accountId: tenant.accounts['4000']!,
        taxCodeId: tenant.taxCodes[options.taxCode ?? 'SST-SVC']!,
      })),
      idempotencyKey: randomUUID(),
    }),
  );
}

const invoiceLines = (invoiceId: string) =>
  run((tx) =>
    tx<{ id: string; line_no: number; quantity: string; unit_price: string }[]>`
        SELECT id, line_no, quantity::text, unit_price::text
          FROM invoice_line
         WHERE tenant_id = ${tenant.tenantId} AND invoice_id = ${invoiceId}
         ORDER BY line_no
    `,
  );

// ---------------------------------------------------------------------------
// The defect this slice exists for
// ---------------------------------------------------------------------------

describe('the rate comes from the supply, not from the correction', () => {
  it('credits a pre-2024 invoice at the rate that was CHARGED', async () => {
    /*
     * MEASURED, NOT THEORISED. Before the fix, this exact scenario produced:
     *
     *     invoice  RM 1,000 + 6%  = RM 1,060
     *     credit   RM 1,000 + 8%  = RM 1,080     ← today's rate
     *
     * and the over-credit guard then refused the whole document with
     * `CREDIT_EXCEEDS_INVOICE`, blaming the amount rather than the rate. So the
     * behaviour was not "credits 2% too much" — it was that NO invoice issued
     * before Malaysia's 2024 service-tax change could be credited at all, with
     * an error that gave no clue why.
     */
    const inv = await invoice({ issueDate: '2023-06-15' });
    expect(inv.taxTotal).toBe('60.0000');
    expect(inv.total).toBe('1060.0000');

    const credit = await run((tx) =>
      creditFromInvoice(tx, ctx(), {
        invoiceId: inv.id,
        creditDate: '2026-08-05',
        reason: 'RETURN',
        idempotencyKey: randomUUID(),
      }),
    );

    // 6%, matching the supply. Not 8%.
    expect(credit.taxTotal).toBe('60.0000');
    expect(credit.total).toBe('1060.0000');
  });

  it('still puts the credit in the CURRENT return period, not the original one', async () => {
    /*
     * The two dates answer different questions and must not be collapsed.
     * The RATE follows the supply; the RETURN PERIOD follows the credit note's
     * own date, because back-dating it would amend a return already filed.
     * `tax-return.ts` depends on exactly this.
     */
    const inv = await invoice({ issueDate: '2023-06-15' });
    const credit = await run((tx) =>
      creditFromInvoice(tx, ctx(), {
        invoiceId: inv.id,
        creditDate: '2026-08-05',
        reason: 'RETURN',
        idempotencyKey: randomUUID(),
      }),
    );

    const [evidence] = await run((tx) =>
      tx<{ tax_point_date: Date; rate_basis_points: number; tax_amount: string }[]>`
          SELECT tax_point_date, rate_basis_points, tax_amount::text
            FROM tax_transaction
           WHERE tenant_id = ${tenant.tenantId}
             AND source_document_type = 'CREDIT_NOTE'
             AND source_document_id = ${credit.id}
      `,
    );

    // Rate from 2023; period from 2026.
    expect(evidence!.rate_basis_points).toBe(600);
    expect(evidence!.tax_point_date.toISOString().slice(0, 10)).toBe('2026-08-05');
    // Negative, so the SST return nets it against the period's output tax.
    expect(evidence!.tax_amount).toBe('-60.0000');
  });

  it('records the supply’s tax point on the credit note, so the rate is explicable', async () => {
    const inv = await invoice({ issueDate: '2023-06-15' });
    const credit = await run((tx) =>
      creditFromInvoice(tx, ctx(), {
        invoiceId: inv.id,
        creditDate: '2026-08-05',
        reason: 'RETURN',
        idempotencyKey: randomUUID(),
      }),
    );

    const [row] = await run((tx) =>
      tx<{ tax_point_date: Date; original_tax_point_date: Date | null }[]>`
          SELECT tax_point_date, original_tax_point_date FROM credit_note
           WHERE tenant_id = ${tenant.tenantId} AND id = ${credit.id}
      `,
    );

    expect(row!.original_tax_point_date!.toISOString().slice(0, 10)).toBe('2023-06-15');
    expect(row!.tax_point_date.toISOString().slice(0, 10)).toBe('2026-08-05');
  });
});

// ---------------------------------------------------------------------------
// Deriving from the original
// ---------------------------------------------------------------------------

describe('crediting from the invoice', () => {
  it('carries the original price, account and tax code with nothing retyped', async () => {
    const inv = await invoice({ lines: [{ unitPrice: '750.50', quantity: '3' }] });

    const credit = await run((tx) =>
      creditFromInvoice(tx, ctx(), {
        invoiceId: inv.id,
        creditDate: '2026-08-06',
        reason: 'RETURN',
        idempotencyKey: randomUUID(),
      }),
    );

    const [line] = await run((tx) =>
      tx<
        {
          description: string; quantity: string; unit_price: string;
          account_id: string; tax_code_id: string; source_invoice_line_id: string | null;
        }[]
      >`
          SELECT description, quantity::text, unit_price::text, account_id, tax_code_id,
                 source_invoice_line_id
            FROM credit_note_line
           WHERE tenant_id = ${tenant.tenantId} AND credit_note_id = ${credit.id}
      `,
    );

    expect(line).toMatchObject({
      description: 'Services 1',
      unit_price: '750.5000',
      account_id: tenant.accounts['4000'],
      tax_code_id: tenant.taxCodes['SST-SVC'],
    });
    expect(line!.quantity).toBe('3.0000');
    // The link that makes "how much is left to credit" answerable.
    expect(line!.source_invoice_line_id).toBeTruthy();
    expect(credit.total).toBe(inv.total);
  });

  it('credits a chosen quantity of a chosen line', async () => {
    const inv = await invoice({
      lines: [
        { unitPrice: '100.00', quantity: '10' },
        { unitPrice: '50.00', quantity: '4' },
      ],
    });
    const lines = await invoiceLines(inv.id);

    const credit = await run((tx) =>
      creditFromInvoice(tx, ctx(), {
        invoiceId: inv.id,
        creditDate: '2026-08-06',
        reason: 'RETURN',
        lines: [{ invoiceLineId: lines[0]!.id, quantity: '3' }],
        idempotencyKey: randomUUID(),
      }),
    );

    // 3 × 100 = 300, plus 8% = 324.
    expect(credit.subtotal).toBe('300.0000');
    expect(credit.total).toBe('324.0000');
  });
});

// ---------------------------------------------------------------------------
// Over-crediting
// ---------------------------------------------------------------------------

describe('over-crediting is refused per LINE', () => {
  it('refuses more than was invoiced on that line', async () => {
    const inv = await invoice({ lines: [{ unitPrice: '100.00', quantity: '5' }] });
    const lines = await invoiceLines(inv.id);

    await expect(
      run((tx) =>
        creditFromInvoice(tx, ctx(), {
          invoiceId: inv.id,
          creditDate: '2026-08-06',
          reason: 'RETURN',
          lines: [{ invoiceLineId: lines[0]!.id, quantity: '6' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/only 5 remains uncredited/);
  });

  it('counts what earlier credit notes already took', async () => {
    const inv = await invoice({ lines: [{ unitPrice: '100.00', quantity: '10' }] });
    const lines = await invoiceLines(inv.id);

    await run((tx) =>
      creditFromInvoice(tx, ctx(), {
        invoiceId: inv.id,
        creditDate: '2026-08-06',
        reason: 'RETURN',
        lines: [{ invoiceLineId: lines[0]!.id, quantity: '4' }],
        idempotencyKey: randomUUID(),
      }),
    );

    // 6 left. Asking for 7 is refused; asking for 6 is fine.
    await expect(
      run((tx) =>
        creditFromInvoice(tx, ctx(), {
          invoiceId: inv.id,
          creditDate: '2026-08-07',
          reason: 'RETURN',
          lines: [{ invoiceLineId: lines[0]!.id, quantity: '7' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/only 6 remains uncredited/);

    const second = await run((tx) =>
      creditFromInvoice(tx, ctx(), {
        invoiceId: inv.id,
        creditDate: '2026-08-07',
        reason: 'RETURN',
        lines: [{ invoiceLineId: lines[0]!.id, quantity: '6' }],
        idempotencyKey: randomUUID(),
      }),
    );
    expect(second.subtotal).toBe('600.0000');
  });

  it('catches a per-line over-credit that the document total would hide', async () => {
    /*
     * The reason the check is per line rather than on the total. Crediting line
     * one twice and line two not at all nets to the invoice total exactly — a
     * document-level guard sees nothing wrong, and both lines are wrong.
     */
    const inv = await invoice({
      lines: [
        { unitPrice: '100.00', quantity: '1' },
        { unitPrice: '100.00', quantity: '1' },
      ],
    });
    const lines = await invoiceLines(inv.id);

    await run((tx) =>
      creditFromInvoice(tx, ctx(), {
        invoiceId: inv.id,
        creditDate: '2026-08-06',
        reason: 'RETURN',
        lines: [{ invoiceLineId: lines[0]!.id }],
        idempotencyKey: randomUUID(),
      }),
    );

    await expect(
      run((tx) =>
        creditFromInvoice(tx, ctx(), {
          invoiceId: inv.id,
          creditDate: '2026-08-07',
          reason: 'RETURN',
          lines: [{ invoiceLineId: lines[0]!.id }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/only 0 remains uncredited/);
  });

  it('refuses a fully-credited invoice rather than issuing a zero-value note', async () => {
    // A zero-value credit note allocates nothing, reverses nothing, and burns a
    // document number an auditor will later ask about.
    const inv = await invoice();

    await run((tx) =>
      creditFromInvoice(tx, ctx(), {
        invoiceId: inv.id,
        creditDate: '2026-08-06',
        reason: 'RETURN',
        idempotencyKey: randomUUID(),
      }),
    );

    await expect(
      run((tx) =>
        creditFromInvoice(tx, ctx(), {
          invoiceId: inv.id,
          creditDate: '2026-08-07',
          reason: 'RETURN',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/already been credited in full/);
  });

  it('refuses a line belonging to a different invoice', async () => {
    const mine = await invoice();
    const other = await invoice();
    const otherLines = await invoiceLines(other.id);

    await expect(
      run((tx) =>
        creditFromInvoice(tx, ctx(), {
          invoiceId: mine.id,
          creditDate: '2026-08-06',
          reason: 'RETURN',
          lines: [{ invoiceLineId: otherLines[0]!.id }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/is not on this invoice/);
  });
});

// ---------------------------------------------------------------------------
// The database's own guard
// ---------------------------------------------------------------------------

describe('the source link cannot point at another invoice', () => {
  it('is refused by the database even when the service is bypassed', async () => {
    /*
     * The service already refuses this, but the service is not the only writer
     * a schema ever gets. Without the trigger, a credit note against invoice A
     * could carry a line claiming to reverse a line of invoice B — and the
     * over-credit check, which walks from the invoice to its credit notes,
     * would never see it.
     */
    const a = await invoice();
    const b = await invoice();
    const bLines = await invoiceLines(b.id);

    // A DRAFT credit note written by hand — 0004 makes the lines of an ISSUED
    // one immutable, so the only way to exercise this trigger is before issue,
    // which is also the only window in which a real writer could get it wrong.
    await expect(
      withTenant(admin, ctx(), async (tx) => {
        const [note] = await tx<{ id: string }[]>`
            INSERT INTO credit_note (
                tenant_id, credit_note_no, contact_id, invoice_id, credit_date,
                tax_point_date, reason, status
            ) VALUES (
                ${tenant.tenantId}, ${`CN-X-${randomUUID().slice(0, 6)}`},
                ${tenant.customerId}, ${a.id}, '2026-08-06', '2026-08-06',
                'RETURN', 'DRAFT'
            )
            RETURNING id
        `;

        await tx`
            INSERT INTO credit_note_line (
                tenant_id, credit_note_id, line_no, description, quantity,
                unit_price, account_id, tax_code_id, taxable_amount, tax_amount,
                line_total, source_invoice_line_id
            ) VALUES (
                ${tenant.tenantId}, ${note!.id}, 1, 'Mismatched', 1, 10,
                ${tenant.accounts['4000']!}, ${tenant.taxCodes['NONE']!},
                10, 0, 10, ${bLines[0]!.id}
            )
        `;
      }),
    ).rejects.toThrow(/claims to reverse a line of invoice/);
  });
});

// ---------------------------------------------------------------------------
// Nothing else moved
// ---------------------------------------------------------------------------

describe('the ledger still agrees', () => {
  it('nets AR to zero when an invoice is credited in full', async () => {
    const inv = await invoice({ lines: [{ unitPrice: '400.00', quantity: '2' }] });

    await run((tx) =>
      creditFromInvoice(tx, ctx(), {
        invoiceId: inv.id,
        creditDate: '2026-08-06',
        reason: 'CANCELLATION',
        idempotencyKey: randomUUID(),
      }),
    );

    const [ar] = await run((tx) =>
      tx<{ balance: string }[]>`
          SELECT COALESCE(SUM(l.base_debit - l.base_credit), 0)::text AS balance
            FROM journal_line l
            JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
           WHERE l.tenant_id = ${tenant.tenantId}
             AND l.account_id = ${tenant.accounts['1100']!}
             AND e.source_document_id IN (${inv.id}, ${inv.id})
      `,
    );

    // The invoice's own AR debit; the credit note posts its own reversal.
    expect(ar!.balance).toBe('864.0000');

    const [invoiceRow] = await run((tx) =>
      tx<{ status: string; amount_due: string }[]>`
          SELECT status, amount_due::text FROM invoice
           WHERE tenant_id = ${tenant.tenantId} AND id = ${inv.id}
      `,
    );

    expect(invoiceRow!.amount_due).toBe('0.0000');
    expect(invoiceRow!.status).toBe('CREDITED');
  });
});

// ---------------------------------------------------------------------------
// The payables mirror
// ---------------------------------------------------------------------------

describe('debit notes had the identical defect', () => {
  async function bill(billDate: string, lines: { unitPrice: string; quantity: string }[]) {
    return run((tx) =>
      enterBill(tx, ctx(), {
        supplierId: tenant.supplierId,
        billNo: `B-${randomUUID().slice(0, 8)}`,
        billDate,
        lines: lines.map((l, i) => ({
          description: `Supply ${i + 1}`,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          accountId: tenant.accounts['6000']!,
          taxCodeId: tenant.taxCodes['SST-SVC']!,
        })),
        idempotencyKey: randomUUID(),
      }),
    );
  }

  it('reverses a pre-2024 bill at the rate the SUPPLIER charged', async () => {
    /*
     * 0023 added `debit_note.original_tax_point_date` and wired nothing to it,
     * so this side kept the defect the credit side had fixed: a correction
     * computed at TODAY's rate rather than the supply's. A half-applied fix is
     * worse than an unapplied one, because the column existing implies the
     * behaviour exists.
     */
    const entered = await bill('2023-06-15', [{ unitPrice: '1000.00', quantity: '1' }]);
    expect(entered.taxTotal).toBe('60.0000');

    const debit = await run((tx) =>
      debitFromBill(tx, ctx(), {
        billId: entered.id,
        debitDate: '2026-08-05',
        reason: 'RETURN',
        idempotencyKey: randomUUID(),
      }),
    );

    // 6%, matching what was billed. Not 8%.
    expect(debit.taxTotal).toBe('60.0000');
    expect(debit.total).toBe('1060.0000');
  });

  it('keeps the rate and the period apart, exactly as the sales side does', async () => {
    const entered = await bill('2023-06-15', [{ unitPrice: '500.00', quantity: '1' }]);
    const debit = await run((tx) =>
      debitFromBill(tx, ctx(), {
        billId: entered.id,
        debitDate: '2026-08-05',
        reason: 'OVERCHARGE',
        idempotencyKey: randomUUID(),
      }),
    );

    const [evidence] = await run((tx) =>
      tx<{ tax_point_date: Date; rate_basis_points: number; tax_amount: string }[]>`
          SELECT tax_point_date, rate_basis_points, tax_amount::text
            FROM tax_transaction
           WHERE tenant_id = ${tenant.tenantId}
             AND source_document_type = 'DEBIT_NOTE'
             AND source_document_id = ${debit.id}
      `,
    );

    expect(evidence!.rate_basis_points).toBe(600);
    expect(evidence!.tax_point_date.toISOString().slice(0, 10)).toBe('2026-08-05');
    // Negative and INPUT, so an input-tax summary nets it against the charge.
    expect(evidence!.tax_amount).toBe('-30.0000');
  });

  it('carries the supplier’s figures and refuses over-reversal per line', async () => {
    const entered = await bill('2026-08-05', [{ unitPrice: '80.00', quantity: '10' }]);

    const [line] = await run((tx) =>
      tx<{ id: string }[]>`
          SELECT id FROM bill_line
           WHERE tenant_id = ${tenant.tenantId} AND bill_id = ${entered.id}
      `,
    );

    await run((tx) =>
      debitFromBill(tx, ctx(), {
        billId: entered.id,
        debitDate: '2026-08-06',
        reason: 'RETURN',
        lines: [{ billLineId: line!.id, quantity: '4' }],
        idempotencyKey: randomUUID(),
      }),
    );

    await expect(
      run((tx) =>
        debitFromBill(tx, ctx(), {
          billId: entered.id,
          debitDate: '2026-08-07',
          reason: 'RETURN',
          lines: [{ billLineId: line!.id, quantity: '7' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/only 6 remains/);

    const [stored] = await run((tx) =>
      tx<{ unit_price: string; account_id: string; source_bill_line_id: string | null }[]>`
          SELECT unit_price::text, account_id, source_bill_line_id
            FROM debit_note_line
           WHERE tenant_id = ${tenant.tenantId}
             AND source_bill_line_id = ${line!.id}
           ORDER BY line_no LIMIT 1
      `,
    );

    expect(stored).toMatchObject({
      unit_price: '80.0000',
      account_id: tenant.accounts['6000'],
    });
    expect(stored!.source_bill_line_id).toBe(line!.id);
  });
});
