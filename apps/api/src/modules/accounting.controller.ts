import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decimal, isoDate, quantity } from '@emil/contracts';
import type { AgeingReport } from '@emil/domain';
import {
  approvalFor,
  createApprovalRule,
  decideApproval,
  pendingApprovals,
  agedPayables,
  agedReceivables,
  checkBankInvariant,
  enterBill,
  applyBankRules,
  importStatement,
  creditFromInvoice,
  issueCreditNote,
  issueInvoice,
  outstandingPayables,
  outstandingReceivables,
  paySupplier,
  recordReceipt,
  reconcileAccount,
  suggestForAccount,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { principalOf, tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';
import { NotFoundError } from '../errors.js';

/**
 * The accounting surface.
 *
 * ---------------------------------------------------------------------------
 * EVERY HANDLER IS THE SAME FOUR LINES: resolve the principal, build a
 * `TenantContext`, call the service inside `withTenant`, return.
 *
 * That sameness is the design. The services already own every rule — balanced
 * entries, gapless numbering, idempotency, tax at the tax point, the append-only
 * ledger. If a handler here started making a decision, it would be a decision
 * made outside the layer that is tested against a real database, and one that
 * an API key or a background job would bypass.
 *
 * So the controller's whole job is: authenticate, authorise, translate. No
 * business logic reaches this file, and a review that finds some has found a
 * bug.
 * ---------------------------------------------------------------------------
 */
@Controller('v1')
export class AccountingController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  // Assembled in `tenantContextOf`, not here. Five copies of this helper is
  // how the audit log ended up with no IP, user agent or request id on any row.
  private ctx(request: FastifyRequest) {
    return tenantContextOf(request);
  }

  // ---- Sales --------------------------------------------------------------

  @Requires('invoice.create')
  @Doc({ request: () => invoiceSchema })
  @Post('invoices')
  async issueInvoice(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(invoiceSchema, body);
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) =>
      issueInvoice(tx, ctx, { ...input, idempotencyKey }),
    );
  }

  @Requires('invoice.read')
  @Get('receivables')
  async receivables(@Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) => outstandingReceivables(tx, ctx));
  }

  @Requires('invoice.read')
  @Get('receivables/ageing')
  async receivablesAgeing(@Query('asOf') asOf: string, @Req() request: FastifyRequest) {
    const asOfDate = parse(isoDate, asOf);
    const ctx = this.ctx(request);
    const report = await withTenant(this.sql, ctx, (tx) => agedReceivables(tx, ctx, asOfDate));
    return renderAgeing(report);
  }

  @Requires('receipt.create')
  @Doc({ request: () => receiptSchema })
  @Post('receipts')
  async recordReceipt(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(receiptSchema, body);
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) => recordReceipt(tx, ctx, { ...input, idempotencyKey }));
  }

  /**
   * Credit an invoice from the invoice itself.
   *
   * The route a user should always take when there IS an invoice: every figure
   * is read off the original, over-crediting is refused per line, and the tax
   * rate is the one that was charged rather than today's. `POST /v1/credit-notes`
   * remains for a standalone customer credit, which corrects no particular
   * supply and therefore has no original to read.
   */
  @Requires('creditnote.create')
  @Doc({ request: () => creditFromInvoiceSchema })
  @Post('invoices/:id/credit-note')
  async creditInvoice(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(creditFromInvoiceSchema, body);
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) =>
      creditFromInvoice(tx, ctx, {
        ...input,
        invoiceId: parse(uuidParam, id),
        idempotencyKey,
      }),
    );
  }

  @Requires('creditnote.create')
  @Doc({ request: () => creditNoteSchema })
  @Post('credit-notes')
  async issueCreditNote(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(creditNoteSchema, body);
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) =>
      issueCreditNote(tx, ctx, { ...input, idempotencyKey }),
    );
  }

  // ---- Purchases ----------------------------------------------------------

  @Requires('bill.create')
  @Doc({ request: () => billSchema })
  @Post('bills')
  async enterBill(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(billSchema, body);
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) => enterBill(tx, ctx, { ...input, idempotencyKey }));
  }

  @Requires('bill.read')
  @Get('payables')
  async payables(@Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) => outstandingPayables(tx, ctx));
  }

  @Requires('bill.read')
  @Get('payables/ageing')
  async payablesAgeing(@Query('asOf') asOf: string, @Req() request: FastifyRequest) {
    const asOfDate = parse(isoDate, asOf);
    const ctx = this.ctx(request);
    const report = await withTenant(this.sql, ctx, (tx) => agedPayables(tx, ctx, asOfDate));
    return renderAgeing(report);
  }

  @Requires('payment.create')
  @Doc({ request: () => supplierPaymentSchema })
  @Post('supplier-payments')
  async paySupplier(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(supplierPaymentSchema, body);
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) => paySupplier(tx, ctx, { ...input, idempotencyKey }));
  }

  // ---- Bill approval ------------------------------------------------------

  @Requires('bill.approve')
  @Get('approvals')
  async pendingApprovals(@Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    return { pending: await withTenant(this.sql, ctx, (tx) => pendingApprovals(tx, ctx)) };
  }

  @Requires('bill.read')
  @Get('bills/:id/approval')
  async billApproval(@Param('id') billId: string, @Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    const approval = await withTenant(this.sql, ctx, (tx) => approvalFor(tx, ctx, billId));

    if (approval === null) {
      // No routing rule matched, so nothing is waiting. Reported as a state
      // rather than a 404: "this bill needs no approval" is the answer, and a
      // 404 would read as "no such bill".
      return { billId, status: 'NOT_REQUIRED', outstanding: [], decisions: [] };
    }

    return {
      billId,
      status: approval.state.status,
      amount: approval.amount,
      outstanding: approval.state.outstanding,
      decisions: approval.decisions,
      violations: approval.state.violations,
    };
  }

  @Requires('bill.approve')
  @Doc({ request: () => decideApprovalSchema })
  @Post('bills/:id/approval')
  async decideApproval(
    @Param('id') billId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const principal = principalOf(request);
    const input = parse(decideApprovalSchema,
      body,
    );

    const ctx = this.ctx(request);
    // The actor's role comes from the resolved principal, never from the body.
    // A client-supplied role would make the whole separation of duties
    // advisory.
    const result = await withTenant(this.sql, ctx, (tx) =>
      decideApproval(tx, ctx, { ...input, billId, actorRole: principal.role }),
    );

    return {
      billId,
      status: result.state.status,
      outstanding: result.state.outstanding,
    };
  }

  @Requires('org.manage')
  @Doc({ request: () => statementSchema })
  @Post('approval-rules')
  async createApprovalRule(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(createApprovalRuleSchema,
      body,
    );

    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) => createApprovalRule(tx, ctx, input));
  }

  // ---- Banking ------------------------------------------------------------

  /**
   * Import, then run the bank rules over the account — one transaction.
   *
   * The importer holds `bank.import`, not `journal.post`, and the auto-apply
   * postings happen anyway. That is deliberate, not an escalation: the
   * standing authorisation was granted when someone with `bank.reconcile`
   * flipped `autoApply` on the rule. The importer merely delivers the
   * statement the rule was waiting for — the same shape as a POS cashier
   * whose sale posts COGS without holding `journal.post`. Every posting is
   * an ordinary RULE-method match, named after its rule, reversible with
   * `unmatch`, and reported in the response so the importer sees what was
   * coded the moment it happens.
   */
  @Requires('bank.import')
  @Doc({ request: () => statementSchema })
  @Post('bank-accounts/:id/statements')
  async importStatement(
    @Param('id') bankAccountId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(statementSchema, body);
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, async (tx) => {
      const imported = await importStatement(tx, ctx, { ...input, bankAccountId, idempotencyKey });
      const rules = await applyBankRules(tx, ctx, { bankAccountId });
      return { ...imported, autoCategorised: rules.applied, ruleSuggestions: rules.suggestedOnly };
    });
  }

  @Requires('bank.reconcile')
  @Get('bank-accounts/:id/suggestions')
  async suggestions(@Param('id') bankAccountId: string, @Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    const byLine = await withTenant(this.sql, ctx, (tx) =>
      suggestForAccount(tx, ctx, bankAccountId),
    );

    return {
      lines: [...byLine.entries()].map(([bankTransactionId, suggestions]) => ({
        bankTransactionId,
        suggestions: suggestions.map((s) => ({
          candidateIds: s.candidateIds,
          kind: s.kind,
          confidence: s.confidence,
          // Never omitted: a user will not accept a match they cannot explain
          // to their auditor.
          reason: s.reason,
          amountDifference: s.amountDifference.toDecimalString(),
          dayDifference: s.dayDifference,
        })),
      })),
    };
  }

  @Requires('bank.read')
  @Get('bank-accounts/:id/reconciliation')
  async reconciliation(
    @Param('id') bankAccountId: string,
    @Query('asOf') asOf: string,
    @Req() request: FastifyRequest,
  ) {
    const asOfDate = parse(isoDate, asOf);
    const ctx = this.ctx(request);

    const [result, invariant] = await withTenant(this.sql, ctx, async (tx) => [
      await reconcileAccount(tx, ctx, bankAccountId, asOfDate),
      await checkBankInvariant(tx, ctx, bankAccountId, asOfDate),
    ]);

    return {
      asOfDate: result.asOfDate,
      adjustedBankBalance: result.adjustedBankBalance.toDecimalString(),
      adjustedBookBalance: result.adjustedBookBalance.toDecimalString(),
      variance: result.variance.toDecimalString(),
      reconciles: result.reconciles,
      unpresentedPayments: result.unpresentedPayments.toDecimalString(),
      depositsInTransit: result.depositsInTransit.toDecimalString(),
      unrecordedBankMovement: result.unrecordedBankMovement.toDecimalString(),
      counts: result.counts,
      // Invariant #8, reported with the precondition it depends on rather than
      // as a bare boolean that would read as false on every real account.
      invariantEight: {
        holds: invariant.holds,
        fullyReconciled: invariant.fullyReconciled,
        expected: invariant.expected.toDecimalString(),
        actual: invariant.actual.toDecimalString(),
      },
    };
  }

  // Reporting lives in `reports.controller.ts` — trial balance, SOPL, SOFP,
  // cash flow, changes in equity, the general ledger and the CSV exports are
  // one surface and belong in one file.

  @Get('organisation')
  async organisation(@Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    const [row] = await withTenant(this.sql, ctx, (tx) =>
      tx<{ id: string; name: string; base_currency: string; reporting_framework: string }[]>`
          SELECT id, name, base_currency, reporting_framework
            FROM organisation WHERE id = ${ctx.tenantId}
      `,
    );
    if (!row) throw new NotFoundError('Organisation');
    return {
      id: row.id,
      name: row.name,
      baseCurrency: row.base_currency,
      reportingFramework: row.reporting_framework,
    };
  }
}

// ---------------------------------------------------------------------------
// Schemas
//
// Money is a DECIMAL STRING on the wire, never a JSON number. A JSON number is
// an IEEE-754 double, and 0.1 + 0.2 is not 0.3 — accepting one would put a
// float in the one place this system has been careful to keep them out of.
// ---------------------------------------------------------------------------

/**
 * One document line.
 *
 * `description`, `unitPrice`, `accountId` and `taxCodeId` became OPTIONAL when
 * the item catalogue landed: a line carrying an `itemId` takes them from the
 * item, and anything supplied overrides. The service refuses a line that has
 * neither an item nor the fields, naming what is missing — Zod cannot express
 * "required unless a sibling field is present" without a refinement that would
 * report the failure less clearly than the service does.
 *
 * `quantity` stays required. An item has no inherent quantity, and a line that
 * silently became "1" is a wrong invoice.
 */
const documentLine = z.object({
  quantity,
  itemId: z.string().uuid().optional(),
  description: z.string().min(1).optional(),
  unitPrice: decimal.optional(),
  accountId: z.string().uuid().optional(),
  taxCodeId: z.string().uuid().optional(),
  unitOfMeasure: z.string().min(1).max(50).optional(),
  discountBasisPoints: z.number().int().min(0).max(10_000).optional(),
  /** For a serialised item: one serial per unit on this line. */
  serialNumbers: z.array(z.string().min(1).max(120)).max(1000).optional(),
  /**
   * LHDN item classification, per line.
   *
   * Accepted at issue time rather than asked for at submission, because by then
   * the invoice has been sent to the customer and correcting it means a credit
   * note. `issueInvoice` has stored it since M6; the route simply never let a
   * caller supply one.
   */
  classificationCode: z.string().max(20).optional(),
});

/**
 * A credit-note line.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY NOT ITEM-AWARE, WHERE INVOICES AND BILLS ARE.
 *
 * A credit note reverses something that was already charged, so its price must
 * come from what the customer was ACTUALLY billed — not from the catalogue as
 * it stands today. Defaulting an item's current price onto a credit note
 * against a six-month-old invoice would credit RM 95 against a sale of RM 80,
 * and the difference lands in revenue with nothing flagging it.
 *
 * Crediting from the original document is the right feature and is not built.
 * Until it is, the line carries its own figures, which is at least honest about
 * where they came from.
 * ---------------------------------------------------------------------------
 */
const reversalLine = z.object({
  description: z.string().min(1),
  quantity,
  unitPrice: decimal,
  accountId: z.string().uuid(),
  taxCodeId: z.string().uuid(),
  itemId: z.string().uuid().optional(),
  discountBasisPoints: z.number().int().min(0).max(10_000).optional(),
  classificationCode: z.string().min(1).max(20).optional(),
});

const invoiceSchema = z.object({
  contactId: z.string().uuid(),
  issueDate: isoDate,
  dueDate: isoDate.optional(),
  taxPointDate: isoDate.optional(),
  currency: z.string().length(3).optional(),
  fxRate: z.string().optional(),
  amountsAreTaxInclusive: z.boolean().optional(),
  reference: z.string().optional(),
  lines: z.array(documentLine).min(1),
});

const billSchema = z.object({
  supplierId: z.string().uuid(),
  billNo: z.string().min(1),
  billDate: isoDate,
  dueDate: isoDate.optional(),
  taxPointDate: isoDate.optional(),
  currency: z.string().length(3).optional(),
  fxRate: z.string().optional(),
  amountsAreTaxInclusive: z.boolean().optional(),
  reference: z.string().optional(),
  lines: z.array(documentLine).min(1),
});

const receiptSchema = z.object({
  contactId: z.string().uuid(),
  paymentDate: isoDate,
  amount: decimal,
  method: z.enum(['FPX', 'DUITNOW', 'CARD', 'CHEQUE', 'CASH', 'TRANSFER', 'OTHER']),
  depositAccountId: z.string().uuid(),
  currency: z.string().length(3).optional(),
  fxRate: z.string().optional(),
  reference: z.string().optional(),
  allocations: z
    .array(z.object({ invoiceId: z.string().uuid(), amount: decimal }))
    .optional(),
});

const supplierPaymentSchema = z.object({
  supplierId: z.string().uuid(),
  paymentDate: isoDate,
  amount: decimal,
  method: z.enum(['FPX', 'DUITNOW', 'CARD', 'CHEQUE', 'CASH', 'TRANSFER', 'OTHER']),
  depositAccountId: z.string().uuid(),
  currency: z.string().length(3).optional(),
  fxRate: z.string().optional(),
  reference: z.string().optional(),
  allocations: z.array(z.object({ billId: z.string().uuid(), amount: decimal })).optional(),
  withholding: z
    .object({ paymentType: z.string().min(1), countryCode: z.string().length(2).optional() })
    .optional(),
});

const creditNoteSchema = z.object({
  contactId: z.string().uuid(),
  invoiceId: z.string().uuid().optional(),
  creditDate: isoDate,
  taxPointDate: isoDate.optional(),
  reason: z.enum(['RETURN', 'OVERCHARGE', 'DISCOUNT', 'CANCELLATION', 'BAD_DEBT', 'OTHER']),
  reasonDetail: z.string().optional(),
  currency: z.string().length(3).optional(),
  amountsAreTaxInclusive: z.boolean().optional(),
  lines: z.array(reversalLine).min(1),
  allocations: z.array(z.object({ invoiceId: z.string().uuid(), amount: decimal })).optional(),
});

const statementSchema = z.object({
  content: z.string().min(1),
  statementDate: isoDate,
  profileId: z.string().uuid().optional(),
  fileName: z.string().optional(),
  profile: z
    .object({
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
    })
    .optional(),
});

// ---------------------------------------------------------------------------

function renderAgeing(report: AgeingReport) {
  return {
    asOfDate: report.asOfDate,
    buckets: report.buckets.map((b) => ({
      key: b.key,
      label: b.label,
      total: b.total.toDecimalString(),
      count: b.count,
    })),
    total: report.total.toDecimalString(),
  };
}

const decideApprovalSchema = z.object({
  sequence: z.number().int().min(1),
  decision: z.enum(['APPROVE', 'REJECT']),
  comment: z.string().optional(),
});

const createApprovalRuleSchema = z.object({
  name: z.string().min(1),
  minAmount: decimal,
  maxAmount: decimal.optional(),
  requiredRole: z.enum([
    'OWNER', 'ADMIN', 'ACCOUNTANT', 'APPROVER',
    'BOOKKEEPER', 'SALES', 'READ_ONLY', 'EXTERNAL_AUDITOR',
  ]),
  sequence: z.number().int().min(1),
});

const uuidParam = z.string().uuid();

const creditFromInvoiceSchema = z.object({
  creditDate: isoDate,
  reason: z.enum(['RETURN', 'OVERCHARGE', 'DISCOUNT', 'CANCELLATION', 'BAD_DEBT', 'OTHER']),
  reasonDetail: z.string().max(500).optional(),
  /*
   * Omit to credit everything not already credited. Per-line quantities are
   * how a partial return is expressed — and the quantity is the ONLY thing a
   * caller may choose. Price, account, tax code and classification all come
   * from the original, because a credit that differs from the sale in any of
   * them is not a reversal of that sale.
   */
  lines: z
    .array(z.object({ invoiceLineId: uuidParam, quantity: quantity.optional() }))
    .min(1)
    .optional(),
});
