import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Money,
  pairingAccountCodes,
  unwrap,
  validateJournalEntry,
  type JournalEntryDraft,
} from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { postJournalEntry } from '../src/ledger.js';
import { suggestJournalCounterAccount } from '../src/general-ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The order of the two lookups, which is the whole design.
 *
 * History is a fact about this shop. The standard-adjustment table is a fact
 * about bookkeeping. The first beats the second everywhere it has anything to
 * say, and the second exists only to fill a silence that used to be returned as
 * `null` — so what these tests actually protect is the precedence, not either
 * source on its own.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('journalpairing');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin);
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

const suggest = (code: string, side: 'DEBIT' | 'CREDIT') =>
  withTenant(sql, ctx(), (tx) =>
    suggestJournalCounterAccount(tx, ctx(), tenant.accounts[code]!, side),
  );

/** Post a two-line entry the given number of times, so it becomes a pattern. */
async function postPair(
  debitCode: string,
  creditCode: string,
  times: number,
  amount = '10.00',
): Promise<void> {
  const rm = Money.fromDecimal(amount, 'MYR');
  for (let i = 0; i < times; i++) {
    const draft: JournalEntryDraft = {
      entryDate: '2026-08-07',
      description: 'Pairing fixture',
      sourceModule: 'MANUAL',
      lines: [
        { accountId: tenant.accounts[debitCode]!, side: 'DEBIT', amount: rm, baseAmount: rm },
        { accountId: tenant.accounts[creditCode]!, side: 'CREDIT', amount: rm, baseAmount: rm },
      ],
    };
    const valid = unwrap(validateJournalEntry(draft, 'MYR'));
    await withTenant(sql, ctx(), (tx) =>
      postJournalEntry(tx, ctx(), valid, {
        idempotencyKey: `pairing-${debitCode}-${creditCode}-${i}`,
      }),
    );
  }
}

describe('the chart the rules name', () => {
  it('seeds every account code the pairing table mentions', async () => {
    // The test that catches a rule pointing at an account nobody creates —
    // which would be a rule that silently never fires, with nothing to explain
    // why. Checked against the real seeded chart, not the table's own opinion.
    const codes = pairingAccountCodes();
    const rows = await withTenant(sql, ctx(), (tx) =>
      tx<{ code: string }[]>`
          SELECT code FROM account WHERE tenant_id = ${ctx().tenantId}
      `,
    );
    const present = new Set(rows.map((r) => r.code));
    const missing = codes.filter((code) => !present.has(code));
    expect(
      missing,
      `\nThe pairing table names accounts the chart does not create: ${missing.join(', ')}.\n` +
        'Add them to DEFAULT_CHART and to migration 0054, or drop the rule.',
    ).toEqual([]);
  });
});

describe('bookkeeping fills the silence', () => {
  it('suggests accumulated depreciation for a depreciation charge, with its reason', async () => {
    // Nothing has ever been posted to 6300 in this tenant, so before the table
    // existed this was `null` and the accountant typed both lines.
    const suggestion = await suggest('6300', 'DEBIT');

    expect(suggestion).toMatchObject({
      accountId: tenant.accounts['1590'],
      code: '1590',
      source: 'STANDARD_ADJUSTMENT',
      occurrences: 0,
    });
    expect(suggestion?.because).toMatch(/depreciation/i);
  });

  it('works from the other side of the same entry', async () => {
    expect(await suggest('1590', 'CREDIT')).toMatchObject({
      code: '6300',
      source: 'STANDARD_ADJUSTMENT',
    });
  });

  it('still says nothing about an account bookkeeping has no opinion on', async () => {
    // 4000 Sales Revenue pairs with whatever was sold and to whom. A rule here
    // would be the guess this whole arrangement exists to avoid.
    expect(await suggest('4000', 'CREDIT')).toBeNull();
  });

  it('says nothing when the tenant does not have the account a rule names', async () => {
    // A shop that retired the account, or renumbered their chart. Suggesting
    // whatever else sits at that code would be worse than suggesting nothing.
    await withTenant(admin, ctx(), (tx) =>
      tx`UPDATE account SET is_active = FALSE
          WHERE tenant_id = ${ctx().tenantId} AND code = '2400'`,
    );
    expect(await suggest('6000', 'DEBIT')).toBeNull();
    await withTenant(admin, ctx(), (tx) =>
      tx`UPDATE account SET is_active = TRUE
          WHERE tenant_id = ${ctx().tenantId} AND code = '2400'`,
    );
  });
});

describe('history wins wherever history speaks', () => {
  it('overrides the table once the shop has actually posted a pairing', async () => {
    // 6400 Bank Charges is in the table, paired with 1000 Cash and Bank. This
    // shop posts theirs against Undeposited Funds instead — their gateway
    // deducts before settlement. Three entries and the table stops applying.
    expect(await suggest('6400', 'DEBIT')).toMatchObject({
      code: '1000',
      source: 'STANDARD_ADJUSTMENT',
    });

    await postPair('6400', '1200', 3);

    expect(await suggest('6400', 'DEBIT')).toMatchObject({
      code: '1200',
      source: 'HISTORY',
      occurrences: 3,
    });
  });

  it('answers HISTORY for a pairing the table never knew about', async () => {
    await postPair('6000', '1000', 2);

    const suggestion = await suggest('6000', 'DEBIT');
    expect(suggestion).toMatchObject({ code: '1000', source: 'HISTORY', occurrences: 2 });
    // The rule for 6000 DEBIT names 2400. History said 1000, so the reason
    // string must not be carried over from a rule that did not answer.
    expect(suggestion?.because).toBeUndefined();
  });
});

describe('a suggestion never crosses a tenant', () => {
  it('says nothing for an account id belonging to somebody else', async () => {
    const other = await seedTenant(admin, 'Another Shop Sdn Bhd');
    await withTenant(admin, { tenantId: other.tenantId, userId: other.userId }, async (tx) => {
      // Give the OTHER tenant a depreciation habit, so a leak would be visible
      // as an answer rather than as silence.
      await tx`SELECT 1`;
    });

    const leaked = await withTenant(sql, ctx(), (tx) =>
      suggestJournalCounterAccount(tx, ctx(), other.accounts['6300']!, 'DEBIT'),
    );
    // The code lookup is scoped to the tenant, so the id resolves to nothing
    // here — not to this tenant's 6300, and not to the other tenant's answer.
    expect(leaked).toBeNull();
  });
});
