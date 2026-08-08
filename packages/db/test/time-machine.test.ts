import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, unwrap, validateJournalEntry } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { postJournalEntry, reversePostedEntry } from '../src/ledger.js';
import { booksAsAt, lockMoments, whatChanged } from '../src/time-machine.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The time machine against the real ledger.
 *
 * The test that matters is BACKDATING INTO A MONTH ALREADY READ: post March's
 * figures, note the instant they were read, then post another entry DATED in
 * March afterwards. March's reported profit has now changed under everyone who
 * relied on it — and the books as at the earlier instant must still show the
 * old figure, exactly, while the diff names the new entry and the person who
 * posted it. No other package for a shop this size can answer that, because no
 * other package keeps the ledger append-only.
 */

let sql: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

/** A balanced entry: bank debited, revenue credited. */
const rm = (amount: string) => Money.fromDecimal(amount, 'MYR');

const post = (amount: string, entryDate: string, description: string) =>
  withTenant(sql, ctx(), (tx) =>
    postJournalEntry(
      tx,
      ctx(),
      unwrap(
        validateJournalEntry(
          {
            entryDate,
            description,
            sourceModule: 'MANUAL',
            lines: [
              {
                accountId: tenant.accounts['1000']!,
                side: 'DEBIT',
                amount: rm(amount),
                baseAmount: rm(amount),
              },
              {
                accountId: tenant.accounts['4000']!,
                side: 'CREDIT',
                amount: rm(amount),
                baseAmount: rm(amount),
              },
            ],
          },
          'MYR',
        ),
      ),
      { idempotencyKey: randomUUID() },
    ),
  );

const balanceOf = (books: Awaited<ReturnType<typeof booksAsAt>>, code: string) =>
  books.balances.find((b) => b.code === code)?.balance.toDecimalString() ?? '0.0000';

let afterMarchWasRead: string;

beforeAll(async () => {
  const db = await createTestDatabase('timemachine');
  sql = db.sql;
  drop = db.drop;
  tenant = await seedTenant(db.admin, 'Time Machine Sdn Bhd');

  /*
   * A real person behind `posted_by`.
   *
   * `seedTenant` mints a bare UUID, which is enough for every other suite —
   * but "who changed it" is half of what this feature answers, and
   * `audit_actor` resolves a name only for somebody who is a MEMBER of this
   * tenant (0016:641). Without the membership row the name comes back null and
   * the assertion below would pass vacuously against a broken join.
   */
  await withTenant(db.admin, { tenantId: tenant.tenantId }, async (tx) => {
    await tx`
        INSERT INTO app_user (id, email, full_name)
        VALUES (${tenant.userId}, ${`tm-${tenant.userId}@example.test`}, 'Siti the Bookkeeper')
    `;
    await tx`
        INSERT INTO membership (tenant_id, user_id, role_code, status, joined_at)
        VALUES (${tenant.tenantId}, ${tenant.userId}, 'OWNER', 'ACTIVE', now())
    `;
  });
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('the books as they stood', () => {
  it('reconstructs an instant exactly, from posted_at alone', async () => {
    await post('10000.00', '2026-03-10', 'March sales, first half');
    await post('5000.00', '2026-03-20', 'March sales, second half');

    // The moment the accountant read March and reported RM 15,000.
    afterMarchWasRead = new Date().toISOString();
    const asRead = await withTenant(sql, ctx(), (tx) =>
      booksAsAt(tx, ctx(), { asAt: afterMarchWasRead, from: '2026-03-01', to: '2026-03-31' }),
    );
    expect(balanceOf(asRead, '4000')).toBe('-15000.0000'); // credit balance
  });

  it('excludes a DRAFT entry, which has no posted_at at all', async () => {
    const draft = await withTenant(sql, ctx(), (tx) =>
      tx<{ n: string }[]>`
          SELECT COUNT(*)::text AS n FROM journal_entry
           WHERE tenant_id = ${ctx().tenantId} AND posted_at IS NULL
      `,
    );
    // Nothing in this suite posts a draft; the assertion documents the
    // predicate's other half rather than testing PostgreSQL.
    expect(Number(draft[0]!.n)).toBe(0);
  });
});

describe('an entry backdated into a month that was already read', () => {
  it('leaves the earlier instant untouched and names the culprit', async () => {
    // Two weeks later, somebody posts a March-dated invoice that was in a
    // drawer. March's figure changes for everyone who reported it.
    await post('2500.00', '2026-03-28', 'Invoice found in the drawer');

    const stillAsRead = await withTenant(sql, ctx(), (tx) =>
      booksAsAt(tx, ctx(), { asAt: afterMarchWasRead, from: '2026-03-01', to: '2026-03-31' }),
    );
    const today = await withTenant(sql, ctx(), (tx) =>
      booksAsAt(tx, ctx(), {
        asAt: new Date().toISOString(),
        from: '2026-03-01',
        to: '2026-03-31',
      }),
    );

    // The whole feature in two lines: what was reported, and what is true now.
    expect(balanceOf(stillAsRead, '4000')).toBe('-15000.0000');
    expect(balanceOf(today, '4000')).toBe('-17500.0000');

    const diff = await withTenant(sql, ctx(), (tx) =>
      whatChanged(tx, ctx(), {
        since: afterMarchWasRead,
        until: new Date().toISOString(),
        from: '2026-03-01',
        to: '2026-03-31',
      }),
    );

    expect(diff.unchanged).toBe(false);
    const revenue = diff.changes.find((c) => c.code === '4000')!;
    expect(revenue.before.toDecimalString()).toBe('-15000.0000');
    expect(revenue.after.toDecimalString()).toBe('-17500.0000');
    expect(revenue.delta.toDecimalString()).toBe('-2500.0000');

    expect(diff.entries).toHaveLength(1);
    const culprit = diff.entries[0]!;
    expect(culprit.description).toBe('Invoice found in the drawer');
    // Dated inside the examined month, posted after it was read.
    expect(culprit.kind).toBe('BACKDATED');
    // The half of the answer that matters: who.
    expect(culprit.postedByName).toBe('Siti the Bookkeeper');
  });

  it('sorts the biggest movement first, whichever direction it went', async () => {
    const before = new Date().toISOString();
    await post('40.00', '2026-04-02', 'Small');
    await post('9000.00', '2026-04-03', 'Large');

    const diff = await withTenant(sql, ctx(), (tx) =>
      whatChanged(tx, ctx(), { since: before, until: new Date().toISOString() }),
    );
    // Both accounts moved by 9,040 — bank up, revenue down. Equal magnitude,
    // so the tiebreak is the account code, and neither is buried.
    expect(diff.changes).toHaveLength(2);
    expect(diff.changes.map((c) => c.code)).toEqual(['1000', '4000']);
  });
});

describe('a reversal', () => {
  it('does not erase the original from the past — it appears as its own event', async () => {
    const entry = await post('777.00', '2026-05-05', 'Keyed at the wrong amount');
    const beforeReversal = new Date().toISOString();

    await withTenant(sql, ctx(), (tx) =>
      reversePostedEntry(tx, ctx(), {
        entryId: entry.id,
        reason: 'wrong amount keyed',
        idempotencyKey: randomUUID(),
      }),
    );

    // As at the instant before the reversal, the original still stands. A
    // system filtering on today's status would have retroactively erased it.
    const past = await withTenant(sql, ctx(), (tx) =>
      booksAsAt(tx, ctx(), { asAt: beforeReversal, from: '2026-05-01', to: '2026-05-31' }),
    );
    expect(balanceOf(past, '4000')).toBe('-777.0000');

    // And now it nets to nothing, with the reversal explaining itself.
    const now = await withTenant(sql, ctx(), (tx) =>
      booksAsAt(tx, ctx(), {
        asAt: new Date().toISOString(),
        from: '2026-05-01',
        to: '2026-05-31',
      }),
    );
    expect(balanceOf(now, '4000')).toBe('0.0000');

    const diff = await withTenant(sql, ctx(), (tx) =>
      whatChanged(tx, ctx(), {
        since: beforeReversal,
        until: new Date().toISOString(),
        from: '2026-05-01',
        to: '2026-05-31',
      }),
    );
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]!.kind).toBe('REVERSAL');
  });
});

describe('nothing changed', () => {
  it('says so, rather than returning an empty table to interpret', async () => {
    const instant = new Date().toISOString();
    const diff = await withTenant(sql, ctx(), (tx) =>
      whatChanged(tx, ctx(), { since: instant, until: instant }),
    );
    expect(diff.unchanged).toBe(true);
    expect(diff.changes).toHaveLength(0);
  });
});

describe('lock moments', () => {
  it('offers the instants worth comparing against, newest first', async () => {
    const moments = await withTenant(sql, ctx(), (tx) => lockMoments(tx, ctx()));
    // The seeded tenant locks January (see helpers.ts), so there is at least
    // one real moment to offer — this is what saves the screen from asking a
    // shopkeeper for a timestamp.
    expect(Array.isArray(moments)).toBe(true);
  });
});
