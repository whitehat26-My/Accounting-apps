import {
  Money,
  expandCalendar,
  freeCashPosition,
  type Currency,
  type DeadlineRule,
  type FreeCashPosition,
  type HeldForOthers,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { businessToday } from './internal.js';

/**
 * What of the bank balance is actually the shop's.
 *
 * ---------------------------------------------------------------------------
 * READ FROM THE LEDGER, NOT ESTIMATED.
 *
 * Every held amount below is the closing balance of a real liability account
 * — the same rows the balance sheet prints. EPF deducted from staff sits in
 * EPF_PAYABLE until it is paid to KWSP; SST charged to customers sits in
 * SST_PAYABLE until the SST-02. So "money that is not yours" is not a model
 * of anything: it is the credit balance of the accounts that say so.
 *
 * Balances are DEBIT-POSITIVE in `account_period_balance` (see ledger.ts), so
 * a liability sums negative and is negated here. A payable that somehow sits
 * in debit — overpaid EPF, say — clamps to zero rather than being shown as
 * negative money-you-are-holding, which would read as an asset.
 * ---------------------------------------------------------------------------
 */

/** Posting role → how it is described to the person reading it. */
const HOLDINGS: readonly {
  readonly key: string;
  readonly roles: readonly string[];
  readonly label: string;
  readonly owedTo: string;
  /** Which compliance rule fixes its deadline, when one does. */
  readonly ruleCode: string | null;
  readonly note?: string;
}[] = [
  {
    key: 'EPF',
    roles: ['EPF_PAYABLE'],
    label: 'EPF (KWSP)',
    owedTo: 'Your staff’s retirement fund — deducted from their pay and matched by you',
    ruleCode: 'EPF_CONTRIBUTION',
  },
  {
    key: 'SOCSO_EIS',
    roles: ['SOCSO_PAYABLE', 'EIS_PAYABLE'],
    label: 'SOCSO + EIS',
    owedTo: 'PERKESO, for your staff’s injury and unemployment cover',
    ruleCode: 'SOCSO_EIS_CONTRIBUTION',
  },
  {
    key: 'PCB',
    roles: ['PCB_PAYABLE'],
    label: 'Income tax (PCB)',
    owedTo: 'LHDN — your staff’s tax, which you deducted on their behalf',
    ruleCode: 'PCB_CP39',
  },
  {
    key: 'SST',
    roles: ['SST_PAYABLE'],
    label: 'SST collected',
    owedTo: 'RMCD — charged to your customers, never your income',
    ruleCode: 'SST_RETURN',
    note:
      'Shown gross. Input tax is not netted off here because the SST-02 box ' +
      'mapping is not yet on file — see the settlement register §3.6.',
  },
  {
    key: 'WHT',
    roles: ['WHT_PAYABLE'],
    label: 'Withholding tax',
    owedTo: 'LHDN — withheld from a payment to a non-resident',
    ruleCode: null,
  },
  {
    key: 'NET_WAGES',
    roles: ['NET_WAGES_PAYABLE'],
    label: 'Wages not yet paid out',
    owedTo: 'Your staff — a confirmed pay run that has not left the bank',
    ruleCode: null,
    note: 'Due on your usual pay day; no statute fixes the date.',
  },
];

export interface FreeCash extends FreeCashPosition {
  readonly asOf: string;
  readonly currency: string;
}

export async function freeCash(tx: Tx, ctx: TenantContext): Promise<FreeCash> {
  const today = businessToday();

  const [org] = await tx<{ base_currency: string }[]>`
      SELECT base_currency FROM organisation WHERE id = ${ctx.tenantId}
  `;
  const currency = (org?.base_currency ?? 'MYR') as Currency;

  // The same figure the forecast and the balance sheet open from.
  const [cash] = await tx<{ balance: string }[]>`
      SELECT COALESCE(SUM(b.net_movement), 0)::text AS balance
        FROM account_period_balance b
        JOIN account_tag t
          ON t.tenant_id = b.tenant_id AND t.account_id = b.account_id
         AND t.tag = 'cash_and_bank'
       WHERE b.tenant_id = ${ctx.tenantId} AND b.currency = ${currency}
  `;

  const balances = await tx<{ role: string; balance: string }[]>`
      SELECT m.role,
             COALESCE(SUM(b.net_movement), 0)::text AS balance
        FROM posting_account_map m
        LEFT JOIN account_period_balance b
               ON b.tenant_id = m.tenant_id
              AND b.account_id = m.account_id
              AND b.currency = ${currency}
       WHERE m.tenant_id = ${ctx.tenantId}
       GROUP BY m.role
  `;
  const byRole = new Map(balances.map((r) => [r.role, r.balance]));

  const dueDates = await nextDueDates(tx, ctx, today);

  const held: HeldForOthers[] = HOLDINGS.map((holding) => {
    // Negate: a liability's credit balance is debit-negative. Clamp at zero —
    // an overpaid payable is not money being held for anyone.
    const owed = holding.roles.reduce((sum, role) => {
      const debitPositive = Money.fromDecimal(byRole.get(role) ?? '0', currency);
      return sum.subtract(debitPositive);
    }, Money.zero(currency));

    return {
      key: holding.key,
      label: holding.label,
      owedTo: holding.owedTo,
      amount: owed.isNegative() ? Money.zero(currency) : owed,
      dueDate: holding.ruleCode === null ? null : (dueDates.get(holding.ruleCode) ?? null),
      ...(holding.note !== undefined ? { note: holding.note } : {}),
    };
  });

  const position = freeCashPosition({
    bankBalance: Money.fromDecimal(cash!.balance, currency),
    held,
    currency,
  });

  return { ...position, asOf: today, currency };
}

/**
 * The NEXT date money of each kind must leave, from the compliance calendar's
 * own rule rows.
 *
 * Deliberately the soonest upcoming deadline rather than "the deadline for
 * the month this balance was accrued in": a payable balance is a running
 * total that may span months (last month's unpaid EPF sits in the same
 * account as this month's), and the date the owner actually faces is the next
 * one. Two years are expanded because a December holding falls due in
 * January.
 */
async function nextDueDates(
  tx: Tx,
  ctx: TenantContext,
  today: string,
): Promise<Map<string, string>> {
  void ctx;
  const rows = await tx<
    {
      code: string;
      label: string;
      description: string;
      frequency: DeadlineRule['frequency'];
      due_day: number | null;
      due_month: number | null;
      applies_when: DeadlineRule['appliesWhen'];
      legislation_ref: string;
      verification: 'PRIMARY' | 'SECONDARY';
    }[]
  >`
      SELECT code, label, description, frequency, due_day, due_month,
             applies_when, legislation_ref, verification
        FROM statutory_deadline_rule
       WHERE effective_to IS NULL OR effective_to >= ${today}
  `;

  const rules: DeadlineRule[] = rows.map((r) => ({
    code: r.code,
    label: r.label,
    description: r.description,
    frequency: r.frequency,
    dueDay: r.due_day,
    dueMonth: r.due_month,
    appliesWhen: r.applies_when,
    legislationRef: r.legislation_ref,
    verification: r.verification,
  }));

  const year = Number(today.slice(0, 4));
  const instances = [...expandCalendar(rules, year), ...expandCalendar(rules, year + 1)];

  const next = new Map<string, string>();
  for (const instance of instances) {
    if (instance.dueDate < today) continue;
    const existing = next.get(instance.ruleCode);
    if (existing === undefined || instance.dueDate < existing) {
      next.set(instance.ruleCode, instance.dueDate);
    }
  }
  return next;
}
