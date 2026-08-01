import type { ValidatedJournalEntry } from '@emil/domain';
import { Money } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';

/**
 * The ONE write path into the general ledger.
 *
 * Nothing else in the system writes `journal_entry`, `journal_line`, or
 * `account_period_balance` (CLAUDE.md rule 4). Sales, purchases and banking
 * all build a draft, validate it in the pure domain layer, and hand it here.
 *
 * Every step below runs in the caller's transaction, so a failure anywhere
 * rolls back the document and its ledger effect together.
 */

export interface PostedEntry {
  readonly id: string;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly totalDebit: string;
  readonly totalCredit: string;
  /** True when an existing entry was returned for a replayed idempotency key. */
  readonly replayed: boolean;
}

export interface PostOptions {
  readonly idempotencyKey: string;
  /** Emitted to the outbox after commit, e.g. 'invoice.issued'. */
  readonly emitEvent?: { readonly type: string; readonly payload: unknown };
}

export async function postJournalEntry(
  tx: Tx,
  ctx: TenantContext,
  entry: ValidatedJournalEntry,
  options: PostOptions,
): Promise<PostedEntry> {
  // ---- 1. Idempotency ------------------------------------------------------
  // A double-clicked "Record payment" must not post twice. The unique index on
  // (tenant_id, idempotency_key) is the backstop; this lookup is the fast path.
  const existing = await tx<{ id: string; entry_no: string; entry_date: Date }[]>`
      SELECT id, entry_no, entry_date
        FROM journal_entry
       WHERE tenant_id = ${ctx.tenantId}
         AND idempotency_key = ${options.idempotencyKey}
  `;

  if (existing.length > 0) {
    const row = existing[0]!;
    return {
      id: row.id,
      entryNo: row.entry_no,
      entryDate: toIsoDate(row.entry_date),
      totalDebit: entry.totalDebit.toDecimalString(),
      totalCredit: entry.totalCredit.toDecimalString(),
      replayed: true,
    };
  }

  // ---- 2. Resolve the fiscal period ---------------------------------------
  const periods = await tx<{ id: string; status: string }[]>`
      SELECT id, status
        FROM fiscal_period
       WHERE tenant_id = ${ctx.tenantId}
         AND ${entry.entryDate}::date BETWEEN start_date AND end_date
  `;

  const period = periods[0];
  if (!period) {
    throw new LedgerError(
      'NO_FISCAL_PERIOD',
      `No fiscal period covers ${entry.entryDate}. Create the financial year first.`,
    );
  }

  // ---- 3. Allocate a gapless entry number ----------------------------------
  const [numbered] = await tx<{ allocate_document_number: string }[]>`
      SELECT allocate_document_number('JOURNAL')
  `;
  const entryNo = numbered!.allocate_document_number;

  // ---- 4. Header -----------------------------------------------------------
  const [header] = await tx<{ id: string }[]>`
      INSERT INTO journal_entry (
          tenant_id, entry_no, entry_date, fiscal_period_id, description,
          source_module, source_document_type, source_document_id,
          status, idempotency_key, posted_by, posted_at
      ) VALUES (
          ${ctx.tenantId}, ${entryNo}, ${entry.entryDate}, ${period.id},
          ${entry.description ?? null}, ${entry.sourceModule},
          ${entry.sourceDocumentType ?? null}, ${entry.sourceDocumentId ?? null},
          'POSTED', ${options.idempotencyKey}, ${ctx.userId ?? null}, now()
      )
      RETURNING id
  `;
  const entryId = header!.id;

  // ---- 5. Lines ------------------------------------------------------------
  // The domain models a line as (side, positive amount); the table has separate
  // debit/credit columns with a CHECK. The translation happens here, at the
  // boundary, and nowhere else.
  for (const [index, line] of entry.lines.entries()) {
    const isDebit = line.side === 'DEBIT';
    await tx`
        INSERT INTO journal_line (
            tenant_id, journal_entry_id, line_no, account_id,
            debit, credit, currency, fx_rate, base_debit, base_credit,
            description, contact_id, tax_code_id, tracking_option_id
        ) VALUES (
            ${ctx.tenantId}, ${entryId}, ${index + 1}, ${line.accountId},
            ${isDebit ? line.amount.toDecimalString() : '0'},
            ${isDebit ? '0' : line.amount.toDecimalString()},
            ${line.amount.currency},
            ${fxRateOf(line.amount, line.baseAmount)},
            ${isDebit ? line.baseAmount.toDecimalString() : '0'},
            ${isDebit ? '0' : line.baseAmount.toDecimalString()},
            ${line.description ?? null}, ${line.contactId ?? null},
            ${line.taxCodeId ?? null}, ${line.trackingOptionId ?? null}
        )
    `;
  }

  // ---- 6. Rollup -----------------------------------------------------------
  // Updated inside the posting transaction so a trial balance never has to
  // scan journal_line. This table is a cache; the journal remains the truth.
  for (const line of entry.lines) {
    const isDebit = line.side === 'DEBIT';
    const debit = isDebit ? line.baseAmount.toDecimalString() : '0';
    const credit = isDebit ? '0' : line.baseAmount.toDecimalString();

    await tx`
        INSERT INTO account_period_balance (
            tenant_id, account_id, fiscal_period_id, currency,
            debit_total, credit_total, net_movement
        ) VALUES (
            ${ctx.tenantId}, ${line.accountId}, ${period.id}, ${entry.baseCurrency},
            ${debit}, ${credit}, ${isDebit ? debit : `-${credit}`}
        )
        ON CONFLICT (tenant_id, account_id, fiscal_period_id, currency) DO UPDATE
        SET debit_total  = account_period_balance.debit_total  + EXCLUDED.debit_total,
            credit_total = account_period_balance.credit_total + EXCLUDED.credit_total,
            -- Debit-positive movement for this period. Cumulative balance is
            -- SUM(net_movement) over periods, computed at read time.
            net_movement = account_period_balance.debit_total  + EXCLUDED.debit_total
                         - account_period_balance.credit_total - EXCLUDED.credit_total,
            updated_at   = now()
    `;
  }

  // ---- 7. Audit ------------------------------------------------------------
  await tx`
      INSERT INTO audit_log (
          tenant_id, actor_user_id, action, entity_type, entity_id, after_json, row_hash
      ) VALUES (
          ${ctx.tenantId}, ${ctx.userId ?? null}, 'JOURNAL_POSTED', 'journal_entry',
          ${entryId},
          ${tx.json({
            entryNo,
            entryDate: entry.entryDate,
            totalDebit: entry.totalDebit.toDecimalString(),
            totalCredit: entry.totalCredit.toDecimalString(),
            lineCount: entry.lines.length,
          })},
          ''::bytea
      )
  `;

  // ---- 8. Outbox -----------------------------------------------------------
  // Written in the SAME transaction as the ledger effect. If the commit fails
  // there is no job; if it succeeds the job exists even if Redis was down.
  if (options.emitEvent) {
    await tx`
        INSERT INTO outbox_event (tenant_id, event_type, aggregate_type, aggregate_id, payload)
        VALUES (
            ${ctx.tenantId}, ${options.emitEvent.type}, 'journal_entry', ${entryId},
            ${tx.json(options.emitEvent.payload as never)}
        )
    `;
  }

  return {
    id: entryId,
    entryNo,
    entryDate: entry.entryDate,
    totalDebit: entry.totalDebit.toDecimalString(),
    totalCredit: entry.totalCredit.toDecimalString(),
    replayed: false,
  };
}

export class LedgerError extends Error {
  constructor(
    readonly code: 'NO_FISCAL_PERIOD' | 'PERIOD_LOCKED' | 'UNBALANCED',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * Trial balance from the rollup — one indexed read per account, not a scan of
 * millions of journal lines.
 */
export async function trialBalance(
  tx: Tx,
  ctx: TenantContext,
  fiscalPeriodId: string,
): Promise<{ accountId: string; code: string; name: string; debit: string; credit: string }[]> {
  return tx<{ accountId: string; code: string; name: string; debit: string; credit: string }[]>`
      SELECT b.account_id   AS "accountId",
             a.code,
             a.name,
             b.debit_total  AS debit,
             b.credit_total AS credit
        FROM account_period_balance b
        JOIN account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
       WHERE b.tenant_id = ${ctx.tenantId}
         AND b.fiscal_period_id = ${fiscalPeriodId}
       ORDER BY a.code
  `;
}

/**
 * Recompute the rollup from raw journal lines and report any drift.
 *
 * This is the nightly canary for a posting bug. If it ever returns rows, the
 * journal is right and the rollup is wrong — rebuild the rollup, never "fix"
 * the journal to match.
 */
export async function detectRollupDrift(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ accountId: string; rollupDebit: string; actualDebit: string; rollupCredit: string; actualCredit: string }[]> {
  return tx`
      WITH actual AS (
          SELECT l.account_id,
                 e.fiscal_period_id,
                 SUM(l.base_debit)  AS debit_total,
                 SUM(l.base_credit) AS credit_total
            FROM journal_line l
            JOIN journal_entry e
              ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
           WHERE l.tenant_id = ${ctx.tenantId}
             AND e.status IN ('POSTED', 'REVERSED')
           GROUP BY l.account_id, e.fiscal_period_id
      )
      SELECT COALESCE(b.account_id, a.account_id)      AS "accountId",
             COALESCE(b.debit_total, 0)::text          AS "rollupDebit",
             COALESCE(a.debit_total, 0)::text          AS "actualDebit",
             COALESCE(b.credit_total, 0)::text         AS "rollupCredit",
             COALESCE(a.credit_total, 0)::text         AS "actualCredit"
        FROM account_period_balance b
        FULL OUTER JOIN actual a
          ON a.account_id = b.account_id
         AND a.fiscal_period_id = b.fiscal_period_id
       WHERE COALESCE(b.debit_total, 0)  IS DISTINCT FROM COALESCE(a.debit_total, 0)
          OR COALESCE(b.credit_total, 0) IS DISTINCT FROM COALESCE(a.credit_total, 0)
  ` as unknown as Promise<
    { accountId: string; rollupDebit: string; actualDebit: string; rollupCredit: string; actualCredit: string }[]
  >;
}

// ------------------------------------------------------------------ internals

const FX_SCALE = 8;

function fxRateOf(amount: Money, baseAmount: Money): string {
  if (amount.units === 0n) return '1';
  if (amount.currency === baseAmount.currency) return '1';

  // rate = base / transaction, held at 8 dp to match the fx_rate column.
  // Both operands are at MONEY_SCALE, so the scales cancel and only the
  // target precision needs applying.
  const scaled = (baseAmount.units * 10n ** BigInt(FX_SCALE)) / amount.units;
  return formatScaled(scaled, FX_SCALE);
}

function formatScaled(units: bigint, scale: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const factor = 10n ** BigInt(scale);
  const whole = abs / factor;
  const fraction = (abs % factor).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}
