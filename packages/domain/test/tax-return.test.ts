import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import {
  checkTaxReturn,
  computeTaxReturn,
  periodFor,
  taxablePeriods,
  type TaxTransactionRecord,
} from '../src/tax-return.js';

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

/**
 * A credit note, as the DATABASE actually stores it.
 *
 * `credit-note.ts` writes its tax_transaction rows already NEGATED. An earlier
 * version of this file built them positive and let the module re-derive the
 * sign from the document type — so the unit tests agreed with a bug that the
 * integration test against the real engine then caught. Building them the way
 * they are stored is what keeps the two honest.
 */
const creditNote = (over: { taxable: string; tax: string; taxPointDate?: string }) =>
  txn({
    sourceDocumentType: 'CREDIT_NOTE',
    taxableAmount: rm(over.taxable).negate(),
    taxAmount: rm(over.tax).negate(),
    ...(over.taxPointDate !== undefined ? { taxPointDate: over.taxPointDate } : {}),
  });

const txn = (over: Partial<TaxTransactionRecord> = {}): TaxTransactionRecord => ({
  regime: 'SST_SERVICE',
  direction: 'OUTPUT',
  sourceDocumentType: 'INVOICE',
  sourceDocumentId: `doc-${Math.random().toString(36).slice(2)}`,
  taxPointDate: '2026-03-15',
  taxableAmount: rm('1000.00'),
  taxAmount: rm('80.00'),
  ...over,
});

// ---------------------------------------------------------------------------
// The correctness point the whole module exists for
// ---------------------------------------------------------------------------

describe('SST is not a VAT', () => {
  it('does NOT deduct input tax from what must be remitted', () => {
    /*
     * The single most consequential assertion in this file.
     *
     * Under GST a business offsets tax paid on purchases against tax charged
     * and remits the difference. Under SST it does not: input tax is a cost,
     * absorbed into the expense, and the full output tax is remitted.
     *
     * A return that subtracts it under-declares by exactly the input tax — a
     * figure that looks entirely plausible on the form and reconciles against a
     * P&L built the same wrong way. The shortfall is the business's liability.
     */
    const figures = computeTaxReturn('SST_SERVICE', '2026-03-01', '2026-04-30', [
      txn({ taxAmount: rm('80.00'), taxableAmount: rm('1000.00') }),
      txn({
        direction: 'INPUT',
        sourceDocumentType: 'BILL',
        taxAmount: rm('30.00'),
        taxableAmount: rm('375.00'),
      }),
    ]);

    // 80, not 50.
    expect(figures.netTaxPayable.equals(rm('80.00'))).toBe(true);
    // Reported so it can be checked, and labelled so it cannot be mistaken for
    // a credit.
    expect(figures.inputTaxAbsorbed.equals(rm('30.00'))).toBe(true);
  });

  it('keeps sales tax and service tax apart', () => {
    // Different registration, different scope, different returns. Summing them
    // produces a number that is not any return — which is exactly what
    // outputTaxForPeriod() did, aggregating with no regime filter at all.
    const transactions = [
      txn({ regime: 'SST_SERVICE', taxAmount: rm('80.00') }),
      txn({ regime: 'SST_SALES', taxAmount: rm('50.00') }),
    ];

    const service = computeTaxReturn('SST_SERVICE', '2026-03-01', '2026-04-30', transactions);
    const sales = computeTaxReturn('SST_SALES', '2026-03-01', '2026-04-30', transactions);

    expect(service.netTaxPayable.equals(rm('80.00'))).toBe(true);
    expect(sales.netTaxPayable.equals(rm('50.00'))).toBe(true);
  });

  it('ignores a regime the business is not filing for', () => {
    const figures = computeTaxReturn('SST_SALES', '2026-03-01', '2026-04-30', [
      txn({ regime: 'SST_SERVICE', taxAmount: rm('80.00') }),
      txn({ regime: 'WHT', taxAmount: rm('100.00') }),
      txn({ regime: 'NONE', taxAmount: rm('0.00') }),
    ]);

    expect(figures.netTaxPayable.isZero()).toBe(true);
    expect(figures.documentCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

describe('credit notes reduce the return', () => {
  it('nets a credit note against supplies in ITS period, not the invoice’s', () => {
    // A credit note issued in April against a March invoice reduces April's
    // return. Applying it to March would mean amending a return already filed.
    const march = computeTaxReturn('SST_SERVICE', '2026-03-01', '2026-03-31', [
      txn({ taxPointDate: '2026-03-15', taxAmount: rm('80.00'), taxableAmount: rm('1000.00') }),
      creditNote({ taxPointDate: '2026-04-10', tax: '16.00', taxable: '200.00' }),
    ]);

    expect(march.netTaxPayable.equals(rm('80.00'))).toBe(true);
    expect(march.outputTaxAdjustments.isZero()).toBe(true);

    const april = computeTaxReturn('SST_SERVICE', '2026-04-01', '2026-04-30', [
      txn({ taxPointDate: '2026-03-15', taxAmount: rm('80.00') }),
      creditNote({ taxPointDate: '2026-04-10', tax: '16.00', taxable: '200.00' }),
    ]);

    expect(april.outputTaxAdjustments.equals(rm('16.00'))).toBe(true);
    // Negative: the period had a credit and no sales. Legitimate, and flagged.
    expect(april.netTaxPayable.equals(rm('-16.00'))).toBe(true);
    expect(checkTaxReturn(april).violations.join(' ')).toMatch(/negative/);
  });

  it('reduces taxable supplies as well as the tax', () => {
    const figures = computeTaxReturn('SST_SERVICE', '2026-03-01', '2026-03-31', [
      txn({ taxableAmount: rm('1000.00'), taxAmount: rm('80.00') }),
      creditNote({ taxable: '200.00', tax: '16.00' }),
    ]);

    expect(figures.taxableSupplies.equals(rm('800.00'))).toBe(true);
    expect(figures.netTaxPayable.equals(rm('64.00'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

describe('exempt supplies', () => {
  it('declares them separately rather than folding them into taxable supplies', () => {
    // An exempt supply is still a supply that has to be declared; it is simply
    // not taxed. Folding it into taxable supplies would overstate the base and
    // make the return disagree with itself.
    const figures = computeTaxReturn('SST_SERVICE', '2026-03-01', '2026-03-31', [
      txn({ taxableAmount: rm('1000.00'), taxAmount: rm('80.00') }),
      txn({
        taxableAmount: rm('500.00'),
        taxAmount: rm('0.00'),
        exemptionReason: 'Certificate CJ(P) 12345',
      }),
    ]);

    expect(figures.taxableSupplies.equals(rm('1000.00'))).toBe(true);
    expect(figures.exemptSupplies.equals(rm('500.00'))).toBe(true);
    expect(figures.netTaxPayable.equals(rm('80.00'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Internal consistency
// ---------------------------------------------------------------------------

describe('checkTaxReturn', () => {
  it('accepts an ordinary return', () => {
    const figures = computeTaxReturn('SST_SERVICE', '2026-03-01', '2026-04-30', [txn()]);
    expect(checkTaxReturn(figures).consistent).toBe(true);
  });

  it('PROPERTY: net payable is always charged less adjustments, and never touches input tax', () => {
    const money = fc.integer({ min: 0, max: 1_000_000 }).map((c) => rm((c / 100).toFixed(2)));

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom('INVOICE', 'CREDIT_NOTE', 'BILL'),
            taxable: money,
            tax: money,
          }),
          { maxLength: 40 },
        ),
        (rows) => {
          const transactions = rows.map((r) =>
            txn({
              sourceDocumentType: r.kind,
              direction: r.kind === 'BILL' ? 'INPUT' : 'OUTPUT',
              // Negated for a credit note, matching how they are stored.
              taxableAmount: r.kind === 'CREDIT_NOTE' ? r.taxable.negate() : r.taxable,
              taxAmount: r.kind === 'CREDIT_NOTE' ? r.tax.negate() : r.tax,
            }),
          );

          const figures = computeTaxReturn(
            'SST_SERVICE',
            '2026-03-01',
            '2026-04-30',
            transactions,
          );

          expect(
            figures.netTaxPayable.equals(
              figures.outputTaxCharged.subtract(figures.outputTaxAdjustments),
            ),
          ).toBe(true);

          // The invariant that matters: adding purchase tax never changes what
          // is owed, however much of it there is.
          const withoutInput = computeTaxReturn(
            'SST_SERVICE',
            '2026-03-01',
            '2026-04-30',
            transactions.filter((t) => t.direction === 'OUTPUT'),
          );
          expect(figures.netTaxPayable.equals(withoutInput.netTaxPayable)).toBe(true);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Taxable periods
// ---------------------------------------------------------------------------

describe('taxablePeriods', () => {
  it('generates contiguous bi-monthly periods with no gaps', () => {
    // Generated rather than stored so a period cannot be silently skipped — a
    // gap in a filing history is what draws an assessment.
    const periods = taxablePeriods('2026-01-01', 2, '2026-12-31');

    expect(periods).toHaveLength(6);
    expect(periods[0]).toMatchObject({ start: '2026-01-01', end: '2026-02-28' });
    expect(periods[5]).toMatchObject({ start: '2026-11-01', end: '2026-12-31' });

    for (let i = 1; i < periods.length; i++) {
      const previousEnd = new Date(`${periods[i - 1]!.end}T00:00:00Z`);
      const thisStart = new Date(`${periods[i]!.start}T00:00:00Z`);
      const gapDays = (thisStart.getTime() - previousEnd.getTime()) / 86_400_000;
      expect(gapDays, `gap before ${periods[i]!.start}`).toBe(1);
    }
  });

  it('handles a leap year end date', () => {
    const periods = taxablePeriods('2028-01-01', 2, '2028-03-01');
    expect(periods[0]!.end).toBe('2028-02-29');
  });

  it('supports a monthly cadence too, because the cycle is assigned not assumed', () => {
    const periods = taxablePeriods('2026-01-01', 1, '2026-03-31');
    expect(periods.map((p) => p.end)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('refuses a cadence that is not whole months', () => {
    expect(() => taxablePeriods('2026-01-01', 0, '2026-12-31')).toThrow(/whole months/);
    expect(() => taxablePeriods('2026-01-01', 1.5, '2026-12-31')).toThrow(/whole months/);
  });

  it('PROPERTY: every date on or after the first period falls in exactly one period', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 700 }),
        fc.constantFrom(1, 2, 3, 6),
        (dayOffset, cadence) => {
          const date = new Date(Date.UTC(2026, 0, 1 + dayOffset)).toISOString().slice(0, 10);
          const periods = taxablePeriods('2026-01-01', cadence, date);
          const containing = periods.filter((p) => date >= p.start && date <= p.end);

          expect(containing, `${date} at cadence ${cadence}`).toHaveLength(1);
          expect(periodFor(date, '2026-01-01', cadence)).toEqual(containing[0]);
        },
      ),
    );
  });

  it('returns null for a date before the first period', () => {
    expect(periodFor('2025-12-31', '2026-01-01', 2)).toBeNull();
  });
});
