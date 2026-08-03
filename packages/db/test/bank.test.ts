import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, type ImportProfile } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { bookBalance, createBankAccount, importStatement, previewStatement } from '../src/bank.js';
import {
  checkBankInvariant,
  completeReconciliation,
  confirmMatch,
  createEntryFromBankLine,
  reconcileAccount,
  suggestForAccount,
  suggestTransfersForTenant,
  unmatch,
} from '../src/reconciliation.js';
import { issueInvoice } from '../src/invoice.js';
import { recordReceipt } from '../src/payment.js';
import { enterBill } from '../src/bill.js';
import { paySupplier } from '../src/supplier-payment.js';
import { detectRollupDrift } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDatabase('bank');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const MAYBANK: ImportProfile = {
  bankName: 'Maybank',
  delimiter: ',',
  dateFormat: 'DD/MM/YYYY',
  amountConvention: 'SIGNED',
  columns: { txnDate: 0, description: 1, amount: 2, runningBalance: 3 },
};

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

/** A tenant with a bank account wired to the 1000 Cash and Bank GL account. */
async function bankTenant(name: string): Promise<{
  tenant: Tenant;
  ctx: { tenantId: string; userId: string };
  bankAccountId: string;
}> {
  const tenant = await seedTenant(admin, name);
  const ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

  const account = await withTenant(sql, ctx, (tx) =>
    createBankAccount(tx, ctx, {
      name: 'Maybank Current',
      bankName: 'Malayan Banking Berhad',
      glAccountId: tenant.accounts['1000']!,
      accountNoMasked: '****4455',
      openingBalance: '0',
      openingDate: '2026-01-01',
    }),
  );

  return { tenant, ctx, bankAccountId: account.id };
}

describe('bank accounts', () => {
  it('maps to a GL account, and refuses a second account on the same one', async () => {
    // Two bank accounts on one GL account makes invariant #8 unprovable:
    // neither account's transactions can be separated within the control
    // balance.
    const { tenant, ctx } = await bankTenant('Bank Mapping Sdn Bhd');

    await expect(
      withTenant(sql, ctx, (tx) =>
        createBankAccount(tx, ctx, {
          name: 'Second Account',
          bankName: 'CIMB',
          glAccountId: tenant.accounts['1000']!,
        }),
      ),
    ).rejects.toThrow(/already mapped/i);
  });

  it('does not confirm that another tenant’s GL account exists', async () => {
    const { ctx } = await bankTenant('Bank Isolation Sdn Bhd');
    await expect(
      withTenant(sql, ctx, (tx) =>
        createBankAccount(tx, ctx, {
          name: 'Ghost',
          bankName: 'CIMB',
          glAccountId: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/not found/i);
  });
});

describe('statement import', () => {
  const csv = [
    'Date,Description,Amount,Balance',
    '05/08/2026,IBG TRANSFER FR NUSANTARA RETAIL SDN BHD,1080.00,1080.00',
    '10/08/2026,DUITNOW QR PYMT SELANGOR SUPPLIES,-600.00,480.00',
    '31/08/2026,SERVICE CHARGE,-5.00,475.00',
  ].join('\n');

  it('imports every row and derives the balances', async () => {
    const { ctx, bankAccountId } = await bankTenant('Import Sdn Bhd');

    const result = await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: csv,
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result.imported).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.closingBalance).toBe('475.0000');
  });

  it('skips rows already held when an overlapping statement is re-imported', async () => {
    // Users download this month and last month and forget which rows they
    // already had. A re-import has to be safe, and has to SAY what it skipped.
    const { ctx, bankAccountId } = await bankTenant('Reimport Sdn Bhd');

    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: csv,
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    const overlapping = [
      'Date,Description,Amount,Balance',
      '10/08/2026,DUITNOW QR PYMT SELANGOR SUPPLIES,-600.00,480.00',
      '31/08/2026,SERVICE CHARGE,-5.00,475.00',
      '02/09/2026,NEW ROW,100.00,575.00',
    ].join('\n');

    const second = await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: overlapping,
        profile: MAYBANK,
        statementDate: '2026-09-30',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(second.imported).toBe(1);
    expect(second.duplicates).toBe(2);
  });

  it('imports a Maybank payment advice — the photographed format — and dedupes on re-import', async () => {
    const { ctx, bankAccountId } = await bankTenant('Advice Import Sdn Bhd');
    const advice = [
      'Our Reference             : 202605183294290',
      'Payment Reference         : DEPOSIT',
      'Branch                    : IBS BANGSAR BARU',
      'Details Of Payment        : PAYMENT DESCRIPTIONS : MAKAN',
      'Remiting Bank             : BANK SIMPANAN',
      'Remittance Amount         : 10.00',
      'Total Charges             : 0.00',
      'Total Amount              : 10.00',
    ].join('\n');

    const first = await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: advice,
        format: 'ADVICE',
        statementDate: '2026-05-18',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(first.imported).toBe(1);
    // The advice carries no date label: dated by the statement date, and the
    // response SAYS so rather than substituting silently.
    expect(first.violations).toEqual([
      { code: 'ADVICE_NO_DATE', reference: '202605183294290' },
    ]);

    const [line] = await admin<{ description: string; amount: string; reference: string }[]>`
        SELECT description, amount::text, reference FROM bank_transaction
         WHERE tenant_id = ${ctx.tenantId} AND bank_account_id = ${bankAccountId}
    `;
    expect(line!.description).toBe('DEPOSIT MAKAN FR BANK SIMPANAN');
    expect(line!.amount).toBe('10.0000');
    expect(line!.reference).toBe('202605183294290');

    const again = await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: advice,
        format: 'ADVICE',
        statementDate: '2026-05-18',
        idempotencyKey: randomUUID(),
      }),
    );
    expect(again.imported).toBe(0);
    expect(again.duplicates).toBe(1);
  });

  it('keeps two genuinely identical transactions on the same day', async () => {
    // Two RM 50 ATM withdrawals, same day, same narrative. A naive hash drops
    // the second and understates the bank by RM 50, with no error anywhere.
    const { ctx, bankAccountId } = await bankTenant('Identical Rows Sdn Bhd');

    const result = await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: [
          'Date,Description,Amount,Balance',
          '05/08/2026,ATM WITHDRAWAL,-50.00,950.00',
          '05/08/2026,ATM WITHDRAWAL,-50.00,900.00',
        ].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result.imported).toBe(2);
  });

  it('is idempotent on the import key', async () => {
    const { ctx, bankAccountId } = await bankTenant('Idempotent Import Sdn Bhd');
    const key = randomUUID();
    const input = {
      bankAccountId,
      content: csv,
      profile: MAYBANK,
      statementDate: '2026-08-31',
      idempotencyKey: key,
    };

    const first = await withTenant(sql, ctx, (tx) => importStatement(tx, ctx, input));
    const second = await withTenant(sql, ctx, (tx) => importStatement(tx, ctx, input));

    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it('previews without writing, flagging rows already held', async () => {
    const { ctx, bankAccountId } = await bankTenant('Preview Sdn Bhd');

    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: csv,
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    const preview = await withTenant(sql, ctx, (tx) =>
      previewStatement(tx, ctx, { bankAccountId, content: csv, profile: MAYBANK }),
    );

    expect(preview.rows).toHaveLength(3);
    expect(preview.rows.every((r) => r.duplicate)).toBe(true);

    // And nothing new was written.
    const [count] = await withTenant(sql, ctx, (tx) =>
      tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM bank_transaction
           WHERE tenant_id = ${ctx.tenantId}
      `,
    );
    expect(count!.count).toBe('3');
  });
});

describe('an imported bank line records what the BANK said', () => {
  it('refuses to have its amount edited', async () => {
    // Without this, a user who cannot get an account to reconcile can "fix"
    // the statement instead of finding the error, and the reconciliation then
    // proves nothing at all.
    const { ctx, bankAccountId } = await bankTenant('Immutable Lines Sdn Bhd');
    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: ['Date,Description,Amount,Balance', '05/08/2026,PAYMENT,100.00,100.00'].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    await expect(
      withTenant(sql, ctx, (tx) => tx`
          UPDATE bank_transaction SET amount = 999
           WHERE tenant_id = ${ctx.tenantId}
      `),
    ).rejects.toThrow(/cannot be edited|what the bank reported/i);
  });

  it('allows its reconciliation status to change', async () => {
    const { ctx, bankAccountId } = await bankTenant('Status Change Sdn Bhd');
    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: ['Date,Description,Amount,Balance', '05/08/2026,PAYMENT,100.00,100.00'].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, ctx, (tx) => tx`
        UPDATE bank_transaction SET status = 'EXCLUDED', excluded_reason = 'Duplicate at the bank'
         WHERE tenant_id = ${ctx.tenantId}
    `);
  });
});

describe('matching against real documents', () => {
  it('suggests the receipt that settles a bank credit, with a reason', async () => {
    const { tenant, ctx, bankAccountId } = await bankTenant('Matching Sdn Bhd');

    const invoice = await withTenant(sql, ctx, (tx) =>
      issueInvoice(tx, ctx, {
        contactId: tenant.customerId,
        issueDate: '2026-08-01',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitPrice: '1080.00',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const receipt = await withTenant(sql, ctx, (tx) =>
      recordReceipt(tx, ctx, {
        contactId: tenant.customerId,
        paymentDate: '2026-08-05',
        amount: '1080.00',
        method: 'DUITNOW',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '1080.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: [
          'Date,Description,Amount,Balance',
          '05/08/2026,IBG TRANSFER FR NUSANTARA RETAIL SDN BHD,1080.00,1080.00',
        ].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    const suggestions = await withTenant(sql, ctx, (tx) =>
      suggestForAccount(tx, ctx, bankAccountId),
    );

    const forLine = [...suggestions.values()][0]!;
    expect(forLine.length).toBeGreaterThan(0);

    const best = forLine[0]!;
    expect(best.candidateIds).toContain(receipt.id);
    expect(best.reason).toMatch(/Amount matches exactly/);
    expect(best.reason).toMatch(/Nusantara Retail/i);
  });

  it('never suggests a document pointing the wrong way', async () => {
    const { tenant, ctx, bankAccountId } = await bankTenant('Direction Sdn Bhd');

    // An open BILL for 600 — an outflow. The statement line is an INFLOW of
    // the same amount on the same day.
    await withTenant(sql, ctx, (tx) =>
      enterBill(tx, ctx, {
        supplierId: tenant.supplierId,
        billNo: 'SUP-1',
        billDate: '2026-08-05',
        lines: [
          {
            description: 'Supplies',
            quantity: '1',
            unitPrice: '600.00',
            accountId: tenant.accounts['6000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: [
          'Date,Description,Amount,Balance',
          '05/08/2026,IBG TRANSFER FR SELANGOR SUPPLIES SDN BHD,600.00,600.00',
        ].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    const suggestions = await withTenant(sql, ctx, (tx) =>
      suggestForAccount(tx, ctx, bankAccountId),
    );

    for (const list of suggestions.values()) {
      expect(list.every((s) => s.kind !== 'BILL')).toBe(true);
    }
  });

  it('spots a transfer between two of the tenant’s own accounts', async () => {
    // An own-account transfer reconciled as two unrelated lines books an
    // expense on one side and income on the other. The balance sheet still
    // balances and the P&L is overstated on both lines — it looks entirely
    // normal on a trial balance.
    const { tenant, ctx, bankAccountId } = await bankTenant('Transfer Sdn Bhd');

    const second = await withTenant(sql, ctx, (tx) =>
      createBankAccount(tx, ctx, {
        name: 'CIMB Current',
        bankName: 'CIMB Bank Berhad',
        glAccountId: tenant.accounts['1100']!, // any distinct GL account
      }),
    );

    for (const [accountId, line] of [
      [bankAccountId, '05/08/2026,INSTANT TRANSFER TO CIMB,-5000.00,0.00'],
      [second.id, '06/08/2026,INSTANT TRANSFER FR MAYBANK,5000.00,5000.00'],
    ] as const) {
      await withTenant(sql, ctx, (tx) =>
        importStatement(tx, ctx, {
          bankAccountId: accountId,
          content: ['Date,Description,Amount,Balance', line].join('\n'),
          profile: MAYBANK,
          statementDate: '2026-08-31',
          idempotencyKey: randomUUID(),
        }),
      );
    }

    const transfers = await withTenant(sql, ctx, (tx) => suggestTransfersForTenant(tx, ctx));
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.amount.toDecimalString()).toBe('5000.0000');
  });
});

describe('confirming and undoing a match', () => {
  it('never rewrites the journal entry', async () => {
    const { tenant, ctx, bankAccountId } = await bankTenant('Confirm Sdn Bhd');

    const invoice = await withTenant(sql, ctx, (tx) =>
      issueInvoice(tx, ctx, {
        contactId: tenant.customerId,
        issueDate: '2026-08-01',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitPrice: '500.00',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const receipt = await withTenant(sql, ctx, (tx) =>
      recordReceipt(tx, ctx, {
        contactId: tenant.customerId,
        paymentDate: '2026-08-05',
        amount: '500.00',
        method: 'DUITNOW',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '500.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: ['Date,Description,Amount,Balance', '05/08/2026,PAYMENT IN,500.00,500.00'].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    const [line] = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM bank_transaction WHERE tenant_id = ${ctx.tenantId}`,
    );

    const before = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string; base_debit: string }[]>`
          SELECT id, base_debit FROM journal_line
           WHERE tenant_id = ${ctx.tenantId} AND journal_entry_id = ${receipt.journalEntryId}
           ORDER BY id
      `,
    );

    await withTenant(sql, ctx, (tx) =>
      confirmMatch(tx, ctx, {
        bankTransactionId: line!.id,
        matchedType: 'PAYMENT',
        matchedId: receipt.id,
        amount: '500.00',
        confidence: 95,
      }),
    );

    const after = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string; base_debit: string }[]>`
          SELECT id, base_debit FROM journal_line
           WHERE tenant_id = ${ctx.tenantId} AND journal_entry_id = ${receipt.journalEntryId}
           ORDER BY id
      `,
    );

    expect(after).toEqual(before);

    const [status] = await withTenant(sql, ctx, (tx) =>
      tx<{ status: string }[]>`
          SELECT status FROM bank_transaction
           WHERE tenant_id = ${ctx.tenantId} AND id = ${line!.id}
      `,
    );
    expect(status!.status).toBe('RECONCILED');
  });

  it('undoes by inserting a reversal, leaving both decisions visible', async () => {
    const { tenant, ctx, bankAccountId } = await bankTenant('Unmatch Sdn Bhd');

    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: ['Date,Description,Amount,Balance', '05/08/2026,BANK CHARGE,-5.00,-5.00'].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    const [line] = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM bank_transaction WHERE tenant_id = ${ctx.tenantId}`,
    );

    const created = await withTenant(sql, ctx, (tx) =>
      createEntryFromBankLine(tx, ctx, {
        bankTransactionId: line!.id,
        accountId: tenant.accounts['6000']!,
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, ctx, (tx) => unmatch(tx, ctx, created.matchId, 'Coded to the wrong account'));

    const rows = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string; reverses_match_id: string | null }[]>`
          SELECT id, reverses_match_id FROM reconciliation_match
           WHERE tenant_id = ${ctx.tenantId} ORDER BY matched_at
      `,
    );

    // Both decisions survive: the match, and the undo that reversed it.
    expect(rows).toHaveLength(2);
    expect(rows[1]!.reverses_match_id).toBe(created.matchId);

    // And the line is open again.
    const [status] = await withTenant(sql, ctx, (tx) =>
      tx<{ status: string }[]>`
          SELECT status FROM bank_transaction
           WHERE tenant_id = ${ctx.tenantId} AND id = ${line!.id}
      `,
    );
    expect(status!.status).toBe('UNRECONCILED');
  });

  it('refuses to undo the same match twice', async () => {
    const { tenant, ctx, bankAccountId } = await bankTenant('Double Unmatch Sdn Bhd');

    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: ['Date,Description,Amount,Balance', '05/08/2026,BANK CHARGE,-5.00,-5.00'].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    const [line] = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM bank_transaction WHERE tenant_id = ${ctx.tenantId}`,
    );

    const created = await withTenant(sql, ctx, (tx) =>
      createEntryFromBankLine(tx, ctx, {
        bankTransactionId: line!.id,
        accountId: tenant.accounts['6000']!,
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, ctx, (tx) => unmatch(tx, ctx, created.matchId));
    await expect(
      withTenant(sql, ctx, (tx) => unmatch(tx, ctx, created.matchId)),
    ).rejects.toThrow(/not found|already been undone/i);
  });

  it('a match row can never be updated or deleted', async () => {
    const { tenant, ctx, bankAccountId } = await bankTenant('Append Only Sdn Bhd');

    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: ['Date,Description,Amount,Balance', '05/08/2026,BANK CHARGE,-5.00,-5.00'].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    const [line] = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM bank_transaction WHERE tenant_id = ${ctx.tenantId}`,
    );
    await withTenant(sql, ctx, (tx) =>
      createEntryFromBankLine(tx, ctx, {
        bankTransactionId: line!.id,
        accountId: tenant.accounts['6000']!,
        idempotencyKey: randomUUID(),
      }),
    );

    await expect(
      withTenant(sql, ctx, (tx) => tx`
          UPDATE reconciliation_match SET amount = 0 WHERE tenant_id = ${ctx.tenantId}
      `),
    ).rejects.toThrow(/append-only|permission denied/i);

    await expect(
      withTenant(sql, ctx, (tx) => tx`
          DELETE FROM reconciliation_match WHERE tenant_id = ${ctx.tenantId}
      `),
    ).rejects.toThrow(/append-only|permission denied/i);
  });
});

describe('creating a ledger entry from a bank line', () => {
  it('posts a bank charge with the sign taken from the statement', async () => {
    const { tenant, ctx, bankAccountId } = await bankTenant('Bank Charge Sdn Bhd');

    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: ['Date,Description,Amount,Balance', '31/08/2026,SERVICE CHARGE,-5.00,-5.00'].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    const [line] = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM bank_transaction WHERE tenant_id = ${ctx.tenantId}`,
    );

    const created = await withTenant(sql, ctx, (tx) =>
      createEntryFromBankLine(tx, ctx, {
        bankTransactionId: line!.id,
        accountId: tenant.accounts['6000']!,
        description: 'Monthly service charge',
        idempotencyKey: randomUUID(),
      }),
    );

    const lines = await withTenant(sql, ctx, (tx) =>
      tx<{ account_id: string; base_debit: string; base_credit: string }[]>`
          SELECT account_id, base_debit, base_credit FROM journal_line
           WHERE tenant_id = ${ctx.tenantId} AND journal_entry_id = ${created.journalEntryId}
      `,
    );

    // Money OUT of the bank: credit the bank GL account, debit the expense.
    const bank = lines.find((l) => l.account_id === tenant.accounts['1000'])!;
    const expense = lines.find((l) => l.account_id === tenant.accounts['6000'])!;
    expect(rm(bank.base_credit).toDecimalString()).toBe('5.0000');
    expect(rm(expense.base_debit).toDecimalString()).toBe('5.0000');
  });
});

describe('ledger invariant #8 — bank GL = opening + reconciled transactions', () => {
  it('holds once every line on both sides is accounted for', async () => {
    const { tenant, ctx, bankAccountId } = await bankTenant('Invariant Eight Sdn Bhd');

    // A receipt, a supplier payment, and a bank charge that originates at the
    // bank — the three shapes a real account contains.
    const invoice = await withTenant(sql, ctx, (tx) =>
      issueInvoice(tx, ctx, {
        contactId: tenant.customerId,
        issueDate: '2026-08-01',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitPrice: '1080.00',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const receipt = await withTenant(sql, ctx, (tx) =>
      recordReceipt(tx, ctx, {
        contactId: tenant.customerId,
        paymentDate: '2026-08-05',
        amount: '1080.00',
        method: 'DUITNOW',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ invoiceId: invoice.id, amount: '1080.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const bill = await withTenant(sql, ctx, (tx) =>
      enterBill(tx, ctx, {
        supplierId: tenant.supplierId,
        billNo: 'SUP-99',
        billDate: '2026-08-02',
        lines: [
          {
            description: 'Supplies',
            quantity: '1',
            unitPrice: '600.00',
            accountId: tenant.accounts['6000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const payment = await withTenant(sql, ctx, (tx) =>
      paySupplier(tx, ctx, {
        supplierId: tenant.supplierId,
        paymentDate: '2026-08-10',
        amount: '600.00',
        method: 'TRANSFER',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ billId: bill.id, amount: '600.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: [
          'Date,Description,Amount,Balance',
          '05/08/2026,IBG TRANSFER FR NUSANTARA RETAIL SDN BHD,1080.00,1080.00',
          '10/08/2026,DUITNOW QR PYMT SELANGOR SUPPLIES SDN BHD,-600.00,480.00',
          '31/08/2026,SERVICE CHARGE,-5.00,475.00',
        ].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    const lines = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string; amount: string; description: string }[]>`
          SELECT id, amount, description FROM bank_transaction
           WHERE tenant_id = ${ctx.tenantId} ORDER BY txn_date
      `,
    );

    // Before anything is matched, the invariant must NOT claim to hold.
    const before = await withTenant(sql, ctx, (tx) =>
      checkBankInvariant(tx, ctx, bankAccountId, '2026-08-31'),
    );
    expect(before.fullyReconciled).toBe(false);

    await withTenant(sql, ctx, (tx) =>
      confirmMatch(tx, ctx, {
        bankTransactionId: lines[0]!.id,
        matchedType: 'PAYMENT',
        matchedId: receipt.id,
        amount: '1080.00',
      }),
    );
    await withTenant(sql, ctx, (tx) =>
      confirmMatch(tx, ctx, {
        bankTransactionId: lines[1]!.id,
        matchedType: 'PAYMENT',
        matchedId: payment.id,
        amount: '-600.00',
      }),
    );
    // The charge has no ledger entry behind it — the bank is right and the
    // books are missing one. Without this path the invariant is unreachable on
    // any real account.
    await withTenant(sql, ctx, (tx) =>
      createEntryFromBankLine(tx, ctx, {
        bankTransactionId: lines[2]!.id,
        accountId: tenant.accounts['6000']!,
        idempotencyKey: randomUUID(),
      }),
    );

    const after = await withTenant(sql, ctx, (tx) =>
      checkBankInvariant(tx, ctx, bankAccountId, '2026-08-31'),
    );

    expect(after.fullyReconciled).toBe(true);
    expect(after.holds).toBe(true);
    expect(after.expected.toDecimalString()).toBe('475.0000');

    // The GL agrees independently.
    const book = await withTenant(sql, ctx, (tx) =>
      bookBalance(tx, ctx, bankAccountId, '2026-08-31'),
    );
    expect(book.toDecimalString()).toBe('475.0000');

    const reconciliation = await withTenant(sql, ctx, (tx) =>
      reconcileAccount(tx, ctx, bankAccountId, '2026-08-31'),
    );
    expect(reconciliation.reconciles).toBe(true);

    const session = await withTenant(sql, ctx, (tx) =>
      completeReconciliation(tx, ctx, {
        bankAccountId,
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
      }),
    );
    expect(session.variance).toBe('0.0000');

    const drift = await withTenant(sql, ctx, (tx) => detectRollupDrift(tx, ctx));
    expect(drift).toEqual([]);
  });

  it('separates an unpresented cheque from an unrecorded bank charge', async () => {
    // The distinction the module turns on. A cheque not yet presented needs no
    // action; a bank charge is unposted expense sitting in a screen. Lumped
    // together, the second hides behind the first for a year.
    const { tenant, ctx, bankAccountId } = await bankTenant('Two Kinds Sdn Bhd');

    // Money out per the books that has not reached the bank.
    const bill = await withTenant(sql, ctx, (tx) =>
      enterBill(tx, ctx, {
        supplierId: tenant.supplierId,
        billNo: 'CHQ-1',
        billDate: '2026-08-02',
        lines: [
          {
            description: 'Supplies',
            quantity: '1',
            unitPrice: '250.00',
            accountId: tenant.accounts['6000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );
    await withTenant(sql, ctx, (tx) =>
      paySupplier(tx, ctx, {
        supplierId: tenant.supplierId,
        paymentDate: '2026-08-28',
        amount: '250.00',
        method: 'CHEQUE',
        depositAccountId: tenant.accounts['1000']!,
        allocations: [{ billId: bill.id, amount: '250.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    // And a charge on the statement that the books know nothing about.
    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: ['Date,Description,Amount,Balance', '31/08/2026,SERVICE CHARGE,-5.00,-5.00'].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    const result = await withTenant(sql, ctx, (tx) =>
      reconcileAccount(tx, ctx, bankAccountId, '2026-08-31'),
    );

    expect(result.unpresentedPayments.toDecimalString()).toBe('250.0000');
    expect(result.unrecordedBankMovement.toDecimalString()).toBe('-5.0000');
    // Both are explained, so the account still reconciles.
    expect(result.reconciles).toBe(true);
  });

  it('refuses to sign off a period that does not reconcile', async () => {
    const { ctx, bankAccountId, tenant } = await bankTenant('Wont Sign Sdn Bhd');

    await withTenant(sql, ctx, (tx) =>
      importStatement(tx, ctx, {
        bankAccountId,
        content: ['Date,Description,Amount,Balance', '31/08/2026,MYSTERY CREDIT,12.00,12.00'].join('\n'),
        profile: MAYBANK,
        statementDate: '2026-08-31',
        idempotencyKey: randomUUID(),
      }),
    );

    // A statement line with no ledger entry behind it is explained by the
    // unrecorded-movement adjustment, so this account DOES reconcile. Force a
    // genuine variance by giving the account an opening balance the ledger
    // knows nothing about.
    await withTenant(admin, { tenantId: tenant.tenantId }, (tx) => tx`
        UPDATE bank_account SET opening_balance = 100
         WHERE tenant_id = ${tenant.tenantId} AND id = ${bankAccountId}
    `);

    await expect(
      withTenant(sql, ctx, (tx) =>
        completeReconciliation(tx, ctx, {
          bankAccountId,
          periodStart: '2026-08-01',
          periodEnd: '2026-08-31',
        }),
      ),
    ).rejects.toThrow(/does not reconcile|unexplained/i);
  });

  it('a completed session is frozen', async () => {
    const { ctx, bankAccountId } = await bankTenant('Frozen Session Sdn Bhd');

    await withTenant(sql, ctx, (tx) =>
      completeReconciliation(tx, ctx, {
        bankAccountId,
        periodStart: '2026-08-01',
        periodEnd: '2026-08-31',
      }),
    );

    await expect(
      withTenant(sql, ctx, (tx) => tx`
          UPDATE reconciliation_session SET variance = 99
           WHERE tenant_id = ${ctx.tenantId}
      `),
    ).rejects.toThrow(/completed|immutable/i);
  });
});
