import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { listAnchors, proofPack, takeAnchor, verifyProofPack } from '../src/proof.js';
import { createItem } from '../src/item.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * Provable books.
 *
 * The test that matters is the LAST one: re-chain the audit log the way an
 * attacker with database owner rights would — the single attack the hash
 * chain alone cannot survive, as `audit.ts` has said since 0016 — and watch a
 * pack issued beforehand refuse to agree with it. That is the whole point of
 * anchoring, and it is only a proof if something outside the database holds a
 * copy, which is what the pack is.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

beforeAll(async () => {
  const db = await createTestDatabase('proof');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin, 'Provable Sdn Bhd');
}, 60_000);

afterAll(async () => {
  await drop?.();
});

/** Anything auditable, to put rows in the log between anchors. */
const doSomething = async (code: string) =>
  withTenant(sql, ctx(), (tx) =>
    createItem(tx, ctx(), {
      code,
      name: `Item ${code}`,
      itemType: 'SERVICE',
      isSold: true,
      sale: {
        unitPrice: '10.00',
        accountId: tenant.accounts['4000']!,
        taxCodeId: tenant.taxCodes['NONE']!,
      },
    }),
  );

describe('anchoring', () => {
  it('chains each anchor into the one before it', async () => {
    await doSomething('AAA');
    const first = await withTenant(sql, ctx(), (tx) => takeAnchor(tx, ctx(), 'MANUAL'));
    await doSomething('BBB');
    const second = await withTenant(sql, ctx(), (tx) => takeAnchor(tx, ctx(), 'MANUAL'));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.entryCount).toBeGreaterThan(first.entryCount);

    const anchors = await withTenant(sql, ctx(), (tx) => listAnchors(tx, ctx()));
    expect(anchors[0]!.prevAnchorHash).toBeNull();
    expect(anchors[1]!.prevAnchorHash).toBe(anchors[0]!.anchorHash);
  });

  it('refuses to be edited or deleted, even by the owner role', async () => {
    await expect(
      admin`UPDATE audit_anchor SET entry_count = 0 WHERE tenant_id = ${tenant.tenantId}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      admin`DELETE FROM audit_anchor WHERE tenant_id = ${tenant.tenantId}`,
    ).rejects.toThrow(/append-only/);
  });
});

describe('the proof pack', () => {
  it('carries the trial balance, the anchors, and a hash over both', async () => {
    const pack = await withTenant(sql, ctx(), (tx) =>
      proofPack(tx, ctx(), { from: null, to: '2026-12-31' }),
    );

    expect(pack.format).toBe('emil-proof-pack/1');
    expect(pack.organisation.id).toBe(tenant.tenantId);
    expect(pack.chain.anchors.length).toBeGreaterThanOrEqual(2);
    expect(pack.chain.intact).toBe(true);
    expect(pack.packHash).toMatch(/^[0-9a-f]{64}$/);
    // The algorithm travels WITH the pack — a third party should not need
    // this repository to check it.
    expect(pack.algorithm).toContain('SHA-256');
  });

  it('CONFIRMS a pack that has not been touched', async () => {
    const pack = await withTenant(sql, ctx(), (tx) =>
      proofPack(tx, ctx(), { from: null, to: '2026-12-31' }),
    );
    const verdict = await withTenant(sql, ctx(), (tx) => verifyProofPack(tx, ctx(), pack));

    expect(verdict.verdict).toBe('CONFIRMED');
    expect(verdict.packHash.matches).toBe(true);
    expect(verdict.divergedAt).toBeNull();
  });

  it('says PACK_ALTERED when the pack itself was edited after issue', async () => {
    const pack = await withTenant(sql, ctx(), (tx) =>
      proofPack(tx, ctx(), { from: null, to: '2026-12-31' }),
    );
    // Somebody improves their trial balance in the file they emailed the bank.
    const doctored = {
      ...pack,
      trialBalance: { ...pack.trialBalance, totalDebit: '999999.0000' },
    };

    const verdict = await withTenant(sql, ctx(), (tx) => verifyProofPack(tx, ctx(), doctored));
    expect(verdict.verdict).toBe('PACK_ALTERED');
    expect(verdict.packHash.matches).toBe(false);
  });

  it('still CONFIRMS after ordinary trading — new anchors do not disturb old ones', async () => {
    const march = await withTenant(sql, ctx(), (tx) =>
      proofPack(tx, ctx(), { from: null, to: '2026-12-31' }),
    );

    await doSomething('CCC');
    await withTenant(sql, ctx(), (tx) => takeAnchor(tx, ctx(), 'SCHEDULED'));

    const verdict = await withTenant(sql, ctx(), (tx) => verifyProofPack(tx, ctx(), march));
    expect(verdict.verdict).toBe('CONFIRMED');
    expect(verdict.anchorsChecked).toBe(march.chain.anchors.length);
  });

  it('catches the re-chaining attack the hash chain alone cannot survive', async () => {
    /*
     * The pack the accountant was given in March.
     */
    const issued = await withTenant(sql, ctx(), (tx) =>
      proofPack(tx, ctx(), { from: null, to: '2026-12-31' }),
    );
    expect(issued.chain.intact).toBe(true);

    /*
     * Now the attack, performed exactly as a real attacker with OWNER rights
     * would: DISABLE the append-only trigger, edit the row, recompute every
     * hash forward so the chain verifies again, put the trigger back. This is
     * the scenario `audit.ts` has documented as undetectable since 0016 —
     * reproduced here in full rather than approximated, because a defence
     * tested against a weaker attack is not tested.
     */
    await admin.unsafe(`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_append_only`);
    await admin.unsafe(`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_chain`);
    try {
      await admin.unsafe(`
        DO $$
        DECLARE r RECORD; v_prev BYTEA := NULL; v_first BIGINT;
        BEGIN
            SELECT MIN(id) INTO v_first FROM audit_log
             WHERE tenant_id = '${tenant.tenantId}';

            UPDATE audit_log
               SET after_json = jsonb_set(COALESCE(after_json, '{}'::jsonb),
                                          '{name}', '"Rewritten history"')
             WHERE tenant_id = '${tenant.tenantId}' AND id = v_first;

            FOR r IN SELECT * FROM audit_log
                      WHERE tenant_id = '${tenant.tenantId}' ORDER BY id LOOP
                UPDATE audit_log SET
                    prev_hash = v_prev,
                    row_hash  = audit_row_hash(
                        v_prev, r.tenant_id, r.actor_user_id, r.actor_ip,
                        r.user_agent, r.request_id, r.action, r.entity_type,
                        r.entity_id, r.before_json, r.after_json, r.occurred_at)
                 WHERE tenant_id = r.tenant_id AND id = r.id
             RETURNING row_hash INTO v_prev;
            END LOOP;
        END $$;
      `);
    } finally {
      await admin.unsafe(`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_append_only`);
      await admin.unsafe(`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_chain`);
    }

    // The system's own check is fooled — as documented.
    const selfCheck = await withTenant(sql, ctx(), (tx) =>
      proofPack(tx, ctx(), { from: null, to: '2026-12-31' }),
    );
    expect(selfCheck.chain.intact).toBe(true);

    // The March pack is not. It pinned hashes that no longer exist, and the
    // verification names the anchor where the histories part company.
    const verdict = await withTenant(sql, ctx(), (tx) => verifyProofPack(tx, ctx(), issued));
    expect(verdict.verdict).toBe('TAMPERED');
    expect(verdict.divergedAt).not.toBeNull();
    expect(verdict.divergedAt!.seq).toBe(1);
    expect(verdict.divergedAt!.reason).toContain('rewritten');
  });
});
