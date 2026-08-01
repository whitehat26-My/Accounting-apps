import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money, sumMoney } from '../src/money.js';
import { isErr, unwrap } from '../src/result.js';
import { validateJournalEntry } from '../src/journal-entry.js';
import {
  autoAllocate,
  buildSettlementJournal,
  settlementStatus,
  validateReceipt,
  type OpenDocument,
  type ReceiptInput,
} from '../src/payment.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);

const ACCOUNTS = { controlAccountId: 'acc-ar' };
const POSTING = { entryDate: '2026-08-20', documentType: 'PAYMENT', documentId: 'pay-1' };

const openInvoice = (over: Partial<OpenDocument> = {}): OpenDocument => ({
  documentId: 'inv-1',
  documentNo: 'INV-00001',
  issueDate: '2026-08-01',
  dueDate: '2026-08-31',
  amountDue: rm('1080.00'),
  ...over,
});

const receipt = (over: Partial<ReceiptInput> = {}): ReceiptInput => ({
  contactId: 'cust-1',
  paymentDate: '2026-08-20',
  amount: rm('1080.00'),
  method: 'DUITNOW',
  depositAccountId: 'acc-bank',
  allocations: [{ documentId: 'inv-1', amount: rm('1080.00') }],
  ...over,
});

describe('receipt validation', () => {
  it('accepts a receipt that settles an invoice in full', () => {
    const result = validateReceipt(receipt(), [openInvoice()]);
    expect(result.ok).toBe(true);
    const validated = unwrap(result);
    expect(validated.allocatedTotal.toDecimalString()).toBe('1080.0000');
    expect(validated.unallocated.isZero()).toBe(true);
  });

  it('accepts a part payment', () => {
    const validated = unwrap(
      validateReceipt(
        receipt({ amount: rm('500.00'), allocations: [{ documentId: 'inv-1', amount: rm('500.00') }] }),
        [openInvoice()],
      ),
    );
    expect(validated.allocatedTotal.toDecimalString()).toBe('500.0000');
  });

  it('accepts one receipt settling several invoices — the DuitNow lump sum', () => {
    const validated = unwrap(
      validateReceipt(
        receipt({
          amount: rm('1500.00'),
          allocations: [
            { documentId: 'inv-1', amount: rm('1000.00') },
            { documentId: 'inv-2', amount: rm('500.00') },
          ],
        }),
        [
          openInvoice({ documentId: 'inv-1', amountDue: rm('1000.00') }),
          openInvoice({ documentId: 'inv-2', documentNo: 'INV-00002', amountDue: rm('500.00') }),
        ],
      ),
    );
    expect(validated.allocatedTotal.toDecimalString()).toBe('1500.0000');
    expect(validated.unallocated.isZero()).toBe(true);
  });

  it('records an overpayment as unallocated rather than rejecting it', () => {
    const validated = unwrap(
      validateReceipt(
        receipt({ amount: rm('1200.00'), allocations: [{ documentId: 'inv-1', amount: rm('1080.00') }] }),
        [openInvoice()],
      ),
    );
    expect(validated.unallocated.toDecimalString()).toBe('120.0000');
  });

  it('rejects allocating more than was received', () => {
    const result = validateReceipt(
      receipt({ amount: rm('500.00'), allocations: [{ documentId: 'inv-1', amount: rm('1080.00') }] }),
      [openInvoice()],
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]).toMatchObject({ code: 'OVER_ALLOCATED' });
  });

  it('rejects allocating more than the invoice still owes', () => {
    const result = validateReceipt(
      receipt({ amount: rm('2000.00'), allocations: [{ documentId: 'inv-1', amount: rm('2000.00') }] }),
      [openInvoice({ amountDue: rm('1080.00') })],
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]).toMatchObject({ code: 'EXCEEDS_AMOUNT_DUE' });
  });

  it('rejects an unknown invoice', () => {
    const result = validateReceipt(
      receipt({ allocations: [{ documentId: 'inv-ghost', amount: rm('10.00') }] }),
      [openInvoice()],
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]).toMatchObject({ code: 'UNKNOWN_DOCUMENT' });
  });

  it('rejects the same invoice allocated twice', () => {
    const result = validateReceipt(
      receipt({
        amount: rm('100.00'),
        allocations: [
          { documentId: 'inv-1', amount: rm('50.00') },
          { documentId: 'inv-1', amount: rm('50.00') },
        ],
      }),
      [openInvoice()],
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'DUPLICATE_ALLOCATION')).toBe(true);
    }
  });

  it('rejects a zero or negative receipt', () => {
    expect(isErr(validateReceipt(receipt({ amount: rm('0'), allocations: [] }), []))).toBe(true);
    expect(isErr(validateReceipt(receipt({ amount: rm('-5'), allocations: [] }), []))).toBe(true);
  });
});

describe('autoAllocate', () => {
  const invoices = [
    openInvoice({ documentId: 'a', documentNo: 'INV-1', issueDate: '2026-06-01', dueDate: '2026-07-31', amountDue: rm('300.00') }),
    openInvoice({ documentId: 'b', documentNo: 'INV-2', issueDate: '2026-07-01', dueDate: '2026-07-15', amountDue: rm('400.00') }),
    openInvoice({ documentId: 'c', documentNo: 'INV-3', issueDate: '2026-08-01', dueDate: '2026-08-31', amountDue: rm('500.00') }),
  ];

  it('settles oldest first by default', () => {
    const allocations = autoAllocate(rm('800.00'), invoices);
    expect(allocations.map((a) => [a.documentId, a.amount.toDecimalString()])).toEqual([
      ['a', '300.0000'],
      ['b', '400.0000'],
      ['c', '100.0000'],
    ]);
  });

  it('can settle by due date instead', () => {
    const allocations = autoAllocate(rm('500.00'), invoices, 'DUE_FIRST');
    // INV-2 is due first despite being issued after INV-1.
    expect(allocations[0]!.documentId).toBe('b');
  });

  it('stops when the money runs out', () => {
    const allocations = autoAllocate(rm('100.00'), invoices);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.amount.toDecimalString()).toBe('100.0000');
  });

  it('leaves a remainder unallocated when it exceeds everything owing', () => {
    const allocations = autoAllocate(rm('5000.00'), invoices);
    expect(sumMoney(allocations.map((a) => a.amount), MYR).toDecimalString()).toBe('1200.0000');
  });

  it('never allocates more than received or more than owed (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100_000_0000n }),
        fc.array(fc.bigInt({ min: 1n, max: 10_000_0000n }), { minLength: 1, maxLength: 12 }),
        (received, dues) => {
          const open = dues.map((d, i) =>
            openInvoice({
              documentId: `inv-${i}`,
              documentNo: `INV-${i}`,
              issueDate: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
              amountDue: Money.fromUnits(d, MYR),
            }),
          );
          const amount = Money.fromUnits(received, MYR);
          const allocations = autoAllocate(amount, open);
          const total = sumMoney(allocations.map((a) => a.amount), MYR);

          expect(total.compare(amount)).toBeLessThanOrEqual(0);

          const dueById = new Map(open.map((o) => [o.documentId, o.amountDue]));
          for (const allocation of allocations) {
            expect(allocation.amount.compare(dueById.get(allocation.documentId)!)).toBeLessThanOrEqual(0);
          }

          // And whatever it proposes must pass validation.
          expect(validateReceipt(receipt({ amount, allocations }), open).ok).toBe(true);
        },
      ),
    );
  });
});

describe('receipt journal', () => {
  it('posts Dr Bank / Cr AR for the full amount received', () => {
    const validated = unwrap(validateReceipt(receipt(), [openInvoice()]));
    const entry = buildSettlementJournal('INBOUND', validated, ACCOUNTS, POSTING)!;

    expect(entry.lines).toHaveLength(2);
    const bank = entry.lines.find((l) => l.accountId === 'acc-bank')!;
    const ar = entry.lines.find((l) => l.accountId === 'acc-ar')!;

    expect(bank.side).toBe('DEBIT');
    expect(bank.amount.toDecimalString()).toBe('1080.0000');
    expect(ar.side).toBe('CREDIT');
    expect(ar.amount.toDecimalString()).toBe('1080.0000');
  });

  it('credits AR with the unallocated remainder too', () => {
    // An overpayment leaves the customer in credit — AR goes negative, which
    // correctly says the business owes them money.
    const validated = unwrap(
      validateReceipt(
        receipt({ amount: rm('1200.00'), allocations: [{ documentId: 'inv-1', amount: rm('1080.00') }] }),
        [openInvoice()],
      ),
    );
    const entry = buildSettlementJournal('INBOUND', validated, ACCOUNTS, POSTING)!;
    expect(entry.lines.find((l) => l.accountId === 'acc-ar')!.amount.toDecimalString()).toBe('1200.0000');
  });

  it('always produces a balanced entry (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 100_000_0000n }), (units) => {
        const amount = Money.fromUnits(units, MYR);
        const validated = unwrap(validateReceipt(receipt({ amount, allocations: [] }), []));
        const entry = buildSettlementJournal('INBOUND', validated, ACCOUNTS, POSTING)!;
        expect(validateJournalEntry(entry, MYR).ok).toBe(true);
      }),
    );
  });
});

describe('settlementStatus', () => {
  it('maps paid amount to invoice status', () => {
    expect(settlementStatus(rm('100'), rm('0'))).toBe('ISSUED');
    expect(settlementStatus(rm('100'), rm('40'))).toBe('PART_PAID');
    expect(settlementStatus(rm('100'), rm('100'))).toBe('PAID');
    // Overpayment against a single invoice still reads as settled.
    expect(settlementStatus(rm('100'), rm('120'))).toBe('PAID');
  });
});
