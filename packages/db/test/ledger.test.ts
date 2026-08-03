import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, reverseEntry, unwrap, validateJournalEntry, type JournalEntryDraft } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { detectRollupDrift, postJournalEntry, trialBalance } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('ledger');
  sql = db.sql; // unprivileged app role — subject to RLS
  drop = db.drop;
  tenant = await seedTenant(db.admin);
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

/** Dr AR 1,080 / Cr Revenue 1,000 / Cr SST Payable 80 — an 8% service-tax sale. */
function invoiceEntry(t: Tenant, date = '2026-08-05'): JournalEntryDraft {
  return {
    entryDate: date,
    description: 'Invoice INV-00001',
    sourceModule: 'SALES',
    lines: [
      { accountId: t.accounts['1100']!, side: 'DEBIT', amount: rm('1080.00'), baseAmount: rm('1080.00') },
      { accountId: t.accounts['4000']!, side: 'CREDIT', amount: rm('1000.00'), baseAmount: rm('1000.00') },
      { accountId: t.accounts['2100']!, side: 'CREDIT', amount: rm('80.00'), baseAmount: rm('80.00') },
    ],
  };
}

describe('posting a journal entry', () => {
  it('posts a balanced entry and returns a gapless number', async () => {
    const entry = unwrap(validateJournalEntry(invoiceEntry(tenant), 'MYR'));

    const posted = await withTenant(sql, { tenantId: tenant.tenantId, userId: tenant.userId }, (tx) =>
      postJournalEntry(tx, { tenantId: tenant.tenantId, userId: tenant.userId }, entry, {
        idempotencyKey: randomUUID(),
        emitEvent: { type: 'invoice.issued', payload: { invoiceNo: 'INV-00001' } },
      }),
    );

    expect(posted.entryNo).toMatch(/^JE-\d{5}$/);
    expect(posted.totalDebit).toBe('1080.0000');
    expect(posted.totalCredit).toBe('1080.0000');
    expect(posted.replayed).toBe(false);
  });

  it('writes the outbox event in the same transaction', async () => {
    const events = await withTenant(sql, { tenantId: tenant.tenantId }, (tx) =>
      tx<{ event_type: string; status: string }[]>`
          SELECT event_type, status FROM outbox_event WHERE tenant_id = ${tenant.tenantId}
      `,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: 'invoice.issued', status: 'PENDING' });
  });

  it('writes a hash-chained audit row for the entry AND every line', async () => {
    // This used to assert a single hand-written 'JOURNAL_POSTED' row — the only
    // audit row anywhere in the system. Migration 0016 replaced that insert with
    // a trigger on every audited table, so the assertion is now about coverage:
    // the header and each of its lines, each carrying a before image and the
    // actor's origin, none of which the hand-written row had.
    const rows = await withTenant(sql, { tenantId: tenant.tenantId }, (tx) =>
      tx<{ action: string; entity_type: string; row_hash: Uint8Array; after_json: unknown }[]>`
          SELECT action, entity_type, row_hash, after_json
            FROM audit_log
           WHERE tenant_id = ${tenant.tenantId}
             AND entity_type IN ('journal_entry', 'journal_line')
           ORDER BY id
      `,
    );

    const headers = rows.filter((r) => r.entity_type === 'journal_entry');
    const lines = rows.filter((r) => r.entity_type === 'journal_line');

    expect(headers.length).toBeGreaterThan(0);
    // A balanced entry has at least two lines, and each is now attributable.
    expect(lines.length).toBeGreaterThanOrEqual(2 * headers.length);

    for (const row of rows) {
      expect(row.action).toBe('CREATE');
      expect(row.row_hash.length).toBe(32); // sha256
    }

    // The whole header, not a five-field summary that drifts from the schema.
    expect(headers[0]!.after_json).toMatchObject({ status: 'POSTED' });
  });

  it('is idempotent — a replayed key posts exactly one entry', async () => {
    const key = randomUUID();
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId };
    const entry = unwrap(validateJournalEntry(invoiceEntry(tenant, '2026-08-06'), 'MYR'));

    const first = await withTenant(sql, ctx, (tx) =>
      postJournalEntry(tx, ctx, entry, { idempotencyKey: key }),
    );
    const second = await withTenant(sql, ctx, (tx) =>
      postJournalEntry(tx, ctx, entry, { idempotencyKey: key }),
    );

    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);

    const [countRow] = await withTenant(sql, ctx, (tx) =>
      tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM journal_entry
           WHERE tenant_id = ${tenant.tenantId} AND idempotency_key = ${key}
      `,
    );
    expect(countRow!.count).toBe('1');
  });
});

describe('database-enforced invariants', () => {
  it('rejects an unbalanced entry at COMMIT (deferred constraint trigger)', async () => {
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

    // Bypass domain validation deliberately: this proves the DATABASE refuses
    // an unbalanced entry even if application code is buggy or bypassed.
    await expect(
      withTenant(sql, ctx, async (tx) => {
        const [numbered] = await tx<{ allocate_document_number: string }[]>`
            SELECT allocate_document_number('JOURNAL')
        `;
        const [e] = await tx<{ id: string }[]>`
            INSERT INTO journal_entry (tenant_id, entry_no, entry_date, fiscal_period_id,
                                       source_module, status, posted_by, posted_at)
            VALUES (${tenant.tenantId}, ${numbered!.allocate_document_number}, '2026-08-07', ${tenant.periodId},
                    'MANUAL', 'POSTED', ${tenant.userId}, now())
            RETURNING id
        `;
        await tx`
            INSERT INTO journal_line (tenant_id, journal_entry_id, line_no, account_id,
                                      debit, credit, currency, base_debit, base_credit)
            VALUES (${tenant.tenantId}, ${e!.id}, 1, ${tenant.accounts['1000']!},
                    100, 0, 'MYR', 100, 0),
                   (${tenant.tenantId}, ${e!.id}, 2, ${tenant.accounts['4000']!},
                    0, 99, 'MYR', 0, 99)
        `;
      }),
    ).rejects.toThrow(/unbalanced/i);
  });

  it('rejects a single-line entry', async () => {
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId };
    await expect(
      withTenant(sql, ctx, async (tx) => {
        const [numbered] = await tx<{ allocate_document_number: string }[]>`
            SELECT allocate_document_number('JOURNAL')
        `;
        const [e] = await tx<{ id: string }[]>`
            INSERT INTO journal_entry (tenant_id, entry_no, entry_date, fiscal_period_id,
                                       source_module, status, posted_by, posted_at)
            VALUES (${tenant.tenantId}, ${numbered!.allocate_document_number}, '2026-08-07', ${tenant.periodId},
                    'MANUAL', 'POSTED', ${tenant.userId}, now())
            RETURNING id
        `;
        await tx`
            INSERT INTO journal_line (tenant_id, journal_entry_id, line_no, account_id,
                                      debit, credit, currency, base_debit, base_credit)
            VALUES (${tenant.tenantId}, ${e!.id}, 1, ${tenant.accounts['1000']!}, 100, 0, 'MYR', 100, 0)
        `;
      }),
    ).rejects.toThrow(/double entry requires at least two/i);
  });

  it('refuses a line that is both a debit and a credit', async () => {
    const ctx = { tenantId: tenant.tenantId };
    await expect(
      withTenant(sql, ctx, async (tx) => {
        const [e] = await tx<{ id: string }[]>`
            INSERT INTO journal_entry (tenant_id, entry_no, entry_date, fiscal_period_id,
                                       source_module, status)
            VALUES (${tenant.tenantId}, ${'JE-X' + randomUUID().slice(0, 8)}, '2026-08-07',
                    ${tenant.periodId}, 'MANUAL', 'DRAFT')
            RETURNING id
        `;
        await tx`
            INSERT INTO journal_line (tenant_id, journal_entry_id, line_no, account_id,
                                      debit, credit, currency, base_debit, base_credit)
            VALUES (${tenant.tenantId}, ${e!.id}, 1, ${tenant.accounts['1000']!},
                    100, 100, 'MYR', 100, 0)
        `;
      }),
    ).rejects.toThrow(/debit_xor_credit/i);
  });

  it('forbids updating a posted entry', async () => {
    const ctx = { tenantId: tenant.tenantId };
    await expect(
      withTenant(sql, ctx, (tx) => tx`
          UPDATE journal_entry SET entry_date = '2026-08-31'
           WHERE tenant_id = ${tenant.tenantId} AND status = 'POSTED'
      `),
    ).rejects.toThrow(/posted and immutable/i);
  });

  it('forbids deleting a posted entry', async () => {
    const ctx = { tenantId: tenant.tenantId };
    await expect(
      withTenant(sql, ctx, (tx) => tx`
          DELETE FROM journal_entry
           WHERE tenant_id = ${tenant.tenantId} AND status = 'POSTED'
      `),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('forbids altering the lines of a posted entry', async () => {
    const ctx = { tenantId: tenant.tenantId };
    await expect(
      withTenant(sql, ctx, (tx) => tx`
          UPDATE journal_line SET base_debit = base_debit + 1
           WHERE tenant_id = ${tenant.tenantId}
             AND journal_entry_id IN (
                 SELECT id FROM journal_entry
                  WHERE tenant_id = ${tenant.tenantId} AND status = 'POSTED' LIMIT 1)
      `),
    ).rejects.toThrow(/immutable/i);
  });

  it('blocks posting into a LOCKED period', async () => {
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId };
    const entry = unwrap(validateJournalEntry(invoiceEntry(tenant, '2026-01-15'), 'MYR'));

    await expect(
      withTenant(sql, ctx, (tx) =>
        postJournalEntry(tx, ctx, entry, { idempotencyKey: randomUUID() }),
      ),
    ).rejects.toThrow(/LOCKED/i);
  });

  it('allows posting into a LOCKED period with the override permission', async () => {
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId, allowLockedPeriod: true };
    const entry = unwrap(validateJournalEntry(invoiceEntry(tenant, '2026-01-15'), 'MYR'));

    const posted = await withTenant(sql, ctx, (tx) =>
      postJournalEntry(tx, ctx, entry, { idempotencyKey: randomUUID() }),
    );
    expect(posted.replayed).toBe(false);
  });
});

describe('gapless numbering', () => {
  it('returns the number to the pool when the transaction rolls back', async () => {
    const ctx = { tenantId: tenant.tenantId };

    const before = await withTenant(sql, ctx, (tx) =>
      tx<{ next_value: string }[]>`
          SELECT next_value::text FROM number_sequence
           WHERE tenant_id = ${tenant.tenantId} AND document_type = 'INVOICE'
      `,
    );

    await expect(
      withTenant(sql, ctx, async (tx) => {
        await tx`SELECT allocate_document_number('INVOICE')`;
        throw new Error('simulated failure after allocation');
      }),
    ).rejects.toThrow('simulated failure');

    const after = await withTenant(sql, ctx, (tx) =>
      tx<{ next_value: string }[]>`
          SELECT next_value::text FROM number_sequence
           WHERE tenant_id = ${tenant.tenantId} AND document_type = 'INVOICE'
      `,
    );

    // A PostgreSQL SEQUENCE would have burned this number and left a gap.
    expect(after[0]!.next_value).toBe(before[0]!.next_value);
  });

  it('allocates consecutively with no gaps', async () => {
    const ctx = { tenantId: tenant.tenantId };
    const numbers: string[] = [];

    for (let i = 0; i < 5; i++) {
      const [row] = await withTenant(sql, ctx, (tx) =>
        tx<{ allocate_document_number: string }[]>`SELECT allocate_document_number('INVOICE')`,
      );
      numbers.push(row!.allocate_document_number);
    }

    const suffixes = numbers.map((n) => Number(n.replace('INV-', '')));
    expect(suffixes).toEqual([suffixes[0]!, suffixes[0]! + 1, suffixes[0]! + 2, suffixes[0]! + 3, suffixes[0]! + 4]);
  });
});

describe('trial balance and rollup integrity', () => {
  it('produces a trial balance whose debits equal its credits', async () => {
    const ctx = { tenantId: tenant.tenantId };
    const rows = await withTenant(sql, ctx, (tx) => trialBalance(tx, ctx, tenant.periodId));

    expect(rows.length).toBeGreaterThan(0);

    const totals = rows.reduce(
      (acc, r) => ({
        debit: acc.debit.add(Money.fromDecimal(r.debit, 'MYR')),
        credit: acc.credit.add(Money.fromDecimal(r.credit, 'MYR')),
      }),
      { debit: Money.zero('MYR'), credit: Money.zero('MYR') },
    );

    expect(totals.debit.toDecimalString()).toBe(totals.credit.toDecimalString());
  });

  it('keeps the rollup in agreement with the raw journal lines', async () => {
    const ctx = { tenantId: tenant.tenantId };
    const drift = await withTenant(sql, ctx, (tx) => detectRollupDrift(tx, ctx));
    expect(drift).toEqual([]);
  });

  it('a reversal returns every affected account to its prior balance', async () => {
    const ctx = { tenantId: tenant.tenantId, userId: tenant.userId };
    const original = invoiceEntry(tenant, '2026-08-20');

    const balancesBefore = await accountBalances(sql, tenant);

    await withTenant(sql, ctx, (tx) =>
      postJournalEntry(tx, ctx, unwrap(validateJournalEntry(original, 'MYR')), {
        idempotencyKey: randomUUID(),
      }),
    );

    const reversal = reverseEntry(original, { entryDate: '2026-08-21' });
    await withTenant(sql, ctx, (tx) =>
      postJournalEntry(tx, ctx, unwrap(validateJournalEntry(reversal, 'MYR')), {
        idempotencyKey: randomUUID(),
      }),
    );

    const balancesAfter = await accountBalances(sql, tenant);
    expect(balancesAfter).toEqual(balancesBefore);
  });
});

async function accountBalances(sql: Sql, t: Tenant): Promise<Record<string, string>> {
  const ctx = { tenantId: t.tenantId };
  const rows = await withTenant(sql, ctx, (tx) =>
    tx<{ code: string; balance: string }[]>`
        SELECT a.code, COALESCE(SUM(b.net_movement), 0)::text AS balance
          FROM account a
          LEFT JOIN account_period_balance b
            ON b.tenant_id = a.tenant_id AND b.account_id = a.id
         WHERE a.tenant_id = ${t.tenantId}
         GROUP BY a.code
         ORDER BY a.code
    `,
  );
  return Object.fromEntries(rows.map((r) => [r.code, r.balance]));
}
