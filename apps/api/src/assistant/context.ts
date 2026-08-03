import type { Permission } from '@emil/domain';
import {
  cashForecast,
  dailyTakings,
  listOpenBills,
  listOpenInvoices,
  listWeeklyDigests,
  outstandingPayables,
  outstandingReceivables,
  type TenantContext,
  type Tx,
} from '@emil/db';

/**
 * The business snapshot the model reasons over — built strictly from what THIS
 * caller's permissions allow.
 *
 * ---------------------------------------------------------------------------
 * THE PERMISSION FILTER HERE IS THE SECURITY BOUNDARY OF THE WHOLE FEATURE.
 *
 * The model cannot leak a figure it was never given. A cashier's assistant
 * knows today's till and nothing else; the technician's knows nothing
 * financial at all; the boss's knows everything. Each block below names the
 * permission that gates the equivalent screen, so the assistant sees exactly
 * what its user would see by clicking around — no more.
 *
 * Everything is passed through as the decimal STRINGS the services already
 * emit. No arithmetic happens here; this file only arranges words.
 * ---------------------------------------------------------------------------
 */
export async function buildAssistantContext(
  tx: Tx,
  ctx: TenantContext,
  permissions: ReadonlySet<Permission>,
  today: string,
): Promise<string> {
  const sections: string[] = [`Today's date: ${today} (Asia/Kuala_Lumpur). All amounts are RM (MYR).`];

  if (permissions.has('pos.sale')) {
    const t = await dailyTakings(tx, ctx, today);
    const methods = t.byMethod.map((m) => `${m.method} RM ${m.total} (${m.count}x)`).join(', ');
    sections.push(
      `TODAY'S TILL — takings RM ${t.receiptsTotal}` +
        (methods ? ` [${methods}]` : '') +
        `; ${t.invoiceCount} sale(s) invoiced RM ${t.invoicedTotal}; ` +
        `cost of goods RM ${t.costOfGoodsSold}; gross profit RM ${t.grossProfit}.`,
    );
  }

  if (permissions.has('report.read')) {
    const f = await cashForecast(tx, ctx, today);
    const horizons = f.horizons
      .map(
        (h) =>
          `${h.days}d: +RM ${h.inflows.toDecimalString()} -RM ${h.outflows.toDecimalString()} ` +
          `= RM ${h.closing.toDecimalString()}`,
      )
      .join('; ');
    sections.push(
      `CASH — in the bank now RM ${f.openingCash.toDecimalString()}. Forecast from dated ` +
        `commitments (overdue receivables NOT counted, timing unknown): ${horizons}.`,
    );

    const digests = await listWeeklyDigests(tx, ctx, 1);
    const d = digests[0];
    if (d) {
      const flags = d.digest.flags.map((flag) => `${flag.severity}: ${flag.message}`).join(' | ');
      sections.push(
        `LAST FULL WEEK (${d.weekStart} to ${d.weekEnd}) — sales RM ${d.digest.week.salesNet}, ` +
          `gross profit RM ${d.digest.week.grossProfit}, expenses RM ${d.digest.week.expenses}, ` +
          `collected RM ${d.digest.week.takings}. ` +
          (flags ? `Flags: ${flags}` : 'No flags — a normal week.'),
      );
    }
  }

  if (permissions.has('invoice.read')) {
    const { total, count } = await outstandingReceivables(tx, ctx);
    const open = await listOpenInvoices(tx, ctx);
    const overdue = open.filter((i) => i.dueDate < today);
    const top = open
      .slice(0, 8)
      .map(
        (i) =>
          `${i.invoiceNo} ${i.contactName} due ${i.dueDate}` +
          `${i.dueDate < today ? ' (OVERDUE)' : ''} RM ${i.amountDue}`,
      )
      .join('; ');
    sections.push(
      `CUSTOMERS OWE — RM ${total} across ${count} open invoice(s), ` +
        `${overdue.length} overdue.` +
        (top ? ` Oldest first: ${top}.` : ''),
    );
  }

  if (permissions.has('bill.read')) {
    const { total, count } = await outstandingPayables(tx, ctx);
    const open = await listOpenBills(tx, ctx);
    const top = open
      .slice(0, 8)
      .map((b) => `${b.billNo} ${b.supplierName} due ${b.dueDate} RM ${b.amountDue}`)
      .join('; ');
    sections.push(
      `WE OWE SUPPLIERS — RM ${total} across ${count} open bill(s).` + (top ? ` ${top}.` : ''),
    );
  }

  if (sections.length === 1) {
    sections.push(
      'No financial figures are visible to this user — their role does not include ' +
        'them. Help with how-to questions; do not speculate about numbers.',
    );
  }

  return sections.join('\n\n');
}
