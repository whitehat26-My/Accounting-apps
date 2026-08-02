import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDate } from '@emil/contracts';
import { Money, isErr, validateJournalEntry, type JournalLineDraft } from '@emil/domain';
import {
  changeAccountType,
  changePeriodStatus,
  closeFiscalYear,
  createAccount,
  detectRollupDrift,
  getAccount,
  listAccounts,
  listFiscalYears,
  listPeriods,
  loadBaseCurrency,
  postJournalEntry,
  reopenFiscalYear,
  receivablesAtClosingRate,
  runRevaluation,
  updateAccount,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';
import { ValidationError } from '../errors.js';

/**
 * The general ledger: chart of accounts, fiscal periods, manual journals.
 *
 * ---------------------------------------------------------------------------
 * ALL OF THIS WAS BUILT AND UNREACHABLE.
 *
 * `postJournalEntry()` is the single write path into the ledger and has been
 * tested since the first commit; the `journal.post` permission has existed since
 * M0. There was no route, so the one operation the whole system is built around
 * could not be performed by a user. `account` and `fiscal_period` were in the
 * same position — tables and triggers, no service, no route.
 *
 * These handlers are thin for the usual reason: the services own every rule, and
 * a decision made here would be one an API key or a background job bypasses.
 * ---------------------------------------------------------------------------
 */
@Controller('v1')
export class LedgerController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  // ---- Chart of accounts ---------------------------------------------------

  @Requires('journal.read')
  @Get('accounts')
  async listAccounts(
    @Query('type') type: string | undefined,
    @Query('includeInactive') includeInactive: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const filter = parse(listAccountsSchema,
      {
        ...(type !== undefined ? { type } : {}),
        ...(includeInactive !== undefined ? { includeInactive: includeInactive === 'true' } : {}),
      },
    );

    const ctx = tenantContextOf(request);
    return { accounts: await withTenant(this.sql, ctx, (tx) => listAccounts(tx, ctx, filter)) };
  }

  @Requires('journal.read')
  @Get('accounts/:id')
  async getAccount(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => getAccount(tx, ctx, id));
  }

  @Requires('org.manage')
  @Doc({ request: () => accountSchema })
  @Post('accounts')
  async createAccount(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(accountSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => createAccount(tx, ctx, input));
  }

  /**
   * Rename, re-code or archive.
   *
   * `type` is handled by its own route below rather than being accepted and
   * silently ignored here — the refusal is the interesting behaviour and it
   * deserves to be visible.
   */
  @Requires('org.manage')
  @Doc({ request: () => updateAccountSchema })
  @Patch('accounts/:id')
  async updateAccount(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(updateAccountSchema,
      body,
    );

    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => updateAccount(tx, ctx, id, input));
  }

  @Requires('org.manage')
  @Doc({ request: () => changeTypeSchema })
  @Patch('accounts/:id/type')
  async changeType(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const { type } = parse(changeTypeSchema,
      body,
    );

    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => changeAccountType(tx, ctx, id, type));
  }

  // ---- Fiscal periods ------------------------------------------------------

  @Requires('journal.read')
  @Get('periods')
  async listPeriods(
    @Query('fiscalYearId') fiscalYearId: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    return {
      periods: await withTenant(this.sql, ctx, (tx) =>
        listPeriods(tx, ctx, fiscalYearId !== undefined ? { fiscalYearId } : {}),
      ),
    };
  }

  /**
   * Close, lock or reopen a period.
   *
   * One route rather than three verbs, because the interesting thing is the
   * transition and the service is what decides which are legal — reopening
   * needs a reason, closing out of order is refused, and both write a financial
   * event.
   */
  // The document said `journalSchema` here — a copy-paste from the handler
  // below. The conformance test only checks that a body-taking route HAS a
  // schema, not that it is the right one, so the OpenAPI document has been
  // telling clients this route accepts a journal entry.
  @Requires('period.lock')
  @Doc({ request: () => changePeriodStatusSchema })
  @Post('periods/:id/status')
  async changePeriodStatus(
    @Param('id') periodId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(changePeriodStatusSchema,
      body,
    );

    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => changePeriodStatus(tx, ctx, { ...input, periodId }));
  }

  // ---- Fiscal years and the year-end close ---------------------------------

  @Requires('journal.read')
  @Get('fiscal-years')
  async listFiscalYears(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return { fiscalYears: await withTenant(this.sql, ctx, (tx) => listFiscalYears(tx, ctx)) };
  }

  /**
   * Close a fiscal year.
   *
   * Under `period.lock` rather than `journal.post`: what the caller is deciding
   * is that a year is FINISHED, and the entry that transfers the profit is a
   * consequence of that decision rather than the point of it. The same
   * permission gates locking a period, which is the same judgement one level
   * down.
   */
  // No request schema: the close takes no body. Everything it needs is the
  // year in the path and the Idempotency-Key in the header — there is no
  // decision left for a payload to carry, and one would only invite a caller to
  // override a figure the ledger already knows.
  @Requires('period.lock')
  @Post('fiscal-years/:id/close')
  async closeFiscalYear(
    @Param('id') fiscalYearId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      closeFiscalYear(tx, ctx, { fiscalYearId, idempotencyKey }),
    );
  }

  /**
   * Reopen a closed year, reversing its closing entry.
   *
   * The reason is required by the service, not merely by this schema — a rule
   * enforced only at the edge is one an API key or a background job walks past.
   */
  @Requires('period.lock')
  @Doc({ request: () => reopenFiscalYearSchema })
  @Post('fiscal-years/:id/reopen')
  async reopenFiscalYear(
    @Param('id') fiscalYearId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(reopenFiscalYearSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      reopenFiscalYear(tx, ctx, { fiscalYearId, reason: input.reason, idempotencyKey }),
    );
  }

  // ---- Manual journals -----------------------------------------------------

  /**
   * Post a manual journal entry.
   *
   * The only route in the system that writes to the ledger without a document
   * behind it — accruals, prepayments, depreciation, corrections. It goes
   * through the same `postJournalEntry()` as every invoice and payment, so the
   * period lock, the balanced-entry trigger, gapless numbering, the outbox and
   * the audit trail all apply identically. There is deliberately no second way
   * in.
   */
  @Requires('journal.post')
  @Doc({ request: () => journalSchema })
  @Post('journals')
  async postJournal(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(journalSchema, body);
    const ctx = tenantContextOf(request);

    return withTenant(this.sql, ctx, async (tx) => {
      const baseCurrency = await loadBaseCurrency(tx, ctx);
      const currency = input.currency ?? baseCurrency;

      const lines: JournalLineDraft[] = input.lines.map((line) => {
        const amount = Money.fromDecimal(line.amount, currency);
        return {
          accountId: line.accountId,
          side: line.side,
          amount,
          // A foreign-currency manual journal must state its base amounts: the
          // rate that applies to an accrual is a judgement the poster makes,
          // not something to infer from a table.
          baseAmount:
            line.baseAmount !== undefined
              ? Money.fromDecimal(line.baseAmount, baseCurrency)
              : amount,
          ...(line.description !== undefined ? { description: line.description } : {}),
          ...(line.contactId !== undefined ? { contactId: line.contactId } : {}),
        };
      });

      const draft = {
        entryDate: input.entryDate,
        ...(input.description !== undefined ? { description: input.description } : {}),
        sourceModule: 'MANUAL' as const,
        ...(input.reference !== undefined ? { sourceDocumentType: input.reference } : {}),
        lines,
      };

      const valid = validateJournalEntry(draft, baseCurrency);
      if (isErr(valid)) {
        // Unbalanced, empty, or mixing currencies without base amounts. A 422
        // with the violation, not a 500 — the request was well formed and its
        // content was not acceptable.
        throw new ValidationError('The journal entry is not valid', valid.error);
      }

      return postJournalEntry(tx, ctx, valid.value, { idempotencyKey });
    });
  }

  // ---- Period-end revaluation ---------------------------------------------

  /**
   * What a revaluation WOULD do, without doing it.
   *
   * A revaluation posts to the ledger and its reversal posts the next day, so
   * running one to see the number is not free. This shows the exposure at the
   * closing rate first: outstanding foreign balances, what they were carried
   * at, and the difference.
   */
  @Requires('report.read')
  @Get('fx/exposure')
  async fxExposure(@Query('asOf') asOf: string, @Req() request: FastifyRequest) {
    const asOfDate = parse(isoDate, asOf);
    const ctx = tenantContextOf(request);
    const exposure = await withTenant(this.sql, ctx, (tx) =>
      receivablesAtClosingRate(tx, ctx, asOfDate),
    );
    // What the receivables are carried at, what they are worth at the closing
    // rate, and the difference a revaluation would post.
    return { asOfDate, ...exposure };
  }

  /**
   * Run a period-end FX revaluation.
   *
   * ---------------------------------------------------------------------------
   * IT POSTS AND THEN REVERSES, WHICH IS THE WHOLE DESIGN.
   *
   * An unrealised difference is a reporting-date statement, not a settlement.
   * The adjustment is posted at the reporting date and reversed the following
   * day, so the receivable goes back to its booked rate — and the realised gain
   * or loss, when the invoice is eventually settled, is measured from the
   * ORIGINAL rate rather than being double-counted against an adjustment that
   * was never undone.
   *
   * `journal.post` rather than a reporting permission: this writes to the
   * ledger.
   * ---------------------------------------------------------------------------
   */
  @Requires('journal.post')
  @Doc({ request: () => revaluationSchema })
  @Post('revaluations')
  async revalue(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(revaluationSchema, body);
    const ctx = tenantContextOf(request);

    // Rebuilt field by field rather than spread: `exactOptionalPropertyTypes`
    // distinguishes an absent key from one set to undefined, and a spread of an
    // optional Zod field produces the latter.
    return withTenant(this.sql, ctx, (tx) =>
      runRevaluation(tx, ctx, {
        fiscalPeriodId: input.fiscalPeriodId,
        idempotencyKey,
        ...(input.asOfDate !== undefined ? { asOfDate: input.asOfDate } : {}),
        ...(input.closingRates !== undefined ? { closingRates: input.closingRates } : {}),
      }),
    );
  }

  @Requires('report.read')
  @Get('revaluations')
  async listRevaluations(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    const rows = await withTenant(this.sql, ctx, (tx) =>
      tx<
        { id: string; as_of_date: Date; total_difference: string; status: string;
          journal_entry_id: string | null; reversal_entry_id: string | null }[]
      >`
          SELECT id, as_of_date, total_difference, status,
                 journal_entry_id, reversal_entry_id
            FROM revaluation_run
           WHERE tenant_id = ${ctx.tenantId}
           ORDER BY as_of_date DESC
      `,
    );

    return {
      runs: rows.map((r) => ({
        id: r.id,
        asOfDate: r.as_of_date.toISOString().slice(0, 10),
        totalDifference: r.total_difference,
        status: r.status,
        journalEntryId: r.journal_entry_id,
        // Null only when there was no adjustment to make. A posted revaluation
        // without a reversal would leave the books permanently restated.
        reversalEntryId: r.reversal_entry_id,
      })),
    };
  }

  /**
   * Whether the rollup cache still agrees with the journal it is derived from.
   *
   * `account_period_balance` is what every report reads, and it is a CACHE —
   * exposed here because "the reports disagree with the ledger" is a question
   * somebody will eventually need answered without shell access to the database.
   */
  @Requires('report.read')
  @Get('ledger/integrity')
  async integrity(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    const drift = await withTenant(this.sql, ctx, (tx) => detectRollupDrift(tx, ctx));
    return { rollupDrift: drift, intact: drift.length === 0 };
  }
}

const decimal = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, 'Money must be a decimal string with at most 4 decimal places');

const accountSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']),
  subtype: z.string().optional(),
  parentId: z.string().uuid().optional(),
  currency: z.string().length(3).optional(),
  tags: z.array(z.string().min(1)).optional(),
});

const reopenFiscalYearSchema = z.object({
  /**
   * Required, and `min(1)` rather than merely present. Reopening a closed year
   * is the act most likely to be asked about in an audit, and "why" is the
   * question. The service enforces this too — see `reopenFiscalYear`.
   */
  reason: z.string().min(1, 'Reopening a closed year requires a reason'),
});

const revaluationSchema = z.object({
  fiscalPeriodId: z.string().uuid(),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /**
   * Closing rates by currency. Omitted to use the stored rate on or before the
   * reporting date — supplied explicitly when the rate to use is a decision
   * rather than a lookup, which at a year end it usually is.
   */
  // Keyed by ISO currency code.
  closingRates: z.record(z.string(), decimal).optional(),
});

const journalSchema = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD'),
  description: z.string().optional(),
  reference: z.string().optional(),
  currency: z.string().length(3).optional(),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        side: z.enum(['DEBIT', 'CREDIT']),
        amount: decimal,
        baseAmount: decimal.optional(),
        description: z.string().optional(),
        contactId: z.string().uuid().optional(),
      }),
    )
    // Two lines is the minimum that can balance. One is always wrong, and
    // catching it here gives a better message than the trigger would.
    .min(2),
});

const listAccountsSchema = z.object({
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']).optional(),
  includeInactive: z.boolean().optional(),
});

const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  code: z.string().min(1).max(20).optional(),
  subtype: z.string().optional(),
  isActive: z.boolean().optional(),
});

const changeTypeSchema = z.object({ type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']) });

const changePeriodStatusSchema = z.object({
  status: z.enum(['OPEN', 'CLOSED', 'LOCKED']),
  reason: z.string().min(1).max(500).optional(),
});
