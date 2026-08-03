import {
  Money,
  parsePaymentAdvices,
  parseStatement,
  type ImportProfile,
  type ParsedStatementRow,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { loadBaseCurrency } from './invoice.js';
import { toIsoDate } from './internal.js';

/**
 * BankService — accounts and statement import (M4).
 *
 * Malaysia has no broad open banking, so CSV import is the product rather than
 * a fallback for when the feed is down. `BankFeedProvider` is left as a port
 * with no adapter: a speculative client written against an aggregator nobody
 * has integrated would look finished and be wrong.
 */

export class BankError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'GL_ACCOUNT_NOT_FOUND'
      | 'GL_ACCOUNT_IN_USE'
      | 'PROFILE_NOT_FOUND'
      | 'IMPORT_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'BankError';
  }
}

export interface CreateBankAccountInput {
  readonly name: string;
  readonly bankName: string;
  readonly glAccountId: string;
  readonly accountNoMasked?: string;
  readonly currency?: string;
  readonly accountType?: 'BANK' | 'CASH' | 'CREDIT_CARD' | 'EWALLET';
  readonly openingBalance?: string;
  readonly openingDate?: string;
}

export async function createBankAccount(
  tx: Tx,
  ctx: TenantContext,
  input: CreateBankAccountInput,
): Promise<{ id: string }> {
  const [glAccount] = await tx<{ id: string; type: string }[]>`
      SELECT id, type FROM account
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.glAccountId}
  `;
  if (!glAccount) {
    throw new BankError('GL_ACCOUNT_NOT_FOUND', `Account ${input.glAccountId} not found`);
  }

  const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM bank_account
       WHERE tenant_id = ${ctx.tenantId} AND gl_account_id = ${input.glAccountId}
  `;
  if (existing) {
    // Two bank accounts on one GL account makes ledger invariant #8
    // unprovable: neither account's transactions could be separated from the
    // other's within the control balance.
    throw new BankError(
      'GL_ACCOUNT_IN_USE',
      `GL account ${input.glAccountId} is already mapped to another bank account`,
    );
  }

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO bank_account (
          tenant_id, name, bank_name, account_no_masked, currency,
          gl_account_id, account_type, opening_balance, opening_date
      ) VALUES (
          ${ctx.tenantId}, ${input.name}, ${input.bankName},
          ${input.accountNoMasked ?? null}, ${input.currency ?? 'MYR'},
          ${input.glAccountId}, ${input.accountType ?? 'BANK'},
          ${input.openingBalance ?? '0'}, ${input.openingDate ?? null}
      )
      RETURNING id
  `;

  /*
   * A high-signal event, not merely an audited row change.
   *
   * The audit trigger already records the INSERT with a full after-image. This
   * is the SECOND log — `financial_event_log`, the small set an auditor asks
   * about by name (0012:200-211). Where a tenant's money is paid belongs on
   * that list: redirecting settlement to an attacker's account is the classic
   * fraud, and in a stream of ordinary row changes it looks like any other
   * insert. `BANK_DETAILS_CHANGED` has been declared in the event enum since
   * 0012 and, until now, was never written by anything.
   */
  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'BANK_DETAILS_CHANGED', ${ctx.userId ?? null},
          'bank.import',
          'bank_account', ${row!.id},
          ${tx.json({
            name: input.name,
            bankName: input.bankName,
            accountNoMasked: input.accountNoMasked ?? null,
            glAccountId: input.glAccountId,
          })}
      )
  `;

  return { id: row!.id };
}

export interface ImportStatementInput {
  readonly bankAccountId: string;
  readonly content: string;
  /** A saved profile, or an inline one for a preview. Ignored for ADVICE. */
  readonly profileId?: string;
  readonly profile?: ImportProfile;
  /**
   * CSV (default): rows against a column profile. ADVICE: Maybank-style
   * `Label : value` payment-advice documents, no profile involved — the
   * layout is fixed by the bank and parsed from a real sample.
   */
  readonly format?: 'CSV' | 'ADVICE';
  readonly statementDate: string;
  readonly fileName?: string;
  readonly idempotencyKey: string;
}

export interface ImportedStatement {
  readonly id: string;
  readonly imported: number;
  /** Rows already present, skipped. Surfaced so a re-import feels safe. */
  readonly duplicates: number;
  readonly violations: readonly unknown[];
  readonly openingBalance: string | null;
  readonly closingBalance: string | null;
  readonly replayed: boolean;
}

/**
 * Import a statement, skipping rows already held.
 *
 * ---------------------------------------------------------------------------
 * DE-DUPLICATION IS ENFORCED BY THE DATABASE, NOT BY CHECKING FIRST.
 *
 * The unique index on `(tenant_id, bank_account_id, dedupe_hash, occurrence)`
 * is what actually prevents a duplicate. This function inserts and handles the
 * conflict, rather than SELECTing to see what exists and then inserting: a
 * user who double-clicks Import, or a retried request, would otherwise slip
 * two identical statements between the check and the insert.
 * ---------------------------------------------------------------------------
 */
export async function importStatement(
  tx: Tx,
  ctx: TenantContext,
  input: ImportStatementInput,
): Promise<ImportedStatement> {
  const existing = await tx<
    {
      id: string;
      line_count: number;
      duplicate_count: number;
      opening_balance: string | null;
      closing_balance: string | null;
    }[]
  >`
      SELECT id, line_count, duplicate_count, opening_balance, closing_balance
        FROM bank_statement
       WHERE tenant_id = ${ctx.tenantId} AND idempotency_key = ${input.idempotencyKey}
  `;

  if (existing.length > 0) {
    const row = existing[0]!;
    return {
      id: row.id,
      imported: row.line_count,
      duplicates: row.duplicate_count,
      violations: [],
      openingBalance: row.opening_balance,
      closingBalance: row.closing_balance,
      replayed: true,
    };
  }

  const [bankAccount] = await tx<{ id: string; currency: string }[]>`
      SELECT id, currency FROM bank_account
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.bankAccountId}
  `;
  if (!bankAccount) {
    throw new BankError('ACCOUNT_NOT_FOUND', `Bank account ${input.bankAccountId} not found`);
  }

  let parsed;
  let profileId: string | null = null;
  if (input.format === 'ADVICE') {
    // Undated advices are dated by the statement date, with a violation the
    // response carries so the substitution is seen, not silent.
    parsed = parsePaymentAdvices(input.content, bankAccount.currency, {
      fallbackDate: input.statementDate,
    });
  } else {
    const profile = input.profile ?? (await loadProfile(tx, ctx, input.profileId));
    parsed = parseStatement(input.content, profile, bankAccount.currency);
    profileId = input.profileId ?? null;
  }

  if (parsed.rows.length === 0) {
    throw new BankError(
      'IMPORT_INVALID',
      'No rows could be read from this file. Check the import profile against a preview.',
      parsed.violations,
    );
  }

  const [statement] = await tx<{ id: string }[]>`
      INSERT INTO bank_statement (
          tenant_id, bank_account_id, statement_date, opening_balance,
          closing_balance, source, import_profile_id, file_name,
          line_count, duplicate_count, idempotency_key, imported_by
      ) VALUES (
          ${ctx.tenantId}, ${input.bankAccountId}, ${input.statementDate},
          ${parsed.openingBalance?.toDecimalString() ?? null},
          ${parsed.closingBalance?.toDecimalString() ?? null},
          'CSV', ${profileId}, ${input.fileName ?? null},
          0, 0, ${input.idempotencyKey}, ${ctx.userId ?? null}
      )
      RETURNING id
  `;
  const statementId = statement!.id;

  let imported = 0;
  let duplicates = 0;

  for (const row of parsed.rows) {
    const inserted = await insertTransaction(tx, ctx, input.bankAccountId, statementId, row);
    if (inserted) imported++;
    else duplicates++;
  }

  await tx`
      UPDATE bank_statement
         SET line_count = ${imported}, duplicate_count = ${duplicates}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${statementId}
  `;

  return {
    id: statementId,
    imported,
    duplicates,
    violations: parsed.violations,
    openingBalance: parsed.openingBalance?.toDecimalString() ?? null,
    closingBalance: parsed.closingBalance?.toDecimalString() ?? null,
    replayed: false,
  };
}

/** Returns false when the row was already held. */
async function insertTransaction(
  tx: Tx,
  ctx: TenantContext,
  bankAccountId: string,
  statementId: string,
  row: ParsedStatementRow,
): Promise<boolean> {
  const inserted = await tx<{ id: string }[]>`
      INSERT INTO bank_transaction (
          tenant_id, bank_account_id, statement_id, txn_date, value_date,
          description, reference, amount, running_balance, dedupe_hash, occurrence
      ) VALUES (
          ${ctx.tenantId}, ${bankAccountId}, ${statementId}, ${row.txnDate},
          ${row.valueDate ?? null}, ${row.description}, ${row.reference ?? null},
          ${row.amount.toDecimalString()},
          ${row.runningBalance?.toDecimalString() ?? null},
          ${row.dedupeHash}, ${row.occurrence}
      )
      ON CONFLICT (tenant_id, bank_account_id, dedupe_hash, occurrence) DO NOTHING
      RETURNING id
  `;

  return inserted.length > 0;
}

/**
 * Preview an import without writing anything.
 *
 * The counterpart to explicit profiles: a wrong profile has to fail in front
 * of the person who can fix it, not silently produce a plausible statement
 * with wrong numbers.
 */
export async function previewStatement(
  tx: Tx,
  ctx: TenantContext,
  input: {
    bankAccountId: string;
    content: string;
    profileId?: string;
    profile?: ImportProfile;
    format?: 'CSV' | 'ADVICE';
    /** Fallback date for undated advices, so the preview shows what an import would do. */
    statementDate?: string;
  },
): Promise<{
  rows: readonly {
    txnDate: string;
    description: string;
    amount: string;
    duplicate: boolean;
  }[];
  violations: readonly unknown[];
}> {
  const [bankAccount] = await tx<{ currency: string }[]>`
      SELECT currency FROM bank_account
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.bankAccountId}
  `;
  if (!bankAccount) {
    throw new BankError('ACCOUNT_NOT_FOUND', `Bank account ${input.bankAccountId} not found`);
  }

  let parsed;
  if (input.format === 'ADVICE') {
    parsed = parsePaymentAdvices(input.content, bankAccount.currency, {
      ...(input.statementDate !== undefined ? { fallbackDate: input.statementDate } : {}),
    });
  } else {
    const profile = input.profile ?? (await loadProfile(tx, ctx, input.profileId));
    parsed = parseStatement(input.content, profile, bankAccount.currency);
  }

  const existing = await tx<{ dedupe_hash: string; occurrence: number }[]>`
      SELECT dedupe_hash, occurrence FROM bank_transaction
       WHERE tenant_id = ${ctx.tenantId} AND bank_account_id = ${input.bankAccountId}
  `;
  const held = new Set(existing.map((r) => `${r.dedupe_hash}#${r.occurrence}`));

  return {
    rows: parsed.rows.map((r) => ({
      txnDate: r.txnDate,
      description: r.description,
      amount: r.amount.toDecimalString(),
      duplicate: held.has(`${r.dedupeHash}#${r.occurrence}`),
    })),
    violations: parsed.violations,
  };
}

async function loadProfile(
  tx: Tx,
  ctx: TenantContext,
  profileId?: string,
): Promise<ImportProfile> {
  if (!profileId) {
    throw new BankError('PROFILE_NOT_FOUND', 'An import profile is required');
  }

  const [row] = await tx<
    {
      id: string;
      bank_name: string;
      delimiter: string;
      skip_rows: number;
      has_header: boolean;
      date_format: ImportProfile['dateFormat'];
      amount_convention: ImportProfile['amountConvention'];
      column_map: ImportProfile['columns'];
    }[]
  >`
      SELECT id, bank_name, delimiter, skip_rows, has_header, date_format,
             amount_convention, column_map
        FROM import_profile
       WHERE tenant_id = ${ctx.tenantId} AND id = ${profileId}
  `;

  if (!row) {
    throw new BankError('PROFILE_NOT_FOUND', `Import profile ${profileId} not found`);
  }

  return {
    id: row.id,
    bankName: row.bank_name,
    delimiter: row.delimiter,
    skipRows: row.skip_rows,
    hasHeader: row.has_header,
    dateFormat: row.date_format,
    amountConvention: row.amount_convention,
    columns: row.column_map,
  };
}

/**
 * The GL balance of a bank account's mapped account, as at a date.
 *
 * Read from `account_period_balance`, never from `journal_line` — the same
 * discipline the reporting module follows, and the reason a trial balance is
 * one indexed read per account rather than a scan.
 */
export async function bookBalance(
  tx: Tx,
  ctx: TenantContext,
  bankAccountId: string,
  asOfDate: string,
): Promise<Money> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const [row] = await tx<{ balance: string }[]>`
      SELECT COALESCE(SUM(b.net_movement), 0)::text AS balance
        FROM account_period_balance b
        JOIN fiscal_period p
          ON p.tenant_id = b.tenant_id AND p.id = b.fiscal_period_id
        JOIN bank_account ba
          ON ba.tenant_id = b.tenant_id AND ba.gl_account_id = b.account_id
       WHERE b.tenant_id = ${ctx.tenantId}
         AND ba.id = ${bankAccountId}
         AND p.start_date <= ${asOfDate}::date
  `;

  return Money.fromDecimal(row?.balance ?? '0', baseCurrency);
}

export interface BankTransactionRow {
  readonly id: string;
  readonly bankAccountId: string;
  readonly txnDate: string;
  readonly description: string;
  readonly reference: string | null;
  readonly amount: Money;
  readonly status: string;
}

export async function bankTransactions(
  tx: Tx,
  ctx: TenantContext,
  bankAccountId: string,
  options: { asOfDate?: string; status?: string } = {},
): Promise<BankTransactionRow[]> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const rows = await tx<
    {
      id: string;
      bank_account_id: string;
      txn_date: Date;
      description: string;
      reference: string | null;
      amount: string;
      status: string;
    }[]
  >`
      SELECT id, bank_account_id, txn_date, description, reference, amount, status
        FROM bank_transaction
       WHERE tenant_id = ${ctx.tenantId}
         AND bank_account_id = ${bankAccountId}
         AND (${options.asOfDate ?? null}::date IS NULL OR txn_date <= ${options.asOfDate ?? null}::date)
         AND (${options.status ?? null}::text IS NULL OR status = ${options.status ?? null})
       ORDER BY txn_date, created_at, id
  `;

  return rows.map((r) => ({
    id: r.id,
    bankAccountId: r.bank_account_id,
    txnDate: toIsoDate(r.txn_date),
    description: r.description,
    reference: r.reference,
    amount: Money.fromDecimal(r.amount, baseCurrency),
    status: r.status,
  }));
}
