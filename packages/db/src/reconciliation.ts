import {
  checkInvariantEight,
  isErr,
  Money,
  reconcile,
  suggestMatchesForStatement,
  suggestTransfers,
  validateJournalEntry,
  type BankTransactionView,
  type InvariantEightResult,
  type MatchCandidate,
  type MatchSuggestion,
  type ReconciliationItem,
  type ReconciliationResult,
  type TransferSuggestion,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';
import { loadBaseCurrency } from './invoice.js';
import { bankTransactions, bookBalance } from './bank.js';
import { toIsoDate } from './internal.js';

/**
 * ReconciliationService — M4.
 *
 * ---------------------------------------------------------------------------
 * A MATCH NEVER REWRITES HISTORY.
 *
 * Confirming a match inserts a `reconciliation_match` row and flips a status.
 * It does not touch the posted journal entry, because the entry was already
 * correct — reconciliation is the act of AGREEING that a ledger entry and a
 * bank line describe the same event, not of changing either.
 *
 * Unmatching likewise inserts a reversal row rather than deleting, so the
 * audit trail shows both decisions. This is the same shape as the ledger's own
 * rule that a posted entry is corrected by a reversing entry.
 * ---------------------------------------------------------------------------
 */

export class ReconciliationError extends Error {
  constructor(
    readonly code:
      | 'BANK_ACCOUNT_NOT_FOUND'
      | 'TRANSACTION_NOT_FOUND'
      | 'MATCH_NOT_FOUND'
      | 'ALREADY_MATCHED'
      | 'ALREADY_UNMATCHED'
      | 'NO_POSTING_ACCOUNT'
      | 'JOURNAL_INVALID'
      | 'SESSION_DOES_NOT_BALANCE',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/**
 * Suggest matches for every unreconciled line on an account.
 *
 * Candidates are loaded once and scored against the whole statement in a
 * single batch — the engine normalises each candidate's name once per run
 * rather than once per line, which is what keeps a 500-line statement inside
 * its 3-second budget.
 *
 * Writes nothing. Every suggestion still requires a human click, including one
 * scoring 100.
 */
export async function suggestForAccount(
  tx: Tx,
  ctx: TenantContext,
  bankAccountId: string,
  options: { asOfDate?: string } = {},
): Promise<Map<string, MatchSuggestion[]>> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const lines = (
    await bankTransactions(tx, ctx, bankAccountId, {
      ...(options.asOfDate !== undefined ? { asOfDate: options.asOfDate } : {}),
      status: 'UNRECONCILED',
    })
  ).map(
    (r): BankTransactionView => ({
      id: r.id,
      bankAccountId: r.bankAccountId,
      txnDate: r.txnDate,
      amount: r.amount,
      description: r.description,
      ...(r.reference !== null ? { reference: r.reference } : {}),
    }),
  );

  if (lines.length === 0) return new Map();

  const candidates = await loadCandidates(tx, ctx, baseCurrency);
  const learnedAliases = await loadLearnedAliases(tx, ctx);

  return suggestMatchesForStatement(lines, candidates, { baseCurrency, learnedAliases });
}

/** Transfers between the tenant's own accounts, across every bank account. */
export async function suggestTransfersForTenant(
  tx: Tx,
  ctx: TenantContext,
  options: { asOfDate?: string } = {},
): Promise<TransferSuggestion[]> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const rows = await tx<
    {
      id: string;
      bank_account_id: string;
      txn_date: Date;
      description: string;
      amount: string;
    }[]
  >`
      SELECT id, bank_account_id, txn_date, description, amount
        FROM bank_transaction
       WHERE tenant_id = ${ctx.tenantId}
         AND status = 'UNRECONCILED'
         AND (${options.asOfDate ?? null}::date IS NULL
              OR txn_date <= ${options.asOfDate ?? null}::date)
       ORDER BY txn_date, id
  `;

  return suggestTransfers(
    rows.map((r) => ({
      id: r.id,
      bankAccountId: r.bank_account_id,
      txnDate: toIsoDate(r.txn_date),
      amount: Money.fromDecimal(r.amount, baseCurrency),
      description: r.description,
    })),
  );
}

/**
 * Everything a bank line could plausibly settle.
 *
 * Payments carry the direction they were recorded with; open invoices and
 * bills are included because a bank line often arrives before anyone records
 * the receipt, and matching against the document is how the receipt then gets
 * created.
 */
async function loadCandidates(
  tx: Tx,
  ctx: TenantContext,
  baseCurrency: string,
): Promise<MatchCandidate[]> {
  const payments = await tx<
    {
      id: string;
      payment_no: string;
      payment_date: Date;
      base_amount: string;
      amount: string;
      direction: string;
      contact_id: string;
      contact_name: string;
    }[]
  >`
      SELECT p.id, p.payment_no, p.payment_date,
             COALESCE(p.base_amount, p.amount) AS base_amount, p.amount,
             p.direction, p.contact_id, c.name AS contact_name
        FROM payment p
        JOIN contact c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
       WHERE p.tenant_id = ${ctx.tenantId}
         AND NOT EXISTS (
               SELECT 1 FROM active_reconciliation_match m
                WHERE m.tenant_id = p.tenant_id
                  AND m.matched_type = 'PAYMENT' AND m.matched_id = p.id
             )
  `;

  const invoices = await tx<
    {
      id: string;
      invoice_no: string;
      issue_date: Date;
      amount_due: string;
      fx_rate: string;
      contact_id: string;
      contact_name: string;
    }[]
  >`
      SELECT i.id, i.invoice_no, i.issue_date, i.amount_due, i.fx_rate,
             i.contact_id, c.name AS contact_name
        FROM invoice i
        JOIN contact c ON c.tenant_id = i.tenant_id AND c.id = i.contact_id
       WHERE i.tenant_id = ${ctx.tenantId}
         AND i.status IN ('ISSUED','PART_PAID')
         AND i.amount_due > 0
  `;

  const bills = await tx<
    {
      id: string;
      internal_ref: string;
      bill_no: string;
      bill_date: Date;
      amount_due: string;
      fx_rate: string;
      supplier_id: string;
      contact_name: string;
    }[]
  >`
      SELECT b.id, b.internal_ref, b.bill_no, b.bill_date, b.amount_due, b.fx_rate,
             b.supplier_id, c.name AS contact_name
        FROM bill b
        JOIN contact c ON c.tenant_id = b.tenant_id AND c.id = b.supplier_id
       WHERE b.tenant_id = ${ctx.tenantId}
         AND b.status IN ('ENTERED','PART_PAID')
         AND b.amount_due > 0
  `;

  /*
   * Posted gateway settlements.
   *
   * -------------------------------------------------------------------------
   * A SETTLEMENT LINE MUST NOT MATCH THE PAYMENTS IT COVERS.
   *
   * Twelve FPX collections arrive on Monday and land in the CLEARING account,
   * not the bank. On Wednesday the provider pays one figure into the bank, net
   * of fees. Without this query the only candidates near that line are the
   * twelve payments — which sum to the GROSS, never equal the line, and were
   * already deposited somewhere else. Matching them would double-count the
   * receipts and leave the clearing account permanently out.
   *
   * The settlement's own journal entry is the correct counterpart: one entry,
   * one amount, exactly what the bank shows. It is offered as a JOURNAL
   * candidate because that is what it is, and `matched_type` already permits
   * it. The provider's batch id is the document number, so the reference
   * extraction in text.ts can find it in a narrative like
   * "FPX SETTLEMENT FPX-20260805-001".
   * -------------------------------------------------------------------------
   */
  const settlements = await tx<
    { journal_entry_id: string; provider_batch_id: string | null; provider: string;
      settlement_date: Date; net_amount: string }[]
  >`
      SELECT s.journal_entry_id, s.provider_batch_id, s.provider,
             s.settlement_date, s.net_amount
        FROM gateway_settlement s
       WHERE s.tenant_id = ${ctx.tenantId}
         AND s.journal_entry_id IS NOT NULL
         AND NOT EXISTS (
               SELECT 1 FROM active_reconciliation_match m
                WHERE m.tenant_id = s.tenant_id
                  AND m.matched_type = 'JOURNAL' AND m.matched_id = s.journal_entry_id
             )
  `;

  return [
    ...settlements.map(
      (s): MatchCandidate => ({
        id: s.journal_entry_id,
        kind: 'JOURNAL',
        documentNo: s.provider_batch_id ?? s.provider,
        documentDate: toIsoDate(s.settlement_date),
        amount: Money.fromDecimal(s.net_amount, baseCurrency),
        direction: 'INFLOW',
      }),
    ),
    ...payments.map(
      (p): MatchCandidate => ({
        id: p.id,
        kind: 'PAYMENT',
        documentNo: p.payment_no,
        documentDate: toIsoDate(p.payment_date),
        amount: Money.fromDecimal(p.base_amount, baseCurrency),
        direction: p.direction === 'INBOUND' ? 'INFLOW' : 'OUTFLOW',
        contactId: p.contact_id,
        contactName: p.contact_name,
      }),
    ),
    ...invoices.map(
      (i): MatchCandidate => ({
        id: i.id,
        kind: 'INVOICE',
        documentNo: i.invoice_no,
        documentDate: toIsoDate(i.issue_date),
        // Valued at the booked rate, like everything else that compares a
        // subledger to a control account.
        amount: multiplyRate(i.amount_due, i.fx_rate, baseCurrency),
        direction: 'INFLOW',
        contactId: i.contact_id,
        contactName: i.contact_name,
      }),
    ),
    ...bills.map(
      (b): MatchCandidate => ({
        id: b.id,
        kind: 'BILL',
        // The SUPPLIER's number is what appears in a bank narrative when they
        // quote a reference, not our internal one — so that is what the
        // matcher is given to look for.
        documentNo: b.bill_no,
        documentDate: toIsoDate(b.bill_date),
        amount: multiplyRate(b.amount_due, b.fx_rate, baseCurrency),
        direction: 'OUTFLOW',
        contactId: b.supplier_id,
        contactName: b.contact_name,
      }),
    ),
  ];
}

/**
 * Narrative patterns previously confirmed against a contact.
 *
 * Learned from the user's own past decisions on this tenant — no model, no
 * cross-tenant data. A pattern that reconciled to a contact before is evidence
 * it will again.
 */
async function loadLearnedAliases(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ pattern: string; contactId: string }[]> {
  const rows = await tx<{ description: string; contact_id: string }[]>`
      SELECT DISTINCT bt.description, p.contact_id
        FROM active_reconciliation_match m
        JOIN bank_transaction bt
          ON bt.tenant_id = m.tenant_id AND bt.id = m.bank_transaction_id
        JOIN payment p
          ON p.tenant_id = m.tenant_id AND p.id = m.matched_id
       WHERE m.tenant_id = ${ctx.tenantId}
         AND m.matched_type = 'PAYMENT'
       LIMIT 500
  `;

  return rows.map((r) => ({ pattern: r.description, contactId: r.contact_id }));
}

// ---------------------------------------------------------------------------
// Confirming and undoing
// ---------------------------------------------------------------------------

export interface ConfirmMatchInput {
  readonly bankTransactionId: string;
  readonly matchedType: 'PAYMENT' | 'INVOICE' | 'BILL' | 'JOURNAL' | 'TRANSFER';
  readonly matchedId: string;
  readonly amount: string;
  readonly confidence?: number;
  readonly method?: 'AUTO' | 'RULE' | 'MANUAL';
  readonly reason?: string;
}

/**
 * Accept a match.
 *
 * Inserts the decision and flips the bank line's status. Deliberately does NOT
 * touch the journal entry: the ledger was already right, and a reconciliation
 * that edits the ledger to make itself agree proves nothing.
 */
export async function confirmMatch(
  tx: Tx,
  ctx: TenantContext,
  input: ConfirmMatchInput,
): Promise<{ id: string }> {
  const [bankTxn] = await tx<{ id: string; status: string; amount: string }[]>`
      SELECT id, status, amount FROM bank_transaction
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.bankTransactionId}
         FOR UPDATE
  `;
  if (!bankTxn) {
    throw new ReconciliationError(
      'TRANSACTION_NOT_FOUND',
      `Bank transaction ${input.bankTransactionId} not found`,
    );
  }

  const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM active_reconciliation_match
       WHERE tenant_id = ${ctx.tenantId}
         AND bank_transaction_id = ${input.bankTransactionId}
         AND matched_type = ${input.matchedType}
         AND matched_id = ${input.matchedId}
  `;
  if (existing) {
    throw new ReconciliationError(
      'ALREADY_MATCHED',
      'This bank line is already matched to that document',
    );
  }

  const journalEntryId = await journalEntryFor(tx, ctx, input.matchedType, input.matchedId);

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO reconciliation_match (
          tenant_id, bank_transaction_id, matched_type, matched_id,
          journal_entry_id, amount, confidence_score, match_method, reason, matched_by
      ) VALUES (
          ${ctx.tenantId}, ${input.bankTransactionId}, ${input.matchedType},
          ${input.matchedId}, ${journalEntryId}, ${input.amount},
          ${input.confidence ?? null}, ${input.method ?? 'MANUAL'},
          ${input.reason ?? null}, ${ctx.userId ?? null}
      )
      RETURNING id
  `;

  await refreshTransactionStatus(tx, ctx, input.bankTransactionId);

  return { id: row!.id };
}

/**
 * Undo a match by inserting its reversal.
 *
 * Never a DELETE. The table is append-only and the trigger enforces it; the
 * audit trail has to show that someone matched this line and someone later
 * decided that was wrong.
 */
export async function unmatch(
  tx: Tx,
  ctx: TenantContext,
  matchId: string,
  reason?: string,
): Promise<{ id: string }> {
  const [match] = await tx<
    { id: string; bank_transaction_id: string; matched_type: string; matched_id: string; amount: string }[]
  >`
      SELECT id, bank_transaction_id, matched_type, matched_id, amount
        FROM active_reconciliation_match
       WHERE tenant_id = ${ctx.tenantId} AND id = ${matchId}
  `;

  if (!match) {
    // Either it never existed or it has already been reversed. Both are
    // reported the same way — the caller's next step is identical.
    throw new ReconciliationError(
      'MATCH_NOT_FOUND',
      `Match ${matchId} not found, or it has already been undone`,
    );
  }

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO reconciliation_match (
          tenant_id, bank_transaction_id, matched_type, matched_id,
          amount, match_method, reverses_match_id, unmatch_reason, matched_by
      ) VALUES (
          ${ctx.tenantId}, ${match.bank_transaction_id}, ${match.matched_type},
          ${match.matched_id}, ${match.amount}, 'MANUAL', ${matchId},
          ${reason ?? null}, ${ctx.userId ?? null}
      )
      RETURNING id
  `;

  await refreshTransactionStatus(tx, ctx, match.bank_transaction_id);

  return { id: row!.id };
}

/**
 * A bank line's status follows from how much of it is matched.
 *
 * Derived rather than set directly, so a status cannot drift from the matches
 * that justify it — which is exactly what would happen if `confirmMatch` and
 * `unmatch` each maintained it by hand.
 */
async function refreshTransactionStatus(
  tx: Tx,
  ctx: TenantContext,
  bankTransactionId: string,
): Promise<void> {
  await tx`
      UPDATE bank_transaction bt
         SET status = CASE
               WHEN bt.status = 'EXCLUDED' THEN 'EXCLUDED'
               WHEN COALESCE((
                     SELECT SUM(m.amount) FROM active_reconciliation_match m
                      WHERE m.tenant_id = bt.tenant_id AND m.bank_transaction_id = bt.id
                   ), 0) = 0 THEN 'UNRECONCILED'
               WHEN COALESCE((
                     SELECT SUM(m.amount) FROM active_reconciliation_match m
                      WHERE m.tenant_id = bt.tenant_id AND m.bank_transaction_id = bt.id
                   ), 0) = bt.amount THEN 'RECONCILED'
               ELSE 'MATCHED'
             END
       WHERE bt.tenant_id = ${ctx.tenantId} AND bt.id = ${bankTransactionId}
  `;
}

async function journalEntryFor(
  tx: Tx,
  ctx: TenantContext,
  matchedType: string,
  matchedId: string,
): Promise<string | null> {
  const table =
    matchedType === 'PAYMENT'
      ? 'payment'
      : matchedType === 'INVOICE'
        ? 'invoice'
        : matchedType === 'BILL'
          ? 'bill'
          : null;

  if (table === null) return matchedType === 'JOURNAL' ? matchedId : null;

  const [row] = await tx<{ journal_entry_id: string | null }[]>`
      SELECT journal_entry_id FROM ${tx(table)}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${matchedId}
  `;

  return row?.journal_entry_id ?? null;
}

// ---------------------------------------------------------------------------
// Creating a ledger entry from a bank line
// ---------------------------------------------------------------------------

export interface CreateFromLineInput {
  readonly bankTransactionId: string;
  /** The expense or income account the other side belongs in. */
  readonly accountId: string;
  readonly description?: string;
  readonly contactId?: string;
  readonly idempotencyKey: string;
  /** Who decided: a person (default) or a bank rule. Recorded on the match. */
  readonly method?: 'RULE' | 'MANUAL';
  readonly reason?: string;
}

/**
 * Post a journal for a bank line nothing in the ledger explains, and match it.
 *
 * This is the bank-charge path, and without it invariant #8 is unreachable in
 * practice: every real account has charges, interest and direct debits that
 * originate at the bank, and a reconciliation that cannot record them can
 * never reach zero variance.
 *
 * The sign follows the bank line, not the caller: money out of the bank
 * credits the bank GL account and debits whatever the user chose.
 */
export async function createEntryFromBankLine(
  tx: Tx,
  ctx: TenantContext,
  input: CreateFromLineInput,
): Promise<{ journalEntryId: string; matchId: string }> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const [bankTxn] = await tx<
    { id: string; bank_account_id: string; txn_date: Date; description: string; amount: string }[]
  >`
      SELECT id, bank_account_id, txn_date, description, amount
        FROM bank_transaction
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.bankTransactionId}
         FOR UPDATE
  `;
  if (!bankTxn) {
    throw new ReconciliationError(
      'TRANSACTION_NOT_FOUND',
      `Bank transaction ${input.bankTransactionId} not found`,
    );
  }

  const [bankAccount] = await tx<{ gl_account_id: string }[]>`
      SELECT gl_account_id FROM bank_account
       WHERE tenant_id = ${ctx.tenantId} AND id = ${bankTxn.bank_account_id}
  `;
  if (!bankAccount) {
    throw new ReconciliationError(
      'BANK_ACCOUNT_NOT_FOUND',
      `Bank account ${bankTxn.bank_account_id} not found`,
    );
  }

  const signed = Money.fromDecimal(bankTxn.amount, baseCurrency);
  const magnitude = signed.abs();
  const moneyIn = signed.isPositive();
  const entryDate = toIsoDate(bankTxn.txn_date);
  const description = input.description ?? bankTxn.description;

  const draft = {
    entryDate,
    description,
    sourceModule: 'BANKING' as const,
    sourceDocumentType: 'BANK_TRANSACTION',
    sourceDocumentId: bankTxn.id,
    lines: [
      {
        accountId: bankAccount.gl_account_id,
        side: moneyIn ? ('DEBIT' as const) : ('CREDIT' as const),
        amount: magnitude,
        baseAmount: magnitude,
        description,
      },
      {
        accountId: input.accountId,
        side: moneyIn ? ('CREDIT' as const) : ('DEBIT' as const),
        amount: magnitude,
        baseAmount: magnitude,
        description,
        ...(input.contactId !== undefined ? { contactId: input.contactId } : {}),
      },
    ],
  };

  const validated = validateJournalEntry(draft, baseCurrency);
  if (isErr(validated)) {
    throw new ReconciliationError(
      'JOURNAL_INVALID',
      'Generated journal is invalid',
      validated.error,
    );
  }

  const posted = await postJournalEntry(tx, ctx, validated.value, {
    idempotencyKey: `bank-line:${input.idempotencyKey}`,
    emitEvent: {
      type: 'bank.entry.created',
      payload: { bankTransactionId: bankTxn.id, amount: signed.toDecimalString() },
    },
  });

  const match = await confirmMatch(tx, ctx, {
    bankTransactionId: bankTxn.id,
    matchedType: 'JOURNAL',
    matchedId: posted.id,
    amount: signed.toDecimalString(),
    method: input.method ?? 'MANUAL',
    reason: input.reason ?? 'Entry created directly from the bank line',
  });

  return { journalEntryId: posted.id, matchId: match.id };
}

// ---------------------------------------------------------------------------
// The reconciliation statement, and invariant #8
// ---------------------------------------------------------------------------

/**
 * Reconcile a bank account at a date.
 *
 * The two sides of "unmatched" are gathered separately and stay separate all
 * the way to the result — a bank charge nobody has posted is not the same kind
 * of thing as a cheque that has not cleared, and presenting them as one pool
 * is how charges go unrecorded for a year.
 */
export async function reconcileAccount(
  tx: Tx,
  ctx: TenantContext,
  bankAccountId: string,
  asOfDate: string,
): Promise<ReconciliationResult> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const [account] = await tx<{ opening_balance: string; gl_account_id: string }[]>`
      SELECT opening_balance, gl_account_id FROM bank_account
       WHERE tenant_id = ${ctx.tenantId} AND id = ${bankAccountId}
  `;
  if (!account) {
    throw new ReconciliationError(
      'BANK_ACCOUNT_NOT_FOUND',
      `Bank account ${bankAccountId} not found`,
    );
  }

  const openingBalance = Money.fromDecimal(account.opening_balance, baseCurrency);
  const book = await bookBalance(tx, ctx, bankAccountId, asOfDate);

  const lines = await bankTransactions(tx, ctx, bankAccountId, { asOfDate });
  const asItem = (r: (typeof lines)[number]): ReconciliationItem => ({
    id: r.id,
    date: r.txnDate,
    amount: r.amount,
    description: r.description,
  });

  const reconciled = lines.filter((r) => r.status === 'RECONCILED').map(asItem);
  const unreconciledStatementItems = lines
    .filter((r) => r.status === 'UNRECONCILED' || r.status === 'MATCHED')
    .map(asItem);

  // In the books, absent from the statement: ledger movements on the bank
  // account with no bank line behind them. Timing differences — the bank will
  // catch up, and no action is needed.
  const unpresentedBookItems = await unpresentedItems(
    tx,
    ctx,
    account.gl_account_id,
    asOfDate,
    baseCurrency,
  );

  const statementClosing = openingBalance
    .add(sum(reconciled, baseCurrency))
    .add(sum(unreconciledStatementItems, baseCurrency));

  return reconcile({
    asOfDate,
    baseCurrency,
    openingBalance,
    statementClosingBalance: statementClosing,
    bookBalance: book,
    reconciled,
    unreconciledStatementItems,
    unpresentedBookItems,
  });
}

/**
 * Ledger movements on the bank account that no bank line accounts for.
 *
 * Journal lines are the right source here, not the rollup: this needs the
 * INDIVIDUAL movements so the reconciliation can name the cheque that has not
 * cleared, and a period total cannot do that.
 */
async function unpresentedItems(
  tx: Tx,
  ctx: TenantContext,
  glAccountId: string,
  asOfDate: string,
  baseCurrency: string,
): Promise<ReconciliationItem[]> {
  const rows = await tx<
    { id: string; entry_date: Date; description: string | null; movement: string }[]
  >`
      SELECT l.id, e.entry_date, COALESCE(l.description, e.description) AS description,
             (l.base_debit - l.base_credit)::text AS movement
        FROM journal_line l
        JOIN journal_entry e
          ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND l.account_id = ${glAccountId}
         AND e.status = 'POSTED'
         AND e.entry_date <= ${asOfDate}::date
         AND NOT EXISTS (
               SELECT 1 FROM active_reconciliation_match m
                WHERE m.tenant_id = l.tenant_id
                  AND m.journal_entry_id = l.journal_entry_id
             )
       ORDER BY e.entry_date, l.id
  `;

  return rows.map((r) => ({
    id: r.id,
    date: toIsoDate(r.entry_date),
    amount: Money.fromDecimal(r.movement, baseCurrency),
    description: r.description ?? 'Ledger movement',
  }));
}

/**
 * Ledger invariant #8, checked properly.
 *
 * Bank GL balance = opening + reconciled transactions — which only holds when
 * the account is FULLY reconciled. The precondition is returned alongside the
 * result rather than assumed, because on a real account there is almost always
 * a cheque in the post, and an invariant asserted without its precondition
 * fails constantly and gets switched off.
 */
export async function checkBankInvariant(
  tx: Tx,
  ctx: TenantContext,
  bankAccountId: string,
  asOfDate: string,
): Promise<InvariantEightResult & { fullyReconciled: boolean }> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const [account] = await tx<{ opening_balance: string; gl_account_id: string }[]>`
      SELECT opening_balance, gl_account_id FROM bank_account
       WHERE tenant_id = ${ctx.tenantId} AND id = ${bankAccountId}
  `;
  if (!account) {
    throw new ReconciliationError(
      'BANK_ACCOUNT_NOT_FOUND',
      `Bank account ${bankAccountId} not found`,
    );
  }

  const lines = await bankTransactions(tx, ctx, bankAccountId, { asOfDate });
  const reconciled = lines.filter((r) => r.status === 'RECONCILED');
  const outstanding = lines.filter(
    (r) => r.status === 'UNRECONCILED' || r.status === 'MATCHED',
  );

  const unpresented = await unpresentedItems(
    tx,
    ctx,
    account.gl_account_id,
    asOfDate,
    baseCurrency,
  );

  const result = checkInvariantEight(
    Money.fromDecimal(account.opening_balance, baseCurrency),
    reconciled.map((r) => r.amount),
    await bookBalance(tx, ctx, bankAccountId, asOfDate),
    baseCurrency,
  );

  return {
    ...result,
    // Nothing outstanding on EITHER side. Without this precondition the
    // invariant fails on every real account — there is always a cheque in the
    // post — and an invariant that fails constantly gets switched off.
    fullyReconciled: outstanding.length === 0 && unpresented.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface CompleteSessionInput {
  readonly bankAccountId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

/**
 * Record that a period was reconciled.
 *
 * Refuses to complete while a variance remains. "Reconciled with a RM 12
 * difference" is not reconciled, and a system that lets someone sign that off
 * accumulates differences until the account means nothing — which is the exact
 * failure this module exists to prevent. The database enforces it too.
 */
export async function completeReconciliation(
  tx: Tx,
  ctx: TenantContext,
  input: CompleteSessionInput,
): Promise<{ id: string; variance: string }> {
  const result = await reconcileAccount(tx, ctx, input.bankAccountId, input.periodEnd);

  if (!result.reconciles) {
    throw new ReconciliationError(
      'SESSION_DOES_NOT_BALANCE',
      `This account does not reconcile at ${input.periodEnd}: a difference of ` +
        `${result.variance.toDisplayString()} is unexplained. Every timing difference is ` +
        'already accounted for, so what remains is a missing item, a duplicate, or a wrong amount.',
      { variance: result.variance.toDecimalString() },
    );
  }

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO reconciliation_session (
          tenant_id, bank_account_id, period_start, period_end,
          statement_closing_balance, book_closing_balance, variance,
          unpresented_total, unrecorded_total, status, completed_by, completed_at
      ) VALUES (
          ${ctx.tenantId}, ${input.bankAccountId}, ${input.periodStart}, ${input.periodEnd},
          ${result.adjustedBankBalance.toDecimalString()},
          ${result.adjustedBookBalance.toDecimalString()},
          ${result.variance.toDecimalString()},
          ${result.unpresentedPayments.negate().toDecimalString()},
          ${result.unrecordedBankMovement.toDecimalString()},
          'COMPLETED', ${ctx.userId ?? null}, now()
      )
      RETURNING id
  `;

  /*
   * Signing off a reconciliation is an act, not just a row.
   *
   * The audit trigger already records the `reconciliation_session` INSERT. This
   * is the second log — the small set an auditor asks about by name (0012:200).
   * "The bank was reconciled to zero at this date, by this person" is close to
   * the top of that list, and `RECONCILIATION_COMPLETED` has been declared in
   * the event enum since 0012 without anything ever writing it.
   *
   * Same transaction as the session row, so a completed reconciliation cannot
   * exist without its event.
   */
  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'RECONCILIATION_COMPLETED', ${ctx.userId ?? null},
          'bank.reconcile', 'reconciliation_session', ${row!.id},
          ${tx.json({
            bankAccountId: input.bankAccountId,
            periodEnd: input.periodEnd,
            variance: result.variance.toDecimalString(),
          })}
      )
  `;

  return { id: row!.id, variance: result.variance.toDecimalString() };
}

// ------------------------------------------------------------------ internals

function sum(items: readonly ReconciliationItem[], currency: string): Money {
  return items.reduce((acc, i) => acc.add(i.amount), Money.zero(currency));
}

function multiplyRate(amount: string, rate: string, currency: string): Money {
  // amount * rate, at money scale. Both come from NUMERIC columns as strings.
  const scaled = Money.fromDecimal(amount, currency);
  const [whole = '0', fraction = ''] = rate.split('.');
  const rateUnits = BigInt(whole + fraction.padEnd(8, '0').slice(0, 8));
  return scaled.multiplyRatio(rateUnits, 10n ** 8n);
}
