import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDate, isoInstant, uuid } from '@emil/contracts';
import {
  toCsv,
  type CashFlowStatement,
  type EquityStatement,
  type RenderedReport,
} from '@emil/domain';
import {
  cashForecast,
  cashFlowStatement,
  dailyTakingsSeries,
  listWeeklyDigests,
  equityStatement,
  generalLedger,
  generalLedgerCsv,
  journalReport,
  listCashFlowClassifications,
  setCashFlowClassification,
  statementOfFinancialPosition,
  statementOfProfitOrLoss,
  customerStatement,
  customersWithBalances,
  sellerBlock,
  trialBalanceCsv,
  trialBalanceReport,
  withTenant,
  type Sql,
  itemMargins,
  repairProfitability,
  stockAgeing,
  freeCash,
  fraudWatch,
  booksAsAt,
  whatChanged,
  lockMoments,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';
import { renderStatementPdf } from '../pdf/render.js';

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

  // ---- Customer statements ------------------------------------------------

  /**
   * Who owes something, so a shop can run the month's statements without first
   * working out which customers to run them for.
   */
  @Requires('report.read')
  @Get('statements')
  async statementList(@Query('asOf') asOf: string, @Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, async (tx) => ({
      asOf: parse(isoDate, asOf),
      customers: await customersWithBalances(tx, ctx, parse(isoDate, asOf)),
    }));
  }

  /**
   * One customer's account over a period.
   *
   * A GET with the customer in the path and the dates in the query, because
   * unlike a payslip there is nothing confidential in the URL that is not
   * already in the path — and a statement is the kind of thing somebody wants
   * to bookmark and re-open.
   */
  /** The same statement, as the page you post or attach to an email. */
  @Requires('report.read')
  @Get('statements/:contactId/pdf')
  async statementPdf(
    @Param('contactId') contactId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = this.ctx(request);
    const { statement, seller } = await withTenant(this.sql, ctx, async (tx) => ({
      statement: await customerStatement(
        tx,
        ctx,
        parse(uuid, contactId),
        parse(isoDate, from),
        parse(isoDate, to),
      ),
      seller: await sellerBlock(tx, ctx),
    }));

    const pdf = await renderStatementPdf(statement, seller);
    void reply
      .header('content-type', 'application/pdf')
      .header(
        'content-disposition',
        `inline; filename="statement-${statement.to}.pdf"`,
      )
      .send(pdf);
  }

  @Requires('report.read')
  @Get('statements/:contactId')
  async statement(
    @Param('contactId') contactId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) =>
      customerStatement(
        tx,
        ctx,
        parse(uuid, contactId),
        parse(isoDate, from),
        parse(isoDate, to),
      ),
    );
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

  /**
   * The second pair of eyes — audit techniques on a five-person shop.
   *
   * Read-only and non-blocking by design: it never stops a payment or flags a
   * record, because an automated control that stops work gets worked around
   * within a fortnight. It makes a person look, and a person looking is the
   * control. Every finding carries its innocent explanation.
   */
  @Requires('report.read')
  @Get('reports/fraud-watch')
  async fraudWatchReport(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) =>
      fraudWatch(tx, ctx, { from: parse(isoDate, from), to: parse(isoDate, to) }),
    );
  }

  /**
   * How much of the bank balance is actually the shop's.
   *
   * The most misread number in a small business is the bank balance: it
   * contains the EPF, SOCSO, PCB and SST the shop is HOLDING for other
   * people. This subtracts them and reports what is left, with a verdict
   * loud enough to stop a stock purchase that would spend the float.
   */
  @Requires('report.read')
  @Get('reports/free-cash')
  async freeCashReport(@Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    const position = await withTenant(this.sql, ctx, (tx) => freeCash(tx, ctx));
    return {
      ...position,
      bankBalance: position.bankBalance.toDecimalString(),
      totalHeld: position.totalHeld.toDecimalString(),
      freeCash: position.freeCash.toDecimalString(),
      held: position.held.map((h) => ({ ...h, amount: h.amount.toDecimalString() })),
      soonest:
        position.soonest === null
          ? null
          : { ...position.soonest, amount: position.soonest.amount.toDecimalString() },
    };
  }

  /**
   * What is sitting on the shelf and for how long — the dead-stock report.
   * Derived entirely from the append-only movement history; no new state.
   */
  @Requires('report.read')
  @Get('reports/stock-ageing')
  async stockAgeingReport(@Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    return { rows: await withTenant(this.sql, ctx, (tx) => stockAgeing(tx, ctx)) };
  }

  @Requires('report.read')
  @Get('reports/stock-ageing/csv')
  async stockAgeingCsv(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const ctx = this.ctx(request);
    const rows = await withTenant(this.sql, ctx, (tx) => stockAgeing(tx, ctx));
    send(
      reply,
      'stock-ageing.csv',
      toCsv([
        ['Code', 'Item', 'On hand', 'Value (RM)', 'Last sold', 'Last received', 'Days idle', 'Bucket'],
        ...rows.map((r) => [
          r.code, r.name, r.quantityOnHand, r.stockValue,
          r.lastSoldOn === null ? 'never' : display(r.lastSoldOn),
          r.lastReceivedOn === null ? '' : display(r.lastReceivedOn),
          String(r.daysIdle), r.bucket,
        ]),
      ]),
    );
  }

  /**
   * Margin by item, WORST first — "what am I selling for nothing". Reads the
   * frozen invoice lines and the perpetual-inventory reliefs those same sales
   * posted, so it cannot disagree with the P&L.
   */
  @Requires('report.read')
  @Get('reports/item-margins')
  async itemMarginsReport(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    return {
      rows: await withTenant(this.sql, ctx, (tx) =>
        itemMargins(tx, ctx, { from: parse(isoDate, from), to: parse(isoDate, to) }),
      ),
    };
  }

  @Requires('report.read')
  @Get('reports/item-margins/csv')
  async itemMarginsCsv(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = this.ctx(request);
    const rows = await withTenant(this.sql, ctx, (tx) =>
      itemMargins(tx, ctx, { from: parse(isoDate, from), to: parse(isoDate, to) }),
    );
    send(
      reply,
      `item-margins-${from}-to-${to}.csv`,
      toCsv([
        ['Code', 'Item', 'Qty sold', 'Revenue (RM)', 'Cost (RM)', 'Margin (RM)', 'Margin %'],
        ...rows.map((r) => [
          r.code, r.name, r.quantitySold, r.revenue, r.cost, r.margin,
          r.marginBp === null ? '' : (r.marginBp / 100).toFixed(2),
        ]),
      ]),
    );
  }

  /** Collected repairs: billed, parts off the shelf, and what was left. */
  @Requires('report.read')
  @Get('reports/repair-profit')
  async repairProfitReport(
    @Query('from') from: string,
    @Query('to') to: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    return withTenant(this.sql, ctx, (tx) =>
      repairProfitability(tx, ctx, { from: parse(isoDate, from), to: parse(isoDate, to) }),
    );
  }

  // ---- The time machine ---------------------------------------------------

  /**
   * The books as they stood at a past instant.
   *
   * Not a reconstruction: the ledger is append-only, so this is one predicate
   * over rows that still exist — see `packages/domain/src/time-machine.ts`.
   * The optional `from`/`to` restrict it to entries DATED in a window, which
   * is how you ask "March, as March was reported".
   */
  @Requires('report.read')
  @Get('reports/books-as-at')
  async booksAsAtReport(
    @Query('asAt') asAt: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    const books = await withTenant(this.sql, ctx, (tx) =>
      booksAsAt(tx, ctx, { asAt: parse(isoInstant, asAt), ...window_(from, to) }),
    );
    return { ...books, balances: books.balances.map(renderBalance) };
  }

  /**
   * What moved between two instants, and who moved it.
   *
   * The question this whole feature exists for: "I closed March on 5 April and
   * the figure is different now — what changed?" No other package for a shop
   * this size answers it, because answering it requires a ledger that was
   * never edited.
   */
  @Requires('report.read')
  @Get('reports/what-changed')
  async whatChangedReport(
    @Query('since') since: string,
    @Query('until') until: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() request: FastifyRequest,
  ) {
    const ctx = this.ctx(request);
    const diff = await withTenant(this.sql, ctx, (tx) =>
      whatChanged(tx, ctx, {
        since: parse(isoInstant, since),
        // Defaulting `until` to now is the common case — "since I closed it,
        // what has happened" — and saves the caller stamping a clock.
        until: until === undefined ? new Date().toISOString() : parse(isoInstant, until),
        ...window_(from, to),
      }),
    );
    return {
      ...diff,
      changes: diff.changes.map((c) => ({
        accountId: c.accountId,
        code: c.code,
        name: c.name,
        before: c.before.toDecimalString(),
        after: c.after.toDecimalString(),
        delta: c.delta.toDecimalString(),
      })),
    };
  }

  @Requires('report.read')
  @Get('reports/what-changed/csv')
  async whatChangedCsv(
    @Query('since') since: string,
    @Query('until') until: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = this.ctx(request);
    const diff = await withTenant(this.sql, ctx, (tx) =>
      whatChanged(tx, ctx, {
        since: parse(isoInstant, since),
        until: until === undefined ? new Date().toISOString() : parse(isoInstant, until),
        ...window_(from, to),
      }),
    );
    send(
      reply,
      `what-changed-since-${diff.since.slice(0, 10)}.csv`,
      toCsv([
        ['Account', 'Name', 'Before (RM)', 'After (RM)', 'Change (RM)'],
        ...diff.changes.map((c) => [
          c.code, c.name,
          c.before.toDecimalString(), c.after.toDecimalString(), c.delta.toDecimalString(),
        ]),
        [],
        // The entries responsible go in the SAME file. Two downloads to answer
        // one question is how the second one gets lost.
        ['Entry', 'Dated', 'Posted', 'Why', 'Posted by', 'Source', 'Description'],
        ...diff.entries.map((e) => [
          e.entryNo, display(e.entryDate), e.postedAt, e.kind,
          e.postedByName ?? 'unknown', e.sourceModule, e.description ?? '',
        ]),
      ]),
    );
  }

  /**
   * The instants worth comparing against — when periods were locked, unlocked
   * or closed. Without these the screen asks for a timestamp, and nobody knows
   * theirs.
   */
  @Requires('report.read')
  @Get('reports/lock-moments')
  async lockMomentsReport(@Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    return { moments: await withTenant(this.sql, ctx, (tx) => lockMoments(tx, ctx)) };
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
  /**
   * 30/60/90-day cash forecast from dated commitments only — overdue
   * receivables reported as unknown-timing upside, never spent in advance.
   */
  @Requires('report.read')
  @Get('reports/cash-forecast')
  async cashForecastReport(@Req() request: FastifyRequest) {
    const ctx = this.ctx(request);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const forecast = await withTenant(this.sql, ctx, (tx) => cashForecast(tx, ctx, today));

    return {
      asOf: forecast.asOf,
      openingCash: forecast.openingCash.toDecimalString(),
      horizons: forecast.horizons.map((h) => ({
        days: h.days,
        until: h.until,
        inflows: h.inflows.toDecimalString(),
        outflows: h.outflows.toDecimalString(),
        net: h.net.toDecimalString(),
        closing: h.closing.toDecimalString(),
      })),
      overdueReceivables: {
        total: forecast.overdueReceivables.total.toDecimalString(),
        count: forecast.overdueReceivables.count,
      },
      overduePayables: {
        total: forecast.overduePayables.total.toDecimalString(),
        count: forecast.overduePayables.count,
      },
    };
  }

  /** The chart behind the Z-report: one point per day, zero days included. */
  @Requires('report.read')
  @Get('reports/daily-takings')
  async dailyTakingsChart(@Req() request: FastifyRequest, @Query('days') days?: string) {
    const parsed = parse(dailySeriesSchema, { days });
    const ctx = this.ctx(request);
    const to = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const fromDate = new Date(`${to}T00:00:00Z`);
    fromDate.setUTCDate(fromDate.getUTCDate() - ((parsed.days ?? 14) - 1));
    const from = fromDate.toISOString().slice(0, 10);

    const points = await withTenant(this.sql, ctx, (tx) =>
      dailyTakingsSeries(tx, ctx, from, to),
    );
    return { from, to, points };
  }

  /**
   * The stored weekly digests, newest first. Read-only by design: digests are
   * written by the worker once per completed week and never recomputed, so
   * the report the owner read in July still reads the same in November.
   */
  @Requires('report.read')
  @Get('reports/weekly-digests')
  async weeklyDigests(@Req() request: FastifyRequest, @Query('limit') limit?: string) {
    const ctx = this.ctx(request);
    const parsed = parse(digestListSchema, { limit });
    const rows = await withTenant(this.sql, ctx, (tx) =>
      listWeeklyDigests(tx, ctx, parsed.limit),
    );
    return { digests: rows };
  }

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
  @Doc({ request: () => classificationSchema })
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

const positiveInt = z.coerce.number().int().positive().max(100_000);
const module_ = z.enum(['SALES', 'PURCHASES', 'BANKING', 'MANUAL', 'SYSTEM']);

const classificationSchema = z.object({
  accountId: uuid,
  classification: z.enum(['OPERATING', 'INVESTING', 'FINANCING']),
  note: z.string().max(500).optional(),
});

const digestListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(52).optional(),
});

const dailySeriesSchema = z.object({
  days: z.coerce.number().int().min(7).max(90).optional(),
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

/**
 * The optional accounting-date window for the time machine.
 *
 * Absent means "the whole ledger". `exactOptionalPropertyTypes` is on, so an
 * explicit `undefined` is not the same as an omitted key — the spread form is
 * what keeps the two apart.
 */
function window_(from: string | undefined, to: string | undefined) {
  return {
    ...(from !== undefined && from !== '' ? { from: parse(isoDate, from) } : {}),
    ...(to !== undefined && to !== '' ? { to: parse(isoDate, to) } : {}),
  };
}

function renderBalance(balance: {
  accountId: string;
  code: string;
  name: string;
  balance: { toDecimalString(): string };
}) {
  return {
    accountId: balance.accountId,
    code: balance.code,
    name: balance.name,
    balance: balance.balance.toDecimalString(),
  };
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
