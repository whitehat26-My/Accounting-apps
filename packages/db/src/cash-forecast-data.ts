import { forecastCash, Money, type CashForecast } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';

/**
 * The cash forecast, fed from the ledger and the open documents.
 *
 * Opening cash is the balance of accounts TAGGED cash_and_bank — the tag the
 * statement templates already use — so the forecast opens from the same figure
 * the balance sheet shows. Undeposited funds is deliberately NOT tagged
 * cash_and_bank (see the fixture's comment): money a gateway holds is not
 * money the drawer can spend, and a forecast that counts it twice — once here,
 * once when the settlement lands — would be wrong in the optimistic direction,
 * which is the direction that hurts.
 */
export async function cashForecast(
  tx: Tx,
  ctx: TenantContext,
  asOf: string,
): Promise<CashForecast> {
  const [org] = await tx<{ base_currency: string }[]>`
      SELECT base_currency FROM organisation WHERE id = ${ctx.tenantId}
  `;
  const currency = org?.base_currency ?? 'MYR';

  const [cash] = await tx<{ balance: string }[]>`
      SELECT COALESCE(SUM(b.net_movement), 0)::text AS balance
        FROM account_period_balance b
        JOIN account_tag t
          ON t.tenant_id = b.tenant_id AND t.account_id = b.account_id
         AND t.tag = 'cash_and_bank'
       WHERE b.tenant_id = ${ctx.tenantId}
         AND b.currency = ${currency}
  `;

  const receivables = await tx<{ due_date: Date; base_due: string }[]>`
      SELECT due_date, ROUND(amount_due * fx_rate, 4)::text AS base_due
        FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('ISSUED','PART_PAID') AND amount_due > 0
  `;

  const payables = await tx<{ due_date: Date; base_due: string }[]>`
      SELECT due_date, ROUND(amount_due * fx_rate, 4)::text AS base_due
        FROM bill
       WHERE tenant_id = ${ctx.tenantId}
         AND status IN ('ENTERED','PART_PAID') AND amount_due > 0
  `;

  return forecastCash({
    asOf,
    openingCash: Money.fromDecimal(cash!.balance, currency),
    receivables: receivables.map((r) => ({
      dueDate: toIsoDate(r.due_date),
      amount: Money.fromDecimal(r.base_due, currency),
    })),
    payables: payables.map((p) => ({
      dueDate: toIsoDate(p.due_date),
      amount: Money.fromDecimal(p.base_due, currency),
    })),
    currency,
  });
}
