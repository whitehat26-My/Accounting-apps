/**
 * AccountService — the chart of accounts.
 *
 * ---------------------------------------------------------------------------
 * ANOTHER TABLE WITH NO WAY IN.
 *
 * `account` has been the spine of the ledger since 0001 and had no repository
 * module and no route, so a tenant's chart of accounts was whatever a fixture
 * inserted. A real organisation cannot add the one expense account it is
 * missing without someone running SQL.
 * ---------------------------------------------------------------------------
 *
 * The interesting part of this module is what it REFUSES. An account's `type`
 * decides which statement it appears on, and codes are quoted in working papers
 * that outlive the software.
 */

import { normalBalanceOf, type AccountType } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';

export class AccountError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_NOT_FOUND'
      | 'CODE_TAKEN'
      | 'TYPE_LOCKED_BY_HISTORY'
      | 'PARENT_NOT_FOUND'
      | 'ACCOUNT_IN_USE'
      | 'SYSTEM_ACCOUNT',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

export interface AccountView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype: string | null;
  readonly parentId: string | null;
  readonly currency: string | null;
  readonly isSystem: boolean;
  readonly isActive: boolean;
  /** DEBIT or CREDIT — derived, never stored, so it cannot disagree with type. */
  readonly normalBalance: 'DEBIT' | 'CREDIT';
  /** Posted journal lines. Zero means the account is still free to change. */
  readonly postings: number;
}

export interface CreateAccountInput {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly subtype?: string;
  readonly parentId?: string;
  /** Set only for an account denominated in something other than base. */
  readonly currency?: string;
  readonly tags?: readonly string[];
}

export async function createAccount(
  tx: Tx,
  ctx: TenantContext,
  input: CreateAccountInput,
): Promise<AccountView> {
  if (input.parentId !== undefined) {
    const [parent] = await tx<{ id: string; type: string }[]>`
        SELECT id, type FROM account
         WHERE tenant_id = ${ctx.tenantId} AND id = ${input.parentId}
    `;
    if (!parent) {
      throw new AccountError('PARENT_NOT_FOUND', `Parent account ${input.parentId} not found`);
    }
    if (parent.type !== input.type) {
      // A liability nested under an asset makes every rolled-up subtotal wrong,
      // and the error surfaces as a balance sheet that does not balance.
      throw new AccountError(
        'PARENT_NOT_FOUND',
        `A ${input.type} account cannot sit under a ${parent.type} parent: the subtotal ` +
          'it rolls into would mix the two sides of the balance sheet.',
      );
    }
  }

  const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM account WHERE tenant_id = ${ctx.tenantId} AND code = ${input.code}
  `;
  if (existing) {
    throw new AccountError('CODE_TAKEN', `Account code ${input.code} is already in use`);
  }

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO account (tenant_id, code, name, type, subtype, parent_id, currency)
      VALUES (
          ${ctx.tenantId}, ${input.code}, ${input.name}, ${input.type},
          ${input.subtype ?? null}, ${input.parentId ?? null}, ${input.currency ?? null}
      )
      RETURNING id
  `;

  for (const tag of input.tags ?? []) {
    await tx`
        INSERT INTO account_tag (tenant_id, account_id, tag)
        VALUES (${ctx.tenantId}, ${row!.id}, ${tag})
        ON CONFLICT DO NOTHING
    `;
  }

  return getAccount(tx, ctx, row!.id);
}

export interface UpdateAccountInput {
  readonly name?: string;
  readonly code?: string;
  readonly subtype?: string;
  readonly isActive?: boolean;
}

/**
 * Rename, re-code or archive an account.
 *
 * ---------------------------------------------------------------------------
 * `type` IS NOT IN THE INPUT, AND THAT IS THE POINT OF THIS FUNCTION.
 *
 * Changing an account's type does not move a number. It moves that number from
 * the profit and loss to the balance sheet — or the reverse — for every period
 * that has ever been reported, retrospectively and silently, because every
 * statement is rendered from the current chart rather than from a snapshot.
 * A year-end that was signed off shows different figures the next time it is
 * opened, and nothing in the ledger changed to explain it.
 *
 * An account with no postings has no history to rewrite, so its type can still
 * be corrected — `changeAccountType` below does exactly that and refuses the
 * moment one line exists. The right correction for an account that has been
 * posted to is a new account and a reclassifying journal, which leaves the
 * trail an auditor needs.
 * ---------------------------------------------------------------------------
 */
export async function updateAccount(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: UpdateAccountInput,
): Promise<AccountView> {
  const current = await getAccount(tx, ctx, id);

  if (current.isSystem && input.isActive === false) {
    throw new AccountError(
      'SYSTEM_ACCOUNT',
      `${current.code} is a system account: the posting rules reference it by role, and ` +
        'archiving it would break the write paths that depend on it.',
    );
  }

  if (input.isActive === false && current.postings > 0) {
    const balance = await accountBalance(tx, ctx, id);
    if (balance !== '0.0000') {
      throw new AccountError(
        'ACCOUNT_IN_USE',
        `${current.code} still holds a balance of ${balance}. Clear it with a journal ` +
          'first — archiving an account does not move what is in it, it just makes the ' +
          'balance harder to find.',
        { balance },
      );
    }
  }

  if (input.code !== undefined && input.code !== current.code) {
    const [clash] = await tx<{ id: string }[]>`
        SELECT id FROM account
         WHERE tenant_id = ${ctx.tenantId} AND code = ${input.code} AND id <> ${id}
    `;
    if (clash) throw new AccountError('CODE_TAKEN', `Account code ${input.code} is already in use`);
  }

  await tx`
      UPDATE account
         SET name      = ${input.name ?? current.name},
             code      = ${input.code ?? current.code},
             subtype   = ${input.subtype ?? current.subtype},
             is_active = ${input.isActive ?? current.isActive}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
  `;

  /*
   * An account with posted history is reference data that reports already
   * depend on, so changing it is on the list an auditor asks about by name
   * (04-security-compliance.md:95). One with no postings is just setup.
   */
  if (current.postings > 0) {
    await tx`
        INSERT INTO financial_event_log (
            tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
        ) VALUES (
            ${ctx.tenantId}, 'CHART_OF_ACCOUNTS_CHANGED', ${ctx.userId ?? null},
            'org.manage', 'account', ${id},
            ${tx.json({
              code: current.code,
              postings: current.postings,
              changed: Object.keys(input),
              ...(input.code !== undefined && input.code !== current.code
                ? { codeFrom: current.code, codeTo: input.code }
                : {}),
            })}
        )
    `;
  }

  return getAccount(tx, ctx, id);
}

/**
 * Correct an account's type — only while it has no posted history.
 *
 * Separate from `updateAccount` so the refusal is a distinct, findable thing
 * rather than a silently ignored field.
 */
export async function changeAccountType(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  type: AccountType,
): Promise<AccountView> {
  const current = await getAccount(tx, ctx, id);

  if (current.type === type) return current;

  if (current.postings > 0) {
    throw new AccountError(
      'TYPE_LOCKED_BY_HISTORY',
      `${current.code} carries ${current.postings} posted journal lines, so its type is ` +
        'fixed. Reclassifying it would move every one of those amounts to the other ' +
        'statement, retrospectively, for periods that have already been reported. ' +
        'Create a new account and post a reclassifying journal instead.',
      { postings: current.postings, from: current.type, to: type },
    );
  }

  await tx`
      UPDATE account SET type = ${type}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
  `;

  return getAccount(tx, ctx, id);
}

export async function listAccounts(
  tx: Tx,
  ctx: TenantContext,
  filter: { type?: AccountType; includeInactive?: boolean } = {},
): Promise<AccountView[]> {
  const rows = await tx<AccountRow[]>`
      SELECT a.id, a.code, a.name, a.type, a.subtype, a.parent_id::text,
             a.currency, a.is_system, a.is_active,
             (SELECT count(*) FROM journal_line l
               WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id)::text AS postings
        FROM account a
       WHERE a.tenant_id = ${ctx.tenantId}
         AND (${filter.includeInactive ?? false} OR a.is_active)
         AND (${filter.type ?? null}::text IS NULL OR a.type = ${filter.type ?? null})
       ORDER BY a.code
  `;

  return rows.map(toView);
}

export async function getAccount(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<AccountView> {
  const [row] = await tx<AccountRow[]>`
      SELECT a.id, a.code, a.name, a.type, a.subtype, a.parent_id::text,
             a.currency, a.is_system, a.is_active,
             (SELECT count(*) FROM journal_line l
               WHERE l.tenant_id = a.tenant_id AND l.account_id = a.id)::text AS postings
        FROM account a
       WHERE a.tenant_id = ${ctx.tenantId} AND a.id = ${id}
  `;

  // RLS already filtered another tenant's row out, so "missing" and "not yours"
  // are indistinguishable here — which is what CLAUDE.md rule 9 wants.
  if (!row) throw new AccountError('ACCOUNT_NOT_FOUND', `Account ${id} not found`);

  return toView(row);
}

async function accountBalance(tx: Tx, ctx: TenantContext, id: string): Promise<string> {
  const [row] = await tx<{ balance: string }[]>`
      SELECT COALESCE(SUM(l.base_debit - l.base_credit), 0)::numeric(19,4)::text AS balance
        FROM journal_line l
       WHERE l.tenant_id = ${ctx.tenantId} AND l.account_id = ${id}
  `;
  return row!.balance;
}

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  parent_id: string | null;
  currency: string | null;
  is_system: boolean;
  is_active: boolean;
  postings: string;
}

function toView(row: AccountRow): AccountView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    subtype: row.subtype,
    parentId: row.parent_id,
    currency: row.currency,
    isSystem: row.is_system,
    isActive: row.is_active,
    normalBalance: normalBalanceOf(row.type),
    postings: Number(row.postings),
  };
}
