import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { createBankAccount, importStatement, bankTransactions } from '../src/bank.js';
import {
  connectFeed,
  ingestFeedTransactions,
  listFeeds,
  revokeFeed,
  setFeedStatus,
} from '../src/bank-feed.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * Bank feeds against the real schema.
 *
 * The test that matters is the COLLISION: a feed batch and a CSV import that
 * describe the same real events must produce each transaction ONCE, whichever
 * arrives first. That is the property that makes "run a feed AND re-import a
 * statement to be safe" a safe habit instead of a doubling machine.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let accountId: string;

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

beforeAll(async () => {
  const db = await createTestDatabase('bankfeed');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin, 'Feeds Sdn Bhd');

  const account = await withTenant(sql, ctx(), (tx) =>
    createBankAccount(tx, ctx(), {
      name: 'Maybank Current',
      bankName: 'Malayan Banking Berhad',
      glAccountId: tenant.accounts['1000']!,
    }),
  );
  accountId = account.id;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('the connection', () => {
  it('connects one live feed per account, and says who did it', async () => {
    const feed = await withTenant(sql, ctx(), (tx) =>
      connectFeed(tx, ctx(), { bankAccountId: accountId, provider: 'API_PUSH' }),
    );
    expect(feed.status).toBe('ACTIVE');

    await expect(
      withTenant(sql, ctx(), (tx) =>
        connectFeed(tx, ctx(), { bankAccountId: accountId, provider: 'SANDBOX' }),
      ),
    ).rejects.toMatchObject({ code: 'FEED_EXISTS' });

    const events = await admin<{ event_type: string }[]>`
        SELECT event_type FROM financial_event_log
         WHERE tenant_id = ${tenant.tenantId} AND event_type = 'BANK_FEED_CONNECTED'
    `;
    expect(events).toHaveLength(1);
  });
});

describe('ingest', () => {
  const feedId = async () => {
    const feeds = await withTenant(sql, ctx(), (tx) => listFeeds(tx, ctx()));
    return feeds.find((f) => f.status !== 'REVOKED')!.id;
  };

  it('lands a batch once, and a replayed key answers from the record', async () => {
    const id = await feedId();
    const batch = {
      feedId: id,
      transactions: [
        { date: '2026-08-03', description: 'DUITNOW QR SETTLEMENT', amount: '1250.00', reference: 'QR-1' },
        { date: '2026-08-03', description: 'TNB BILL PAYMENT', amount: '-380.40' },
      ],
      idempotencyKey: 'feed-batch-1',
    };

    const first = await withTenant(sql, ctx(), (tx) => ingestFeedTransactions(tx, ctx(), batch));
    expect(first.imported).toBe(2);
    expect(first.duplicates).toBe(0);
    expect(first.replayed).toBe(false);

    const replay = await withTenant(sql, ctx(), (tx) => ingestFeedTransactions(tx, ctx(), batch));
    expect(replay.replayed).toBe(true);
    expect(replay.imported).toBe(2);

    // A DIFFERENT key carrying the same facts dedupes at the line level.
    const again = await withTenant(sql, ctx(), (tx) =>
      ingestFeedTransactions(tx, ctx(), { ...batch, idempotencyKey: 'feed-batch-2' }),
    );
    expect(again.imported).toBe(0);
    expect(again.duplicates).toBe(2);
  });

  it('collides with a CSV import of the same real events — the property that matters', async () => {
    const id = await feedId();

    // The shop re-imports a statement covering the same days "to be safe",
    // plus one line the feed has not delivered.
    const csv = [
      'Date,Description,Amount', // the parser treats row one as the header
      '03/08/2026,DUITNOW QR SETTLEMENT,1250.00',
      '03/08/2026,TNB BILL PAYMENT,-380.40',
      '04/08/2026,IBG TRANSFER FR ALPHA TRADING,900.00',
    ].join('\n');

    const imported = await withTenant(sql, ctx(), (tx) =>
      importStatement(tx, ctx(), {
        bankAccountId: accountId,
        content: csv,
        profile: {
          bankName: 'My bank',
          delimiter: ',',
          dateFormat: 'DD/MM/YYYY',
          amountConvention: 'SIGNED',
          columns: { txnDate: 0, description: 1, amount: 2 },
        },
        statementDate: '2026-08-04',
        idempotencyKey: 'overlap-import',
      }),
    );
    expect(imported.imported).toBe(1); // only the IBG line is new
    expect(imported.duplicates).toBe(2); // the feed already delivered the rest

    // And the reverse: the feed later re-delivers a line the CSV brought.
    const echo = await withTenant(sql, ctx(), (tx) =>
      ingestFeedTransactions(tx, ctx(), {
        feedId: id,
        transactions: [
          { date: '2026-08-04', description: 'IBG TRANSFER FR ALPHA TRADING', amount: '900.00' },
        ],
        idempotencyKey: 'feed-batch-3',
      }),
    );
    expect(echo.imported).toBe(0);
    expect(echo.duplicates).toBe(1);

    // Three real events, exactly three rows, all in the ordinary queue.
    const lines = await withTenant(sql, ctx(), (tx) => bankTransactions(tx, ctx(), accountId));
    expect(lines).toHaveLength(3);
  });

  it('a paused feed refuses lines rather than accepting them quietly', async () => {
    const id = await feedId();
    await withTenant(sql, ctx(), (tx) => setFeedStatus(tx, ctx(), id, 'PAUSED'));

    await expect(
      withTenant(sql, ctx(), (tx) =>
        ingestFeedTransactions(tx, ctx(), {
          feedId: id,
          transactions: [{ date: '2026-08-05', description: 'X', amount: '1.00' }],
          idempotencyKey: 'paused-push',
        }),
      ),
    ).rejects.toMatchObject({ code: 'FEED_NOT_ACTIVE' });

    await withTenant(sql, ctx(), (tx) => setFeedStatus(tx, ctx(), id, 'ACTIVE'));
  });

  it('a batch of only malformed rows refuses loudly instead of recording nothing', async () => {
    const id = await feedId();
    await expect(
      withTenant(sql, ctx(), (tx) =>
        ingestFeedTransactions(tx, ctx(), {
          feedId: id,
          transactions: [{ date: 'yesterday', description: 'X', amount: 'ten' }],
          idempotencyKey: 'all-bad',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOTHING_TO_INGEST' });
  });

  it('revocation is terminal, evented, and frees the account for a new feed', async () => {
    const id = await feedId();
    const revoked = await withTenant(sql, ctx(), (tx) => revokeFeed(tx, ctx(), id));
    expect(revoked.status).toBe('REVOKED');

    await expect(
      withTenant(sql, ctx(), (tx) => setFeedStatus(tx, ctx(), id, 'ACTIVE')),
    ).rejects.toMatchObject({ code: 'FEED_NOT_ACTIVE' });

    // The account can be wired to a replacement; history keeps the old row.
    const replacement = await withTenant(sql, ctx(), (tx) =>
      connectFeed(tx, ctx(), { bankAccountId: accountId, provider: 'SANDBOX' }),
    );
    expect(replacement.provider).toBe('SANDBOX');

    const all = await withTenant(sql, ctx(), (tx) => listFeeds(tx, ctx()));
    expect(all).toHaveLength(2);

    const events = await admin<{ event_type: string }[]>`
        SELECT event_type FROM financial_event_log
         WHERE tenant_id = ${tenant.tenantId} AND event_type = 'BANK_FEED_REVOKED'
    `;
    expect(events).toHaveLength(1);
  });
});
