import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decimal, isoDate, quantity } from '@emil/contracts';
import {
  businessToday,
  applyBankRules,
  bankTransactions,
  bookBalance,
  completeReconciliation,
  confirmMatch,
  createBankAccount,
  createBankRule,
  createEntryFromBankLine,
  debitFromBill,
  issueDebitNote,
  listBankRules,
  previewStatement,
  ruleSuggestions,
  unmatch,
  updateBankRule,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * Bank accounts, the reconciliation workflow, and debit notes.
 *
 * ---------------------------------------------------------------------------
 * THE MATCHING ENGINE COULD SUGGEST AND NOBODY COULD ACCEPT.
 *
 * `GET /bank-accounts/:id/suggestions` has existed since M4 and returns ranked
 * matches with reasons. `confirmMatch`, `unmatch`, `completeReconciliation` and
 * `createEntryFromBankLine` — everything that turns a suggestion into a
 * reconciled ledger — had no routes at all. So did `createBankAccount`, which
 * meant a tenant could not create the bank account the rest of it operates on.
 *
 * Debit notes are here rather than with the other purchase routes because they
 * arrived in the same state: `issueDebitNote` built and tested in M3, the
 * `debitnote.create` permission seeded in M0, and no way to call it.
 * ---------------------------------------------------------------------------
 */
@Controller('v1')
export class BankingController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  // ---- Bank accounts -------------------------------------------------------

  @Requires('bank.read')
  @Get('bank-accounts')
  async list(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    const rows = await withTenant(this.sql, ctx, (tx) =>
      tx<
        { id: string; name: string; bank_name: string; currency: string;
          gl_account_id: string; account_type: string; is_active: boolean }[]
      >`
          SELECT id, name, bank_name, currency, gl_account_id, account_type, is_active
            FROM bank_account WHERE tenant_id = ${ctx.tenantId} ORDER BY name
      `,
    );

    return {
      bankAccounts: rows.map((r) => ({
        id: r.id,
        name: r.name,
        bankName: r.bank_name,
        currency: r.currency,
        glAccountId: r.gl_account_id,
        accountType: r.account_type,
        isActive: r.is_active,
      })),
    };
  }

  /**
   * `bank.import` rather than a settings permission.
   *
   * Creating a bank account writes a `BANK_DETAILS_CHANGED` financial event,
   * because where a tenant's money is paid is one of the few settings an
   * auditor asks about by name.
   */
  @Requires('bank.import')
  @Doc({ request: () => bankAccountSchema })
  @Post('bank-accounts')
  async create(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(bankAccountSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => createBankAccount(tx, ctx, input));
  }

  @Requires('bank.read')
  @Get('bank-accounts/:id/transactions')
  async transactions(
    @Param('id') bankAccountId: string,
    @Query('status') status: string | undefined,
    @Query('asOf') asOf: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const filter = parse(transactionsSchema,
      {
        ...(status !== undefined ? { status } : {}),
        ...(asOf !== undefined ? { asOfDate: asOf } : {}),
      },
    );

    const ctx = tenantContextOf(request);
    // The book balance is stated AS AT a date, never "now": comparing a
    // running bank balance to a book balance taken at a different moment is
    // the classic way to chase a variance that does not exist.
    const asOfDate = filter.asOfDate ?? businessToday();

    const [transactions, book] = await withTenant(this.sql, ctx, async (tx) => [
      await bankTransactions(tx, ctx, bankAccountId, filter),
      await bookBalance(tx, ctx, bankAccountId, asOfDate),
    ]);

    return { transactions, asOfDate, bookBalance: book.toDecimalString() };
  }

  /**
   * Parse a statement without importing it.
   *
   * The counterpart to "profiles are saved per bank, never sniffed": a preview
   * is how a wrong column map fails in front of the person who can fix it,
   * rather than as plausible-looking wrong numbers found at year end.
   */
  @Requires('bank.import')
  @Doc({ request: () => previewSchema })
  @Post('bank-accounts/:id/statements/preview')
  async preview(
    @Param('id') bankAccountId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(previewSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      previewStatement(tx, ctx, { ...input, bankAccountId }),
    );
  }

  // ---- Reconciliation ------------------------------------------------------

  @Requires('bank.reconcile')
  @Doc({ request: () => matchSchema })
  @Post('bank-transactions/:id/match')
  async match(
    @Param('id') bankTransactionId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(matchSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      confirmMatch(tx, ctx, { ...input, bankTransactionId }),
    );
  }

  /**
   * Undo a match.
   *
   * A DELETE that inserts. `unmatch` writes a reversing decision rather than
   * removing the original, so both remain visible — the same principle as the
   * ledger itself, and the reason a reconciliation can be explained months
   * later.
   */
  @Requires('bank.reconcile')
  @Doc({ request: () => removeMatchSchema })
  @Delete('reconciliation-matches/:id')
  async removeMatch(
    @Param('id') matchId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    // Keyed on the MATCH, not the bank line. A line can carry several matches
    // when one payment settles against a split, and "undo the match" has to say
    // which one.
    const { reason } = parse(removeMatchSchema, body ?? {});
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => unmatch(tx, ctx, matchId, reason));
  }

  /**
   * Create the missing ledger entry for a bank line nobody recorded.
   *
   * Bank charges, interest, a direct debit nobody entered. The line is real and
   * the books are missing it, so the fix is a journal — not an adjustment to
   * the statement, which is evidence.
   */
  @Requires('journal.post')
  @Doc({ request: () => journalFromLineSchema })
  @Post('bank-transactions/:id/journal')
  async journalFromLine(
    @Param('id') bankTransactionId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(journalFromLineSchema,
      body,
    );

    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      createEntryFromBankLine(tx, ctx, { ...input, bankTransactionId, idempotencyKey }),
    );
  }

  /**
   * Sign off a period's reconciliation.
   *
   * Refused unless the account genuinely reconciles to zero — an unexplained
   * variance is a missing item, a duplicate or a wrong amount, and signing off
   * around it is how a difference becomes permanent. Writes a
   * `RECONCILIATION_COMPLETED` financial event in the same transaction.
   */
  @Requires('bank.reconcile')
  @Doc({ request: () => debitNoteSchema })
  @Post('bank-accounts/:id/reconciliation')
  async complete(
    @Param('id') bankAccountId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(completeSchema,
      body,
    );

    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      completeReconciliation(tx, ctx, { ...input, bankAccountId }),
    );
  }

  // ---- Bank rules ----------------------------------------------------------

  @Requires('bank.read')
  @Get('bank-rules')
  async rules(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    const rules = await withTenant(this.sql, ctx, (tx) => listBankRules(tx, ctx));
    return { rules };
  }

  /**
   * `bank.reconcile`, because a rule is a standing reconciliation decision:
   * whoever may match a line by hand may also record how it should always be
   * matched. With `autoApply` the rule will POST journals with nobody
   * watching — which is exactly why it defaults off, every firing is an
   * ordinary match (method RULE) that `unmatch` reverses, and the reason on
   * each match names the rule that made the call.
   */
  @Requires('bank.reconcile')
  @Doc({ request: () => bankRuleSchema })
  @Post('bank-rules')
  async createRule(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(bankRuleSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => createBankRule(tx, ctx, input));
  }

  @Requires('bank.reconcile')
  @Doc({ request: () => bankRulePatchSchema })
  @Post('bank-rules/:id')
  async updateRule(
    @Param('id') ruleId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const patch = parse(bankRulePatchSchema, body);
    const ctx = tenantContextOf(request);
    await withTenant(this.sql, ctx, (tx) => updateBankRule(tx, ctx, ruleId, patch));
    return { updated: true };
  }

  /** What the rules WOULD do to the unmatched lines. Writes nothing. */
  @Requires('bank.reconcile')
  @Get('bank-rules/suggestions')
  async ruleHits(
    @Query('bankAccountId') bankAccountId: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const options = parse(ruleRunSchema,
      bankAccountId !== undefined ? { bankAccountId } : {},
    );
    const ctx = tenantContextOf(request);
    const hits = await withTenant(this.sql, ctx, (tx) => ruleSuggestions(tx, ctx, options));
    return { hits };
  }

  /**
   * Run the rules now: post every auto-apply hit, count the rest.
   *
   * Also runs automatically after every statement import. This route exists
   * for the other direction — the owner spots a recurring line, writes the
   * rule, and wants the backlog coded without re-importing anything.
   */
  @Requires('journal.post')
  @Doc({ request: () => ruleRunSchema })
  @Post('bank-rules/run')
  async runRules(@Body() body: unknown, @Req() request: FastifyRequest) {
    const options = parse(ruleRunSchema, body ?? {});
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => applyBankRules(tx, ctx, options));
  }

  // ---- Debit notes ---------------------------------------------------------

  /**
   * Raise a debit note from the bill it corrects.
   *
   * The payables mirror of `POST /v1/invoices/:id/credit-note`: every figure —
   * the supplier's price, their tax code, the account the spend landed in —
   * comes off the bill rather than being retyped, and the tax rate is the one
   * the supplier charged rather than today's.
   */
  @Requires('debitnote.create')
  @Doc({ request: () => debitFromBillSchema })
  @Post('bills/:id/debit-note')
  async debitBill(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(debitFromBillSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      debitFromBill(tx, ctx, { ...input, billId: parse(billIdParam, id), idempotencyKey }),
    );
  }

  @Requires('debitnote.create')
  @Doc({ request: () => debitNoteSchema })
  @Post('debit-notes')
  async issueDebitNote(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(debitNoteSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      issueDebitNote(tx, ctx, { ...input, idempotencyKey }),
    );
  }
}

const bankAccountSchema = z.object({
  name: z.string().min(1),
  bankName: z.string().min(1),
  glAccountId: z.string().uuid(),
  // Masked, and only masked. The full number is never needed to reconcile, and
  // storing it turns a statement import into a payment-credential store.
  accountNoMasked: z.string().max(40).optional(),
  swift: z.string().max(20).optional(),
  currency: z.string().length(3).optional(),
  accountType: z.enum(['BANK', 'CASH', 'CREDIT_CARD', 'EWALLET']).optional(),
  openingBalance: decimal.optional(),
  openingDate: isoDate.optional(),
});

const importProfile = z.object({
  bankName: z.string(),
  delimiter: z.string().min(1).max(4),
  skipRows: z.number().int().min(0).optional(),
  hasHeader: z.boolean().optional(),
  dateFormat: z.enum(['DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM-DD']),
  amountConvention: z.enum(['SIGNED', 'DEBIT_CREDIT']),
  columns: z.object({
    txnDate: z.number().int().min(0),
    description: z.number().int().min(0),
    amount: z.number().int().min(0).optional(),
    debit: z.number().int().min(0).optional(),
    credit: z.number().int().min(0).optional(),
    valueDate: z.number().int().min(0).optional(),
    reference: z.number().int().min(0).optional(),
    runningBalance: z.number().int().min(0).optional(),
  }),
});

const previewSchema = z.object({
  content: z.string().min(1),
  format: z.enum(['CSV', 'ADVICE']).optional(),
  /** Fallback date for undated advices, so the preview mirrors the import. */
  statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  profileId: z.string().uuid().optional(),
  profile: importProfile.optional(),
});

const matchSchema = z.object({
  matchedType: z.enum(['PAYMENT', 'INVOICE', 'BILL', 'JOURNAL', 'TRANSFER']),
  matchedId: z.string().uuid(),
  amount: decimal,
  confidence: z.number().min(0).max(100).optional(),
  method: z.enum(['AUTO', 'RULE', 'MANUAL']).optional(),
  reason: z.string().optional(),
});

const debitNoteSchema = z.object({
  supplierId: z.string().uuid(),
  billId: z.string().uuid().optional(),
  debitDate: isoDate,
  taxPointDate: isoDate.optional(),
  reason: z.enum(['RETURN', 'OVERCHARGE', 'DISCOUNT', 'CANCELLATION', 'BAD_DEBT', 'OTHER']),
  reasonDetail: z.string().optional(),
  currency: z.string().length(3).optional(),
  amountsAreTaxInclusive: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity: z.string().regex(/^\d+(\.\d{1,4})?$/),
        unitPrice: decimal,
        accountId: z.string().uuid(),
        taxCodeId: z.string().uuid(),
        discountBasisPoints: z.number().int().min(0).max(10_000).optional(),
      }),
    )
    .min(1),
  allocations: z.array(z.object({ billId: z.string().uuid(), amount: decimal })).optional(),
});

const transactionsSchema = z.object({
  status: z.enum(['UNRECONCILED', 'MATCHED', 'RECONCILED', 'IGNORED']).optional(),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const removeMatchSchema = z.object({ reason: z.string().min(1).max(500) });

const journalFromLineSchema = z.object({
  // The expense or income account the other side of the bank line
  // belongs in. Bank charges, interest received, a direct debit.
  accountId: z.string().uuid(),
  description: z.string().optional(),
  contactId: z.string().uuid().optional(),
});

const bankRuleSchema = z.object({
  name: z.string().min(1).max(120),
  // Three characters minimum: "TNB" is a payee, "E" is half the statement.
  contains: z.string().trim().min(3).max(120),
  accountId: z.string().uuid(),
  matchesDirection: z.enum(['INFLOW', 'OUTFLOW']).optional(),
  minAmount: decimal.optional(),
  maxAmount: decimal.optional(),
  contactId: z.string().uuid().optional(),
  bankAccountId: z.string().uuid().optional(),
  priority: z.number().int().min(1).max(10_000).optional(),
  autoApply: z.boolean().optional(),
});

const bankRulePatchSchema = z
  .object({
    isActive: z.boolean().optional(),
    autoApply: z.boolean().optional(),
    priority: z.number().int().min(1).max(10_000).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to update' });

const ruleRunSchema = z.object({
  bankAccountId: z.string().uuid().optional(),
});

const completeSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const billIdParam = z.string().uuid();

const debitFromBillSchema = z.object({
  debitDate: isoDate,
  reason: z.enum(['RETURN', 'OVERCHARGE', 'DISCOUNT', 'CANCELLATION', 'BAD_DEBT', 'OTHER']),
  reasonDetail: z.string().max(500).optional(),
  /*
   * Omit to reverse everything not already reversed. Quantity is the ONLY
   * thing a caller may choose — price, account and tax code all come from the
   * bill, because a debit note that differs from it is not a reversal of it.
   */
  lines: z
    .array(z.object({ billLineId: billIdParam, quantity: quantity.optional() }))
    .min(1)
    .optional(),
});
