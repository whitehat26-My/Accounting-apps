import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Money, isErr, validateJournalEntry, type JournalLineDraft } from '@emil/domain';
import {
  changeAccountType,
  changePeriodStatus,
  createAccount,
  detectRollupDrift,
  getAccount,
  listAccounts,
  listPeriods,
  loadBaseCurrency,
  postJournalEntry,
  updateAccount,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
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
    const filter = parse(
      z.object({
        type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']).optional(),
        includeInactive: z.boolean().optional(),
      }),
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
  @Patch('accounts/:id')
  async updateAccount(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(
      z.object({
        name: z.string().min(1).optional(),
        code: z.string().min(1).max(20).optional(),
        subtype: z.string().optional(),
        isActive: z.boolean().optional(),
      }),
      body,
    );

    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => updateAccount(tx, ctx, id, input));
  }

  @Requires('org.manage')
  @Patch('accounts/:id/type')
  async changeType(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const { type } = parse(
      z.object({ type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']) }),
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
  @Requires('period.lock')
  @Post('periods/:id/status')
  async changePeriodStatus(
    @Param('id') periodId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(
      z.object({
        status: z.enum(['OPEN', 'CLOSED', 'LOCKED']),
        reason: z.string().min(1).max(500).optional(),
      }),
      body,
    );

    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => changePeriodStatus(tx, ctx, { ...input, periodId }));
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
