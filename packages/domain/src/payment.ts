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
import { fxPostingSide, realisedFx, Rate, toBase, type SettlementLeg } from './fx.js';
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

/** An invoice with something still owing on it. */
export interface OpenInvoice {
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly amountDue: Money;
  /**
   * The rate at which this invoice's AR was booked. Absent means 1:1 (a
   * base-currency invoice). AR must be relieved at THIS rate, not at the
   * settlement rate — see packages/domain/src/fx.ts.
   */
  readonly bookedRate?: Rate;
}

export interface ReceiptAllocation {
  readonly invoiceId: string;
  readonly amount: Money;
}

export interface ReceiptInput {
  readonly contactId: string;
  readonly paymentDate: string;
  readonly amount: Money;
  readonly method: PaymentMethod;
  /** GL account the money landed in — bank, cash, or undeposited funds. */
  readonly depositAccountId: string;
  readonly allocations: readonly ReceiptAllocation[];
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
  | { readonly code: 'NON_POSITIVE_ALLOCATION'; readonly invoiceId: string; readonly amount: string }
  | { readonly code: 'UNKNOWN_INVOICE'; readonly invoiceId: string }
  | { readonly code: 'EXCEEDS_AMOUNT_DUE'; readonly invoiceId: string; readonly allocated: string; readonly amountDue: string }
  | { readonly code: 'DUPLICATE_ALLOCATION'; readonly invoiceId: string }
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
  allocations: readonly ReceiptAllocation[],
  openInvoices: readonly OpenInvoice[],
): Result<AllocationOutcome, AllocationViolation[]> {
  const violations: AllocationViolation[] = [];
  const currency = available.currency;
  const byId = new Map(openInvoices.map((i) => [i.invoiceId, i]));
  const seen = new Set<string>();

  for (const allocation of allocations) {
    if (allocation.amount.currency !== currency) {
      violations.push({ code: 'MIXED_CURRENCY', expected: currency, found: allocation.amount.currency });
      continue;
    }

    if (!allocation.amount.isPositive()) {
      violations.push({
        code: 'NON_POSITIVE_ALLOCATION',
        invoiceId: allocation.invoiceId,
        amount: allocation.amount.toDecimalString(),
      });
    }

    if (seen.has(allocation.invoiceId)) {
      violations.push({ code: 'DUPLICATE_ALLOCATION', invoiceId: allocation.invoiceId });
    }
    seen.add(allocation.invoiceId);

    const invoice = byId.get(allocation.invoiceId);
    if (!invoice) {
      violations.push({ code: 'UNKNOWN_INVOICE', invoiceId: allocation.invoiceId });
      continue;
    }

    if (allocation.amount.compare(invoice.amountDue) > 0) {
      violations.push({
        code: 'EXCEEDS_AMOUNT_DUE',
        invoiceId: allocation.invoiceId,
        allocated: allocation.amount.toDecimalString(),
        amountDue: invoice.amountDue.toDecimalString(),
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
  openInvoices: readonly OpenInvoice[],
): Result<ValidatedReceipt, ReceiptViolation[]> {
  const violations: ReceiptViolation[] = [];

  if (!ISO_DATE.test(input.paymentDate) || Number.isNaN(Date.parse(input.paymentDate))) {
    violations.push({ code: 'INVALID_PAYMENT_DATE', value: input.paymentDate });
  }

  if (!input.amount.isPositive()) {
    violations.push({ code: 'NON_POSITIVE_AMOUNT', amount: input.amount.toDecimalString() });
  }

  if (violations.length > 0) return err(violations);

  const allocated = validateAllocations(input.amount, input.allocations, openInvoices);
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
  openInvoices: readonly OpenInvoice[],
  strategy: AllocationStrategy = 'OLDEST_FIRST',
): ReceiptAllocation[] {
  const key = strategy === 'OLDEST_FIRST' ? 'issueDate' : 'dueDate';
  const ordered = [...openInvoices].sort((a, b) =>
    a[key] === b[key] ? a.invoiceNo.localeCompare(b.invoiceNo) : a[key] < b[key] ? -1 : 1,
  );

  const allocations: ReceiptAllocation[] = [];
  let remaining = amount;

  for (const invoice of ordered) {
    if (!remaining.isPositive()) break;
    if (!invoice.amountDue.isPositive()) continue;

    const applied = remaining.compare(invoice.amountDue) >= 0 ? invoice.amountDue : remaining;
    allocations.push({ invoiceId: invoice.invoiceId, amount: applied });
    remaining = remaining.subtract(applied);
  }

  return allocations;
}

export interface ReceiptPostingAccounts {
  readonly accountsReceivableId: string;
  /** Required only when a settlement can produce an FX difference. */
  readonly fxGainLossId?: string;
}

/**
 * Supplied when the receipt is not in the tenant's base currency.
 *
 * `settlementRate` is the rate on the day the money arrived. Each allocation's
 * booked rate comes from its `OpenInvoice`.
 */
export interface ReceiptFxContext {
  readonly baseCurrency: Currency;
  readonly settlementRate: Rate;
  readonly openInvoices: readonly OpenInvoice[];
}

export interface ReceiptPostingContext {
  readonly entryDate: string;
  readonly description?: string;
  readonly documentType: string;
  readonly documentId: string;
}

/**
 * Receipt:
 *   Dr Bank / Cash / Undeposited Funds   (amount received)
 *   Cr Accounts Receivable               (amount received)
 *
 * The FULL amount credits AR, including any unallocated remainder. An
 * overpayment leaves the customer's AR balance negative — which is exactly
 * right: the business owes them that money until it is applied or refunded.
 * Parking it in a separate "customer credits" account would take it out of
 * AR and break the agreement between the control account and the subledger.
 */
export function buildReceiptJournal(
  receipt: ValidatedReceipt,
  accounts: ReceiptPostingAccounts,
  ctx: ReceiptPostingContext,
  fx?: ReceiptFxContext,
): JournalEntryDraft | null {
  if (receipt.amount.isZero()) return null;

  // --- base-currency case -------------------------------------------------
  if (!fx || receipt.amount.currency === fx.baseCurrency) {
    return {
      entryDate: ctx.entryDate,
      ...(ctx.description !== undefined ? { description: ctx.description } : {}),
      sourceModule: 'SALES',
      sourceDocumentType: ctx.documentType,
      sourceDocumentId: ctx.documentId,
      lines: [
        {
          accountId: receipt.depositAccountId,
          side: 'DEBIT',
          amount: receipt.amount,
          baseAmount: receipt.amount,
          description: `Receipt (${receipt.method})`,
          contactId: receipt.contactId,
        },
        {
          accountId: accounts.accountsReceivableId,
          side: 'CREDIT',
          amount: receipt.amount,
          baseAmount: receipt.amount,
          description: 'Accounts receivable settled',
          contactId: receipt.contactId,
        },
      ],
    };
  }

  // --- foreign-currency case ----------------------------------------------
  const { baseCurrency, settlementRate } = fx;
  const rateByInvoice = new Map(
    fx.openInvoices.map((i) => [i.invoiceId, i.bookedRate ?? Rate.one()]),
  );

  const legs: SettlementLeg[] = receipt.allocations.map((a) => ({
    amount: a.amount,
    bookedRate: rateByInvoice.get(a.invoiceId) ?? settlementRate,
  }));

  // The bank receives the whole amount at today's rate.
  const bankBase = toBase(receipt.amount, settlementRate, baseCurrency);

  // AR is relieved at each invoice's own booked rate. An unallocated
  // remainder is a fresh customer credit, so it is carried at today's rate.
  const allocated = realisedFx(legs, settlementRate, baseCurrency);
  const unallocatedBase = toBase(receipt.unallocated, settlementRate, baseCurrency);
  const arBase = allocated.bookedBase.add(unallocatedBase);

  const lines: JournalLineDraft[] = [
    {
      accountId: receipt.depositAccountId,
      side: 'DEBIT',
      amount: receipt.amount,
      baseAmount: bankBase,
      description: `Receipt (${receipt.method})`,
      contactId: receipt.contactId,
    },
    {
      accountId: accounts.accountsReceivableId,
      side: 'CREDIT',
      amount: receipt.amount,
      baseAmount: arBase,
      description: 'Accounts receivable settled',
      contactId: receipt.contactId,
    },
  ];

  // The difference is whatever is left over — derived from the two rates, not
  // plugged. If it is zero there is no FX line at all.
  const difference = bankBase.subtract(arBase);

  if (!difference.isZero()) {
    if (!accounts.fxGainLossId) {
      throw new Error(
        'A settlement produced a realised exchange difference of ' +
          `${difference.toDecimalString()} ${baseCurrency}, but no FX gain/loss ` +
          'account is configured. Posting without it would leave the entry unbalanced.',
      );
    }

    lines.push({
      accountId: accounts.fxGainLossId,
      side: fxPostingSide(difference),
      amount: difference.abs(),
      baseAmount: difference.abs(),
      description: difference.isNegative()
        ? 'Realised foreign exchange loss'
        : 'Realised foreign exchange gain',
      contactId: receipt.contactId,
    });
  }

  return {
    entryDate: ctx.entryDate,
    ...(ctx.description !== undefined ? { description: ctx.description } : {}),
    sourceModule: 'SALES',
    sourceDocumentType: ctx.documentType,
    sourceDocumentId: ctx.documentId,
    lines,
  };
}

/** The status an invoice moves to once `paid` has been applied to it. */
export function settlementStatus(total: Money, paid: Money): 'ISSUED' | 'PART_PAID' | 'PAID' {
  if (paid.isZero()) return 'ISSUED';
  return paid.compare(total) >= 0 ? 'PAID' : 'PART_PAID';
}
