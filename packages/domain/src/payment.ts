/**
 * Receipts and their allocation against open invoices — the settlement half
 * of M2.
 *
 * Pure: allocation arithmetic and journal construction only. Loading open
 * invoices and persisting the result belongs to the service layer.
 *
 * The model is many-to-many by design. One receipt can settle several
 * invoices (the common Malaysian case: a customer pays three invoices in a
 * single DuitNow transfer), and one invoice can be settled by several
 * receipts (instalments). Anything that assumes one payment = one invoice
 * will not survive contact with a real bank statement.
 */

import { Money, sumMoney, type Currency } from './money.js';
import { err, isErr, ok, type Result } from './result.js';
import { realisedFx, Rate, toBase, type SettlementLeg } from './fx.js';
import type { JournalEntryDraft, JournalLineDraft } from './journal-entry.js';

export type PaymentMethod =
  | 'FPX'
  | 'DUITNOW'
  | 'CARD'
  | 'CHEQUE'
  | 'CASH'
  | 'TRANSFER'
  | 'OTHER';

export type PaymentDirection = 'INBOUND' | 'OUTBOUND';

/**
 * A document with something still owing on it.
 *
 * Named for documents rather than invoices because none of these fields is
 * invoice-specific — a bill has every one of them, and `issueCreditNote()`
 * already reuses this shape for a non-receipt document. Settling a payable
 * runs the identical arithmetic.
 */
export interface OpenDocument {
  readonly documentId: string;
  readonly documentNo: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly amountDue: Money;
  /**
   * The rate at which this document's control account was booked. Absent
   * means 1:1. The control account must be relieved at THIS rate, not at the
   * settlement rate — see packages/domain/src/fx.ts.
   */
  readonly bookedRate?: Rate;
}

export interface SettlementAllocation {
  readonly documentId: string;
  readonly amount: Money;
}

export interface ReceiptInput {
  readonly contactId: string;
  readonly paymentDate: string;
  readonly amount: Money;
  readonly method: PaymentMethod;
  /** GL account the money landed in — bank, cash, or undeposited funds. */
  readonly depositAccountId: string;
  readonly allocations: readonly SettlementAllocation[];
  readonly reference?: string;
}

export interface ValidatedReceipt extends ReceiptInput {
  readonly _validated: true;
  readonly allocatedTotal: Money;
  /**
   * Received but not applied to any invoice. Sits as a credit on the
   * customer's account (an overpayment or a deposit against future work).
   */
  readonly unallocated: Money;
  readonly currency: Currency;
}

/**
 * Allocation violations, shared by receipts and credit notes.
 *
 * Both apply a sum of money against a set of open invoices under identical
 * rules, so the checks live in one place. If they drift apart, one of the two
 * settlement paths starts accepting something the other refuses.
 */
export type AllocationViolation =
  | { readonly code: 'NON_POSITIVE_ALLOCATION'; readonly documentId: string; readonly amount: string }
  | { readonly code: 'UNKNOWN_DOCUMENT'; readonly documentId: string }
  | { readonly code: 'EXCEEDS_AMOUNT_DUE'; readonly documentId: string; readonly allocated: string; readonly amountDue: string }
  | { readonly code: 'DUPLICATE_ALLOCATION'; readonly documentId: string }
  | { readonly code: 'OVER_ALLOCATED'; readonly received: string; readonly allocated: string }
  | { readonly code: 'MIXED_CURRENCY'; readonly expected: Currency; readonly found: Currency };

export interface AllocationOutcome {
  readonly allocatedTotal: Money;
  readonly unallocated: Money;
}

/**
 * Check that `allocations` can legitimately be applied against `openInvoices`,
 * given a pot of `available` money (a receipt amount, or a credit note total).
 */
export function validateAllocations(
  available: Money,
  allocations: readonly SettlementAllocation[],
  openDocuments: readonly OpenDocument[],
): Result<AllocationOutcome, AllocationViolation[]> {
  const violations: AllocationViolation[] = [];
  const currency = available.currency;
  const byId = new Map(openDocuments.map((d) => [d.documentId, d]));
  const seen = new Set<string>();

  for (const allocation of allocations) {
    if (allocation.amount.currency !== currency) {
      violations.push({ code: 'MIXED_CURRENCY', expected: currency, found: allocation.amount.currency });
      continue;
    }

    if (!allocation.amount.isPositive()) {
      violations.push({
        code: 'NON_POSITIVE_ALLOCATION',
        documentId: allocation.documentId,
        amount: allocation.amount.toDecimalString(),
      });
    }

    if (seen.has(allocation.documentId)) {
      violations.push({ code: 'DUPLICATE_ALLOCATION', documentId: allocation.documentId });
    }
    seen.add(allocation.documentId);

    const document = byId.get(allocation.documentId);
    if (!document) {
      violations.push({ code: 'UNKNOWN_DOCUMENT', documentId: allocation.documentId });
      continue;
    }

    if (allocation.amount.compare(document.amountDue) > 0) {
      violations.push({
        code: 'EXCEEDS_AMOUNT_DUE',
        documentId: allocation.documentId,
        allocated: allocation.amount.toDecimalString(),
        amountDue: document.amountDue.toDecimalString(),
      });
    }
  }

  if (violations.length > 0) return err(violations);

  const allocatedTotal = sumMoney(allocations.map((a) => a.amount), currency);

  if (allocatedTotal.compare(available) > 0) {
    return err([
      {
        code: 'OVER_ALLOCATED',
        received: available.toDecimalString(),
        allocated: allocatedTotal.toDecimalString(),
      },
    ]);
  }

  return ok({ allocatedTotal, unallocated: available.subtract(allocatedTotal) });
}

export type ReceiptViolation =
  | AllocationViolation
  | { readonly code: 'NON_POSITIVE_AMOUNT'; readonly amount: string }
  | { readonly code: 'INVALID_PAYMENT_DATE'; readonly value: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a receipt against the invoices it claims to settle.
 *
 * Over-allocating is an error rather than a silent truncation: paying RM 100
 * against an invoice with RM 80 outstanding means either the wrong invoice or
 * an overpayment the user must acknowledge, and guessing which is not the
 * software's call.
 */
export function validateReceipt(
  input: ReceiptInput,
  openDocuments: readonly OpenDocument[],
): Result<ValidatedReceipt, ReceiptViolation[]> {
  const violations: ReceiptViolation[] = [];

  if (!ISO_DATE.test(input.paymentDate) || Number.isNaN(Date.parse(input.paymentDate))) {
    violations.push({ code: 'INVALID_PAYMENT_DATE', value: input.paymentDate });
  }

  if (!input.amount.isPositive()) {
    violations.push({ code: 'NON_POSITIVE_AMOUNT', amount: input.amount.toDecimalString() });
  }

  if (violations.length > 0) return err(violations);

  const allocated = validateAllocations(input.amount, input.allocations, openDocuments);
  if (isErr(allocated)) return err(allocated.error);

  return ok({
    ...input,
    _validated: true,
    allocatedTotal: allocated.value.allocatedTotal,
    unallocated: allocated.value.unallocated,
    currency: input.amount.currency,
  });
}

export type AllocationStrategy = 'OLDEST_FIRST' | 'DUE_FIRST';

/**
 * Propose an allocation for a receipt with no explicit instruction.
 *
 * Oldest-first is the conventional default and the one an auditor expects.
 * Due-first settles by due date instead, which matters when invoices carry
 * different payment terms.
 *
 * A *proposal*, not a decision: the caller still confirms. Silently applying a
 * guess to someone's ledger is how reconciliation disputes start.
 */
export function autoAllocate(
  amount: Money,
  openDocuments: readonly OpenDocument[],
  strategy: AllocationStrategy = 'OLDEST_FIRST',
): SettlementAllocation[] {
  const key = strategy === 'OLDEST_FIRST' ? 'issueDate' : 'dueDate';
  const ordered = [...openDocuments].sort((a, b) =>
    a[key] === b[key] ? a.documentNo.localeCompare(b.documentNo) : a[key] < b[key] ? -1 : 1,
  );

  const allocations: SettlementAllocation[] = [];
  let remaining = amount;

  for (const document of ordered) {
    if (!remaining.isPositive()) break;
    if (!document.amountDue.isPositive()) continue;

    const applied = remaining.compare(document.amountDue) >= 0 ? document.amountDue : remaining;
    allocations.push({ documentId: document.documentId, amount: applied });
    remaining = remaining.subtract(applied);
  }

  return allocations;
}

export interface SettlementPostingAccounts {
  /** Accounts receivable for an inbound settlement, payable for outbound. */
  readonly controlAccountId: string;
  /** Required only when a settlement can produce an FX difference. */
  readonly fxGainLossId?: string;
}

/**
 * Supplied when the settlement is not in the tenant's base currency.
 *
 * `settlementRate` is the rate on the day the money moved. Each allocation's
 * booked rate comes from its `OpenDocument`.
 */
export interface SettlementFxContext {
  readonly baseCurrency: Currency;
  readonly settlementRate: Rate;
  readonly openDocuments: readonly OpenDocument[];
}

export interface SettlementPostingContext {
  readonly entryDate: string;
  readonly description?: string;
  readonly documentType: string;
  readonly documentId: string;
}

/**
 * Post a settlement, in either direction.
 *
 *   INBOUND  (receipt):  Dr Bank / Cr Accounts receivable
 *   OUTBOUND (payment):  Dr Accounts payable / Cr Bank
 *
 * ---------------------------------------------------------------------------
 * ONE code path for both directions, and one for base and foreign currency.
 *
 * The temptation is to write a payables copy of the receipts version. That
 * would be a mistake: the foreign-currency logic is the subtlest code in this
 * package, and a copy needs the debit and credit sides swapped — which INVERTS
 * the meaning of the realised difference. A copied `fxPostingSide()` would
 * cheerfully label a loss as a gain, and nothing about the entry would look
 * wrong, because it would still balance.
 *
 * So the FX line is not computed from a sign rule at all. The two real lines
 * are posted first, and the FX line is simply WHATEVER BALANCES THE ENTRY. For
 * an inbound settlement at a higher rate the bank debit exceeds the relieved
 * receivable, so the balancing figure is a credit — a gain. For an outbound
 * settlement at a higher rate the bank credit exceeds the relieved payable, so
 * the balancing figure is a debit — a loss. The direction never appears in a
 * sign conditional, because it does not need to.
 * ---------------------------------------------------------------------------
 *
 * The FULL amount hits the control account, including any unallocated
 * remainder. An overpayment leaves the customer in credit — which is exactly
 * right: the business owes them that money until it is applied or refunded.
 * Parking it elsewhere would break the agreement between the control account
 * and the subledger.
 */
export function buildSettlementJournal(
  direction: PaymentDirection,
  settlement: ValidatedReceipt,
  accounts: SettlementPostingAccounts,
  ctx: SettlementPostingContext,
  fx?: SettlementFxContext,
): JournalEntryDraft | null {
  if (settlement.amount.isZero()) return null;

  const inbound = direction === 'INBOUND';
  const baseCurrency = fx?.baseCurrency ?? settlement.amount.currency;
  const foreign = fx !== undefined && settlement.amount.currency !== fx.baseCurrency;

  // --- the bank side: the money that actually moved, at today's rate -------
  const bankBase = foreign
    ? toBase(settlement.amount, fx.settlementRate, baseCurrency)
    : settlement.amount;

  // --- the control side: relieved at each document's OWN booked rate -------
  let controlBase: Money;

  if (foreign) {
    const rateByDocument = new Map(
      fx.openDocuments.map((d) => [d.documentId, d.bookedRate ?? Rate.one()]),
    );

    const legs: SettlementLeg[] = settlement.allocations.map((a) => ({
      amount: a.amount,
      bookedRate: rateByDocument.get(a.documentId) ?? fx.settlementRate,
    }));

    // An unallocated remainder is a fresh credit, so it is carried at today's
    // rate rather than at any historical one.
    const allocated = realisedFx(legs, fx.settlementRate, baseCurrency);
    controlBase = allocated.bookedBase.add(
      toBase(settlement.unallocated, fx.settlementRate, baseCurrency),
    );
  } else {
    controlBase = settlement.amount;
  }

  const lines: JournalLineDraft[] = [
    {
      accountId: settlement.depositAccountId,
      side: inbound ? 'DEBIT' : 'CREDIT',
      amount: settlement.amount,
      baseAmount: bankBase,
      description: inbound
        ? `Receipt (${settlement.method})`
        : `Payment (${settlement.method})`,
      contactId: settlement.contactId,
    },
    {
      accountId: accounts.controlAccountId,
      side: inbound ? 'CREDIT' : 'DEBIT',
      amount: settlement.amount,
      baseAmount: controlBase,
      description: inbound ? 'Accounts receivable settled' : 'Accounts payable settled',
      contactId: settlement.contactId,
    },
  ];

  // --- the FX line: the balancing figure -----------------------------------
  const debits = lines
    .filter((l) => l.side === 'DEBIT')
    .reduce((acc, l) => acc.add(l.baseAmount), Money.zero(baseCurrency));
  const credits = lines
    .filter((l) => l.side === 'CREDIT')
    .reduce((acc, l) => acc.add(l.baseAmount), Money.zero(baseCurrency));

  const imbalance = debits.subtract(credits);

  if (!imbalance.isZero()) {
    if (!accounts.fxGainLossId) {
      throw new Error(
        `A settlement produced a realised exchange difference of ` +
          `${imbalance.toDecimalString()} ${baseCurrency}, but no FX gain/loss ` +
          'account is configured. Posting without it would leave the entry unbalanced.',
      );
    }

    // A surplus of debits needs a credit to balance, and vice versa.
    const side = imbalance.isPositive() ? 'CREDIT' : 'DEBIT';
    // Debit to the FX account is a loss whichever way the money moved.
    const isLoss = side === 'DEBIT';

    lines.push({
      accountId: accounts.fxGainLossId,
      side,
      amount: imbalance.abs(),
      baseAmount: imbalance.abs(),
      description: isLoss
        ? 'Realised foreign exchange loss'
        : 'Realised foreign exchange gain',
      contactId: settlement.contactId,
    });
  }

  return {
    entryDate: ctx.entryDate,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    sourceModule: inbound ? 'SALES' : 'PURCHASES',
    sourceDocumentType: ctx.documentType,
    sourceDocumentId: ctx.documentId,
    lines,
  };
}

/** The status a document moves to once `paid` has been applied to it. */
export function settlementStatus(total: Money, paid: Money): 'ISSUED' | 'PART_PAID' | 'PAID' {
  if (paid.isZero()) return 'ISSUED';
  return paid.compare(total) >= 0 ? 'PAID' : 'PART_PAID';
}
