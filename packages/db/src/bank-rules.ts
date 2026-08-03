import { firstMatchingRule, Money, type BankRule } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { loadBaseCurrency } from './invoice.js';
import { createEntryFromBankLine } from './reconciliation.js';
import { toIsoDate } from './internal.js';

/**
 * Bank rules: "if the narrative contains TNB, code it to Utilities."
 *
 * ---------------------------------------------------------------------------
 * THE TABLE AND THE ENGINE WAITED THREE MILESTONES FOR THIS FILE.
 *
 * `bank_rule` was created in 0011 and `firstMatchingRule` written and tested
 * beside the matching engine — then nothing could create a rule or run one,
 * the exact served-but-unreachable shape M4's own header complains about.
 * This module is the missing middle: CRUD, and the two verbs.
 *
 * Two verbs, deliberately distinct. SUGGEST is free: any active rule may
 * propose a coding for an unmatched line, a human confirms. APPLY posts a
 * journal with no human in the loop, so it is restricted to rules where the
 * owner explicitly flipped `auto_apply` on — a decision made once, per payee,
 * by someone who has watched the rule suggest correctly. Rules never touch a
 * line the matching engine could settle against a real document: they run
 * only on UNRECONCILED lines, and an applied rule is an ordinary match
 * (method RULE) that `unmatch` reverses like any other.
 *
 * The posting itself is `createEntryFromBankLine` — the bank-charge path that
 * already exists — with a deterministic idempotency key per line, so a rule
 * can fire at every import and re-run and still post at most once.
 * ---------------------------------------------------------------------------
 */

export class BankRuleError extends Error {
  constructor(
    readonly code: 'RULE_NOT_FOUND' | 'ACCOUNT_NOT_FOUND' | 'PATTERN_TOO_BROAD',
    message: string,
  ) {
    super(message);
    this.name = 'BankRuleError';
  }
}

export interface CreateBankRuleInput {
  readonly name: string;
  /** Case-insensitive narrative substring, e.g. "TNB", "UNIFI", "SHOPEE". */
  readonly contains: string;
  readonly accountId: string;
  readonly matchesDirection?: 'INFLOW' | 'OUTFLOW';
  readonly minAmount?: string;
  readonly maxAmount?: string;
  readonly contactId?: string;
  /** Restrict to one bank account; omit to match lines on any account. */
  readonly bankAccountId?: string;
  readonly priority?: number;
  /** Post without a human click. OFF unless explicitly requested. */
  readonly autoApply?: boolean;
}

export interface BankRuleRow {
  readonly id: string;
  readonly name: string;
  readonly contains: string | null;
  readonly matchesDirection: string | null;
  readonly minAmount: string | null;
  readonly maxAmount: string | null;
  readonly accountId: string;
  readonly accountName: string;
  readonly contactId: string | null;
  readonly bankAccountId: string | null;
  readonly priority: number;
  readonly autoApply: boolean;
  readonly isActive: boolean;
  readonly hitCount: number;
}

export async function createBankRule(
  tx: Tx,
  ctx: TenantContext,
  input: CreateBankRuleInput,
): Promise<{ id: string }> {
  /*
   * Three characters minimum, after trimming. "TNB" is a payee; "E" matches
   * half the statement, and with auto_apply on it would code half the
   * statement to one account silently. The domain engine accepts any rule —
   * this boundary is where a tenant's typo is refused.
   */
  const contains = input.contains.trim();
  if (contains.length < 3) {
    throw new BankRuleError(
      'PATTERN_TOO_BROAD',
      'The match text must be at least 3 characters — shorter patterns match far too much.',
    );
  }

  const [account] = await tx<{ id: string }[]>`
      SELECT id FROM account
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.accountId} AND is_active
  `;
  if (!account) {
    throw new BankRuleError('ACCOUNT_NOT_FOUND', `Account ${input.accountId} not found`);
  }

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO bank_rule (
          tenant_id, name, contains, matches_direction, min_amount, max_amount,
          account_id, contact_id, bank_account_id, priority, auto_apply
      ) VALUES (
          ${ctx.tenantId}, ${input.name}, ${contains},
          ${input.matchesDirection ?? null}, ${input.minAmount ?? null},
          ${input.maxAmount ?? null}, ${input.accountId}, ${input.contactId ?? null},
          ${input.bankAccountId ?? null}, ${input.priority ?? 100},
          ${input.autoApply ?? false}
      )
      RETURNING id
  `;

  return { id: row!.id };
}

export async function updateBankRule(
  tx: Tx,
  ctx: TenantContext,
  ruleId: string,
  patch: { isActive?: boolean; autoApply?: boolean; priority?: number },
): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
      UPDATE bank_rule
         SET is_active  = COALESCE(${patch.isActive ?? null}, is_active),
             auto_apply = COALESCE(${patch.autoApply ?? null}, auto_apply),
             priority   = COALESCE(${patch.priority ?? null}, priority)
       WHERE tenant_id = ${ctx.tenantId} AND id = ${ruleId}
      RETURNING id
  `;
  if (!row) throw new BankRuleError('RULE_NOT_FOUND', `Bank rule ${ruleId} not found`);
}

export async function listBankRules(tx: Tx, ctx: TenantContext): Promise<BankRuleRow[]> {
  const rows = await tx<
    { id: string; name: string; contains: string | null; matches_direction: string | null;
      min_amount: string | null; max_amount: string | null; account_id: string;
      account_name: string; contact_id: string | null; bank_account_id: string | null;
      priority: number; auto_apply: boolean; is_active: boolean; hit_count: number }[]
  >`
      SELECT r.id, r.name, r.contains, r.matches_direction, r.min_amount::text,
             r.max_amount::text, r.account_id, a.name AS account_name, r.contact_id,
             r.bank_account_id, r.priority, r.auto_apply, r.is_active, r.hit_count
        FROM bank_rule r
        JOIN account a ON a.tenant_id = r.tenant_id AND a.id = r.account_id
       WHERE r.tenant_id = ${ctx.tenantId}
       ORDER BY r.priority, r.name
  `;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    contains: r.contains,
    matchesDirection: r.matches_direction,
    minAmount: r.min_amount,
    maxAmount: r.max_amount,
    accountId: r.account_id,
    accountName: r.account_name,
    contactId: r.contact_id,
    bankAccountId: r.bank_account_id,
    priority: r.priority,
    autoApply: r.auto_apply,
    isActive: r.is_active,
    hitCount: r.hit_count,
  }));
}

// ---------------------------------------------------------------------------
// Running the rules
// ---------------------------------------------------------------------------

interface LoadedRule extends BankRule {
  readonly name: string;
  readonly bankAccountId: string | null;
}

async function loadActiveRules(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
): Promise<LoadedRule[]> {
  const rows = await tx<
    { id: string; name: string; priority: number; contains: string | null;
      matches_direction: 'INFLOW' | 'OUTFLOW' | null; min_amount: string | null;
      max_amount: string | null; account_id: string; tax_code_id: string | null;
      contact_id: string | null; bank_account_id: string | null; auto_apply: boolean }[]
  >`
      SELECT id, name, priority, contains, matches_direction, min_amount::text,
             max_amount::text, account_id, tax_code_id, contact_id,
             bank_account_id, auto_apply
        FROM bank_rule
       WHERE tenant_id = ${ctx.tenantId} AND is_active
  `;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    priority: r.priority,
    ...(r.contains !== null ? { contains: r.contains } : {}),
    ...(r.matches_direction !== null ? { matchesDirection: r.matches_direction } : {}),
    ...(r.min_amount !== null ? { minAmount: Money.fromDecimal(r.min_amount, currency) } : {}),
    ...(r.max_amount !== null ? { maxAmount: Money.fromDecimal(r.max_amount, currency) } : {}),
    accountId: r.account_id,
    ...(r.tax_code_id !== null ? { taxCodeId: r.tax_code_id } : {}),
    ...(r.contact_id !== null ? { contactId: r.contact_id } : {}),
    bankAccountId: r.bank_account_id,
    autoApply: r.auto_apply,
  }));
}

/** Unmatched lines with NO match rows at all — a partially matched line is
 *  mid-conversation with a human and no place for a rule. */
async function unmatchedLines(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  bankAccountId?: string,
) {
  const rows = await tx<
    { id: string; bank_account_id: string; txn_date: Date; description: string;
      amount: string }[]
  >`
      SELECT t.id, t.bank_account_id, t.txn_date, t.description, t.amount
        FROM bank_transaction t
       WHERE t.tenant_id = ${ctx.tenantId}
         AND t.status = 'UNRECONCILED'
         AND (${bankAccountId ?? null}::uuid IS NULL
              OR t.bank_account_id = ${bankAccountId ?? null})
         AND NOT EXISTS (
               SELECT 1 FROM active_reconciliation_match m
                WHERE m.tenant_id = t.tenant_id AND m.bank_transaction_id = t.id
             )
       ORDER BY t.txn_date, t.id
  `;

  return rows.map((r) => ({
    id: r.id,
    bankAccountId: r.bank_account_id,
    txnDate: toIsoDate(r.txn_date),
    description: r.description,
    amount: Money.fromDecimal(r.amount, currency),
  }));
}

export interface RuleHit {
  readonly bankTransactionId: string;
  readonly txnDate: string;
  readonly description: string;
  readonly amount: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly accountId: string;
  readonly contactId: string | null;
  readonly reason: string;
  readonly autoApply: boolean;
}

/**
 * What the rules WOULD do to the unmatched lines. Writes nothing.
 */
export async function ruleSuggestions(
  tx: Tx,
  ctx: TenantContext,
  options: { bankAccountId?: string } = {},
): Promise<RuleHit[]> {
  const currency = await loadBaseCurrency(tx, ctx);
  const rules = await loadActiveRules(tx, ctx, currency);
  if (rules.length === 0) return [];

  const lines = await unmatchedLines(tx, ctx, currency, options.bankAccountId);
  const hits: RuleHit[] = [];

  for (const line of lines) {
    const eligible = rules.filter(
      (r) => r.bankAccountId === null || r.bankAccountId === line.bankAccountId,
    );
    const match = firstMatchingRule(line, eligible);
    if (!match) continue;

    const rule = match.rule as LoadedRule;
    hits.push({
      bankTransactionId: line.id,
      txnDate: line.txnDate,
      description: line.description,
      amount: line.amount.toDecimalString(),
      ruleId: rule.id,
      ruleName: rule.name,
      accountId: rule.accountId,
      contactId: rule.contactId ?? null,
      reason: match.reason,
      autoApply: rule.autoApply,
    });
  }

  return hits;
}

export interface AppliedRule {
  readonly bankTransactionId: string;
  readonly ruleId: string;
  readonly ruleName: string;
  readonly journalEntryId: string;
  readonly amount: string;
}

export interface ApplyRulesResult {
  readonly applied: readonly AppliedRule[];
  /** Lines a suggest-only rule matched — waiting for a human, not posted. */
  readonly suggestedOnly: number;
}

/**
 * Post the auto-apply hits; leave the rest as suggestions.
 *
 * The idempotency key is the LINE id, not a request id: however many times
 * the rules run over a line — every import, a manual re-run, a retry — the
 * ledger entry exists at most once, and `createEntryFromBankLine` replays.
 */
export async function applyBankRules(
  tx: Tx,
  ctx: TenantContext,
  options: { bankAccountId?: string } = {},
): Promise<ApplyRulesResult> {
  const hits = await ruleSuggestions(tx, ctx, options);
  const applied: AppliedRule[] = [];
  let suggestedOnly = 0;

  for (const hit of hits) {
    if (!hit.autoApply) {
      suggestedOnly++;
      continue;
    }

    const { journalEntryId } = await createEntryFromBankLine(tx, ctx, {
      bankTransactionId: hit.bankTransactionId,
      accountId: hit.accountId,
      ...(hit.contactId !== null ? { contactId: hit.contactId } : {}),
      idempotencyKey: `rule:${hit.bankTransactionId}`,
      method: 'RULE',
      reason: `Rule "${hit.ruleName}": ${hit.reason}`,
    });

    await tx`
        UPDATE bank_rule SET hit_count = hit_count + 1
         WHERE tenant_id = ${ctx.tenantId} AND id = ${hit.ruleId}
    `;

    applied.push({
      bankTransactionId: hit.bankTransactionId,
      ruleId: hit.ruleId,
      ruleName: hit.ruleName,
      journalEntryId,
      amount: hit.amount,
    });
  }

  return { applied, suggestedOnly };
}
