import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { auditTrail, entityHistory, verifyAuditChain } from '../src/audit.js';
import { issueInvoice } from '../src/invoice.js';
import { createBankAccount } from '../src/bank.js';
import { createContact } from '../src/contact.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };

beforeAll(async () => {
  const db = await createTestDatabase('audit');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Audited Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };
}, 60_000);

afterAll(async () => {
  await drop?.();
});

/**
 * Edit the audit log the only way it can be edited: as the table owner, with
 * the append-only trigger switched off.
 *
 * That is not a loophole this test invents — it is the realistic threat model.
 * The application role has UPDATE and DELETE revoked and the trigger refuses
 * both, so reaching these rows at all means someone had owner rights and used
 * them deliberately. The question this file answers is whether doing so leaves
 * a mark.
 *
 * `finally` matters: a test that turns off a protective trigger and fails
 * mid-way must not leave the table unprotected for everything after it.
 */
async function tamper(fn: () => Promise<unknown>): Promise<void> {
  await admin`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_append_only`;
  try {
    await fn();
  } finally {
    await admin`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_append_only`;
  }
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Tables that deliberately carry NO audit trigger.
 *
 * The same discipline as `NON_TENANT_TABLES` in rls.test.ts: a table is
 * PRESUMED audited, and exempting one is a reviewed decision recorded here
 * rather than something a developer can do by forgetting. Every entry needs a
 * reason, and the sweep below fails in both directions — an unlisted table with
 * no trigger, and a listed table that has one.
 */
const AUDIT_EXEMPT: Record<string, string> = {
  audit_log: 'auditing the audit log recurses without end',
  financial_event_log: 'already append-only evidence, and already the high-signal log',
  outbox_event: 'delivery-mechanism state; the business fact was audited at its source',
  account_period_balance: 'a derived cache of journal_line, which is itself audited',
  number_sequence: 'an allocation counter; the number it issued is on the audited document',
};

describe('audit coverage', () => {
  it('every tenant-owned table has an audit trigger', async () => {
    // The CI guard. A table added in a future migration with no decision
    // recorded fails the build rather than silently going unaudited — which is
    // the failure mode that produced this milestone in the first place.
    const rows = await admin<
      { tablename: string; has_tenant_id: boolean; triggers: number }[]
    >`
        SELECT c.relname AS tablename,
               EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                          AND NOT a.attisdropped) AS has_tenant_id,
               (SELECT COUNT(*)::int FROM pg_trigger t
                  JOIN pg_proc p ON p.oid = t.tgfoid
                 WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                   AND p.proname = 'audit_row_change')                AS triggers
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
    `;

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      if (row.tablename in AUDIT_EXEMPT) {
        expect(row.triggers, `${row.tablename} is exempt but has an audit trigger`).toBe(0);
        continue;
      }

      // A table with no tenant_id has no tenant to attribute a row to, and
      // audit_log.tenant_id is NOT NULL. `organisation` is the exception: it IS
      // the tenant, so it is audited on its own id.
      if (!row.has_tenant_id && row.tablename !== 'organisation') continue;

      expect(row.triggers, `${row.tablename} has no audit trigger`).toBe(1);
    }
  });

  it('the trigger covers INSERT, UPDATE and DELETE, not just one of them', async () => {
    // A trigger installed as INSERT-only would pass a name-based check while
    // auditing a third of what it claims to.
    const [row] = await admin<{ insert: boolean; update: boolean; delete: boolean }[]>`
        SELECT (t.tgtype & 4)  <> 0 AS insert,
               (t.tgtype & 16) <> 0 AS update,
               (t.tgtype & 8)  <> 0 AS delete
          FROM pg_trigger t
         WHERE t.tgrelid = 'invoice'::regclass AND NOT t.tgisinternal
           AND t.tgname = 'trg_audit_invoice'
    `;

    expect(row).toMatchObject({ insert: true, update: true, delete: true });
  });
});

// ---------------------------------------------------------------------------
// What a row actually records
// ---------------------------------------------------------------------------

describe('what the trigger records', () => {
  it('captures the actor, the origin and the request that caused a change', async () => {
    // The four columns that were NULL on every audit row in the system before
    // this milestone, because TenantContext had nowhere to carry them.
    const requestId = `req-${randomUUID()}`;

    const contact = await withTenant(
      sql,
      { ...ctx, requestId, actorIp: '203.0.113.7', userAgent: 'Mozilla/5.0 (audit test)' },
      (tx) => createContact(tx, ctx, { name: 'Traceable Sdn Bhd', isCustomer: true }),
    );

    const [row] = await admin<
      {
        actor_user_id: string;
        actor_ip: string;
        user_agent: string;
        request_id: string;
        action: string;
      }[]
    >`
        SELECT actor_user_id::text, host(actor_ip) AS actor_ip, user_agent, request_id, action
          FROM audit_log
         WHERE tenant_id = ${ctx.tenantId} AND entity_type = 'contact'
           AND entity_id = ${contact.id}
    `;

    expect(row).toMatchObject({
      actor_user_id: ctx.userId,
      actor_ip: '203.0.113.7',
      user_agent: 'Mozilla/5.0 (audit test)',
      request_id: requestId,
      action: 'CREATE',
    });
  });

  it('records the before image on an update, which no hand-written row did', async () => {
    const contact = await withTenant(sql, ctx, (tx) =>
      createContact(tx, ctx, { name: 'Before And After Sdn Bhd', isCustomer: true }),
    );

    await withTenant(sql, ctx, (tx) =>
      tx`UPDATE contact SET name = 'Renamed Sdn Bhd'
          WHERE tenant_id = ${ctx.tenantId} AND id = ${contact.id}`,
    );

    const entries = await withTenant(sql, ctx, (tx) =>
      entityHistory(tx, ctx, 'contact', contact.id),
    );

    expect(entries.map((e) => e.action)).toEqual(['CREATE', 'UPDATE']);
    expect((entries[1]!.before as { name: string }).name).toBe('Before And After Sdn Bhd');
    expect((entries[1]!.after as { name: string }).name).toBe('Renamed Sdn Bhd');
    // Computed on read from the two images, so it cannot disagree with them.
    expect(entries[1]!.changed).toContain('name');
  });

  it('does not log an update that changed nothing', async () => {
    // Several services write idempotent UPDATEs on a replay path. Logging those
    // buries the real changes among them.
    const contact = await withTenant(sql, ctx, (tx) =>
      createContact(tx, ctx, { name: 'Idempotent Sdn Bhd', isCustomer: true }),
    );

    await withTenant(sql, ctx, (tx) =>
      tx`UPDATE contact SET name = 'Idempotent Sdn Bhd'
          WHERE tenant_id = ${ctx.tenantId} AND id = ${contact.id}`,
    );

    const entries = await withTenant(sql, ctx, (tx) =>
      entityHistory(tx, ctx, 'contact', contact.id),
    );
    expect(entries).toHaveLength(1);
  });

  it('redacts credential digests rather than copying them into a broader audience', async () => {
    // audit_log is readable by EXTERNAL_AUDITOR. It must not become the place
    // where token and key digests accumulate.
    await withTenant(sql, ctx, (tx) =>
      tx`INSERT INTO api_key (tenant_id, name, key_hash, prefix)
         VALUES (${ctx.tenantId}, 'ci', 'super-secret-digest', 'emk_ab')`,
    );

    const [row] = await admin<{ leaks: boolean; body: string }[]>`
        SELECT (after_json ? 'key_hash') AS leaks, after_json::text AS body
          FROM audit_log
         WHERE tenant_id = ${ctx.tenantId} AND entity_type = 'api_key'
         ORDER BY id DESC LIMIT 1
    `;

    expect(row!.leaks).toBe(false);
    expect(row!.body).not.toContain('super-secret-digest');
    // The fact worth recording survives.
    expect(row!.body).toContain('emk_ab');
  });

  it('does not write a row every time an API key is merely used', async () => {
    // `touch_api_key` stamps last_used_at on EVERY api-key-authenticated
    // request. Auditing that would bury key issuance and revocation — the two
    // facts anyone wants from this table — under per-request noise.
    const [key] = await admin<{ id: string }[]>`
        SELECT id FROM api_key WHERE tenant_id = ${ctx.tenantId} LIMIT 1
    `;

    const before = await admin<{ count: string }[]>`
        SELECT count(*)::text FROM audit_log
         WHERE tenant_id = ${ctx.tenantId} AND entity_type = 'api_key'
    `;

    await admin`SELECT touch_api_key(${key!.id}::uuid)`;

    const after = await admin<{ count: string }[]>`
        SELECT count(*)::text FROM audit_log
         WHERE tenant_id = ${ctx.tenantId} AND entity_type = 'api_key'
    `;

    expect(after[0]!.count).toBe(before[0]!.count);
  });

  it('audits the organisation itself, which has no tenant_id column', async () => {
    await withTenant(sql, ctx, (tx) =>
      tx`UPDATE organisation SET name = 'Renamed Audited Sdn Bhd' WHERE id = ${ctx.tenantId}`,
    );

    const entries = await withTenant(sql, ctx, (tx) =>
      auditTrail(tx, ctx, { entityType: 'organisation', action: 'UPDATE' }),
    );

    expect(entries).toHaveLength(1);
    // The base currency, the SST number and the year end all live here, and all
    // of them silently change what every later document means.
    expect(entries[0]!.changed).toContain('name');
  });
});

// ---------------------------------------------------------------------------
// Tamper detection — the point of the whole thing
// ---------------------------------------------------------------------------

describe('tamper detection', () => {
  it('reports an untouched chain as intact', async () => {
    const result = await withTenant(sql, ctx, (tx) => verifyAuditChain(tx, ctx));

    expect(result.intact).toBe(true);
    // And it says how many rows it checked, so an empty result can never be
    // mistaken for a clean one.
    expect(result.entries).toBeGreaterThan(0);
  });

  it('DETECTS A ROW EDITED IN PLACE — which the original verifier did not', async () => {
    // The headline. The 0001 verifier compared each row's prev_hash to the
    // previous row's STORED row_hash and never recomputed anything, so
    // rewriting what a row said happened left every link in the chain intact.
    const contact = await withTenant(sql, ctx, (tx) =>
      createContact(tx, ctx, { name: 'Original Sdn Bhd', isCustomer: true }),
    );

    const [target] = await admin<{ id: string }[]>`
        SELECT id::text FROM audit_log
         WHERE tenant_id = ${ctx.tenantId} AND entity_id = ${contact.id}
    `;

    await tamper(async () => {
      await admin`
          UPDATE audit_log
             SET after_json = jsonb_set(after_json, '{name}', '"Something Else Bhd"')
           WHERE id = ${target!.id} AND tenant_id = ${ctx.tenantId}
      `;
    });

    const result = await withTenant(sql, ctx, (tx) => verifyAuditChain(tx, ctx));

    expect(result.intact).toBe(false);
    expect(result.breaks).toContainEqual({ brokenAt: target!.id, reason: 'CONTENT_ALTERED' });

    // Prove the claim rather than assert it: the ORIGINAL linkage-only check
    // still finds nothing wrong with this chain.
    const linkageOnly = await admin<{ id: string }[]>`
        WITH chained AS (
            SELECT id, prev_hash, LAG(row_hash) OVER (ORDER BY id) AS expected_prev
              FROM audit_log WHERE tenant_id = ${ctx.tenantId}
        )
        SELECT id::text FROM chained WHERE prev_hash IS DISTINCT FROM expected_prev
    `;
    expect(linkageOnly).toEqual([]);
  });

  it('detects the ACTOR IP being rewritten', async () => {
    // The case that survives even after adding recomputation, unless the hash
    // covers the attribution columns — and the 0001 formula did not include
    // actor_ip, user_agent or request_id at all. Rewriting "which machine did
    // this" was free.
    const contact = await withTenant(
      sql,
      { ...ctx, actorIp: '203.0.113.9' },
      (tx) => createContact(tx, ctx, { name: 'Origin Sdn Bhd', isCustomer: true }),
    );

    const [target] = await admin<{ id: string }[]>`
        SELECT id::text FROM audit_log
         WHERE tenant_id = ${ctx.tenantId} AND entity_id = ${contact.id}
    `;

    await tamper(async () => {
      await admin`
          UPDATE audit_log SET actor_ip = '10.0.0.1'
           WHERE id = ${target!.id} AND tenant_id = ${ctx.tenantId}
      `;
    });

    const result = await withTenant(sql, ctx, (tx) => verifyAuditChain(tx, ctx));
    expect(result.breaks).toContainEqual({ brokenAt: target!.id, reason: 'CONTENT_ALTERED' });
  });

  it('detects a row removed from the middle of the chain', async () => {
    const contact = await withTenant(sql, ctx, (tx) =>
      createContact(tx, ctx, { name: 'Deleted Trail Sdn Bhd', isCustomer: true }),
    );
    // Something after it, so the deletion is genuinely mid-chain.
    await withTenant(sql, ctx, (tx) =>
      createContact(tx, ctx, { name: 'Follows It Sdn Bhd', isCustomer: true }),
    );

    const [target] = await admin<{ id: string }[]>`
        SELECT id::text FROM audit_log
         WHERE tenant_id = ${ctx.tenantId} AND entity_id = ${contact.id}
    `;

    await tamper(async () => {
      await admin`DELETE FROM audit_log WHERE id = ${target!.id} AND tenant_id = ${ctx.tenantId}`;
    });

    const result = await withTenant(sql, ctx, (tx) => verifyAuditChain(tx, ctx));
    expect(result.intact).toBe(false);
    expect(result.breaks.some((b) => b.reason === 'CHAIN_BROKEN')).toBe(true);
  });

  it('refuses to verify another tenant’s chain rather than reporting it clean', async () => {
    // The subtler defect. The 0001 verifier ran under RLS, so asking about a
    // tenant you cannot see returned zero rows — indistinguishable from "no
    // breaks found". A verifier whose failure mode is a silent pass is not a
    // verifier.
    const other = await seedTenant(admin, 'Somebody Else Sdn Bhd');

    await expect(
      withTenant(sql, ctx, (tx) => tx`SELECT * FROM verify_audit_chain(${other.tenantId})`),
    ).rejects.toThrow(/another tenant/);
  });

  it('leaves the append-only guards in force after all that', async () => {
    // A file that disables a protective trigger has to prove it put it back.
    await expect(
      admin`UPDATE audit_log SET action = 'X' WHERE tenant_id = ${ctx.tenantId}`,
    ).rejects.toThrow(/append-only/);

    await expect(
      admin`DELETE FROM audit_log WHERE tenant_id = ${ctx.tenantId}`,
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// What it costs
// ---------------------------------------------------------------------------

describe('the price of auditing every row', () => {
  it('writes one audit row per row changed, and takes the chain lock ONCE', async () => {
    /*
     * Both halves matter, and the second is a correctness assertion wearing a
     * performance costume.
     *
     * One row per row is the cost of the claim in README rule 4: a 500-line
     * statement import writes 500 audit rows, and the audit log will be the
     * largest table in the database within months. That is the expected outcome
     * of "every mutation", not a defect — but it should be a budgeted number
     * rather than a discovered one.
     *
     * The lock count is the part that could quietly be wrong. Advisory locks are
     * re-entrant within a transaction, so a hundred audited rows should acquire
     * the chain lock ONCE and hold it to commit. If this ever reads as N, the
     * trigger is re-taking the lock per row and the import is paying for it
     * every time.
     */
    const rows = 60;
    const codes = Array.from({ length: rows }, (_, i) => `VOL-${i}`);

    const { locks, audited } = await withTenant(sql, ctx, async (tx) => {
      for (const code of codes) {
        await tx`INSERT INTO account (tenant_id, code, name, type)
                 VALUES (${ctx.tenantId}, ${code}, 'volume probe', 'ASSET')`;
      }

      const [lockRow] = await tx<{ count: string }[]>`
          SELECT count(*)::text FROM pg_locks
           WHERE locktype = 'advisory' AND pid = pg_backend_pid()
      `;
      const [auditRow] = await tx<{ count: string }[]>`
          SELECT count(*)::text FROM audit_log
           WHERE tenant_id = ${ctx.tenantId} AND entity_type = 'account'
             AND after_json ->> 'name' = 'volume probe'
      `;

      return { locks: Number(lockRow!.count), audited: Number(auditRow!.count) };
    });

    expect(audited).toBe(rows);
    // One advisory lock for the whole transaction, not one per row.
    expect(locks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The lock order
// ---------------------------------------------------------------------------

describe('the audit chain lock does not deadlock against document numbering', () => {
  it('runs the two conflicting transaction shapes concurrently without deadlocking', async () => {
    /*
     * A hash chain has to be written in order, so the chain trigger takes a
     * per-tenant advisory lock. That lock introduced a deadlock, and this test
     * exists because the fix for it is invisible in the code it protects.
     *
     *   Issuing an invoice:  allocate('INVOICE') takes lock A
     *                        → an audited INSERT takes the chain lock X
     *                        → postJournalEntry → allocate('JOURNAL') wants B
     *   Posting a journal:   allocate('JOURNAL') takes lock B
     *                        → an audited INSERT wants X
     *
     * T1 holds A and X and waits for B; T2 holds B and waits for X.
     *
     * Measured, not theorised: with `allocate_document_number` restored to its
     * pre-0016 body, this shape deadlocked on 8 of 8 rounds. The fix — the audit
     * chain lock is ALWAYS taken before any document-number lock, enforced
     * inside `allocate_document_number` itself — takes it to 0 of 8.
     */
    const rounds = 6;
    const outcomes: PromiseSettledResult<unknown>[] = [];

    for (let i = 0; i < rounds; i++) {
      // Shape 1: a number, then an audited write, then a second number.
      const invoiceLike = withTenant(sql, ctx, async (tx) => {
        await tx`SELECT allocate_document_number('INVOICE')`;
        await tx`INSERT INTO account (tenant_id, code, name, type)
                 VALUES (${ctx.tenantId}, ${`DL-A-${i}`}, 'lock probe', 'ASSET')`;
        await new Promise((resolve) => setTimeout(resolve, 20));
        await tx`SELECT allocate_document_number('JOURNAL')`;
      });

      // Shape 2: the second number FIRST, then an audited write.
      const journalLike = withTenant(sql, ctx, async (tx) => {
        await tx`SELECT allocate_document_number('JOURNAL')`;
        await new Promise((resolve) => setTimeout(resolve, 20));
        await tx`INSERT INTO account (tenant_id, code, name, type)
                 VALUES (${ctx.tenantId}, ${`DL-B-${i}`}, 'lock probe', 'ASSET')`;
      });

      outcomes.push(...(await Promise.allSettled([invoiceLike, journalLike])));
    }

    const deadlocked = outcomes.filter(
      (o) => o.status === 'rejected' && (o.reason as { code?: string })?.code === '40P01',
    );

    expect(deadlocked, 'the audit chain lock deadlocked against document numbering').toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Isolation and reading
// ---------------------------------------------------------------------------

describe('the audit trail as a reader sees it', () => {
  it('never shows one tenant another tenant’s history', async () => {
    const other = await seedTenant(admin, 'Isolated Sdn Bhd');
    const otherCtx = { tenantId: other.tenantId, userId: other.userId };

    await withTenant(sql, otherCtx, (tx) =>
      createContact(tx, otherCtx, { name: 'Their Customer Sdn Bhd', isCustomer: true }),
    );

    const mine = await withTenant(sql, ctx, (tx) =>
      auditTrail(tx, ctx, { entityType: 'contact', limit: 500 }),
    );

    expect(mine.length).toBeGreaterThan(0);
    expect(
      mine.every((e) => JSON.stringify(e.after).includes('Their Customer') === false),
    ).toBe(true);
  });

  it('groups everything one request did under a single request id', async () => {
    // The property that makes the trail readable. Issuing an invoice writes to
    // invoice, invoice_line, journal_entry, journal_line and tax_transaction;
    // one request id across all of them is what turns those rows back into a
    // single act somebody performed.
    const requestId = `req-${randomUUID()}`;
    const requestCtx = { ...ctx, requestId };

    await withTenant(sql, requestCtx, (tx) =>
      issueInvoice(tx, requestCtx, {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitPrice: '1000.00',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const rows = await admin<{ entity_type: string }[]>`
        SELECT DISTINCT entity_type FROM audit_log
         WHERE tenant_id = ${ctx.tenantId} AND request_id = ${requestId}
    `;

    const touched = rows.map((r) => r.entity_type).sort();
    expect(touched).toContain('invoice');
    expect(touched).toContain('invoice_line');
    expect(touched).toContain('journal_entry');
    expect(touched).toContain('journal_line');
  });

  it('records a bank account creation in BOTH logs, for different readers', async () => {
    // The two-log split. The audit trigger records the row change; the
    // financial event log records the ACT, because "where our money is paid
    // changed" is a question an auditor asks by name and would otherwise be
    // one insert among thousands.
    const [glAccount] = await admin<{ id: string }[]>`
        SELECT id FROM account WHERE tenant_id = ${ctx.tenantId} AND code = '1000'
    `;

    const bank = await withTenant(sql, ctx, (tx) =>
      createBankAccount(tx, ctx, {
        name: 'Audited Current',
        bankName: 'Malayan Banking Berhad',
        glAccountId: glAccount!.id,
        openingBalance: '0',
        openingDate: '2026-01-01',
      }),
    );

    const audited = await withTenant(sql, ctx, (tx) =>
      auditTrail(tx, ctx, { entityType: 'bank_account', entityId: bank.id }),
    );
    expect(audited).toHaveLength(1);

    const [event] = await admin<{ event_type: string; permission: string }[]>`
        SELECT event_type, permission FROM financial_event_log
         WHERE tenant_id = ${ctx.tenantId} AND entity_id = ${bank.id}
    `;
    expect(event).toMatchObject({
      event_type: 'BANK_DETAILS_CHANGED',
      permission: 'bank.import',
    });
  });
});
