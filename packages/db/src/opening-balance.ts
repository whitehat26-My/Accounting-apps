import {
  buildOpeningJournal,
  isErr,
  Money,
  validateJournalEntry,
  CONTROLLED_ROLES,
  CONTROLLED_ROLE_GUIDANCE,
  type ControlledRole,
  type OpeningBalanceLine,
  type OpeningBalanceViolation,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';
import { loadBaseCurrency } from './invoice.js';
import { toIsoDate } from './internal.js';

/**
 * Opening balances — the position the shop brought with it.
 *
 * See `packages/domain/src/opening-balance.ts` for why the difference falls to
 * equity and why receivables, payables and inventory are refused. This module
 * does the two things the pure builder cannot: resolve which accounts carry a
 * control role, and post the result through the one write path into the
 * ledger.
 */

export class OpeningBalanceError extends Error {
  constructor(
    readonly code: 'NO_EQUITY_ACCOUNT' | 'ACCOUNT_NOT_FOUND' | 'OPENING_INVALID' | 'ALREADY_POSTED',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'OpeningBalanceError';
  }
}

/** The account the balancing figure lands in, by code. Seeded by onboarding. */
const OPENING_EQUITY_CODE = '3100';

export interface PostOpeningBalancesInput {
  readonly asOfDate: string;
  readonly balances: readonly { accountId: string; amount: string }[];
  readonly idempotencyKey: string;
}

export interface PostedOpeningBalances {
  readonly journalEntryId: string;
  readonly entryNo: string;
  readonly balancingFigure: string;
  readonly balancingSide: 'DEBIT' | 'CREDIT';
  readonly replayed: boolean;
}

export async function postOpeningBalances(
  tx: Tx,
  ctx: TenantContext,
  input: PostOpeningBalancesInput,
): Promise<PostedOpeningBalances> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const [equity] = await tx<{ id: string }[]>`
      SELECT id FROM account
       WHERE tenant_id = ${ctx.tenantId} AND code = ${OPENING_EQUITY_CODE} AND is_active
  `;
  if (!equity) {
    throw new OpeningBalanceError(
      'NO_EQUITY_ACCOUNT',
      `No active account with code ${OPENING_EQUITY_CODE} (Opening Balances). It is seeded ` +
        'during setup; add it on the Settings screen if it was removed.',
    );
  }

  const ids = input.balances.map((b) => b.accountId);
  const rows = await tx<
    { id: string; code: string; name: string; type: string; role: string | null }[]
  >`
      SELECT a.id, a.code, a.name, a.type, m.role
        FROM account a
        LEFT JOIN posting_account_map m
          ON m.tenant_id = a.tenant_id AND m.account_id = a.id
         AND m.role = ANY(${CONTROLLED_ROLES as unknown as string[]})
       WHERE a.tenant_id = ${ctx.tenantId} AND a.id = ANY(${ids})
  `;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines: OpeningBalanceLine[] = input.balances.map((balance) => {
    const account = byId.get(balance.accountId);
    if (!account) {
      throw new OpeningBalanceError('ACCOUNT_NOT_FOUND', `No account ${balance.accountId}`);
    }
    return {
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      accountType: account.type as OpeningBalanceLine['accountType'],
      amount: Money.fromDecimal(balance.amount, baseCurrency),
      ...(account.role !== null ? { controlledRole: account.role as ControlledRole } : {}),
    };
  });

  const built = buildOpeningJournal({
    asOfDate: input.asOfDate,
    baseCurrency,
    openingEquityAccountId: equity.id,
    lines,
  });

  if (isErr(built)) {
    throw new OpeningBalanceError(
      'OPENING_INVALID',
      built.error.map((v: OpeningBalanceViolation) => v.message).join(' '),
      built.error,
    );
  }

  // The ledger only accepts a branded `ValidatedJournalEntry`, so the draft
  // goes through the same validator every invoice and payment does. The
  // builder already balances by construction; this is belt and braces, and it
  // is the check that would catch a future change to the builder.
  const validated = validateJournalEntry(
    {
      entryDate: built.value.entryDate,
      description: built.value.description,
      sourceModule: 'MANUAL',
      sourceDocumentType: 'OPENING_BALANCE',
      lines: built.value.lines,
    },
    baseCurrency,
  );
  if (isErr(validated)) {
    throw new OpeningBalanceError(
      'OPENING_INVALID',
      'The opening entry did not balance, which should be impossible — the balancing ' +
        'figure is computed, never supplied.',
      validated.error,
    );
  }

  const posted = await postJournalEntry(tx, ctx, validated.value, {
    idempotencyKey: input.idempotencyKey,
  });

  return {
    journalEntryId: posted.id,
    entryNo: posted.entryNo,
    balancingFigure: built.value.balancingFigure.toDecimalString(),
    balancingSide: built.value.balancingSide,
    replayed: posted.replayed,
  };
}

export interface StatableAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: 'ASSET' | 'LIABILITY' | 'EQUITY';
}

export interface ControlledAccount {
  readonly code: string;
  readonly name: string;
  readonly role: ControlledRole;
  /** Where this balance is entered instead, in the user's own terms. */
  readonly guidance: string;
}

/**
 * What the opening-balance form may offer, and what it must explain away.
 *
 * A purpose-built read model rather than teaching `/v1/accounts` about control
 * roles: the general accounts list is used by six screens that do not care,
 * and the refusals only mean something in this one context. Returning the
 * refused accounts WITH their reason lets the form show them greyed and
 * explained, which teaches the rule instead of just enforcing it.
 */
export async function openingBalanceAccounts(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ statable: StatableAccount[]; controlled: ControlledAccount[]; equityCode: string }> {
  const rows = await tx<
    { id: string; code: string; name: string; type: string; role: string | null }[]
  >`
      SELECT a.id, a.code, a.name, a.type, m.role
        FROM account a
        LEFT JOIN posting_account_map m
          ON m.tenant_id = a.tenant_id AND m.account_id = a.id
         AND m.role = ANY(${CONTROLLED_ROLES as unknown as string[]})
       WHERE a.tenant_id = ${ctx.tenantId}
         AND a.is_active
         AND a.type IN ('ASSET', 'LIABILITY', 'EQUITY')
       ORDER BY a.code
  `;

  const statable: StatableAccount[] = [];
  const controlled: ControlledAccount[] = [];

  for (const row of rows) {
    if (row.role !== null) {
      const role = row.role as ControlledRole;
      controlled.push({
        code: row.code,
        name: row.name,
        role,
        guidance: CONTROLLED_ROLE_GUIDANCE[role],
      });
      continue;
    }
    // The balancing account is a result, never an input — see the builder.
    if (row.code === OPENING_EQUITY_CODE) continue;
    statable.push({
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type as StatableAccount['type'],
    });
  }

  return { statable, controlled, equityCode: OPENING_EQUITY_CODE };
}

export interface OpeningBalanceGap {
  readonly bankAccountId: string;
  readonly bankAccountName: string;
  readonly openingDate: string | null;
  /** What the bank account was told it started with. */
  readonly statedOpening: string;
  /** What the ledger actually holds for its GL account at that date. */
  readonly ledgerOpening: string;
  readonly difference: string;
  readonly message: string;
}

/**
 * Bank accounts whose stated opening balance the ledger has never heard of.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO CATCH.
 *
 * `createBankAccount` stores `opening_balance` on the bank account, and
 * `reconcileAccount` adds it to the STATEMENT side of the comparison. The BOOK
 * side is computed from the ledger. So a shop that types "18540" when adding
 * its Maybank account, and never posts a matching opening entry, has a
 * permanent RM 18,540 variance: the reconciliation screen refuses sign-off,
 * correctly, and says only that the difference is "a missing entry, a
 * duplicate, or a wrong amount" — none of which describes what happened.
 *
 * The refusal was right and the explanation was unreachable. This closes that:
 * it names the account, both figures, and the fix.
 * ---------------------------------------------------------------------------
 */
export async function openingBalanceGaps(
  tx: Tx,
  ctx: TenantContext,
): Promise<OpeningBalanceGap[]> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const rows = await tx<
    {
      id: string;
      name: string;
      opening_balance: string;
      opening_date: Date | null;
      ledger_opening: string;
    }[]
  >`
      SELECT b.id,
             b.name,
             b.opening_balance::text,
             b.opening_date,
             COALESCE((
                 SELECT SUM(l.base_debit - l.base_credit)
                   FROM journal_line l
                   JOIN journal_entry e
                     ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
                  WHERE l.tenant_id = b.tenant_id
                    AND l.account_id = b.gl_account_id
                    AND e.status IN ('POSTED', 'REVERSED')
                    AND e.entry_date <= COALESCE(b.opening_date, e.entry_date)
             ), 0)::text AS ledger_opening
        FROM bank_account b
       WHERE b.tenant_id = ${ctx.tenantId}
         AND b.opening_balance <> 0
       ORDER BY b.name
  `;

  const gaps: OpeningBalanceGap[] = [];
  for (const row of rows) {
    const stated = Money.fromDecimal(row.opening_balance, baseCurrency);
    const ledger = Money.fromDecimal(row.ledger_opening, baseCurrency);
    const difference = stated.subtract(ledger);
    if (difference.isZero()) continue;

    gaps.push({
      bankAccountId: row.id,
      bankAccountName: row.name,
      openingDate: row.opening_date ? toIsoDate(row.opening_date) : null,
      statedOpening: stated.toDecimalString(),
      ledgerOpening: ledger.toDecimalString(),
      difference: difference.toDecimalString(),
      message:
        `${row.name} was set up as starting with ${stated.toDecimalString()}, but the ledger ` +
        `holds ${ledger.toDecimalString()} for it at that date. Until the difference is ` +
        'recorded as an opening balance, this account can never reconcile to zero.',
    });
  }

  return gaps;
}
