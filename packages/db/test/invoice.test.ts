import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { issueInvoice, outstandingReceivables, loadTaxCodes } from '../src/invoice.js';
import { detectRollupDrift } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('invoice');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin);
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

function invoiceInput(over: Partial<Parameters<typeof issueInvoice>[2]> = {}) {
  return {
    contactId: tenant.customerId,
    issueDate: '2026-08-05',
    lines: [
      {
        description: 'Consulting services — August 2026',
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

describe('issuing an invoice', () => {
  it('computes SST, posts the ledger entry and returns a gapless number', async () => {
    const invoice = await withTenant(sql, ctx(), (tx) => issueInvoice(tx, ctx(), invoiceInput()));

    expect(invoice.invoiceNo).toMatch(/^INV-\d{5}$/);
    expect(invoice.subtotal).toBe('1000.0000');
    expect(invoice.taxTotal).toBe('80.0000'); // 8% at the 2026 tax point
    expect(invoice.total).toBe('1080.0000');
    expect(invoice.journalEntryId).toBeTruthy();
  });

  it('posts Dr AR 1080 / Cr Revenue 1000 / Cr SST Payable 80', async () => {
    const lines = await withTenant(sql, ctx(), (tx) =>
      tx<{ code: string; debit: string; credit: string }[]>`
          SELECT a.code, l.base_debit AS debit, l.base_credit AS credit
            FROM journal_line l
            JOIN account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
            JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
           WHERE l.tenant_id = ${tenant.tenantId}
             AND e.source_document_type = 'INVOICE'
           ORDER BY a.code
      `,
    );

    expect(lines).toEqual([
      { code: '1100', debit: '1080.0000', credit: '0.0000' },
      { code: '2100', debit: '0.0000', credit: '80.0000' },
      { code: '4000', debit: '0.0000', credit: '1000.0000' },
    ]);
  });

  it('records immutable tax evidence for the SST return', async () => {
    const rows = await withTenant(sql, ctx(), (tx) =>
      tx<{ rate_basis_points: number; taxable_amount: string; tax_amount: string; direction: string }[]>`
          SELECT rate_basis_points, taxable_amount, tax_amount, direction
            FROM tax_transaction WHERE tenant_id = ${tenant.tenantId}
      `,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rate_basis_points: 800,
      taxable_amount: '1000.0000',
      tax_amount: '80.0000',
      direction: 'OUTPUT',
    });
  });

  it('queues the e-invoice submission rather than calling LHDN inline', async () => {
    const events = await withTenant(sql, ctx(), (tx) =>
      tx<{ event_type: string; status: string }[]>`
          SELECT event_type, status FROM outbox_event
           WHERE tenant_id = ${tenant.tenantId} AND event_type = 'invoice.issued'
      `,
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.status).toBe('PENDING');
  });

  it('defaults the due date from the contact payment terms', async () => {
    const [row] = await withTenant(sql, ctx(), (tx) =>
      tx<{ issue_date: Date; due_date: Date }[]>`
          SELECT issue_date, due_date FROM invoice
           WHERE tenant_id = ${tenant.tenantId} ORDER BY created_at LIMIT 1
      `,
    );
    // 30-day terms from 5 Aug 2026.
    expect(row!.due_date.toISOString().slice(0, 10)).toBe('2026-09-04');
  });

  it('is idempotent on the idempotency key', async () => {
    const input = invoiceInput();
    const first = await withTenant(sql, ctx(), (tx) => issueInvoice(tx, ctx(), input));
    const second = await withTenant(sql, ctx(), (tx) => issueInvoice(tx, ctx(), input));

    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.invoiceNo).toBe(first.invoiceNo);
  });
});

describe('effective-dated rates reach all the way through', () => {
  it('applies the historic rate when the tax point is before the change', async () => {
    // Same service, invoiced against a 2023 tax point: 6%, not 8%.
    await withTenant(admin, { tenantId: tenant.tenantId }, (tx) => tx`
        INSERT INTO fiscal_year (tenant_id, label, start_date, end_date)
        VALUES (${tenant.tenantId}, 'FY2023', '2023-01-01', '2023-12-31')
    `);
    const [fy] = await withTenant(admin, { tenantId: tenant.tenantId }, (tx) =>
      tx<{ id: string }[]>`
          SELECT id FROM fiscal_year WHERE tenant_id = ${tenant.tenantId} AND label = 'FY2023'
      `,
    );
    await withTenant(admin, { tenantId: tenant.tenantId }, (tx) => tx`
        INSERT INTO fiscal_period (tenant_id, fiscal_year_id, sequence, start_date, end_date, status)
        VALUES (${tenant.tenantId}, ${fy!.id}, 6, '2023-06-01', '2023-06-30', 'OPEN')
    `);

    const invoice = await withTenant(sql, ctx(), (tx) =>
      issueInvoice(tx, ctx(), invoiceInput({ issueDate: '2023-06-15' })),
    );

    expect(invoice.taxTotal).toBe('60.0000');
    expect(invoice.total).toBe('1060.0000');
  });

  it('refuses to overlap two rate versions for the same code', async () => {
    await expect(
      withTenant(admin, { tenantId: tenant.tenantId }, (tx) => tx`
          INSERT INTO tax_rate_version (tenant_id, tax_code_id, rate_basis_points, valid_from, valid_to)
          VALUES (${tenant.tenantId}, ${tenant.taxCodes['SST-SVC']!}, 1000, '2025-01-01', '2025-12-31')
      `),
    ).rejects.toThrow(/conflicting key value|exclusion constraint/i);
  });

  it('loads rate versions back out in a form the domain can use', async () => {
    const codes = await withTenant(sql, ctx(), (tx) => loadTaxCodes(tx, ctx()));
    const svc = codes.find((c) => c.code === 'SST-SVC')!;

    expect(svc.inputTreatment).toBe('COST');
    expect(svc.versions).toHaveLength(2);
    expect(svc.versions.map((v) => v.rateBasisPoints)).toEqual([600n, 800n]);
  });
});

describe('ledger invariant #6 — AR control agrees with the subledger', () => {
  it('holds after every invoice issued so far', async () => {
    const subledger = await withTenant(sql, ctx(), (tx) => outstandingReceivables(tx, ctx()));

    const [control] = await withTenant(sql, ctx(), (tx) =>
      tx<{ balance: string }[]>`
          SELECT COALESCE(SUM(b.net_movement), 0)::text AS balance
            FROM account_period_balance b
           WHERE b.tenant_id = ${tenant.tenantId}
             AND b.account_id = ${tenant.accounts['1100']!}
      `,
    );

    expect(subledger.count).toBeGreaterThan(0);
    expect(Money.fromDecimal(control!.balance, 'MYR').toDecimalString()).toBe(
      Money.fromDecimal(subledger.total, 'MYR').toDecimalString(),
    );
  });

  it('leaves the rollup in agreement with the raw journal', async () => {
    const drift = await withTenant(sql, ctx(), (tx) => detectRollupDrift(tx, ctx()));
    expect(drift).toEqual([]);
  });
});

describe('issued invoices are immutable', () => {
  it('refuses to change the total of an issued invoice', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          UPDATE invoice SET total = total + 1
           WHERE tenant_id = ${tenant.tenantId} AND status = 'ISSUED'
      `),
    ).rejects.toThrow(/immutable|credit note/i);
  });

  it('refuses to delete an issued invoice', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          DELETE FROM invoice WHERE tenant_id = ${tenant.tenantId} AND status = 'ISSUED'
      `),
    ).rejects.toThrow(/cannot be deleted|credit note/i);
  });

  it('refuses to alter the lines of an issued invoice', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          UPDATE invoice_line SET unit_price = unit_price + 1
           WHERE tenant_id = ${tenant.tenantId}
      `),
    ).rejects.toThrow(/immutable/i);
  });

  it('keeps tax_transaction append-only', async () => {
    await expect(
      admin.unsafe(`UPDATE tax_transaction SET tax_amount = 0`),
    ).rejects.toThrow(/append-only/i);
  });

  it('allows settlement state to move', async () => {
    // amount_paid and status are the only mutable parts — this is what a
    // receipt will update in the next slice.
    const updated = await withTenant(sql, ctx(), (tx) => tx`
        UPDATE invoice SET amount_paid = 10, status = 'PART_PAID'
         WHERE tenant_id = ${tenant.tenantId} AND status = 'ISSUED'
         RETURNING id
    `);
    expect(updated.length).toBeGreaterThan(0);

    // Reset so the AR invariant test above stays meaningful on re-runs.
    await withTenant(sql, ctx(), (tx) => tx`
        UPDATE invoice SET amount_paid = 0, status = 'ISSUED'
         WHERE tenant_id = ${tenant.tenantId} AND status = 'PART_PAID'
    `);
  });
});

describe('an unregistered organisation charges no SST', () => {
  it('omits tax entirely rather than showing a zero rate', async () => {
    const other = await seedTenant(admin, 'Kedai Kopi Enterprise');
    await withTenant(admin, { tenantId: other.tenantId }, (tx) => tx`
        UPDATE organisation SET sst_registered = FALSE WHERE id = ${other.tenantId}
    `);

    const otherCtx = { tenantId: other.tenantId, userId: other.userId };
    const invoice = await withTenant(sql, otherCtx, (tx) =>
      issueInvoice(tx, otherCtx, {
        contactId: other.customerId,
        issueDate: '2026-08-05',
        lines: [
          {
            description: 'Nasi lemak catering',
            quantity: '100',
            unitPrice: '8.50',
            accountId: other.accounts['4000']!,
            taxCodeId: other.taxCodes['SST-SVC']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    expect(invoice.subtotal).toBe('850.0000');
    expect(invoice.taxTotal).toBe('0.0000');
    expect(invoice.total).toBe('850.0000');

    // And no SST liability line is posted at all.
    const sstLines = await withTenant(sql, otherCtx, (tx) =>
      tx`
          SELECT 1 FROM journal_line l
           WHERE l.tenant_id = ${other.tenantId}
             AND l.account_id = ${other.accounts['2100']!}
      `,
    );
    expect(sstLines).toHaveLength(0);
  });
});

describe('a zero-total invoice is issued but posts nothing', () => {
  it('creates the document with no journal entry', async () => {
    const invoice = await withTenant(sql, ctx(), (tx) =>
      issueInvoice(tx, ctx(), invoiceInput({
        lines: [
          {
            description: 'Warranty replacement unit — no charge',
            quantity: '1',
            unitPrice: '250.00',
            discountBasisPoints: 10_000, // 100%
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['SST-SVC']!,
          },
        ],
      })),
    );

    expect(invoice.total).toBe('0.0000');
    expect(invoice.journalEntryId).toBeNull();

    const [row] = await withTenant(sql, ctx(), (tx) =>
      tx<{ status: string; journal_entry_id: string | null }[]>`
          SELECT status, journal_entry_id FROM invoice
           WHERE tenant_id = ${tenant.tenantId} AND id = ${invoice.id}
      `,
    );
    expect(row!.status).toBe('ISSUED');
    expect(row!.journal_entry_id).toBeNull();
  });

  it('leaves AR and the rollup untouched', async () => {
    const drift = await withTenant(sql, ctx(), (tx) => detectRollupDrift(tx, ctx()));
    expect(drift).toEqual([]);
  });
});

describe('cross-tenant access', () => {
  it('reports another tenant contact as not found, never as forbidden', async () => {
    const other = await seedTenant(admin, 'Rival Holdings Bhd');

    // Emil's session, pointing at Rival's contact id.
    await expect(
      withTenant(sql, ctx(), (tx) =>
        issueInvoice(tx, ctx(), invoiceInput({ contactId: other.customerId })),
      ),
    ).rejects.toThrow(/not found/i);
  });
});
