import type { JournalEntryDraft, SourceModule, ValidatedJournalEntry } from '@emil/domain';
import { isErr, Money, validateJournalEntry } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';

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
  /**
   * The entry this one reverses.
   *
   * CLAUDE.md rule 1 says corrections are "reversing entries that reference the
   * original", and `journal_entry.reversal_of_id` has existed with its foreign
   * key since 0001 — but nothing has ever WRITTEN it. `general-ledger.ts` reads
   * it back and has therefore reported `reversalOfId: null` for every entry in
   * the system, including the FX revaluation reversals that are unambiguously
   * reversals. The link was declared and never made.
   */
  readonly reversalOfId?: string;
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

  // The database refuses a posting into a LOCKED period unless
  // `app.allow_locked_period` is set, which `withTenant` only sets when the
  // caller holds `period.override`. That half of ledger invariant #9 has held
  // since the ledger core landed.
  //
  // This is the other half: "...AND a financial-event log row". Written here
  // rather than left to each caller, because a caller that forgets leaves an
  // override with no trace, and the whole point of the permission is that
  // exercising it is visible. Same transaction as the entry, so an override
  // cannot be recorded without its posting or a posting without its override.
  if (period.status === 'LOCKED') {
    await tx`
        INSERT INTO financial_event_log (
            tenant_id, event_type, actor_user_id, permission,
            entity_type, entity_id, detail
        ) VALUES (
            ${ctx.tenantId}, 'LOCKED_PERIOD_OVERRIDE', ${ctx.userId ?? null},
            'period.override', 'FISCAL_PERIOD', ${period.id},
            ${tx.json({
              entryDate: entry.entryDate,
              sourceModule: entry.sourceModule,
              totalDebit: entry.totalDebit.toDecimalString(),
              idempotencyKey: options.idempotencyKey ?? null,
            })}
        )
    `;
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
          status, idempotency_key, posted_by, posted_at, reversal_of_id
      ) VALUES (
          ${ctx.tenantId}, ${entryNo}, ${entry.entryDate}, ${period.id},
          ${entry.description ?? null}, ${entry.sourceModule},
          ${entry.sourceDocumentType ?? null}, ${entry.sourceDocumentId ?? null},
          'POSTED', ${options.idempotencyKey}, ${ctx.userId ?? null}, now(),
          ${options.reversalOfId ?? null}
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
  //
  // Nothing to do here any more, and that is the improvement.
  //
  // This function used to hand-write the single `audit_log` row that existed
  // anywhere in the system: action 'JOURNAL_POSTED', a summary payload, no
  // before image, and no IP, user agent or request id because `TenantContext`
  // could not carry them. Migration 0016 replaced it with a trigger on every
  // audited table, so the journal entry and its lines are now recorded the same
  // way every other mutation is — with a before image, the actor's origin, and
  // no chance of a future write path forgetting to call anything.
  //
  // The semantic name is not lost. "Somebody posted to a locked period" is
  // written to `financial_event_log` a few lines above, which is the log that
  // exists for acts rather than for row changes.

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
    readonly code: 'NO_FISCAL_PERIOD' | 'PERIOD_LOCKED' | 'UNBALANCED' | 'ENTRY_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface ReversePostedEntryOptions {
  readonly entryId: string;
  /** Defaults to the original entry's own date. */
  readonly entryDate?: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/**
 * Reverse an entry that is already in the ledger.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY WAY TO UNDO A POSTING — AND UNTIL NOW THERE WAS NO WAY TO DO IT
 * FROM A STORED ENTRY.
 *
 * `reverseEntry()` in the domain flips the sides of a draft the caller already
 * holds in memory, which is all `revaluation.ts` needed: it builds an
 * adjustment and its reversal in the same breath. Nothing could reverse an
 * entry it had only read back from the database — so "post a reversing entry
 * instead", which is what the immutability trigger tells every caller to do,
 * was advice with no implementation behind it.
 *
 * The lines are re-read from `journal_line` rather than rebuilt from the source
 * document. A document can be regenerated differently — a tax rate version
 * changes, a rounding policy is corrected — and a reversal that does not
 * exactly mirror what was posted leaves a residue in the accounts it claimed to
 * clear.
 * ---------------------------------------------------------------------------
 */
export async function reversePostedEntry(
  tx: Tx,
  ctx: TenantContext,
  options: ReversePostedEntryOptions,
): Promise<PostedEntry> {
  const [original] = await tx<
    {
      id: string;
      entry_no: string;
      entry_date: Date;
      description: string | null;
      source_module: SourceModule;
      source_document_type: string | null;
      source_document_id: string | null;
      status: string;
    }[]
  >`
      SELECT id, entry_no, entry_date, description, source_module,
             source_document_type, source_document_id, status
        FROM journal_entry
       WHERE tenant_id = ${ctx.tenantId} AND id = ${options.entryId}
  `;

  // Another tenant's entry is indistinguishable from one that does not exist.
  if (!original) {
    throw new LedgerError('ENTRY_NOT_FOUND', `Journal entry ${options.entryId} not found`);
  }

  const lines = await tx<
    {
      account_id: string;
      debit: string;
      credit: string;
      currency: string;
      base_debit: string;
      base_credit: string;
      description: string | null;
      contact_id: string | null;
      tax_code_id: string | null;
      tracking_option_id: string | null;
    }[]
  >`
      SELECT account_id, debit, credit, currency, base_debit, base_credit,
             description, contact_id, tax_code_id, tracking_option_id
        FROM journal_line
       WHERE tenant_id = ${ctx.tenantId} AND journal_entry_id = ${original.id}
       ORDER BY line_no
  `;

  const baseCurrency = await loadBaseCurrencyForLedger(tx, ctx);

  const draft: JournalEntryDraft = {
    entryDate: options.entryDate ?? toIsoDate(original.entry_date),
    description: `Reversal of ${original.entry_no}: ${options.reason}`,
    sourceModule: original.source_module,
    ...(original.source_document_type !== null
      ? { sourceDocumentType: original.source_document_type }
      : {}),
    ...(original.source_document_id !== null
      ? { sourceDocumentId: original.source_document_id }
      : {}),
    lines: lines.map((line) => {
      // The stored row has separate debit and credit columns; exactly one is
      // non-zero by CHECK. Reversing means taking the other side.
      const wasDebit = line.debit !== '0' && Number(line.debit) !== 0;

      return {
        accountId: line.account_id,
        side: wasDebit ? ('CREDIT' as const) : ('DEBIT' as const),
        amount: Money.fromDecimal(wasDebit ? line.debit : line.credit, line.currency),
        baseAmount: Money.fromDecimal(
          wasDebit ? line.base_debit : line.base_credit,
          baseCurrency,
        ),
        ...(line.description !== null ? { description: line.description } : {}),
        ...(line.contact_id !== null ? { contactId: line.contact_id } : {}),
        ...(line.tax_code_id !== null ? { taxCodeId: line.tax_code_id } : {}),
        ...(line.tracking_option_id !== null
          ? { trackingOptionId: line.tracking_option_id }
          : {}),
      };
    }),
  };

  const validated = validateJournalEntry(draft, baseCurrency);
  if (isErr(validated)) {
    // The original balanced, so its mirror image balances. Reaching here means
    // the stored lines themselves are inconsistent, which is a ledger fault and
    // must not be papered over by posting something almost right.
    throw new LedgerError(
      'UNBALANCED',
      `The reversal of ${original.entry_no} is not a valid entry: ` +
        JSON.stringify(validated.error),
    );
  }

  const posted = await postJournalEntry(tx, ctx, validated.value, {
    idempotencyKey: options.idempotencyKey,
    reversalOfId: original.id,
  });

  /*
   * The original is marked REVERSED, which the immutability trigger explicitly
   * permits (POSTED → REVERSED) and every report already accounts for: each
   * reporting query filters `status IN ('POSTED', 'REVERSED')`, because a
   * reversed entry's lines still stand — they are cancelled by the reversal's
   * lines, not erased. The status says "this was undone", not "ignore this".
   */
  if (original.status === 'POSTED' && !posted.replayed) {
    await tx`
        UPDATE journal_entry
           SET status = 'REVERSED'
         WHERE tenant_id = ${ctx.tenantId} AND id = ${original.id}
    `;
  }

  return posted;
}

/**
 * The base currency, read here rather than imported from `invoice.ts`.
 *
 * `ledger.ts` is the bottom of the dependency graph — `invoice.ts` imports it,
 * so importing back would be a cycle.
 */
async function loadBaseCurrencyForLedger(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx<{ base_currency: string }[]>`
      SELECT base_currency FROM organisation WHERE id = ${ctx.tenantId}
  `;
  return row?.base_currency ?? 'MYR';
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

