import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money, sumMoney } from '../src/money.js';
import { unwrap } from '../src/result.js';
import { netMovementByAccount, validateJournalEntry } from '../src/journal-entry.js';
import { converter, fxPostingSide, Rate, realisedFx, toBase } from '../src/fx.js';
import {
  buildReceiptJournal,
  validateReceipt,
  type OpenInvoice,
  type ReceiptInput,
} from '../src/payment.js';
import { buildSalesJournal, computeDocument, type DocumentLine } from '../src/document.js';
import type { TaxCode } from '../src/tax.js';

const MYR = 'MYR';
const USD = 'USD';
const rm = (v: string) => Money.fromDecimal(v, MYR);
const usd = (v: string) => Money.fromDecimal(v, USD);

describe('Rate', () => {
  it('holds eight decimal places exactly', () => {
    expect(Rate.fromDecimal('4.7050').toDecimalString()).toBe('4.70500000');
    expect(Rate.fromDecimal('4.12345678').toDecimalString()).toBe('4.12345678');
  });

  it('rejects excess precision rather than rounding it away', () => {
    expect(() => Rate.fromDecimal('4.123456789')).toThrow(RangeError);
  });

  it('rejects a non-positive or malformed rate', () => {
    expect(() => Rate.fromDecimal('0')).toThrow(RangeError);
    expect(() => Rate.fromDecimal('-4.70')).toThrow(TypeError);
    expect(() => Rate.fromDecimal('abc')).toThrow(TypeError);
  });

  it('recognises unity', () => {
    expect(Rate.one().isOne()).toBe(true);
    expect(Rate.fromDecimal('1').isOne()).toBe(true);
    expect(Rate.fromDecimal('4.70').isOne()).toBe(false);
  });
});

describe('conversion', () => {
  it('converts USD to MYR at a rate', () => {
    expect(toBase(usd('1000.00'), Rate.fromDecimal('4.70'), MYR).toDecimalString()).toBe('4700.0000');
  });

  it('is a no-op when the amount is already in the base currency', () => {
    const amount = rm('1234.56');
    expect(toBase(amount, Rate.fromDecimal('4.70'), MYR).equals(amount)).toBe(true);
  });

  it('rounds at the money scale', () => {
    // 33.33 * 4.7051 = 156.820983 exactly -> 156.8210 at 4dp
    expect(toBase(usd('33.33'), Rate.fromDecimal('4.7051'), MYR).toDecimalString()).toBe('156.8210');
  });

  it('never produces a float artefact (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000_0000n }),
        fc.bigInt({ min: 1n, max: 10_00000000n }),
        (amountUnits, rateUnits) => {
          const converted = toBase(
            Money.fromUnits(amountUnits, USD),
            Rate.fromUnits(rateUnits),
            MYR,
          );
          expect(converted.currency).toBe(MYR);
          // Exact decimal string round trip — no drift, no exponent notation.
          expect(Money.fromDecimal(converted.toDecimalString(), MYR).equals(converted)).toBe(true);
        },
      ),
    );
  });

  it('exposes a converter function for the posting builders', () => {
    const convert = converter(Rate.fromDecimal('4.70'), MYR);
    expect(convert(usd('100.00')).toDecimalString()).toBe('470.0000');
  });
});

describe('realised FX', () => {
  it('computes a gain when the settlement rate is higher', () => {
    const result = realisedFx(
      [{ amount: usd('1000.00'), bookedRate: Rate.fromDecimal('4.70') }],
      Rate.fromDecimal('4.75'),
      MYR,
    );
    expect(result.bookedBase.toDecimalString()).toBe('4700.0000');
    expect(result.settlementBase.toDecimalString()).toBe('4750.0000');
    expect(result.difference.toDecimalString()).toBe('50.0000');
    expect(fxPostingSide(result.difference)).toBe('CREDIT');
  });

  it('computes a loss when the settlement rate is lower', () => {
    const result = realisedFx(
      [{ amount: usd('1000.00'), bookedRate: Rate.fromDecimal('4.70') }],
      Rate.fromDecimal('4.60'),
      MYR,
    );
    expect(result.difference.toDecimalString()).toBe('-100.0000');
    expect(fxPostingSide(result.difference)).toBe('DEBIT');
  });

  it('is zero when the rate has not moved', () => {
    const result = realisedFx(
      [{ amount: usd('1000.00'), bookedRate: Rate.fromDecimal('4.70') }],
      Rate.fromDecimal('4.70'),
      MYR,
    );
    expect(result.difference.isZero()).toBe(true);
  });

  it('uses each leg its own booked rate rather than an average', () => {
    // Two invoices raised on different days, settled together.
    const result = realisedFx(
      [
        { amount: usd('1000.00'), bookedRate: Rate.fromDecimal('4.70') },
        { amount: usd('1000.00'), bookedRate: Rate.fromDecimal('4.50') },
      ],
      Rate.fromDecimal('4.75'),
      MYR,
    );

    // 4700 + 4500 booked, 9500 settled -> 300 gain. Averaging the rates to
    // 4.60 would give 9200 booked and the same 300 here, but the AR relief
    // per invoice would be wrong and the control account would not clear.
    expect(result.bookedBase.toDecimalString()).toBe('9200.0000');
    expect(result.settlementBase.toDecimalString()).toBe('9500.0000');
    expect(result.difference.toDecimalString()).toBe('300.0000');
  });
});

// ---------------------------------------------------------------------------
// Invariant #13
// ---------------------------------------------------------------------------

const NO_TAX: TaxCode = {
  id: 'tc-none',
  code: 'NONE',
  name: 'Out of scope',
  regime: 'NONE',
  inputTreatment: 'COST',
  versions: [],
};

const SALES_ACCOUNTS = { accountsReceivableId: 'acc-ar', taxPayableId: 'acc-sst' };
const RECEIPT_ACCOUNTS = { accountsReceivableId: 'acc-ar', fxGainLossId: 'acc-fx' };

function foreignInvoice(amount: string, rate: string) {
  const lines: DocumentLine[] = [
    {
      lineId: 'l1',
      description: 'Export services',
      quantity: 10_000n,
      unitPrice: usd(amount),
      accountId: 'acc-revenue',
      taxCodeId: 'tc-none',
    },
  ];

  const doc = unwrap(
    computeDocument({
      lines,
      taxPointDate: '2026-08-01',
      direction: 'OUTPUT',
      amountsAreTaxInclusive: false,
      taxCodes: [NO_TAX],
      entity: { isRegistered: true },
    }),
  );

  const entry = buildSalesJournal(doc, SALES_ACCOUNTS, {
    entryDate: '2026-08-01',
    documentType: 'INVOICE',
    documentId: 'inv-1',
    fxRate: { baseCurrency: MYR, convert: converter(Rate.fromDecimal(rate), MYR) },
  })!;

  return { doc, entry };
}

function receiptFor(
  amount: string,
  settlementRate: string,
  openInvoices: readonly OpenInvoice[],
  allocations: readonly { invoiceId: string; amount: Money }[],
) {
  const input: ReceiptInput = {
    contactId: 'cust-1',
    paymentDate: '2026-09-01',
    amount: usd(amount),
    method: 'TRANSFER',
    depositAccountId: 'acc-bank-usd',
    allocations,
  };

  const receipt = unwrap(validateReceipt(input, openInvoices));

  return buildReceiptJournal(
    receipt,
    RECEIPT_ACCOUNTS,
    { entryDate: '2026-09-01', documentType: 'PAYMENT', documentId: 'pay-1' },
    { baseCurrency: MYR, settlementRate: Rate.fromDecimal(settlementRate), openInvoices },
  )!;
}

describe('invariant #13 — settling at a different rate posts a balanced FX line', () => {
  it('books a foreign invoice into AR at the invoice-date rate', () => {
    const { entry } = foreignInvoice('1000.00', '4.70');

    const ar = entry.lines.find((l) => l.accountId === 'acc-ar')!;
    expect(ar.amount.toDecimalString()).toBe('1000.0000'); // USD
    expect(ar.amount.currency).toBe(USD);
    expect(ar.baseAmount.toDecimalString()).toBe('4700.0000'); // MYR
    expect(validateJournalEntry(entry, MYR).ok).toBe(true);
  });

  it('posts a realised gain and stays balanced', () => {
    const open: OpenInvoice[] = [{
      invoiceId: 'inv-1',
      invoiceNo: 'INV-1',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: usd('1000.00'),
      bookedRate: Rate.fromDecimal('4.70'),
    }];

    const entry = receiptFor('1000.00', '4.75', open, [
      { invoiceId: 'inv-1', amount: usd('1000.00') },
    ]);

    const bank = entry.lines.find((l) => l.accountId === 'acc-bank-usd')!;
    const ar = entry.lines.find((l) => l.accountId === 'acc-ar')!;
    const fx = entry.lines.find((l) => l.accountId === 'acc-fx')!;

    expect(bank.baseAmount.toDecimalString()).toBe('4750.0000');
    // Relieved at the BOOKED rate, not the settlement rate.
    expect(ar.baseAmount.toDecimalString()).toBe('4700.0000');
    expect(fx.side).toBe('CREDIT');
    expect(fx.baseAmount.toDecimalString()).toBe('50.0000');

    expect(validateJournalEntry(entry, MYR).ok).toBe(true);
  });

  it('posts a realised loss and stays balanced', () => {
    const open: OpenInvoice[] = [{
      invoiceId: 'inv-1',
      invoiceNo: 'INV-1',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: usd('1000.00'),
      bookedRate: Rate.fromDecimal('4.70'),
    }];

    const entry = receiptFor('1000.00', '4.55', open, [
      { invoiceId: 'inv-1', amount: usd('1000.00') },
    ]);

    const fx = entry.lines.find((l) => l.accountId === 'acc-fx')!;
    expect(fx.side).toBe('DEBIT');
    expect(fx.baseAmount.toDecimalString()).toBe('150.0000');
    expect(validateJournalEntry(entry, MYR).ok).toBe(true);
  });

  it('omits the FX line entirely when the rate has not moved', () => {
    const open: OpenInvoice[] = [{
      invoiceId: 'inv-1',
      invoiceNo: 'INV-1',
      issueDate: '2026-08-01',
      dueDate: '2026-08-31',
      amountDue: usd('1000.00'),
      bookedRate: Rate.fromDecimal('4.70'),
    }];

    const entry = receiptFor('1000.00', '4.70', open, [
      { invoiceId: 'inv-1', amount: usd('1000.00') },
    ]);

    expect(entry.lines.some((l) => l.accountId === 'acc-fx')).toBe(false);
    expect(entry.lines).toHaveLength(2);
  });

  it('relieves each invoice at its own rate when one receipt settles several', () => {
    const open: OpenInvoice[] = [
      {
        invoiceId: 'inv-a', invoiceNo: 'INV-A', issueDate: '2026-06-01', dueDate: '2026-06-30',
        amountDue: usd('1000.00'), bookedRate: Rate.fromDecimal('4.50'),
      },
      {
        invoiceId: 'inv-b', invoiceNo: 'INV-B', issueDate: '2026-08-01', dueDate: '2026-08-31',
        amountDue: usd('1000.00'), bookedRate: Rate.fromDecimal('4.70'),
      },
    ];

    const entry = receiptFor('2000.00', '4.75', open, [
      { invoiceId: 'inv-a', amount: usd('1000.00') },
      { invoiceId: 'inv-b', amount: usd('1000.00') },
    ]);

    const ar = entry.lines.find((l) => l.accountId === 'acc-ar')!;
    const fx = entry.lines.find((l) => l.accountId === 'acc-fx')!;

    expect(ar.baseAmount.toDecimalString()).toBe('9200.0000'); // 4500 + 4700
    expect(fx.baseAmount.toDecimalString()).toBe('300.0000');
    expect(validateJournalEntry(entry, MYR).ok).toBe(true);
  });

  it('carries an unallocated remainder at the settlement rate', () => {
    const open: OpenInvoice[] = [{
      invoiceId: 'inv-1', invoiceNo: 'INV-1', issueDate: '2026-08-01', dueDate: '2026-08-31',
      amountDue: usd('1000.00'), bookedRate: Rate.fromDecimal('4.70'),
    }];

    // USD 1,200 received, USD 1,000 applied. The 200 overpayment is a fresh
    // credit and belongs at today's rate, not at the old invoice's rate.
    const entry = receiptFor('1200.00', '4.75', open, [
      { invoiceId: 'inv-1', amount: usd('1000.00') },
    ]);

    const ar = entry.lines.find((l) => l.accountId === 'acc-ar')!;
    expect(ar.baseAmount.toDecimalString()).toBe('5650.0000'); // 4700 + 200*4.75
    expect(validateJournalEntry(entry, MYR).ok).toBe(true);
  });

  it('clears AR to exactly zero when a foreign invoice is settled in full', () => {
    const { entry: invoiceEntry } = foreignInvoice('1000.00', '4.70');

    const open: OpenInvoice[] = [{
      invoiceId: 'inv-1', invoiceNo: 'INV-1', issueDate: '2026-08-01', dueDate: '2026-08-31',
      amountDue: usd('1000.00'), bookedRate: Rate.fromDecimal('4.70'),
    }];

    const receiptEntry = receiptFor('1000.00', '4.75', open, [
      { invoiceId: 'inv-1', amount: usd('1000.00') },
    ]);

    // This is the whole point: the AR control account returns to zero, and
    // the residue lands in FX rather than being stranded in AR.
    const movements = netMovementByAccount([invoiceEntry, receiptEntry], MYR);
    expect(movements.get('acc-ar')!.isZero()).toBe(true);
    expect(movements.get('acc-fx')!.toDecimalString()).toBe('-50.0000'); // credit = gain
  });

  it('always balances, at any pair of rates (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_0000n }),        // amount
        fc.bigInt({ min: 1_00000000n, max: 10_00000000n }), // booked rate 1.0 - 10.0
        fc.bigInt({ min: 1_00000000n, max: 10_00000000n }), // settlement rate
        (amountUnits, bookedUnits, settlementUnits) => {
          const amount = Money.fromUnits(amountUnits, USD);
          const open: OpenInvoice[] = [{
            invoiceId: 'inv-1', invoiceNo: 'INV-1',
            issueDate: '2026-08-01', dueDate: '2026-08-31',
            amountDue: amount, bookedRate: Rate.fromUnits(bookedUnits),
          }];

          const receipt = unwrap(
            validateReceipt(
              {
                contactId: 'c', paymentDate: '2026-09-01', amount,
                method: 'TRANSFER', depositAccountId: 'acc-bank-usd',
                allocations: [{ invoiceId: 'inv-1', amount }],
              },
              open,
            ),
          );

          const entry = buildReceiptJournal(
            receipt,
            RECEIPT_ACCOUNTS,
            { entryDate: '2026-09-01', documentType: 'PAYMENT', documentId: 'p' },
            { baseCurrency: MYR, settlementRate: Rate.fromUnits(settlementUnits), openInvoices: open },
          )!;

          const validated = validateJournalEntry(entry, MYR);
          expect(validated.ok, JSON.stringify(validated.ok ? {} : validated.error)).toBe(true);
        },
      ),
    );
  });

  it('refuses to post an FX difference with no account configured', () => {
    const open: OpenInvoice[] = [{
      invoiceId: 'inv-1', invoiceNo: 'INV-1', issueDate: '2026-08-01', dueDate: '2026-08-31',
      amountDue: usd('1000.00'), bookedRate: Rate.fromDecimal('4.70'),
    }];

    const receipt = unwrap(
      validateReceipt(
        {
          contactId: 'c', paymentDate: '2026-09-01', amount: usd('1000.00'),
          method: 'TRANSFER', depositAccountId: 'acc-bank-usd',
          allocations: [{ invoiceId: 'inv-1', amount: usd('1000.00') }],
        },
        open,
      ),
    );

    // Silently dropping the difference would post an unbalanced entry.
    expect(() =>
      buildReceiptJournal(
        receipt,
        { accountsReceivableId: 'acc-ar' },
        { entryDate: '2026-09-01', documentType: 'PAYMENT', documentId: 'p' },
        { baseCurrency: MYR, settlementRate: Rate.fromDecimal('4.75'), openInvoices: open },
      ),
    ).toThrow(/FX gain\/loss account/i);
  });
});

describe('base-currency receipts are unaffected', () => {
  it('posts two lines with no FX involvement', () => {
    const open: OpenInvoice[] = [{
      invoiceId: 'inv-1', invoiceNo: 'INV-1', issueDate: '2026-08-01', dueDate: '2026-08-31',
      amountDue: rm('1000.00'),
    }];

    const receipt = unwrap(
      validateReceipt(
        {
          contactId: 'c', paymentDate: '2026-09-01', amount: rm('1000.00'),
          method: 'FPX', depositAccountId: 'acc-bank',
          allocations: [{ invoiceId: 'inv-1', amount: rm('1000.00') }],
        },
        open,
      ),
    );

    const entry = buildReceiptJournal(
      receipt,
      RECEIPT_ACCOUNTS,
      { entryDate: '2026-09-01', documentType: 'PAYMENT', documentId: 'p' },
      { baseCurrency: MYR, settlementRate: Rate.one(), openInvoices: open },
    )!;

    expect(entry.lines).toHaveLength(2);
    expect(sumMoney(entry.lines.map((l) => l.baseAmount), MYR).toDecimalString()).toBe('2000.0000');
  });
});
