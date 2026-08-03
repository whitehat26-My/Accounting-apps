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

  /**
   * Tables that deliberately hold NO tenant data and therefore carry no RLS.
   *
   * This list is the whole point of the guard below. A new table is presumed
   * tenant-owned and must have RLS; exempting one is a deliberate, reviewed
   * act recorded here, not something a developer can do by forgetting.
   *
   * Every entry needs a reason.
   */
  const NON_TENANT_TABLES: Record<string, string> = {
    // Migration bookkeeping. No tenant data.
    schema_migration: 'migration runner state',
    // LHDN's published item classification list. Identical for every tenant,
    // refreshed from LHDN, contains nothing tenant-specific. Read-only to the
    // application role.
    einvoice_classification_code: 'global LHDN reference data, read-only',
    // Same shape, same reasoning: the MyInvois unit-of-measure code list is
    // identical for every tenant. Ships EMPTY pending LHDN's published
    // reference data, because a plausible-looking wrong code on a submission to
    // a tax authority is worse than an explicit gap.
    einvoice_uom_code: 'global LHDN reference data, read-only',
    // Statement layouts are the same for every tenant and contain no tenant
    // data. Read-only to the application role; tenant-specific overrides,
    // when they exist, will live in separate tenant-scoped tables.
    report_template: 'global statement layout, read-only',
    report_template_line: 'global statement layout, read-only',
    report_template_line_map: 'global statement layout, read-only',
    // Identity is GLOBAL, and deliberately so: one freelance accountant serves
    // N client organisations from one login. A tenant-scoped user table would
    // mean one account and one password per client, which breaks the model the
    // product is differentiated on.
    //
    // Authentication is also pre-tenant by nature — resolving a user by email
    // happens before any tenant is known — so no `tenant_id = current_tenant_id()`
    // policy could express it.
    //
    // The mitigation is stronger than a policy, not weaker: the application
    // role has NO GRANT on these tables at all. Every legitimate operation goes
    // through a narrow SECURITY DEFINER function. Asserted below.
    app_user: 'global identity; app role has no grant, access via SECURITY DEFINER only',
    user_session: 'global session; app role has no grant, access via SECURITY DEFINER only',
    // Scheduled jobs run ACROSS tenants — the rollup-drift canary asks "has
    // any tenant's cache diverged from its journal", and a per-tenant schedule
    // would make the answer depend on whether that tenant happened to have a
    // row. It holds job names, intervals and run outcomes; no tenant data. The
    // assertion below that an exempt table really has no tenant_id is what
    // stops it quietly becoming tenant data later.
    scheduled_job: 'global background schedule; job names and timings only',
    // The role→permission matrix is the same for every tenant.
    app_role: 'global role definitions, read-only',
    app_permission: 'global permission definitions, read-only',
    role_permission: 'global role/permission matrix, read-only',
  };

  it('every tenant-owned table has RLS enabled AND forced with a policy', async () => {
    // The CI guard from docs/architecture/06-data-model.md §6.2: a new table
    // without a policy must fail the build rather than silently leak.
    const rows = await sql<{ tablename: string; rowsecurity: boolean; forced: boolean; policies: number; has_tenant_id: boolean }[]>`
        SELECT c.relname                AS tablename,
               c.relrowsecurity         AS rowsecurity,
               c.relforcerowsecurity    AS forced,
               (SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies,
               EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                          AND NOT a.attisdropped)                                AS has_tenant_id
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
    `;

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      if (row.tablename in NON_TENANT_TABLES) {
        // An exempt table must genuinely hold no tenant data. If someone adds
        // a tenant_id to one, the exemption is no longer valid and this fails.
        expect(
          row.has_tenant_id,
          `${row.tablename} is exempt from RLS but has a tenant_id column`,
        ).toBe(false);
        continue;
      }

      expect(row.rowsecurity, `${row.tablename}: RLS not enabled`).toBe(true);
      expect(row.forced, `${row.tablename}: RLS not FORCED`).toBe(true);
      expect(row.policies, `${row.tablename}: no policy attached`).toBeGreaterThan(0);
    }
  });

  it('every tenant policy carries an explicit WITH CHECK, not USING alone', async () => {
    // The behavioural tests below prove a cross-tenant write is refused. This
    // proves it structurally, at the catalog: a policy with `polwithcheck` NULL
    // is USING-only. Postgres would silently reuse USING as the write check
    // today, so such a policy is not a leak now — but it couples the write rule
    // to the read rule, so the day USING is widened for reads the writes widen
    // with it. Requiring an explicit WITH CHECK keeps the two independent, and
    // catches a hand-written policy that forgot it.
    const policies = await sql<{ tablename: string; polname: string; has_check: boolean }[]>`
        SELECT c.relname                     AS tablename,
               p.polname                     AS polname,
               p.polwithcheck IS NOT NULL    AS has_check
          FROM pg_policy p
          JOIN pg_class c     ON c.oid = p.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                          AND NOT a.attisdropped)
    `;

    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      expect(
        p.has_check,
        `policy ${p.polname} on ${p.tablename} is USING-only — add an explicit WITH CHECK`,
      ).toBe(true);
    }
  });

  it('the exempt identity tables really do have no grant to the app role', async () => {
    // `app_user` and `user_session` are exempt from the RLS sweep because they
    // are global. That exemption is only defensible because the application
    // role cannot reach them AT ALL — so the claim is checked rather than
    // described. If someone adds a convenience GRANT, this fails.
    for (const table of ['app_user', 'user_session']) {
      const [row] = await sql<{ has_any: boolean }[]>`
          SELECT (
              has_table_privilege('emil_app', ${table}, 'SELECT') OR
              has_table_privilege('emil_app', ${table}, 'INSERT') OR
              has_table_privilege('emil_app', ${table}, 'UPDATE') OR
              has_table_privilege('emil_app', ${table}, 'DELETE')
          ) AS has_any
      `;
      expect(row!.has_any, `${table} must not be reachable by emil_app`).toBe(false);
    }
  });

  it('membership is the one policy that admits rows outside a tenant context', async () => {
    // The organisation switcher has to ask "which tenants may I act for", and
    // that question has no tenant context by definition. The policy widens
    // visibility by exactly the caller's own rows — never another user's — and
    // that boundary is asserted in identity.test.ts.
    const [row] = await sql<{ qual: string }[]>`
        SELECT pg_get_expr(p.polqual, p.polrelid) AS qual
          FROM pg_policy p
          JOIN pg_class c ON c.oid = p.polrelid
         WHERE c.relname = 'membership'
    `;
    expect(row!.qual).toMatch(/current_tenant_id/);
    expect(row!.qual).toMatch(/current_user_id/);
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

describe('views do not become a hole in the boundary', () => {
  /**
   * A PostgreSQL view executes with the privileges of its OWNER by default.
   * Here that owner is the schema owner — a role the tenant policies do not
   * constrain — so a view created without `security_invoker` returns EVERY
   * tenant's rows to any caller.
   *
   * The table sweep above cannot catch this: it walks `relkind = 'r'`. So
   * every view gets checked here, by property rather than by name, and a new
   * one added without the setting fails this test rather than leaking quietly.
   */
  it('every view in the schema runs as the invoker', async () => {
    const views = await sql<{ viewname: string; options: string[] | null }[]>`
        SELECT c.relname AS viewname, c.reloptions AS options
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'v'
    `;

    expect(views.length).toBeGreaterThan(0);

    for (const view of views) {
      expect(
        view.options ?? [],
        `view ${view.viewname} must be created WITH (security_invoker = true), ` +
          'or it bypasses row-level security entirely',
      ).toContain('security_invoker=true');
    }
  });

  it('active_reconciliation_match shows only the caller’s tenant', async () => {
    // The property test above proves the setting is present. This proves the
    // setting does what it claims, through the actual view, with real rows on
    // both sides of the boundary.
    const seed = async (t: Tenant) => {
      const ctx = { tenantId: t.tenantId, userId: t.userId };
      return withTenant(admin, ctx, async (tx) => {
        const [glAccount] = await tx<{ id: string }[]>`
            SELECT id FROM account WHERE tenant_id = ${t.tenantId} AND code = '1000'
        `;
        const [bankAccount] = await tx<{ id: string }[]>`
            INSERT INTO bank_account (tenant_id, name, bank_name, gl_account_id)
            VALUES (${t.tenantId}, 'Current', 'Maybank', ${glAccount!.id})
            RETURNING id
        `;
        const [line] = await tx<{ id: string }[]>`
            INSERT INTO bank_transaction (
                tenant_id, bank_account_id, txn_date, description, amount, dedupe_hash
            ) VALUES (
                ${t.tenantId}, ${bankAccount!.id}, '2026-08-05', 'PAYMENT', 100, ${randomUUID()}
            )
            RETURNING id
        `;
        await tx`
            INSERT INTO reconciliation_match (
                tenant_id, bank_transaction_id, matched_type, matched_id, amount
            ) VALUES (
                ${t.tenantId}, ${line!.id}, 'JOURNAL', ${randomUUID()}, 100
            )
        `;
        return line!.id;
      });
    };

    await seed(alpha);
    await seed(beta);

    const visible = await withTenant(sql, { tenantId: alpha.tenantId }, (tx) =>
      tx<{ tenant_id: string }[]>`SELECT tenant_id FROM active_reconciliation_match`,
    );

    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((r) => r.tenant_id === alpha.tenantId)).toBe(true);
  });
});
