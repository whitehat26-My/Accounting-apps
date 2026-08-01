import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import { isErr, unwrap } from '../src/result.js';
import { netMovementByAccount, validateJournalEntry } from '../src/journal-entry.js';
import type { TaxCode } from '../src/tax.js';
import { buildSalesJournal, computeDocument, type DocumentLine } from '../src/document.js';
import { buildCreditNoteJournal, negateTaxAmounts, validateCreditNote } from '../src/credit-note.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);
const QTY = 10_000n; // 1.0000

const SERVICE_TAX: TaxCode = {
  id: 'tc-svc',
  code: 'SST-SVC',
  name: 'Service tax',
  regime: 'SST_SERVICE',
  inputTreatment: 'COST',
  versions: [{ rateBasisPoints: 800n, validFrom: '2024-03-01', validTo: null }],
};

const NONE: TaxCode = {
  id: 'tc-none',
  code: 'NONE',
  name: 'Out of scope',
  regime: 'NONE',
  inputTreatment: 'COST',
  versions: [],
};

const CODES = [SERVICE_TAX, NONE];
const SALES_ACCOUNTS = { accountsReceivableId: 'acc-ar', taxPayableId: 'acc-sst-payable' };

function doc(lines: DocumentLine[]) {
  return computeDocument({
    lines,
    taxPointDate: '2026-08-01',
    direction: 'OUTPUT',
    amountsAreTaxInclusive: false,
    taxCodes: CODES,
    entity: { isRegistered: true },
  });
}

const line = (over: Partial<DocumentLine> = {}): DocumentLine => ({
  lineId: 'l1',
  description: 'Consulting services',
  quantity: QTY,
  unitPrice: rm('1000.00'),
  accountId: 'acc-revenue',
  taxCodeId: 'tc-svc',
  ...over,
});

const CTX = { entryDate: '2026-08-20', documentType: 'CREDIT_NOTE', documentId: 'cn-1' };
const SALES_CTX = { entryDate: '2026-08-01', documentType: 'INVOICE', documentId: 'inv-1' };

describe('credit note journal', () => {
  it('posts Dr Revenue / Dr SST Payable / Cr AR', () => {
    const d = unwrap(doc([line()]));
    const entry = buildCreditNoteJournal(d, SALES_ACCOUNTS, CTX)!;

    const revenue = entry.lines.find((l) => l.accountId === 'acc-revenue')!;
    const sst = entry.lines.find((l) => l.accountId === 'acc-sst-payable')!;
    const ar = entry.lines.find((l) => l.accountId === 'acc-ar')!;

    expect(revenue.side).toBe('DEBIT');
    expect(revenue.amount.toDecimalString()).toBe('1000.0000');
    expect(sst.side).toBe('DEBIT');
    expect(sst.amount.toDecimalString()).toBe('80.0000');
    expect(ar.side).toBe('CREDIT');
    expect(ar.amount.toDecimalString()).toBe('1080.0000');
  });

  it('is balanced', () => {
    const d = unwrap(doc([line()]));
    const entry = buildCreditNoteJournal(d, SALES_ACCOUNTS, CTX)!;
    expect(validateJournalEntry(entry, MYR).ok).toBe(true);
  });

  it('returns null for a zero-value credit', () => {
    const d = unwrap(doc([line({ discountBasisPoints: 10_000n })]));
    expect(buildCreditNoteJournal(d, SALES_ACCOUNTS, CTX)).toBeNull();
  });

  it('omits the tax line when no tax applies', () => {
    const d = unwrap(doc([line({ taxCodeId: 'tc-none' })]));
    const entry = buildCreditNoteJournal(d, SALES_ACCOUNTS, CTX)!;
    expect(entry.lines.some((l) => l.accountId === 'acc-sst-payable')).toBe(false);
    expect(entry.lines).toHaveLength(2);
  });
});

describe('a credit note exactly mirrors the invoice it corrects', () => {
  // This is the property that makes credit notes a correction mechanism rather
  // than just another document. Asserted rather than achieved by shared code,
  // so a change to either builder that breaks the mirror fails the build.
  const arbLines = fc.array(
    fc.record({
      units: fc.bigInt({ min: 1n, max: 10_000_0000n }),
      quantity: fc.bigInt({ min: 1n, max: 50_0000n }),
      discount: fc.bigInt({ min: 0n, max: 9_000n }),
      accountId: fc.constantFrom('acc-a', 'acc-b', 'acc-c'),
      taxCodeId: fc.constantFrom('tc-svc', 'tc-none'),
    }),
    { minLength: 1, maxLength: 10 },
  );

  it('fully crediting an invoice returns every account to zero (property)', () => {
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

        const invoice = buildSalesJournal(d, SALES_ACCOUNTS, SALES_CTX);
        const credit = buildCreditNoteJournal(d, SALES_ACCOUNTS, CTX);

        // Both builders must agree on whether there is anything to post.
        if (invoice === null || credit === null) {
          expect(invoice).toBeNull();
          expect(credit).toBeNull();
          return;
        }

        const movements = netMovementByAccount([invoice, credit], MYR);
        for (const [accountId, movement] of movements) {
          expect(
            movement.isZero(),
            `${accountId} did not net to zero: ${movement.toDecimalString()}`,
          ).toBe(true);
        }
      }),
    );
  });

  it('every line has the opposite side and the same amount (property)', () => {
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

        const invoice = buildSalesJournal(d, SALES_ACCOUNTS, SALES_CTX);
        const credit = buildCreditNoteJournal(d, SALES_ACCOUNTS, CTX);
        if (invoice === null || credit === null) return;

        expect(credit.lines).toHaveLength(invoice.lines.length);

        for (const invoiceLine of invoice.lines) {
          const mirror = credit.lines.find(
            (c) => c.accountId === invoiceLine.accountId && c.side !== invoiceLine.side,
          );
          expect(mirror, `no mirrored line for ${invoiceLine.accountId}`).toBeDefined();
          expect(mirror!.amount.equals(invoiceLine.amount)).toBe(true);
        }
      }),
    );
  });
});

describe('credit note validation', () => {
  it('accepts a credit for part of an invoice', () => {
    const result = validateCreditNote({
      creditDate: '2026-08-20',
      total: rm('500.00'),
      against: { invoiceId: 'inv-1', invoiceTotal: rm('1080.00') },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a credit for the full invoice', () => {
    const result = validateCreditNote({
      creditDate: '2026-08-20',
      total: rm('1080.00'),
      against: { invoiceId: 'inv-1', invoiceTotal: rm('1080.00') },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects crediting back more than was ever charged', () => {
    const result = validateCreditNote({
      creditDate: '2026-08-20',
      total: rm('2000.00'),
      against: { invoiceId: 'inv-1', invoiceTotal: rm('1080.00') },
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]).toMatchObject({ code: 'CREDIT_EXCEEDS_INVOICE' });
  });

  it('allows a standalone credit with no invoice reference', () => {
    const result = validateCreditNote({ creditDate: '2026-08-20', total: rm('50.00') });
    expect(result.ok).toBe(true);
  });

  it('rejects a zero-value credit', () => {
    const result = validateCreditNote({ creditDate: '2026-08-20', total: rm('0') });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]).toMatchObject({ code: 'ZERO_VALUE_CREDIT' });
  });

  it('rejects a malformed date', () => {
    expect(isErr(validateCreditNote({ creditDate: '20/08/2026', total: rm('50') }))).toBe(true);
  });
});

describe('tax evidence is negated', () => {
  it('flips the sign so the SST return nets correctly', () => {
    const negated = negateTaxAmounts([
      { taxableAmount: rm('1000.00'), taxAmount: rm('80.00') },
      { taxableAmount: rm('500.00'), taxAmount: rm('40.00') },
    ]);

    expect(negated.map((n) => n.taxAmount.toDecimalString())).toEqual(['-80.0000', '-40.0000']);
    expect(negated.map((n) => n.taxableAmount.toDecimalString())).toEqual([
      '-1000.0000',
      '-500.0000',
    ]);
  });
});
