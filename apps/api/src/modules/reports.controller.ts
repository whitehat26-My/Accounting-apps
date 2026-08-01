import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  toCsv,
  type CashFlowStatement,
  type EquityStatement,
  type RenderedReport,
} from '@emil/domain';
import {
  cashFlowStatement,
  equityStatement,
  generalLedger,
  generalLedgerCsv,
  journalReport,
  listCashFlowClassifications,
  setCashFlowClassification,
  statementOfFinancialPosition,
  statementOfProfitOrLoss,
  trialBalanceCsv,
  trialBalanceReport,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * Reporting.
 *
 * Split out of `accounting.controller.ts` rather than added to it: the reports
 * are one surface — statements, the ledger behind them, and the exports of
 * both — and a controller that also issues invoices and pays suppliers is not
 * where the next reporting route should land.
 *
 * ---------------------------------------------------------------------------
 * MONEY LEAVES THIS FILE AS A DECIMAL STRING, ALWAYS.
 *
 * A `Money` holds a `bigint`, and `JSON.stringify` THROWS on one — so a handler
 * that returns a domain object straight out answers 500. That is how the
 * e-invoice document route failed. Every statement here therefore goes through
 * an explicit renderer, which is also the only place the wire shape is decided.
 * ---------------------------------------------------------------------------
 */
@Controller('v1')
export class ReportsController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  private ctx(request: FastifyRequest) {
    return tenantContextOf(request);
  }

  // ---- The statements -----------------------------------------------------

  @Requires('report.read')
  @Get('reports/trial-balance')
  async trialBalance(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) =>
      trialBalanceReport(tx, ctx, { from: parse(isoDate, from), to: parse(isoDate, to) }),
    );
  }

  @Requires('report.read')
  @Get('reports/sopl')
  async sopl(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    const report = await withTenant(this.sql, ctx, (tx) =>
      statementOfProfitOrLoss(tx, ctx, { from: parse(isoDate, from), to: parse(isoDate, to) }),
    );
    return renderReport(report);
  }

  @Requires('report.read')
  @Get('reports/sofp')
  async sofp(@Query('asOf') asOf: string, @Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    const report = await withTenant(this.sql, ctx, (tx) =>
      statementOfFinancialPosition(tx, ctx, { asOfDate: parse(isoDate, asOf) }),
    );
    return renderReport(report);
  }

  /**
   * The statement of cash flows.
   *
   * `check` and `rollupAgrees` are part of the response rather than swallowed:
   * a cash flow statement that does not reconcile, or that disagrees with the
   * balance sheet's idea of closing cash, must say so where the reader will
   * see it. Returning the numbers and hiding the doubt is the failure mode this
   * whole slice is built to avoid.
   */
  @Requires('report.read')
  @Get('reports/cash-flow')
  async cashFlow(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    const result = await withTenant(this.sql, ctx, (tx) =>
      cashFlowStatement(tx, ctx, { from: parse(isoDate, from), to: parse(isoDate, to) }),
    );

    return {
      ...renderCashFlow(result.statement),
      reconciles: result.check.reconciles,
      difference: result.check.difference.toDecimalString(),
      violations: result.check.violations,
      rollupAgrees: result.rollupAgrees,
      rollupClosingCash: result.rollupClosingCash,
    };
  }

  @Requires('report.read')
  @Get('reports/changes-in-equity')
  async changesInEquity(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    const result = await withTenant(this.sql, ctx, (tx) =>
      equityStatement(tx, ctx, { from: parse(isoDate, from), to: parse(isoDate, to) }),
    );

    return {
      ...renderEquity(result.statement),
      consistent: result.check.consistent,
      violations: result.check.violations,
    };
  }

  // ---- Cash flow classification -------------------------------------------

  @Requires('report.read')
  @Get('reports/cash-flow/classifications')
  async classifications(@Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) => listCashFlowClassifications(tx, ctx));
  }

  /**
   * `org.manage`, not `report.read`: this is chart-of-accounts configuration
   * that changes every cash flow statement the business will ever print,
   * including ones already sent to a bank.
   */
  @Requires('org.manage')
  @Post('reports/cash-flow/classifications')
  async classify(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(classificationSchema, body);
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) => setCashFlowClassification(tx, ctx, input));
  }

  // ---- The ledger behind the statements -----------------------------------

  @Requires('journal.read')
  @Get('reports/general-ledger/:accountId')
  async generalLedger(
    @Param('accountId') accountId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('limit') limit: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) =>
      generalLedger(tx, ctx, {
        accountId: parse(uuid, accountId),
        from: parse(isoDate, from),
        to: parse(isoDate, to),
        ...(limit !== undefined ? { limit: parse(positiveInt, limit) } : {}),
      }),
    );
  }

  @Requires('journal.read')
  @Get('reports/journal')
  async journal(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('sourceModule') sourceModule: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) =>
      journalReport(tx, ctx, {
        from: parse(isoDate, from),
        to: parse(isoDate, to),
        ...(sourceModule !== undefined ? { sourceModule: parse(module_, sourceModule) } : {}),
        ...(limit !== undefined ? { limit: parse(positiveInt, limit) } : {}),
      }),
    );
  }

  // ---- Exports ------------------------------------------------------------
  //
  // CSV is rendered in `@emil/db`, not here, because every cell has to pass
  // through the formula-injection guard in `packages/domain/src/csv.ts` and a
  // route that assembled its own rows would be one `join(',')` away from
  // shipping a live `=HYPERLINK(...)` into an accountant's spreadsheet.

  @Requires('journal.read')
  @Get('reports/general-ledger/:accountId/export')
  async generalLedgerExport(
    @Param('accountId') accountId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = this.ctx(request);
    const ledger = await withTenant(this.sql, ctx, (tx) =>
      generalLedger(tx, ctx, {
        accountId: parse(uuid, accountId),
        from: parse(isoDate, from),
        to: parse(isoDate, to),
      }),
    );

    send(reply, `general-ledger-${ledger.code}-${ledger.from}-to-${ledger.to}.csv`,
      generalLedgerCsv(ledger));
  }

  @Requires('report.read')
  @Get('reports/trial-balance/export')
  async trialBalanceExport(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = this.ctx(request);
    const window = { from: parse(isoDate, from), to: parse(isoDate, to) };
    const report = await withTenant(this.sql, ctx, (tx) =>
      trialBalanceReport(tx, ctx, window),
    );

    send(reply, `trial-balance-${window.from}-to-${window.to}.csv`,
      trialBalanceCsv(report, window));
  }

  @Requires('report.read')
  @Get('reports/cash-flow/export')
  async cashFlowExport(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = this.ctx(request);
    const window = { from: parse(isoDate, from), to: parse(isoDate, to) };
    const result = await withTenant(this.sql, ctx, (tx) => cashFlowStatement(tx, ctx, window));

    send(reply, `cash-flow-${window.from}-to-${window.to}.csv`,
      cashFlowCsv(result.statement, result.check.reconciles));
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD');
const uuid = z.string().uuid();
const positiveInt = z.coerce.number().int().positive().max(100_000);
const module_ = z.enum(['SALES', 'PURCHASES', 'BANKING', 'MANUAL', 'SYSTEM']);

const classificationSchema = z.object({
  accountId: uuid,
  classification: z.enum(['OPERATING', 'INVESTING', 'FINANCING']),
  note: z.string().max(500).optional(),
});

// ---------------------------------------------------------------------------
// Renderers — the only place a Money becomes a wire value
// ---------------------------------------------------------------------------

function renderReport(report: RenderedReport) {
  return {
    lines: report.lines.map((l) => ({
      label: l.label,
      level: l.level,
      lineType: l.lineType,
      amount: l.amount.toDecimalString(),
      ...(l.comparative !== undefined ? { comparative: l.comparative.toDecimalString() } : {}),
    })),
  };
}

function renderCashFlow(statement: CashFlowStatement) {
  return {
    periodStart: statement.periodStart,
    periodEnd: statement.periodEnd,
    currency: statement.currency,
    sections: statement.sections.map((s) => ({
      activity: s.activity,
      subtotal: s.subtotal.toDecimalString(),
      lines: s.lines.map((l) => ({
        accountId: l.accountId,
        code: l.code,
        name: l.name,
        amount: l.amount.toDecimalString(),
        entryCount: l.entryCount,
      })),
    })),
    netCashFlow: statement.netCashFlow.toDecimalString(),
    openingCash: statement.openingCash.toDecimalString(),
    closingCash: statement.closingCash.toDecimalString(),
    entryCount: statement.entryCount,
    unclassifiedAccounts: statement.unclassifiedAccounts,
  };
}

function renderEquity(statement: EquityStatement) {
  return {
    periodStart: statement.periodStart,
    periodEnd: statement.periodEnd,
    currency: statement.currency,
    components: statement.components.map((c) => ({
      kind: c.kind,
      key: c.key,
      code: c.code,
      label: c.label,
      opening: c.opening.toDecimalString(),
      movement: c.movement.toDecimalString(),
      closing: c.closing.toDecimalString(),
    })),
    openingEquity: statement.openingEquity.toDecimalString(),
    profitForPeriod: statement.profitForPeriod.toDecimalString(),
    otherMovements: statement.otherMovements.toDecimalString(),
    closingEquity: statement.closingEquity.toDecimalString(),
  };
}

function cashFlowCsv(statement: CashFlowStatement, reconciles: boolean): string {
  const rows: string[][] = [
    ['Statement of cash flows'],
    ['Period', `${display(statement.periodStart)} to ${display(statement.periodEnd)}`],
    ['Currency', statement.currency],
    [],
  ];

  for (const section of statement.sections) {
    // An empty INVESTING or FINANCING section is meaningful — it says nothing
    // happened — but an empty UNCLASSIFIED one is just noise on a clean report.
    if (section.activity === 'UNCLASSIFIED' && section.lines.length === 0) continue;

    rows.push([label(section.activity)]);
    for (const line of section.lines) {
      rows.push(['', `${line.code} ${line.name}`, line.amount.toDecimalString()]);
    }
    rows.push(['', `Net cash from ${label(section.activity).toLowerCase()}`, section.subtotal.toDecimalString()]);
    rows.push([]);
  }

  rows.push(['', 'Net change in cash', statement.netCashFlow.toDecimalString()]);
  rows.push(['', 'Cash at the start of the period', statement.openingCash.toDecimalString()]);
  rows.push(['', 'Cash at the end of the period', statement.closingCash.toDecimalString()]);

  if (!reconciles) {
    // On the face of the exported statement, not in a log. A file that does not
    // reconcile and does not say so is the one that gets sent to a bank.
    rows.push([]);
    rows.push([
      '',
      'WARNING — this statement does not reconcile to the movement in cash. Do not rely on it.',
    ]);
  }

  if (statement.unclassifiedAccounts.length > 0) {
    rows.push([]);
    rows.push(['', 'Accounts awaiting a cash flow classification:']);
    for (const a of statement.unclassifiedAccounts) rows.push(['', `${a.code} ${a.name}`]);
  }

  return toCsv(rows);
}

function label(activity: string): string {
  return activity.charAt(0) + activity.slice(1).toLowerCase() + ' activities';
}

function display(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Send a CSV as a download.
 *
 * `Content-Disposition: attachment` matters beyond convenience: without it a
 * browser may render the response inline, and an inline-rendered file served
 * from the API's own origin is a content-injection surface. `X-Content-Type-
 * Options: nosniff` stops a browser second-guessing the declared type.
 */
function send(reply: FastifyReply, filename: string, body: string): void {
  void reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename.replace(/[^\w.@-]/g, '_')}"`)
    .header('x-content-type-options', 'nosniff')
    .send(body);
}
