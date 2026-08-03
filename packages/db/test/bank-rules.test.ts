import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImportProfile } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { createBankAccount, importStatement } from '../src/bank.js';
import {
  applyBankRules,
  createBankRule,
  listBankRules,
  ruleSuggestions,
  updateBankRule,
} from '../src/bank-rules.js';
import { unmatch } from '../src/reconciliation.js';
import { createTestDatabase, seedTenant } from './helpers.js';

/**
 * Bank rules against real statements: TNB codes itself to the expense
 * account, exactly once, however many times the rules run — and every firing
 * is an ordinary match a human can reverse.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDatabase('bank_rules');
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
  columns: { txnDate: 0, description: 1, amount: 2 },
};

async function bankTenant(name: string) {
  const tenant = await seedTenant(admin, name);
  const ctx = { tenantId: tenant.tenantId, userId: tenant.userId };
  const account = await withTenant(sql, ctx, (tx) =>
    createBankAccount(tx, ctx, {
      name: 'Maybank Current',
      bankName: 'Malayan Banking Berhad',
      glAccountId: tenant.accounts['1000']!,
    }),
  );
  return { tenant, ctx, bankAccountId: account.id };
}

async function importCsv(
  ctx: { tenantId: string; userId: string },
  bankAccountId: string,
  rows: string[],
) {
  return withTenant(sql, ctx, (tx) =>
    importStatement(tx, ctx, {
      bankAccountId,
      content: ['Date,Description,Amount', ...rows].join('\n'),
      profile: MAYBANK,
      statementDate: '2026-08-31',
      idempotencyKey: randomUUID(),
    }),
  );
}

describe('bank rules', () => {
  it('codes the TNB debit automatically, suggests SHOPEE, ignores the stranger', async () => {
    const { tenant, ctx, bankAccountId } = await bankTenant('Rules Sdn Bhd');

    // The owner writes two rules: the electricity bill posts itself; incoming
    // marketplace payouts only SUGGEST, because they may need splitting.
    await withTenant(sql, ctx, (tx) =>
      createBankRule(tx, ctx, {
        name: 'TNB electricity',
        contains: 'TNB',
        matchesDirection: 'OUTFLOW',
        accountId: tenant.accounts['5000']!,
        autoApply: true,
      }),
    );
    await withTenant(sql, ctx, (tx) =>
      createBankRule(tx, ctx, {
        name: 'Shopee payouts',
        contains: 'SHOPEE',
        matchesDirection: 'INFLOW',
        accountId: tenant.accounts['4000']!,
      }),
    );

    await importCsv(ctx, bankAccountId, [
      '05/08/2026,TNB BILL PAYMENT KUALA LUMPUR,-380.50',
      '12/08/2026,SHOPEE MY PAYOUT 8891,1250.00',
      '20/08/2026,CHEQUE 001234,-900.00',
    ]);

    const result = await withTenant(sql, ctx, (tx) => applyBankRules(tx, ctx));

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]!.ruleName).toBe('TNB electricity');
    expect(result.suggestedOnly).toBe(1);

    // Money OUT: credit the bank GL, debit the expense the rule names.
    const lines = await admin<{ account_id: string; base_debit: string; base_credit: string }[]>`
        SELECT account_id, base_debit::text, base_credit::text FROM journal_line
         WHERE tenant_id = ${ctx.tenantId}
           AND journal_entry_id = ${result.applied[0]!.journalEntryId}
         ORDER BY base_debit DESC
    `;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ account_id: tenant.accounts['5000'], base_debit: '380.5000' });
    expect(lines[1]).toMatchObject({ account_id: tenant.accounts['1000'], base_credit: '380.5000' });

    // The firing is an ordinary match, attributed to the rule by name.
    const [match] = await admin<{ match_method: string; reason: string }[]>`
        SELECT match_method, reason FROM reconciliation_match
         WHERE tenant_id = ${ctx.tenantId}
           AND bank_transaction_id = ${result.applied[0]!.bankTransactionId}
    `;
    expect(match!.match_method).toBe('RULE');
    expect(match!.reason).toContain('TNB electricity');

    // The cheque matched nothing: rules that do not apply stay silent.
    const hits = await withTenant(sql, ctx, (tx) => ruleSuggestions(tx, ctx));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ruleName).toBe('Shopee payouts');
    expect(hits[0]!.autoApply).toBe(false);

    expect((await withTenant(sql, ctx, (tx) => listBankRules(tx, ctx)))
      .find((r) => r.name === 'TNB electricity')!.hitCount).toBe(1);
  });

  it('never posts twice, even across unmatch and re-run', async () => {
    const { tenant, ctx, bankAccountId } = await bankTenant('Rules Idempotent Sdn Bhd');

    await withTenant(sql, ctx, (tx) =>
      createBankRule(tx, ctx, {
        name: 'Unifi internet',
        contains: 'UNIFI',
        accountId: tenant.accounts['5000']!,
        autoApply: true,
      }),
    );
    await importCsv(ctx, bankAccountId, ['03/08/2026,TM UNIFI BIZ 03-1234,-129.00']);

    const first = await withTenant(sql, ctx, (tx) => applyBankRules(tx, ctx));
    expect(first.applied).toHaveLength(1);

    // Second pass: the line is matched, so the rule does not even see it.
    const second = await withTenant(sql, ctx, (tx) => applyBankRules(tx, ctx));
    expect(second.applied).toHaveLength(0);

    // A human unmatches; the next pass re-matches — but the idempotency key
    // is the LINE, so the ledger entry is REPLAYED, never duplicated.
    const [matchRow] = await admin<{ id: string }[]>`
        SELECT id FROM reconciliation_match
         WHERE tenant_id = ${ctx.tenantId}
           AND bank_transaction_id = ${first.applied[0]!.bankTransactionId}
    `;
    await withTenant(sql, ctx, (tx) => unmatch(tx, ctx, matchRow!.id, 'checking something'));

    const third = await withTenant(sql, ctx, (tx) => applyBankRules(tx, ctx));
    expect(third.applied).toHaveLength(1);
    expect(third.applied[0]!.journalEntryId).toBe(first.applied[0]!.journalEntryId);

    const [entryCount] = await admin<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM journal_entry
         WHERE tenant_id = ${ctx.tenantId} AND source_document_type = 'BANK_TRANSACTION'
    `;
    expect(entryCount!.count).toBe(1);
  });

  it('a disabled rule stops firing; re-enabling brings it back', async () => {
    const { tenant, ctx, bankAccountId } = await bankTenant('Rules Toggle Sdn Bhd');

    const rule = await withTenant(sql, ctx, (tx) =>
      createBankRule(tx, ctx, {
        name: 'Grab rides',
        contains: 'GRAB',
        accountId: tenant.accounts['5000']!,
      }),
    );
    await importCsv(ctx, bankAccountId, ['07/08/2026,GRAB RIDES 5566,-45.00']);

    expect(await withTenant(sql, ctx, (tx) => ruleSuggestions(tx, ctx))).toHaveLength(1);

    await withTenant(sql, ctx, (tx) => updateBankRule(tx, ctx, rule.id, { isActive: false }));
    expect(await withTenant(sql, ctx, (tx) => ruleSuggestions(tx, ctx))).toHaveLength(0);

    await withTenant(sql, ctx, (tx) => updateBankRule(tx, ctx, rule.id, { isActive: true }));
    expect(await withTenant(sql, ctx, (tx) => ruleSuggestions(tx, ctx))).toHaveLength(1);
  });

  it('refuses a pattern short enough to match half the statement', async () => {
    const { tenant, ctx } = await bankTenant('Rules Broad Sdn Bhd');

    await expect(
      withTenant(sql, ctx, (tx) =>
        createBankRule(tx, ctx, {
          name: 'Too broad',
          contains: ' E ',
          accountId: tenant.accounts['5000']!,
        }),
      ),
    ).rejects.toThrow(/at least 3 characters/);
  });
});
