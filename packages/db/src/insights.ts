import {
  Money,
  daysIdleSince,
  idleBucket,
  marginFigures,
  type Currency,
  type IdleBucket,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { businessToday, toIsoDate } from './internal.js';
import { loadBaseCurrency } from './invoice.js';

/**
 * Owner insights — the reports that turn books into decisions.
 *
 * Everything here is DERIVED from tables that already carry the truth:
 * `stock_movement` (append-only), `item_stock` (the WAC rollup),
 * `invoice_line` (frozen at issue). No new state, no new writes — a report
 * that kept its own copy of the facts would eventually disagree with them.
 */

// ---------------------------------------------------------------------------
// Stock ageing — what is sitting, and for how long
// ---------------------------------------------------------------------------

export interface StockAgeingRow {
  readonly itemId: string;
  readonly code: string;
  readonly name: string;
  readonly quantityOnHand: string;
  readonly stockValue: string;
  /** The last day a unit LEFT for a customer; null = never sold. */
  readonly lastSoldOn: string | null;
  /** The last day a unit arrived, for "new stock, give it time". */
  readonly lastReceivedOn: string | null;
  readonly daysIdle: number;
  readonly bucket: IdleBucket;
}

/**
 * Every tracked item still holding stock, oldest silence first.
 *
 * "Idle" is measured from the last ISSUE — the last time a customer took one —
 * or, for stock that has NEVER sold, from the day it arrived. Both facts are
 * shown separately so a slow shelf and a new delivery do not look alike.
 */
export async function stockAgeing(tx: Tx, ctx: TenantContext): Promise<StockAgeingRow[]> {
  const today = businessToday();

  const rows = await tx<
    {
      item_id: string;
      code: string;
      name: string;
      quantity_on_hand: string;
      stock_value: string;
      last_sold_on: Date | null;
      last_received_on: Date | null;
    }[]
  >`
      SELECT s.item_id, i.code, i.name, s.quantity_on_hand, s.stock_value,
             (SELECT MAX(m.moved_on) FROM stock_movement m
               WHERE m.tenant_id = s.tenant_id AND m.item_id = s.item_id
                 AND m.movement_type = 'ISSUE')   AS last_sold_on,
             (SELECT MAX(m.moved_on) FROM stock_movement m
               WHERE m.tenant_id = s.tenant_id AND m.item_id = s.item_id
                 AND m.movement_type = 'RECEIPT') AS last_received_on
        FROM item_stock s
        JOIN item i ON i.tenant_id = s.tenant_id AND i.id = s.item_id
       WHERE s.tenant_id = ${ctx.tenantId} AND s.quantity_on_hand > 0
  `;

  return rows
    .map((row) => {
      const lastSold = row.last_sold_on === null ? null : toIsoDate(row.last_sold_on);
      const lastReceived = row.last_received_on === null ? null : toIsoDate(row.last_received_on);
      const since = lastSold ?? lastReceived;
      const daysIdle = since === null ? 0 : daysIdleSince(since, today);
      return {
        itemId: row.item_id,
        code: row.code,
        name: row.name,
        quantityOnHand: row.quantity_on_hand,
        stockValue: row.stock_value,
        lastSoldOn: lastSold,
        lastReceivedOn: lastReceived,
        daysIdle,
        bucket: idleBucket(daysIdle),
      };
    })
    .sort((a, b) => b.daysIdle - a.daysIdle);
}

// ---------------------------------------------------------------------------
// Margin by item — what am I selling for nothing?
// ---------------------------------------------------------------------------

export interface ItemMarginRow {
  readonly itemId: string | null;
  readonly code: string;
  readonly name: string;
  readonly quantitySold: string;
  readonly revenue: string;
  readonly cost: string;
  readonly margin: string;
  readonly marginBp: number | null;
}

/**
 * Revenue and cost per item over a period, WORST margin first — the owner's
 * question is "what am I selling for nothing", not "what is doing fine".
 *
 * Revenue is the tax-exclusive `taxable_amount` frozen on each invoice line
 * (SST collected is not the shop's money). Cost is the weighted-average
 * relief the perpetual-inventory posting recorded on the SAME sale — so this
 * report cannot disagree with the P&L, because it reads the P&L's own inputs.
 * Untracked items and services appear with zero cost rather than vanishing:
 * labour sold cheap hides there otherwise.
 */
export async function itemMargins(
  tx: Tx,
  ctx: TenantContext,
  period: { readonly from: string; readonly to: string },
): Promise<ItemMarginRow[]> {
  const currency = (await loadBaseCurrency(tx, ctx)) as Currency;

  const rows = await tx<
    {
      item_id: string | null;
      code: string | null;
      name: string | null;
      quantity_sold: string;
      revenue: string;
      cost: string;
    }[]
  >`
      WITH sold AS (
          SELECT l.item_id, i.code, i.name,
                 SUM(l.quantity)                    AS quantity_sold,
                 COALESCE(SUM(l.taxable_amount), 0) AS revenue
            FROM invoice_line l
            JOIN invoice inv ON inv.tenant_id = l.tenant_id AND inv.id = l.invoice_id
            LEFT JOIN item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
           WHERE l.tenant_id = ${ctx.tenantId}
             AND inv.status <> 'DRAFT' AND inv.status <> 'VOID'
             AND inv.issue_date BETWEEN ${period.from} AND ${period.to}
           GROUP BY l.item_id, i.code, i.name
      ),
      relief AS (
          -- The WAC relief those SAME invoices posted, per item. Joined to the
          -- invoice for its date, so the window is the invoice's, not the
          -- movement's — a sale is one event on one date.
          SELECT m.item_id, -SUM(m.value_delta) AS cost
            FROM stock_movement m
            JOIN invoice inv ON inv.tenant_id = m.tenant_id AND inv.id = m.source_document_id
           WHERE m.tenant_id = ${ctx.tenantId}
             AND m.movement_type = 'ISSUE'
             AND m.source_document_type = 'INVOICE'
             AND inv.issue_date BETWEEN ${period.from} AND ${period.to}
           GROUP BY m.item_id
      )
      SELECT sold.item_id, sold.code, sold.name, sold.quantity_sold, sold.revenue,
             COALESCE(relief.cost, 0) AS cost
        FROM sold
        LEFT JOIN relief ON relief.item_id = sold.item_id
  `;

  return rows
    .map((row) => {
      const figures = marginFigures(row.revenue, row.cost, currency);
      return {
        itemId: row.item_id,
        code: row.code ?? '—',
        name: row.name ?? 'Free-text lines',
        quantitySold: row.quantity_sold,
        ...figures,
      };
    })
    .sort((a, b) => (a.marginBp ?? 10_001) - (b.marginBp ?? 10_001));
}

// ---------------------------------------------------------------------------
// Repair profitability — is the bench earning its space?
// ---------------------------------------------------------------------------

export interface RepairProfitRow {
  readonly jobNo: string;
  readonly device: string;
  readonly customerName: string;
  readonly collectedOn: string;
  readonly revenue: string;
  readonly partsCost: string;
  readonly margin: string;
  readonly marginBp: number | null;
}

export interface RepairProfit {
  readonly jobs: readonly RepairProfitRow[];
  readonly totals: { revenue: string; partsCost: string; margin: string };
}

/**
 * Collected repair jobs over a period: what each one billed (ex-tax), what
 * the parts cost off the shelf, and what was left for labour and margin.
 *
 * Labour is deliberately NOT costed — the technician's wage is a fixed cost
 * the payroll module owns, and spreading it per-job would manufacture a
 * precision the data does not hold. The honest figure is contribution: what
 * the job left behind after parts.
 */
export async function repairProfitability(
  tx: Tx,
  ctx: TenantContext,
  period: { readonly from: string; readonly to: string },
): Promise<RepairProfit> {
  const currency = (await loadBaseCurrency(tx, ctx)) as Currency;

  const rows = await tx<
    {
      job_no: string;
      device_description: string;
      customer_name: string;
      invoice_date: Date;
      revenue: string;
      parts_cost: string;
    }[]
  >`
      SELECT r.job_no, r.device_description, c.name AS customer_name,
             inv.issue_date AS invoice_date, inv.subtotal AS revenue,
             COALESCE((
               SELECT -SUM(m.value_delta)
                 FROM stock_movement m
                WHERE m.tenant_id = r.tenant_id
                  AND m.movement_type = 'ISSUE'
                  AND m.source_document_type = 'INVOICE'
                  AND m.source_document_id = r.invoice_id
             ), 0) AS parts_cost
        FROM repair_job r
        JOIN invoice inv ON inv.tenant_id = r.tenant_id AND inv.id = r.invoice_id
        JOIN contact c   ON c.tenant_id = r.tenant_id AND c.id = r.contact_id
       WHERE r.tenant_id = ${ctx.tenantId} AND r.status = 'COLLECTED'
         AND r.invoice_id IS NOT NULL
         AND inv.issue_date BETWEEN ${period.from} AND ${period.to}
       ORDER BY inv.issue_date DESC, r.job_no DESC
  `;

  const jobs = rows.map((row) => {
    const figures = marginFigures(row.revenue, row.parts_cost, currency);
    return {
      jobNo: row.job_no,
      device: row.device_description,
      customerName: row.customer_name,
      collectedOn: toIsoDate(row.invoice_date),
      revenue: figures.revenue,
      partsCost: figures.cost,
      margin: figures.margin,
      marginBp: figures.marginBp,
    };
  });

  const totals = marginFigures(
    sum(jobs.map((j) => j.revenue), currency),
    sum(jobs.map((j) => j.partsCost), currency),
    currency,
  );

  return {
    jobs,
    totals: { revenue: totals.revenue, partsCost: totals.cost, margin: totals.margin },
  };
}

function sum(decimals: readonly string[], currency: Currency): string {
  return decimals
    .reduce((total, decimal) => total.add(Money.fromDecimal(decimal, currency)), Money.zero(currency))
    .toDecimalString();
}
