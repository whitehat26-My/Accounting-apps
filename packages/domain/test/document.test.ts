import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money, sumMoney } from '../src/money.js';
import { isErr, unwrap } from '../src/result.js';
import { validateJournalEntry } from '../src/journal-entry.js';
import type { TaxCode } from '../src/tax.js';
import {
  buildPurchaseJournal,
  buildSalesJournal,
  computeDocument,
  hasLedgerEffect,
  QUANTITY_SCALE,
  type DocumentLine,
} from '../src/document.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);
/** 2.5 units -> 25000n */
const qty = (v: string) => {
  const [whole = '0', frac = ''] = v.split('.');
  return BigInt(whole) * 10n ** BigInt(QUANTITY_SCALE) + BigInt(frac.padEnd(QUANTITY_SCALE, '0') || '0');
};

const SERVICE_TAX: TaxCode = {
  id: 'tc-svc',
  code: 'SST-SVC',
  name: 'Service tax',
  regime: 'SST_SERVICE',
  inputTreatment: 'COST',
  versions: [{ rateBasisPoints: 800n, validFrom: '2024-03-01', validTo: null }],
};

const RECOVERABLE: TaxCode = {
  id: 'tc-rec',
  code: 'REC',
  name: 'Recoverable input tax',
  regime: 'SST_SALES',
  inputTreatment: 'RECOVERABLE',
  versions: [{ rateBasisPoints: 600n, validFrom: '2018-09-01', validTo: null }],
};

const NONE: TaxCode = {
  id: 'tc-none',
  code: 'NONE',
  name: 'Out of scope',
  regime: 'NONE',
  inputTreatment: 'COST',
  versions: [],
};

const CODES = [SERVICE_TAX, RECOVERABLE, NONE];

const SALES_ACCOUNTS = { accountsReceivableId: 'acc-ar', taxPayableId: 'acc-sst-payable' };
const PURCHASE_ACCOUNTS = { accountsPayableId: 'acc-ap', taxClaimableId: 'acc-sst-claimable' };

function doc(lines: DocumentLine[], overrides: Partial<Parameters<typeof computeDocument>[0]> = {}) {
  return computeDocument({
    lines,
    taxPointDate: '2026-08-01',
    direction: 'OUTPUT',
    amountsAreTaxInclusive: false,
    taxCodes: CODES,
    entity: { isRegistered: true },
    ...overrides,
  });
}

const line = (over: Partial<DocumentLine> = {}): DocumentLine => ({
  lineId: 'l1',
  description: 'Consulting services',
  quantity: qty('1'),
  unitPrice: rm('1000.00'),
  accountId: 'acc-revenue',
  taxCodeId: 'tc-svc',
  ...over,
});

describe('document computation', () => {
  it('computes a simple invoice', () => {
    const d = unwrap(doc([line()]));
    expect(d.subtotal.toDecimalString()).toBe('1000.0000');
    expect(d.taxTotal.toDecimalString()).toBe('80.0000');
    expect(d.total.toDecimalString()).toBe('1080.0000');
  });

  it('multiplies by quantity', () => {
    const d = unwrap(doc([line({ quantity: qty('2.5'), unitPrice: rm('400.00') })]));
    expect(d.subtotal.toDecimalString()).toBe('1000.0000');
  });

  it('applies a line discount before tax', () => {
    const d = unwrap(doc([line({ discountBasisPoints: 1000n })])); // 10%
    expect(d.subtotal.toDecimalString()).toBe('900.0000');
    expect(d.taxTotal.toDecimalString()).toBe('72.0000');
  });

  it('handles tax-inclusive pricing', () => {
    const d = unwrap(doc([line({ unitPrice: rm('1080.00') })], { amountsAreTaxInclusive: true }));
    expect(d.subtotal.toDecimalString()).toBe('1000.0000');
    expect(d.taxTotal.toDecimalString()).toBe('80.0000');
    expect(d.total.toDecimalString()).toBe('1080.0000');
  });

  it('rejects a non-positive quantity', () => {
    const result = doc([line({ quantity: 0n })]);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]).toMatchObject({ code: 'NON_POSITIVE_QUANTITY' });
  });

  it('rejects a discount above 100%', () => {
    const result = doc([line({ discountBasisPoints: 10_001n })]);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]).toMatchObject({ code: 'INVALID_DISCOUNT' });
  });

  it('always has total = subtotal + tax (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            units: fc.bigInt({ min: 1n, max: 10_000_0000n }),
            quantity: fc.bigInt({ min: 1n, max: 100_0000n }),
            discount: fc.bigInt({ min: 0n, max: 9_000n }),
            taxCodeId: fc.constantFrom('tc-svc', 'tc-none'),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (rows) => {
          const d = unwrap(
            doc(
              rows.map((r, i) => ({
                lineId: `l${i}`,
                description: `line ${i}`,
                quantity: r.quantity,
                unitPrice: Money.fromUnits(r.units, MYR),
                discountBasisPoints: r.discount,
                accountId: 'acc-revenue',
                taxCodeId: r.taxCodeId,
              })),
            ),
          );
          expect(d.subtotal.add(d.taxTotal).equals(d.total)).toBe(true);
          expect(sumMoney(d.lines.map((l) => l.lineTotal), MYR).equals(d.total)).toBe(true);
        },
      ),
    );
  });
});

describe('sales journal', () => {
  it('posts Dr AR / Cr Revenue / Cr SST Payable', () => {
    const d = unwrap(doc([line()]));
    const entry = buildSalesJournal(d, SALES_ACCOUNTS, {
      entryDate: '2026-08-01',
      documentType: 'INVOICE',
      documentId: 'inv-1',
      contactId: 'cust-1',
    })!;

    expect(entry.lines).toHaveLength(3);
    const ar = entry.lines.find((l) => l.accountId === 'acc-ar')!;
    const revenue = entry.lines.find((l) => l.accountId === 'acc-revenue')!;
    const sst = entry.lines.find((l) => l.accountId === 'acc-sst-payable')!;

    expect(ar.side).toBe('DEBIT');
    expect(ar.amount.toDecimalString()).toBe('1080.0000');
    expect(revenue.side).toBe('CREDIT');
    expect(revenue.amount.toDecimalString()).toBe('1000.0000');
    expect(sst.side).toBe('CREDIT');
    expect(sst.amount.toDecimalString()).toBe('80.0000');
  });

  it('groups multiple lines by revenue account', () => {
    const d = unwrap(
      doc([
        line({ lineId: 'l1', accountId: 'acc-rev-a', unitPrice: rm('100') }),
        line({ lineId: 'l2', accountId: 'acc-rev-a', unitPrice: rm('200') }),
        line({ lineId: 'l3', accountId: 'acc-rev-b', unitPrice: rm('300') }),
      ]),
    );
    const entry = buildSalesJournal(d, SALES_ACCOUNTS, {
      entryDate: '2026-08-01',
      documentType: 'INVOICE',
      documentId: 'inv-1',
    })!;

    const revA = entry.lines.find((l) => l.accountId === 'acc-rev-a')!;
    expect(revA.amount.toDecimalString()).toBe('300.0000');
    expect(entry.lines.filter((l) => l.accountId === 'acc-rev-a')).toHaveLength(1);
  });

  it('omits the tax line entirely when no tax applies', () => {
    const d = unwrap(doc([line({ taxCodeId: 'tc-none' })]));
    const entry = buildSalesJournal(d, SALES_ACCOUNTS, {
      entryDate: '2026-08-01',
      documentType: 'INVOICE',
      documentId: 'inv-1',
    })!;
    expect(entry.lines.some((l) => l.accountId === 'acc-sst-payable')).toBe(false);
    expect(entry.lines).toHaveLength(2);
  });
});

describe('purchase journal — SST input tax is a cost, not an asset', () => {
  it('absorbs non-recoverable input tax into the expense account', () => {
    const d = unwrap(
      doc([line({ accountId: 'acc-expense', taxCodeId: 'tc-svc' })], { direction: 'INPUT' }),
    );
    const entry = buildPurchaseJournal(d, PURCHASE_ACCOUNTS, {
      entryDate: '2026-08-01',
      documentType: 'BILL',
      documentId: 'bill-1',
    })!;

    const expense = entry.lines.find((l) => l.accountId === 'acc-expense')!;
    const ap = entry.lines.find((l) => l.accountId === 'acc-ap')!;

    // The whole RM 1,080 is expense. Under a VAT regime RM 80 of this would
    // have gone to a claimable asset instead — that difference is the entire
    // point of modelling SST separately.
    expect(expense.amount.toDecimalString()).toBe('1080.0000');
    expect(ap.amount.toDecimalString()).toBe('1080.0000');
    expect(entry.lines.some((l) => l.accountId === 'acc-sst-claimable')).toBe(false);
  });

  it('books recoverable input tax to the claimable account instead', () => {
    const d = unwrap(
      doc([line({ accountId: 'acc-expense', taxCodeId: 'tc-rec' })], { direction: 'INPUT' }),
    );
    const entry = buildPurchaseJournal(d, PURCHASE_ACCOUNTS, {
      entryDate: '2026-08-01',
      documentType: 'BILL',
      documentId: 'bill-1',
    })!;

    const expense = entry.lines.find((l) => l.accountId === 'acc-expense')!;
    const claimable = entry.lines.find((l) => l.accountId === 'acc-sst-claimable')!;

    expect(expense.amount.toDecimalString()).toBe('1000.0000');
    expect(claimable.amount.toDecimalString()).toBe('60.0000');
  });

  it('handles a bill mixing recoverable and non-recoverable lines', () => {
    const d = unwrap(
      doc(
        [
          line({ lineId: 'l1', accountId: 'acc-expense', taxCodeId: 'tc-svc', unitPrice: rm('1000') }),
          line({ lineId: 'l2', accountId: 'acc-expense', taxCodeId: 'tc-rec', unitPrice: rm('1000') }),
        ],
        { direction: 'INPUT' },
      ),
    );
    const entry = buildPurchaseJournal(d, PURCHASE_ACCOUNTS, {
      entryDate: '2026-08-01',
      documentType: 'BILL',
      documentId: 'bill-1',
    })!;

    // 1000 + 80 absorbed, plus 1000 net = 2080 expense; 60 claimable; 2140 AP.
    expect(entry.lines.find((l) => l.accountId === 'acc-expense')!.amount.toDecimalString()).toBe('2080.0000');
    expect(entry.lines.find((l) => l.accountId === 'acc-sst-claimable')!.amount.toDecimalString()).toBe('60.0000');
    expect(entry.lines.find((l) => l.accountId === 'acc-ap')!.amount.toDecimalString()).toBe('2140.0000');
  });
});

describe('every generated document produces a balanced journal', () => {
  const arbLines = fc.array(
    fc.record({
      units: fc.bigInt({ min: 1n, max: 10_000_0000n }),
      quantity: fc.bigInt({ min: 1n, max: 50_0000n }),
      discount: fc.bigInt({ min: 0n, max: 9_000n }),
      accountId: fc.constantFrom('acc-a', 'acc-b', 'acc-c'),
      taxCodeId: fc.constantFrom('tc-svc', 'tc-rec', 'tc-none'),
    }),
    { minLength: 1, maxLength: 10 },
  );

  it('sales: debits equal credits (property)', () => {
    fc.assert(
      fc.property(arbLines, (rows) => {
        const d = unwrap(
          doc(
            rows.map((r, i) => ({
              lineId: `l${i}`,
              description: `line ${i}`,
              quantity: r.quantity,
              unitPrice: Money.fromUnits(r.units, MYR),
              discountBasisPoints: r.discount,
              accountId: r.accountId,
              taxCodeId: r.taxCodeId,
            })),
          ),
        );

        const entry = buildSalesJournal(d, SALES_ACCOUNTS, {
          entryDate: '2026-08-01',
          documentType: 'INVOICE',
          documentId: 'inv-x',
        });

        // Either the document has no ledger effect and nothing is built, or
        // what is built is a valid, balanced entry. Never a third outcome.
        if (entry === null) {
          expect(hasLedgerEffect(d)).toBe(false);
          return;
        }
        const validated = validateJournalEntry(entry, MYR);
        expect(validated.ok, JSON.stringify(validated.ok ? {} : validated.error)).toBe(true);
      }),
    );
  });

  it('purchases: debits equal credits (property)', () => {
    fc.assert(
      fc.property(arbLines, (rows) => {
        const d = unwrap(
          doc(
            rows.map((r, i) => ({
              lineId: `l${i}`,
              description: `line ${i}`,
              quantity: r.quantity,
              unitPrice: Money.fromUnits(r.units, MYR),
              discountBasisPoints: r.discount,
              accountId: r.accountId,
              taxCodeId: r.taxCodeId,
            })),
            { direction: 'INPUT' },
          ),
        );

        const entry = buildPurchaseJournal(d, PURCHASE_ACCOUNTS, {
          entryDate: '2026-08-01',
          documentType: 'BILL',
          documentId: 'bill-x',
        });

        if (entry === null) {
          expect(hasLedgerEffect(d)).toBe(false);
          return;
        }
        const validated = validateJournalEntry(entry, MYR);
        expect(validated.ok, JSON.stringify(validated.ok ? {} : validated.error)).toBe(true);
      }),
    );
  });
});


describe('zero-value documents have no ledger effect', () => {
  // Regression: fast-check found that a line whose net rounds to zero produced
  // a single-sided RM 0.00 debit to AR, because the AR line was pushed
  // unconditionally while the zero revenue and tax lines were skipped.
  it('builds no journal when every line rounds to zero', () => {
    const d = unwrap(doc([line({ quantity: 1n, unitPrice: Money.fromUnits(1n, MYR) })]));
    expect(d.total.isZero()).toBe(true);
    expect(hasLedgerEffect(d)).toBe(false);
    expect(
      buildSalesJournal(d, SALES_ACCOUNTS, {
        entryDate: '2026-08-01',
        documentType: 'INVOICE',
        documentId: 'inv-zero',
      }),
    ).toBeNull();
  });

  it('builds no journal for a fully discounted line — the realistic case', () => {
    const d = unwrap(doc([line({ discountBasisPoints: 10_000n })]));
    expect(d.total.isZero()).toBe(true);
    expect(
      buildSalesJournal(d, SALES_ACCOUNTS, {
        entryDate: '2026-08-01',
        documentType: 'INVOICE',
        documentId: 'inv-free',
      }),
    ).toBeNull();
  });

  it('same for purchases', () => {
    const d = unwrap(
      doc([line({ discountBasisPoints: 10_000n, accountId: 'acc-expense' })], { direction: 'INPUT' }),
    );
    expect(
      buildPurchaseJournal(d, PURCHASE_ACCOUNTS, {
        entryDate: '2026-08-01',
        documentType: 'BILL',
        documentId: 'bill-free',
      }),
    ).toBeNull();
  });

  it('still posts when the total is non-zero but some lines are zero', () => {
    const d = unwrap(
      doc([
        line({ lineId: 'l1', discountBasisPoints: 10_000n }),
        line({ lineId: 'l2', unitPrice: rm('500.00') }),
      ]),
    );
    const entry = buildSalesJournal(d, SALES_ACCOUNTS, {
      entryDate: '2026-08-01',
      documentType: 'INVOICE',
      documentId: 'inv-mixed',
    })!;
    expect(entry).not.toBeNull();
    expect(validateJournalEntry(entry, MYR).ok).toBe(true);
  });
});
