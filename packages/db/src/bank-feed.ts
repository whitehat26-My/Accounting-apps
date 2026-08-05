import {
  normaliseFeedTransactions,
  type Currency,
  type FeedTransaction,
  type FeedViolation,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { businessToday } from './internal.js';
import { insertBankTransaction } from './bank.js';

/**
 * Bank feed connections — the bookkeeping around lines that arrive on their
 * own.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE NEVER TALKS TO A PROVIDER.
 *
 * `packages/db` does no HTTP (rule 6's spirit: IO lives at the edges). The
 * API layer owns the provider port and its adapters; what lives here is what
 * must be transactional either way — who is connected, what arrived, and the
 * guarantee that a line lands exactly once. `ingestFeedTransactions` is the
 * single funnel: the sandbox pull, the JSON push, and any future real
 * adapter all deliver through it, so there is exactly one place where feed
 * lines meet the books.
 * ---------------------------------------------------------------------------
 */

export type FeedErrorCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'FEED_NOT_FOUND'
  | 'FEED_EXISTS'
  | 'FEED_NOT_ACTIVE'
  | 'NOTHING_TO_INGEST';

export class FeedError extends Error {
  constructor(
    readonly code: FeedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FeedError';
  }
}

export type FeedProviderName = 'SANDBOX' | 'API_PUSH';

export interface FeedConnectionView {
  readonly id: string;
  readonly bankAccountId: string;
  readonly bankAccountName: string;
  readonly provider: FeedProviderName;
  readonly status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  readonly lastSyncedAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
}

interface ConnectionRow {
  id: string;
  bank_account_id: string;
  bank_account_name: string;
  provider: FeedProviderName;
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  sync_cursor: string | null;
  last_synced_at: Date | null;
  last_error: string | null;
  created_at: Date;
  currency: string;
}

function toView(row: ConnectionRow): FeedConnectionView {
  return {
    id: row.id,
    bankAccountId: row.bank_account_id,
    bankAccountName: row.bank_account_name,
    provider: row.provider,
    status: row.status,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
  };
}

const CONNECTION_SELECT = `
    SELECT c.id, c.bank_account_id, a.name AS bank_account_name, c.provider,
           c.status, c.sync_cursor, c.last_synced_at, c.last_error, c.created_at,
           a.currency
      FROM bank_feed_connection c
      JOIN bank_account a ON a.tenant_id = c.tenant_id AND a.id = c.bank_account_id`;

export async function listFeeds(tx: Tx, ctx: TenantContext): Promise<FeedConnectionView[]> {
  const rows = await tx.unsafe<ConnectionRow[]>(
    `${CONNECTION_SELECT}
     WHERE c.tenant_id = $1
     ORDER BY (c.status = 'REVOKED'), a.name`,
    [ctx.tenantId],
  );
  return rows.map(toView);
}

export async function connectFeed(
  tx: Tx,
  ctx: TenantContext,
  input: { readonly bankAccountId: string; readonly provider: FeedProviderName },
): Promise<FeedConnectionView> {
  const [account] = await tx<{ id: string }[]>`
      SELECT id FROM bank_account
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.bankAccountId}
  `;
  if (!account) {
    throw new FeedError('ACCOUNT_NOT_FOUND', `Bank account ${input.bankAccountId} not found.`);
  }

  // The partial unique index enforces this; checking first is only to answer
  // with a message instead of a constraint name.
  const [live] = await tx<{ id: string }[]>`
      SELECT id FROM bank_feed_connection
       WHERE tenant_id = ${ctx.tenantId} AND bank_account_id = ${input.bankAccountId}
         AND status <> 'REVOKED'
  `;
  if (live) {
    throw new FeedError(
      'FEED_EXISTS',
      'This account already has a live feed. Revoke it before connecting another.',
    );
  }

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO bank_feed_connection (tenant_id, bank_account_id, provider, created_by)
      VALUES (${ctx.tenantId}, ${input.bankAccountId}, ${input.provider}, ${ctx.userId ?? null})
      RETURNING id
  `;

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'BANK_FEED_CONNECTED', ${ctx.userId ?? null}, 'bank.import',
          'BANK_FEED', ${row!.id},
          ${tx.json({ bankAccountId: input.bankAccountId, provider: input.provider })}
      )
  `;

  return (await feed(tx, ctx, row!.id)).view;
}

export async function setFeedStatus(
  tx: Tx,
  ctx: TenantContext,
  feedId: string,
  status: 'ACTIVE' | 'PAUSED',
): Promise<FeedConnectionView> {
  const { view } = await feed(tx, ctx, feedId);
  if (view.status === 'REVOKED') {
    throw new FeedError('FEED_NOT_ACTIVE', 'A revoked feed cannot be re-enabled — connect a new one.');
  }
  await tx`
      UPDATE bank_feed_connection SET status = ${status}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${feedId}
  `;
  return { ...view, status };
}

/**
 * Revocation is terminal and evented: "who cut off the outside system, and
 * when" is an answer an auditor expects to find by name.
 */
export async function revokeFeed(
  tx: Tx,
  ctx: TenantContext,
  feedId: string,
): Promise<FeedConnectionView> {
  const { view } = await feed(tx, ctx, feedId);
  if (view.status === 'REVOKED') return view;

  await tx`
      UPDATE bank_feed_connection SET status = 'REVOKED', revoked_at = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${feedId}
  `;
  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'BANK_FEED_REVOKED', ${ctx.userId ?? null}, 'bank.import',
          'BANK_FEED', ${feedId}, ${tx.json({ provider: view.provider })}
      )
  `;
  return { ...view, status: 'REVOKED' };
}

export interface IngestResult {
  readonly statementId: string | null;
  readonly imported: number;
  readonly duplicates: number;
  readonly violations: readonly FeedViolation[];
  readonly replayed: boolean;
}

/**
 * The single funnel through which feed lines reach the books.
 *
 * Lands a batch as a `bank_statement` with source = 'FEED' plus
 * `bank_transaction` rows through the SAME conflict target as a CSV import —
 * so a feed and an overlapping import of the same real events produce each
 * line once, whichever arrives first. Idempotent on the key: a retried push
 * gets its original answer back rather than a second statement.
 */
export async function ingestFeedTransactions(
  tx: Tx,
  ctx: TenantContext,
  input: {
    readonly feedId: string;
    readonly transactions: readonly FeedTransaction[];
    readonly idempotencyKey: string;
    /** The provider's next sync position, stored on success. */
    readonly cursor?: string;
  },
): Promise<IngestResult> {
  const { view, currency } = await feed(tx, ctx, input.feedId);
  if (view.status !== 'ACTIVE') {
    throw new FeedError(
      'FEED_NOT_ACTIVE',
      `This feed is ${view.status}. A ${view.status === 'PAUSED' ? 'paused' : 'revoked'} ` +
        'feed refuses lines rather than accepting them quietly.',
    );
  }

  const [replayed] = await tx<{ id: string; line_count: number; duplicate_count: number }[]>`
      SELECT id, line_count, duplicate_count FROM bank_statement
       WHERE tenant_id = ${ctx.tenantId} AND idempotency_key = ${input.idempotencyKey}
  `;
  if (replayed) {
    return {
      statementId: replayed.id,
      imported: replayed.line_count,
      duplicates: replayed.duplicate_count,
      violations: [],
      replayed: true,
    };
  }

  const { rows, violations } = normaliseFeedTransactions(
    input.transactions,
    currency as Currency,
  );
  if (rows.length === 0) {
    throw new FeedError(
      'NOTHING_TO_INGEST',
      violations.length > 0
        ? 'Every transaction in this batch was malformed. Nothing was recorded.'
        : 'The batch was empty. Nothing was recorded.',
    );
  }

  const [statement] = await tx<{ id: string }[]>`
      INSERT INTO bank_statement (
          tenant_id, bank_account_id, statement_date, source,
          line_count, duplicate_count, idempotency_key, imported_by
      ) VALUES (
          ${ctx.tenantId}, ${view.bankAccountId}, ${businessToday()}, 'FEED',
          0, 0, ${input.idempotencyKey}, ${ctx.userId ?? null}
      )
      RETURNING id
  `;

  let imported = 0;
  let duplicates = 0;
  for (const row of rows) {
    const inserted = await insertBankTransaction(tx, ctx, view.bankAccountId, statement!.id, row);
    if (inserted) imported++;
    else duplicates++;
  }

  await tx`
      UPDATE bank_statement
         SET line_count = ${imported}, duplicate_count = ${duplicates}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${statement!.id}
  `;
  await tx`
      UPDATE bank_feed_connection
         SET last_synced_at = now(), last_error = NULL,
             sync_cursor = COALESCE(${input.cursor ?? null}, sync_cursor)
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.feedId}
  `;

  return { statementId: statement!.id, imported, duplicates, violations, replayed: false };
}

/** A pull attempt that failed — kept on the connection so the screen can say so. */
export async function recordFeedError(
  tx: Tx,
  ctx: TenantContext,
  feedId: string,
  message: string,
): Promise<void> {
  await tx`
      UPDATE bank_feed_connection SET last_error = ${message}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${feedId}
  `;
}

/** The connection plus what an adapter needs (cursor, account currency). */
export async function feedForSync(
  tx: Tx,
  ctx: TenantContext,
  feedId: string,
): Promise<{ view: FeedConnectionView; cursor: string | null; currency: string }> {
  const { view, cursor, currency } = await feed(tx, ctx, feedId);
  return { view, cursor, currency };
}

// ------------------------------------------------------------------ internals

async function feed(
  tx: Tx,
  ctx: TenantContext,
  feedId: string,
): Promise<{ view: FeedConnectionView; cursor: string | null; currency: string }> {
  const rows = await tx.unsafe<ConnectionRow[]>(
    `${CONNECTION_SELECT}
     WHERE c.tenant_id = $1 AND c.id = $2`,
    [ctx.tenantId, feedId],
  );
  const row = rows[0];
  if (!row) throw new FeedError('FEED_NOT_FOUND', `No bank feed ${feedId}.`);
  return { view: toView(row), cursor: row.sync_cursor, currency: row.currency };
}
