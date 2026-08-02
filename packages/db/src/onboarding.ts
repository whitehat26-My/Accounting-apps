import { randomUUID } from 'node:crypto';
import type { TenantContext, Tx } from './client.js';

/**
 * Self-serve organisation provisioning — the first-run path.
 *
 * ---------------------------------------------------------------------------
 * ONE TRANSACTION, EVERYTHING A TENANT NEEDS TO POST ITS FIRST DOCUMENT.
 *
 * Every test has always seeded this by hand on the admin connection, which hid
 * the fact that no user could reach a working state at all. This service is
 * that seed, made real: the organisation, the OWNER membership, a Malaysian
 * SME chart of accounts, the posting-role map every document path resolves
 * against, statement tags, the first fiscal year with twelve monthly periods,
 * and the document number sequences.
 *
 * What it deliberately does NOT seed: tax codes with RATES. CLAUDE.md rule 7 —
 * statutory values are effective-dated data, never constants in code — applies
 * to onboarding code too. The one exception is the out-of-scope code 'NONE' at
 * 0%, which is not a statutory value: zero is the DEFINITION of out-of-scope,
 * not a rate someone must verify. SST-registered tenants add their codes
 * through the tax-code routes, citing the instrument the rate came from.
 * ---------------------------------------------------------------------------
 */

export class OnboardingError extends Error {
  constructor(
    readonly code: 'INVALID_FISCAL_START' | 'PROVISION_FAILED',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'OnboardingError';
  }
}

export interface ProvisionInput {
  readonly name: string;
  readonly ssmRegistrationNo?: string;
  readonly tin?: string;
  readonly sstRegistered?: boolean;
  readonly sstNo?: string;
  /** First day of the first fiscal year, e.g. '2026-01-01'. */
  readonly fiscalYearStart: string;
  readonly reportingFramework?: 'MPERS' | 'MFRS';
}

export interface ProvisionedOrganisation {
  readonly tenantId: string;
  readonly name: string;
  readonly fiscalYearId: string;
  readonly fiscalYearLabel: string;
  readonly accountsCreated: number;
}

/**
 * The default chart: code, name, type, posting role (if any), statement tags.
 *
 * Small on purpose. A chart is easier to grow than to prune — every unused
 * account is a line someone has to look past on every report — and account
 * creation is already a route. What must be here is every account a POSTING
 * ROLE resolves to, because a missing role is a runtime refusal mid-document.
 */
const DEFAULT_CHART: readonly {
  code: string; name: string; type: string; role?: string; tags?: string[];
}[] = [
  { code: '1000', name: 'Cash and Bank', type: 'ASSET', tags: ['cash_and_bank'] },
  { code: '1100', name: 'Accounts Receivable', type: 'ASSET', role: 'AR', tags: ['trade_receivables'] },
  { code: '1150', name: 'SST Claimable', type: 'ASSET', role: 'SST_CLAIMABLE', tags: ['trade_receivables'] },
  { code: '1190', name: 'AR Currency Revaluation', type: 'ASSET', role: 'AR_REVALUATION', tags: ['trade_receivables'] },
  { code: '1200', name: 'Undeposited Funds', type: 'ASSET', role: 'UNDEPOSITED_FUNDS' },
  { code: '1300', name: 'Inventory on Hand', type: 'ASSET', role: 'INVENTORY' },
  { code: '2000', name: 'Accounts Payable', type: 'LIABILITY', role: 'AP', tags: ['trade_payables'] },
  { code: '2090', name: 'AP Currency Revaluation', type: 'LIABILITY', role: 'AP_REVALUATION', tags: ['ap_revaluation'] },
  { code: '2100', name: 'SST Payable', type: 'LIABILITY', role: 'SST_PAYABLE', tags: ['trade_payables'] },
  { code: '2200', name: 'Withholding Tax Payable', type: 'LIABILITY', role: 'WHT_PAYABLE', tags: ['trade_payables'] },
  { code: '3000', name: 'Retained Earnings', type: 'EQUITY', role: 'RETAINED_EARNINGS' },
  { code: '3100', name: 'Opening Balances', type: 'EQUITY' },
  { code: '4000', name: 'Sales Revenue', type: 'INCOME' },
  { code: '5000', name: 'Cost of Sales', type: 'EXPENSE' },
  { code: '5100', name: 'Cost of Goods Sold', type: 'EXPENSE', role: 'COGS' },
  { code: '5900', name: 'Stock Shrinkage', type: 'EXPENSE', role: 'STOCK_SHRINKAGE' },
  { code: '6000', name: 'Operating Expenses', type: 'EXPENSE' },
  { code: '6100', name: 'Payment Gateway Fees', type: 'EXPENSE', role: 'GATEWAY_FEE' },
  { code: '6900', name: 'Foreign Exchange Gain/Loss', type: 'EXPENSE', role: 'FX_GAIN_LOSS' },
  { code: '6910', name: 'Unrealised FX Gain/Loss', type: 'EXPENSE', role: 'UNREALISED_FX' },
];

const SEQUENCES: readonly [string, string][] = [
  ['JOURNAL', 'JE-'],
  ['INVOICE', 'INV-'],
  ['PAYMENT', 'PAY-'],
  ['CREDIT_NOTE', 'CN-'],
  ['BILL', 'BILL-'],
  ['DEBIT_NOTE', 'DN-'],
  ['REPAIR_JOB', 'JOB-'],
];

/** Generate the id BEFORE the transaction, so the caller can set the tenant context to it. */
export function newTenantId(): string {
  return randomUUID();
}

export async function provisionOrganisation(
  tx: Tx,
  ctx: TenantContext,
  userId: string,
  input: ProvisionInput,
): Promise<ProvisionedOrganisation> {
  const start = new Date(`${input.fiscalYearStart}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || start.getUTCDate() !== 1) {
    // First of a month, always. Monthly periods that start mid-month produce
    // windows no statement template or comparative can line up with.
    throw new OnboardingError(
      'INVALID_FISCAL_START',
      `The fiscal year must start on the first of a month; got ${input.fiscalYearStart}`,
    );
  }

  const fyeMonth = ((start.getUTCMonth() + 11) % 12) + 1; // month before the start month

  await tx`
      INSERT INTO organisation (
          id, name, ssm_registration_no, tin, sst_registered, sst_no,
          base_currency, fye_month, reporting_framework
      ) VALUES (
          ${ctx.tenantId}, ${input.name}, ${input.ssmRegistrationNo ?? null},
          ${input.tin ?? null}, ${input.sstRegistered ?? false}, ${input.sstNo ?? null},
          'MYR', ${fyeMonth}, ${input.reportingFramework ?? 'MPERS'}
      )
  `;

  // The creator is the OWNER. Every other member arrives by invitation, which
  // already exists; the first owner is the one person no one can invite.
  await tx`
      INSERT INTO membership (tenant_id, user_id, role_code, status, joined_at)
      VALUES (${ctx.tenantId}, ${userId}, 'OWNER', 'ACTIVE', now())
  `;

  const accountIds = new Map<string, string>();
  for (const account of DEFAULT_CHART) {
    const [row] = await tx<{ id: string }[]>`
        INSERT INTO account (tenant_id, code, name, type)
        VALUES (${ctx.tenantId}, ${account.code}, ${account.name}, ${account.type})
        RETURNING id
    `;
    accountIds.set(account.code, row!.id);
  }

  for (const account of DEFAULT_CHART) {
    if (account.role) {
      await tx`
          INSERT INTO posting_account_map (tenant_id, role, account_id)
          VALUES (${ctx.tenantId}, ${account.role}, ${accountIds.get(account.code)!})
      `;
    }
    for (const tag of account.tags ?? []) {
      await tx`
          INSERT INTO account_tag (tenant_id, account_id, tag)
          VALUES (${ctx.tenantId}, ${accountIds.get(account.code)!}, ${tag})
      `;
    }
  }

  // Twelve monthly periods from the given start.
  const end = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), 0));
  const label = `FY${end.getUTCFullYear()}`;

  const [year] = await tx<{ id: string }[]>`
      INSERT INTO fiscal_year (tenant_id, label, start_date, end_date)
      VALUES (${ctx.tenantId}, ${label}, ${input.fiscalYearStart}, ${isoDate(end)})
      RETURNING id
  `;

  for (let month = 0; month < 12; month++) {
    const periodStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + month, 1));
    const periodEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + month + 1, 0));
    await tx`
        INSERT INTO fiscal_period (tenant_id, fiscal_year_id, sequence, start_date, end_date)
        VALUES (${ctx.tenantId}, ${year!.id}, ${month + 1},
                ${isoDate(periodStart)}, ${isoDate(periodEnd)})
    `;
  }

  for (const [documentType, prefix] of SEQUENCES) {
    await tx`
        INSERT INTO number_sequence (tenant_id, document_type, prefix, next_value, padding)
        VALUES (${ctx.tenantId}, ${documentType}, ${prefix}, 1, 5)
    `;
  }

  /*
   * The one tax code everyone gets: out of scope, 0%. Not a statutory value —
   * zero is the DEFINITION of out-of-scope. Every other code is added through
   * the tax-code routes with the instrument it came from, because a rate this
   * product typed for the user is a rate nobody verified.
   */
  const [none] = await tx<{ id: string }[]>`
      INSERT INTO tax_code (tenant_id, code, name, regime, input_treatment)
      VALUES (${ctx.tenantId}, 'NONE', 'Out of scope', 'NONE', 'COST')
      RETURNING id
  `;
  await tx`
      INSERT INTO tax_rate_version (tenant_id, tax_code_id, rate_basis_points, valid_from, valid_to)
      VALUES (${ctx.tenantId}, ${none!.id}, 0, '1900-01-01', NULL)
  `;

  return {
    tenantId: ctx.tenantId,
    name: input.name,
    fiscalYearId: year!.id,
    fiscalYearLabel: label,
    accountsCreated: DEFAULT_CHART.length,
  };
}

// ---------------------------------------------------------------------------
// Tax codes — the write path SST registration needs
// ---------------------------------------------------------------------------

export class TaxCodeError extends Error {
  constructor(
    readonly code: 'DUPLICATE_TAX_CODE' | 'RATE_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'TaxCodeError';
  }
}

export interface CreateTaxCodeInput {
  readonly code: string;
  readonly name: string;
  readonly regime: 'SST_SALES' | 'SST_SERVICE' | 'NONE';
  readonly inputTreatment: 'COST' | 'RECOVERABLE';
  readonly rates: readonly {
    readonly rateBasisPoints: number;
    readonly validFrom: string;
    readonly validTo?: string;
    /**
     * Where the rate came from — "Service Tax (Rate of Tax) Order 2018", an
     * RMCD guide, a gazette number. Required at THIS write path even though
     * the column is nullable (fixtures predate the rule): the 0018 argument —
     * once a figure is in the table nobody can tell verified from guessed
     * unless the row says — applies to SST rates exactly as to withholding.
     */
    readonly legislationRef: string;
  }[];
}

export async function createTaxCode(
  tx: Tx,
  ctx: TenantContext,
  input: CreateTaxCodeInput,
): Promise<{ id: string; code: string }> {
  const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM tax_code WHERE tenant_id = ${ctx.tenantId} AND code = ${input.code}
  `;
  if (existing) {
    throw new TaxCodeError('DUPLICATE_TAX_CODE', `Tax code ${input.code} already exists`);
  }

  for (const rate of input.rates) {
    if (rate.legislationRef.trim().length < 8) {
      // The same floor 0018 gives wht_rate: long enough to name an instrument,
      // impossible to satisfy with "n/a".
      throw new TaxCodeError(
        'RATE_INVALID',
        'Every rate must cite the instrument it came from — an order, a guide, a gazette. ' +
          'A rate whose origin nobody recorded cannot be re-verified when the law changes.',
      );
    }
  }

  const [code] = await tx<{ id: string }[]>`
      INSERT INTO tax_code (tenant_id, code, name, regime, input_treatment)
      VALUES (${ctx.tenantId}, ${input.code}, ${input.name}, ${input.regime},
              ${input.inputTreatment})
      RETURNING id
  `;

  for (const rate of input.rates) {
    await tx`
        INSERT INTO tax_rate_version (
            tenant_id, tax_code_id, rate_basis_points, valid_from, valid_to, legislation_ref
        ) VALUES (
            ${ctx.tenantId}, ${code!.id}, ${rate.rateBasisPoints},
            ${rate.validFrom}, ${rate.validTo ?? null}, ${rate.legislationRef}
        )
    `;
  }

  // Rate changes are the events auditors reconcile filings against.
  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'STATUTORY_RATE_CHANGED', ${ctx.userId ?? null}, 'tax.write',
          'tax_code', ${code!.id},
          ${tx.json({
            code: input.code,
            regime: input.regime,
            rates: input.rates.map((r) => ({
              rateBasisPoints: r.rateBasisPoints,
              validFrom: r.validFrom,
              legislationRef: r.legislationRef,
            })),
          })}
      )
  `;

  return { id: code!.id, code: input.code };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
