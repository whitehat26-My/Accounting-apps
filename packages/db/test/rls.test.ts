/**
 * Ledger invariant #14 and the tenant-isolation boundary.
 *
 * These are the most important tests in the repository. They prove that
 * isolation is enforced by PostgreSQL rather than by application code — which
 * means an application bug cannot leak one client's books into another's.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unwrap, validateJournalEntry, Money, type JournalEntryDraft } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { postJournalEntry } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let alpha: Tenant;
let beta: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('rls');
  sql = db.sql; // unprivileged app role — subject to RLS
  admin = db.admin;
  drop = db.drop;

  alpha = await seedTenant(db.admin, 'Alpha Trading Sdn Bhd');
  beta = await seedTenant(db.admin, 'Beta Services Sdn Bhd');

  // Give each tenant one posted entry to look for.
  for (const t of [alpha, beta]) {
    const ctx = { tenantId: t.tenantId, userId: t.userId };
    const entry: JournalEntryDraft = {
      entryDate: '2026-08-05',
      description: `${t.tenantId} sale`,
      sourceModule: 'SALES',
      lines: [
        { accountId: t.accounts['1100']!, side: 'DEBIT', amount: Money.fromDecimal('500', 'MYR'), baseAmount: Money.fromDecimal('500', 'MYR') },
        { accountId: t.accounts['4000']!, side: 'CREDIT', amount: Money.fromDecimal('500', 'MYR'), baseAmount: Money.fromDecimal('500', 'MYR') },
      ],
    };
    await withTenant(sql, ctx, (tx) =>
      postJournalEntry(tx, ctx, unwrap(validateJournalEntry(entry, 'MYR')), {
        idempotencyKey: randomUUID(),
      }),
    );
  }
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('invariant #14 — tenant isolation is enforced by the database', () => {
  it('a query with no tenant context returns zero rows', async () => {
    // Note: NOT wrapped in withTenant, so app.tenant_id is never set.
    const entries = await sql`SELECT id FROM journal_entry`;
    const accounts = await sql`SELECT id FROM account`;
    const lines = await sql`SELECT id FROM journal_line`;
    const orgs = await sql`SELECT id FROM organisation`;

    expect(entries).toHaveLength(0);
    expect(accounts).toHaveLength(0);
    expect(lines).toHaveLength(0);
    expect(orgs).toHaveLength(0);
  });

  it('each tenant sees only its own journal entries', async () => {
    const alphaEntries = await withTenant(sql, { tenantId: alpha.tenantId }, (tx) =>
      tx<{ tenant_id: string }[]>`SELECT tenant_id FROM journal_entry`,
    );
    const betaEntries = await withTenant(sql, { tenantId: beta.tenantId }, (tx) =>
      tx<{ tenant_id: string }[]>`SELECT tenant_id FROM journal_entry`,
    );

    expect(alphaEntries).toHaveLength(1);
    expect(betaEntries).toHaveLength(1);
    expect(alphaEntries.every((r) => r.tenant_id === alpha.tenantId)).toBe(true);
    expect(betaEntries.every((r) => r.tenant_id === beta.tenantId)).toBe(true);
  });

  it('an explicit WHERE on another tenant returns nothing rather than leaking', async () => {
    const rows = await withTenant(sql, { tenantId: alpha.tenantId }, (tx) =>
      tx`SELECT id FROM journal_entry WHERE tenant_id = ${beta.tenantId}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('the isolation holds across every tenant-owned table', async () => {
    const tables = [
      'account', 'fiscal_year', 'fiscal_period', 'journal_entry', 'journal_line',
      'account_period_balance', 'number_sequence', 'outbox_event', 'audit_log',
    ];

    for (const table of tables) {
      const leaked = await withTenant(sql, { tenantId: alpha.tenantId }, (tx) =>
        tx.unsafe(`SELECT COUNT(*)::text AS count FROM ${table} WHERE tenant_id <> $1`, [alpha.tenantId]),
      );
      expect(leaked[0]!['count'], `${table} leaked rows across tenants`).toBe('0');
    }
  });

  it('every tenant-owned table has RLS enabled AND forced with a policy', async () => {
    // The CI guard from docs/architecture/06-data-model.md §6.2: a new table
    // without a policy must fail the build rather than silently leak.
    const rows = await sql<{ tablename: string; rowsecurity: boolean; forced: boolean; policies: number }[]>`
        SELECT c.relname                AS tablename,
               c.relrowsecurity         AS rowsecurity,
               c.relforcerowsecurity    AS forced,
               (SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND c.relname <> 'schema_migration'
    `;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.rowsecurity, `${row.tablename}: RLS not enabled`).toBe(true);
      expect(row.forced, `${row.tablename}: RLS not FORCED`).toBe(true);
      expect(row.policies, `${row.tablename}: no policy attached`).toBeGreaterThan(0);
    }
  });
});

describe('WITH CHECK — writes cannot escape the tenant either', () => {
  it('refuses to insert a row belonging to another tenant', async () => {
    await expect(
      withTenant(sql, { tenantId: alpha.tenantId }, (tx) => tx`
          INSERT INTO account (tenant_id, code, name, type)
          VALUES (${beta.tenantId}, '9999', 'Smuggled account', 'ASSET')
      `),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses to reassign an existing row to another tenant', async () => {
    // Code '7777' exists only in alpha, so the unique (tenant_id, code) index
    // cannot fire first and mask the RLS rejection we are actually testing.
    await withTenant(sql, { tenantId: alpha.tenantId }, (tx) => tx`
        INSERT INTO account (tenant_id, code, name, type)
        VALUES (${alpha.tenantId}, '7777', 'Movable account', 'ASSET')
    `);

    await expect(
      withTenant(sql, { tenantId: alpha.tenantId }, (tx) => tx`
          UPDATE account SET tenant_id = ${beta.tenantId}
           WHERE tenant_id = ${alpha.tenantId} AND code = '7777'
      `),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a foreign key cannot span tenants', async () => {
    // alpha's journal entry referencing beta's account.
    await expect(
      withTenant(sql, { tenantId: alpha.tenantId }, async (tx) => {
        const [e] = await tx<{ id: string }[]>`
            INSERT INTO journal_entry (tenant_id, entry_no, entry_date, fiscal_period_id,
                                       source_module, status)
            VALUES (${alpha.tenantId}, ${'JE-FK' + randomUUID().slice(0, 6)}, '2026-08-05',
                    ${alpha.periodId}, 'MANUAL', 'DRAFT')
            RETURNING id
        `;
        await tx`
            INSERT INTO journal_line (tenant_id, journal_entry_id, line_no, account_id,
                                      debit, credit, currency, base_debit, base_credit)
            VALUES (${alpha.tenantId}, ${e!.id}, 1, ${beta.accounts['1000']!},
                    100, 0, 'MYR', 100, 0)
        `;
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describe('audit_log is append-only', () => {
  // Two independent guards: the UPDATE/DELETE grants are revoked from the
  // application role, AND a trigger raises. The grant fires first for the app
  // role, so either message is a pass — what matters is that the write is
  // refused. The trigger is what protects against a role that *does* hold the
  // grant, which is why both exist.
  const REFUSED = /append-only|permission denied/i;

  it('rejects UPDATE', async () => {
    await expect(
      withTenant(sql, { tenantId: alpha.tenantId }, (tx) => tx`
          UPDATE audit_log SET action = 'TAMPERED' WHERE tenant_id = ${alpha.tenantId}
      `),
    ).rejects.toThrow(REFUSED);
  });

  it('rejects DELETE', async () => {
    await expect(
      withTenant(sql, { tenantId: alpha.tenantId }, (tx) => tx`
          DELETE FROM audit_log WHERE tenant_id = ${alpha.tenantId}
      `),
    ).rejects.toThrow(REFUSED);
  });

  it('rejects UPDATE even for a role that holds the grant (trigger layer)', async () => {
    await expect(
      admin.unsafe(`UPDATE audit_log SET action = 'TAMPERED'`),
    ).rejects.toThrow(/append-only/i);
  });

  it('has an unbroken hash chain', async () => {
    const broken = await withTenant(sql, { tenantId: alpha.tenantId }, (tx) =>
      tx`SELECT * FROM verify_audit_chain(${alpha.tenantId}::uuid)`,
    );
    expect(broken).toHaveLength(0);
  });
});
