import {
  buildRevaluationJournal,
  isErr,
  Money,
  Rate,
  revalue,
  reversalDate,
  reverseEntry,
  validateJournalEntry,
  type Currency,
  type Revaluation,
  type RevaluationItem,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';
import { loadBaseCurrency } from './invoice.js';

/**
 * Period-end unrealised FX revaluation.
 *
 * Posts the adjustment dated the reporting date and its reversal dated the
 * following day, in ONE transaction. Posting the two separately would leave a
 * window in which a crash strands a permanent adjustment that was only ever
 * meant to be temporary — and the next settlement would then double-count it.
 */

export class RevaluationError extends Error {
  constructor(
    readonly code:
      | 'PERIOD_NOT_FOUND'
      | 'NO_POSTING_ACCOUNTS'
      | 'MISSING_CLOSING_RATE'
      | 'NO_REVERSAL_PERIOD'
      | 'REVALUATION_INVALID'
      | 'JOURNAL_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'RevaluationError';
  }
}

export interface RunRevaluationInput {
  readonly fiscalPeriodId: string;
  /**
   * Reporting date. Defaults to the period's end date — passed explicitly
   * only for an interim revaluation.
   */
  readonly asOfDate?: string;
  /**
   * Closing rates by currency. Omit to read the stored rate on or before the
   * reporting date.
   */
  readonly closingRates?: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
}

export interface RevaluationResult {
  readonly id: string;
  readonly asOfDate: string;
  readonly totalDifference: string;
  readonly journalEntryId: string | null;
  readonly reversalEntryId: string | null;
  readonly status: 'POSTED' | 'NO_ADJUSTMENT';
  readonly byCurrency: readonly {
    currency: string;
    outstanding: string;
    carryingBase: string;
    closingRate: string;
    closingBase: string;
    difference: string;
  }[];
  readonly replayed: boolean;
}

export async function runRevaluation(
  tx: Tx,
  ctx: TenantContext,
  input: RunRevaluationInput,
): Promise<RevaluationResult> {
  // ---- Idempotency ---------------------------------------------------------
  // Keyed on the period as well as the supplied key: a revaluation is a
  // period-end event, and running it twice for one period must not post twice.
  const existing = await tx<
    {
      id: string; as_of_date: Date; total_difference: string;
      journal_entry_id: string | null; reversal_entry_id: string | null;
      status: 'POSTED' | 'NO_ADJUSTMENT';
    }[]
  >`
      SELECT id, as_of_date, total_difference, journal_entry_id, reversal_entry_id, status
        FROM revaluation_run
       WHERE tenant_id = ${ctx.tenantId}
         AND (fiscal_period_id = ${input.fiscalPeriodId}
              OR idempotency_key = ${input.idempotencyKey})
  `;

  if (existing.length > 0) {
    const row = existing[0]!;
    return {
      id: row.id,
      asOfDate: toIsoDate(row.as_of_date),
      totalDifference: row.total_difference,
      journalEntryId: row.journal_entry_id,
      reversalEntryId: row.reversal_entry_id,
      status: row.status,
      byCurrency: await loadLines(tx, ctx, row.id),
      replayed: true,
    };
  }

  // ---- Resolve the period --------------------------------------------------
  const [period] = await tx<{ id: string; end_date: Date; status: string }[]>`
      SELECT id, end_date, status FROM fiscal_period
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.fiscalPeriodId}
  `;

  if (!period) {
    throw new RevaluationError('PERIOD_NOT_FOUND', `Fiscal period ${input.fiscalPeriodId} not found`);
  }

  const asOfDate = input.asOfDate ?? toIsoDate(period.end_date);
  const reverseOn = reversalDate(asOfDate);

  // The reversal lands in the next period, which has to exist and be postable.
  const [nextPeriod] = await tx<{ id: string; status: string }[]>`
      SELECT id, status FROM fiscal_period
       WHERE tenant_id = ${ctx.tenantId}
         AND ${reverseOn}::date BETWEEN start_date AND end_date
  `;

  if (!nextPeriod) {
    throw new RevaluationError(
      'NO_REVERSAL_PERIOD',
      `The revaluation reverses on ${reverseOn}, but no fiscal period covers that date. ` +
        'Create the next period before running a period-end revaluation.',
    );
  }

  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const accounts = await loadRevaluationAccounts(tx, ctx);

  // ---- Gather open monetary items -----------------------------------------
  const items = await loadOpenReceivables(tx, ctx, asOfDate, baseCurrency);
  const currencies = [...new Set(items.map((i) => i.outstanding.currency))];
  const closingRates = await resolveClosingRates(
    tx, ctx, currencies, baseCurrency, asOfDate, input.closingRates,
  );

  // ---- Compute (pure domain) ----------------------------------------------
  const computed = revalue(items, closingRates, baseCurrency, asOfDate);
  if (isErr(computed)) {
    throw new RevaluationError('REVALUATION_INVALID', 'Revaluation failed validation', computed.error);
  }
  const revaluation = computed.value;

  // ---- Post ----------------------------------------------------------------
  const journalDraft = buildRevaluationJournal(revaluation, accounts, {
    entryDate: asOfDate,
    description: `Unrealised FX revaluation at ${asOfDate}`,
    documentType: 'REVALUATION',
    documentId: input.fiscalPeriodId,
  });

  let journalEntryId: string | null = null;
  let reversalEntryId: string | null = null;

  if (journalDraft !== null) {
    const validated = validateJournalEntry(journalDraft, baseCurrency);
    if (isErr(validated)) {
      throw new RevaluationError('JOURNAL_INVALID', 'Generated journal is invalid', validated.error);
    }

    const posted = await postJournalEntry(tx, ctx, validated.value, {
      idempotencyKey: `revaluation:${input.idempotencyKey}`,
    });
    journalEntryId = posted.id;

    // The reversal is posted in the SAME transaction. If it were deferred,
    // a crash between the two would strand a permanent adjustment that was
    // only ever meant to hold until the next day.
    const reversalDraft = reverseEntry(journalDraft, {
      entryDate: reverseOn,
      description: `Reversal of unrealised FX revaluation at ${asOfDate}`,
    });

    const validatedReversal = validateJournalEntry(reversalDraft, baseCurrency);
    if (isErr(validatedReversal)) {
      throw new RevaluationError(
        'JOURNAL_INVALID',
        'Generated reversal is invalid',
        validatedReversal.error,
      );
    }

    const postedReversal = await postJournalEntry(tx, ctx, validatedReversal.value, {
      idempotencyKey: `revaluation-reversal:${input.idempotencyKey}`,
    });
    reversalEntryId = postedReversal.id;
  }

  // ---- Record the run ------------------------------------------------------
  const status = journalEntryId ? 'POSTED' : 'NO_ADJUSTMENT';

  const [run] = await tx<{ id: string }[]>`
      INSERT INTO revaluation_run (
          tenant_id, fiscal_period_id, as_of_date, base_currency, total_difference,
          journal_entry_id, reversal_entry_id, status, idempotency_key, run_by
      ) VALUES (
          ${ctx.tenantId}, ${input.fiscalPeriodId}, ${asOfDate}, ${baseCurrency},
          ${revaluation.totalDifference.toDecimalString()},
          ${journalEntryId}, ${reversalEntryId}, ${status},
          ${input.idempotencyKey}, ${ctx.userId ?? null}
      )
      RETURNING id
  `;

  for (const line of revaluation.byCurrency) {
    await tx`
        INSERT INTO revaluation_line (
            tenant_id, run_id, currency, item_count, outstanding,
            carrying_base, closing_rate, closing_base, difference
        ) VALUES (
            ${ctx.tenantId}, ${run!.id}, ${line.currency}, ${line.itemCount},
            ${line.outstanding.toDecimalString()},
            ${line.carryingBase.toDecimalString()},
            ${line.closingRate.toDecimalString()},
            ${line.closingBase.toDecimalString()},
            ${line.difference.toDecimalString()}
        )
    `;
  }

  return {
    id: run!.id,
    asOfDate,
    totalDifference: revaluation.totalDifference.toDecimalString(),
    journalEntryId,
    reversalEntryId,
    status,
    byCurrency: revaluation.byCurrency.map((l) => ({
      currency: l.currency,
      outstanding: l.outstanding.toDecimalString(),
      carryingBase: l.carryingBase.toDecimalString(),
      closingRate: l.closingRate.toDecimalString(),
      closingBase: l.closingBase.toDecimalString(),
      difference: l.difference.toDecimalString(),
    })),
    replayed: false,
  };
}

// ---------------------------------------------------------------------------

/**
 * Open receivables as at the reporting date.
 *
 * Only invoices ISSUED on or before the date count — an invoice raised in
 * September is not an asset at 31 August, and including it would overstate
 * the adjustment.
 */
async function loadOpenReceivables(
  tx: Tx,
  ctx: TenantContext,
  asOfDate: string,
  baseCurrency: Currency,
): Promise<RevaluationItem[]> {
  const rows = await tx<{ invoice_no: string; currency: string; amount_due: string; fx_rate: string }[]>`
      SELECT invoice_no, currency, amount_due, fx_rate
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('ISSUED','PART_PAID')
         AND amount_due > 0
         AND issue_date <= ${asOfDate}::date
         AND currency <> ${baseCurrency}
       ORDER BY invoice_no
  `;

  return rows.map((r) => ({
    reference: r.invoice_no,
    outstanding: Money.fromDecimal(r.amount_due, r.currency),
    bookedRate: Rate.fromDecimal(r.fx_rate),
  }));
}

async function resolveClosingRates(
  tx: Tx,
  ctx: TenantContext,
  currencies: readonly string[],
  baseCurrency: string,
  asOfDate: string,
  explicit?: Readonly<Record<string, string>>,
): Promise<Map<Currency, Rate>> {
  const rates = new Map<Currency, Rate>();

  for (const currency of currencies) {
    const supplied = explicit?.[currency];
    if (supplied) {
      rates.set(currency, Rate.fromDecimal(supplied));
      continue;
    }

    const [row] = await tx<{ rate: string | null }[]>`
        SELECT rate_on_or_before(${currency}, ${baseCurrency}, ${asOfDate}::date) AS rate
    `;

    if (!row?.rate) {
      throw new RevaluationError(
        'MISSING_CLOSING_RATE',
        `No ${currency}/${baseCurrency} closing rate on or before ${asOfDate}. ` +
          'Import it or supply it explicitly — skipping the currency would ' +
          'silently understate the adjustment.',
      );
    }

    rates.set(currency, Rate.fromDecimal(row.rate));
  }

  return rates;
}

async function loadRevaluationAccounts(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ revaluationAccountId: string; unrealisedFxAccountId: string }> {
  const rows = await tx<{ role: string; account_id: string }[]>`
      SELECT role, account_id FROM posting_account_map WHERE tenant_id = ${ctx.tenantId}
  `;
  const map = new Map(rows.map((r) => [r.role, r.account_id]));

  for (const role of ['AR_REVALUATION', 'UNREALISED_FX'] as const) {
    if (!map.get(role)) {
      throw new RevaluationError(
        'NO_POSTING_ACCOUNTS',
        `Posting account for role ${role} is not configured for this organisation`,
      );
    }
  }

  return {
    revaluationAccountId: map.get('AR_REVALUATION')!,
    unrealisedFxAccountId: map.get('UNREALISED_FX')!,
  };
}

async function loadLines(
  tx: Tx,
  ctx: TenantContext,
  runId: string,
): Promise<RevaluationResult['byCurrency']> {
  const rows = await tx<
    {
      currency: string; outstanding: string; carrying_base: string;
      closing_rate: string; closing_base: string; difference: string;
    }[]
  >`
      SELECT currency, outstanding, carrying_base, closing_rate, closing_base, difference
        FROM revaluation_line
       WHERE tenant_id = ${ctx.tenantId} AND run_id = ${runId}
       ORDER BY currency
  `;

  return rows.map((r) => ({
    currency: r.currency,
    outstanding: r.outstanding,
    carryingBase: r.carrying_base,
    closingRate: r.closing_rate,
    closingBase: r.closing_base,
    difference: r.difference,
  }));
}

/**
 * Receivables valued at the closing rate — the figure that belongs on a
 * balance sheet drawn at `asOfDate`.
 *
 * `outstandingReceivables()` in invoice.ts gives the historical-rate carrying
 * amount, which is what the AR control account holds between reporting dates.
 * The difference between the two is exactly what the revaluation posts.
 */
export async function receivablesAtClosingRate(
  tx: Tx,
  ctx: TenantContext,
  asOfDate: string,
): Promise<{ carryingBase: string; closingBase: string; difference: string }> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const items = await loadOpenReceivables(tx, ctx, asOfDate, baseCurrency);

  if (items.length === 0) {
    const zero = Money.zero(baseCurrency).toDecimalString();
    return { carryingBase: zero, closingBase: zero, difference: zero };
  }

  const currencies = [...new Set(items.map((i) => i.outstanding.currency))];
  const rates = await resolveClosingRates(tx, ctx, currencies, baseCurrency, asOfDate);

  const computed = revalue(items, rates, baseCurrency, asOfDate);
  if (isErr(computed)) {
    throw new RevaluationError('REVALUATION_INVALID', 'Revaluation failed', computed.error);
  }

  const total = (pick: (l: Revaluation['byCurrency'][number]) => Money) =>
    computed.value.byCurrency
      .reduce((acc, l) => acc.add(pick(l)), Money.zero(baseCurrency))
      .toDecimalString();

  return {
    carryingBase: total((l) => l.carryingBase),
    closingBase: total((l) => l.closingBase),
    difference: computed.value.totalDifference.toDecimalString(),
  };
}

function toIsoDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
