/**
 * Chart of accounts primitives.
 *
 * Pure classification logic — no persistence, no tenant awareness. Tenant
 * scoping is the caller's responsibility and is enforced by RLS at the
 * database boundary (see docs/architecture/06-data-model.md §6.2).
 */

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'INCOME',
  'EXPENSE',
];

export type NormalBalance = 'DEBIT' | 'CREDIT';

/**
 * The side on which an account type carries a positive balance.
 *
 * Assets and expenses increase with debits; liabilities, equity and income
 * increase with credits. This single table is what turns a pile of signed
 * numbers into a statement of financial position that balances.
 */
export function normalBalanceOf(type: AccountType): NormalBalance {
  switch (type) {
    case 'ASSET':
    case 'EXPENSE':
      return 'DEBIT';
    case 'LIABILITY':
    case 'EQUITY':
    case 'INCOME':
      return 'CREDIT';
  }
}

/** Accounts that appear on the Statement of Financial Position. */
export function isBalanceSheetAccount(type: AccountType): boolean {
  return type === 'ASSET' || type === 'LIABILITY' || type === 'EQUITY';
}

/**
 * Accounts that appear on the Statement of Profit or Loss, and which are
 * therefore closed to retained earnings at year end.
 */
export function isProfitOrLossAccount(type: AccountType): boolean {
  return type === 'INCOME' || type === 'EXPENSE';
}

/**
 * System accounts that must exist in every tenant's chart of accounts and
 * which cannot be deleted or retyped. Referenced by code from the posting
 * logic, so the codes are part of the domain rather than seed data.
 */
export const SYSTEM_ACCOUNT = {
  ACCOUNTS_RECEIVABLE: 'SYS_AR',
  ACCOUNTS_PAYABLE: 'SYS_AP',
  SST_PAYABLE: 'SYS_SST_PAYABLE',
  SST_COST: 'SYS_SST_COST',
  RETAINED_EARNINGS: 'SYS_RETAINED_EARNINGS',
  CURRENT_YEAR_EARNINGS: 'SYS_CURRENT_YEAR_EARNINGS',
  FX_GAIN_LOSS: 'SYS_FX_GAIN_LOSS',
  ROUNDING: 'SYS_ROUNDING',
  SUSPENSE: 'SYS_SUSPENSE',
  UNDEPOSITED_FUNDS: 'SYS_UNDEPOSITED_FUNDS',
} as const;

export type SystemAccountCode = (typeof SYSTEM_ACCOUNT)[keyof typeof SYSTEM_ACCOUNT];

export const SYSTEM_ACCOUNT_TYPES: Readonly<Record<SystemAccountCode, AccountType>> = {
  [SYSTEM_ACCOUNT.ACCOUNTS_RECEIVABLE]: 'ASSET',
  [SYSTEM_ACCOUNT.ACCOUNTS_PAYABLE]: 'LIABILITY',
  [SYSTEM_ACCOUNT.SST_PAYABLE]: 'LIABILITY',
  // Input SST is generally NOT recoverable under Malaysia's SST regime — it is
  // absorbed as a cost, unlike VAT/GST input tax. Modelling it as an asset is
  // the single most common way products localised from a VAT jurisdiction
  // misstate a Malaysian balance sheet. See docs/architecture/05 §5.2.
  [SYSTEM_ACCOUNT.SST_COST]: 'EXPENSE',
  [SYSTEM_ACCOUNT.RETAINED_EARNINGS]: 'EQUITY',
  [SYSTEM_ACCOUNT.CURRENT_YEAR_EARNINGS]: 'EQUITY',
  [SYSTEM_ACCOUNT.FX_GAIN_LOSS]: 'EXPENSE',
  [SYSTEM_ACCOUNT.ROUNDING]: 'EXPENSE',
  [SYSTEM_ACCOUNT.SUSPENSE]: 'ASSET',
  [SYSTEM_ACCOUNT.UNDEPOSITED_FUNDS]: 'ASSET',
};
