import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import { isErr, unwrap } from '../src/result.js';
import { deriveCorrectionLines, type CorrectableLine } from '../src/credit-note.js';

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

const line = (over: Partial<CorrectableLine> = {}): CorrectableLine => ({
  sourceLineId: 'il-1',
  lineNo: 1,
  description: 'Consulting',
  quantity: '10',
  unitPrice: rm('100.00'),
  accountId: 'acct-4000',
  taxCodeId: 'tax-svc',
  alreadyCredited: '0',
  ...over,
});

const errorsOf = (r: ReturnType<typeof deriveCorrectionLines>) => (isErr(r) ? r.error : []);

// ---------------------------------------------------------------------------
// Carrying the original
// ---------------------------------------------------------------------------

describe('every figure comes from the invoice', () => {
  it('carries price, account, tax code and classification unchanged', () => {
    /*
     * The whole point. Retyping these — which is what the system required
     * before — is a chance to get each of them wrong: a price at today's list
     * rather than what the customer was charged, a different tax code so the
     * SST reversed is not the SST charged, a different revenue account leaving
     * two accounts wrong by one amount.
     */
    const derived = unwrap(
      deriveCorrectionLines([
        line({ classificationCode: '022', itemId: 'item-1', discountBasisPoints: 500 }),
      ]),
    );

    expect(derived[0]).toMatchObject({
      sourceLineId: 'il-1',
      description: 'Consulting',
      accountId: 'acct-4000',
      taxCodeId: 'tax-svc',
      classificationCode: '022',
      itemId: 'item-1',
      discountBasisPoints: 500,
    });
    expect(derived[0]!.unitPrice.equals(rm('100.00'))).toBe(true);
  });

  it('credits the whole remaining quantity when none is named', () => {
    expect(unwrap(deriveCorrectionLines([line()]))[0]!.quantity).toBe('10');
  });

  it('credits only what remains on a partly-credited line', () => {
    const derived = unwrap(deriveCorrectionLines([line({ alreadyCredited: '4' })]));
    expect(derived[0]!.quantity).toBe('6');
  });
});

// ---------------------------------------------------------------------------
// Over-crediting
// ---------------------------------------------------------------------------

describe('over-crediting', () => {
  it('refuses more than remains, naming both figures', () => {
    const result = deriveCorrectionLines([line({ alreadyCredited: '4' })], {
      lines: [{ sourceLineId: 'il-1', quantity: '7' }],
    });

    expect(errorsOf(result)).toContainEqual({
      code: 'EXCEEDS_REMAINING',
      sourceLineId: 'il-1',
      requested: '7',
      remaining: '6',
    });
  });

  it('is checked PER LINE, not on the document total', () => {
    /*
     * Crediting line one twice and line two not at all nets to the invoice
     * total exactly. A document-level guard sees nothing wrong, and both lines
     * are wrong.
     */
    const result = deriveCorrectionLines(
      [
        line({ sourceLineId: 'a', quantity: '1', alreadyCredited: '1' }),
        line({ sourceLineId: 'b', quantity: '1', alreadyCredited: '0' }),
      ],
      { lines: [{ sourceLineId: 'a', quantity: '1' }] },
    );

    expect(errorsOf(result).map((v) => v.code)).toEqual(['EXCEEDS_REMAINING']);
  });

  it('accepts exactly what remains', () => {
    const derived = unwrap(
      deriveCorrectionLines([line({ alreadyCredited: '4' })], {
        lines: [{ sourceLineId: 'il-1', quantity: '6' }],
      }),
    );
    expect(derived[0]!.quantity).toBe('6');
  });

  it('handles fractional quantities without floating point', () => {
    // `0.1 + 0.2 !== 0.3` in IEEE-754, and a quantity is a decimal string
    // everywhere in this codebase for exactly that reason.
    const derived = unwrap(
      deriveCorrectionLines([line({ quantity: '0.3', alreadyCredited: '0.1' })]),
    );
    expect(derived[0]!.quantity).toBe('0.2');
  });
});

// ---------------------------------------------------------------------------
// Explicit versus implicit selection
// ---------------------------------------------------------------------------

describe('naming a line means something different from crediting the rest', () => {
  it('SKIPS a finished line when crediting the whole invoice', () => {
    // "Credit whatever is left" over a line with nothing left is not a
    // mistake — it is the ordinary way to finish a partly-credited invoice.
    const derived = unwrap(
      deriveCorrectionLines([
        line({ sourceLineId: 'a', quantity: '1', alreadyCredited: '1' }),
        line({ sourceLineId: 'b', quantity: '2', alreadyCredited: '0' }),
      ]),
    );

    expect(derived).toHaveLength(1);
    expect(derived[0]!.sourceLineId).toBe('b');
  });

  it('REFUSES a finished line when the caller named it', () => {
    /*
     * The distinction matters for the message, not just the outcome. Skipping
     * silently would report "every line has already been credited in full" —
     * which is a false statement about the rest of the invoice, and how a user
     * concludes a credit went through when it did not.
     */
    const result = deriveCorrectionLines(
      [
        line({ sourceLineId: 'a', quantity: '1', alreadyCredited: '1' }),
        line({ sourceLineId: 'b', quantity: '2', alreadyCredited: '0' }),
      ],
      { lines: [{ sourceLineId: 'a' }] },
    );

    expect(errorsOf(result)).toEqual([
      { code: 'EXCEEDS_REMAINING', sourceLineId: 'a', requested: '1', remaining: '0' },
    ]);
  });

  it('reports NOTHING_TO_CREDIT only when the whole invoice is finished', () => {
    const result = deriveCorrectionLines([
      line({ sourceLineId: 'a', quantity: '1', alreadyCredited: '1' }),
      line({ sourceLineId: 'b', quantity: '2', alreadyCredited: '2' }),
    ]);

    expect(errorsOf(result)).toEqual([{ code: 'NOTHING_TO_CREDIT' }]);
  });
});

describe('bad input', () => {
  it('refuses a line that is not on the invoice', () => {
    const result = deriveCorrectionLines([line()], { lines: [{ sourceLineId: 'nope' }] });
    expect(errorsOf(result)).toEqual([
      { code: 'NO_SUCH_LINE', sourceLineId: 'nope' },
    ]);
  });

  it('refuses a zero or negative quantity', () => {
    for (const quantity of ['0', '-1']) {
      const result = deriveCorrectionLines([line()], {
        lines: [{ sourceLineId: 'il-1', quantity }],
      });
      expect(errorsOf(result).map((v) => v.code), quantity).toEqual(['NON_POSITIVE_QUANTITY']);
    }
  });

  it('reports every bad line rather than only the first', () => {
    const result = deriveCorrectionLines([line()], {
      lines: [{ sourceLineId: 'nope' }, { sourceLineId: 'il-1', quantity: '99' }],
    });
    expect(errorsOf(result)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe('PROPERTY', () => {
  it('never derives more than remains, for any invoiced/credited pair', () => {
    const tenths = fc.integer({ min: 0, max: 500 });

    fc.assert(
      fc.property(tenths, tenths, (invoicedTenths, creditedTenths) => {
        const invoiced = (invoicedTenths / 10).toFixed(1);
        const credited = (creditedTenths / 10).toFixed(1);

        const result = deriveCorrectionLines([
          line({ quantity: invoiced, alreadyCredited: credited }),
        ]);

        if (isErr(result)) {
          // The only legitimate refusal here is "nothing left".
          expect(result.error.map((v) => v.code)).toEqual(['NOTHING_TO_CREDIT']);
          expect(creditedTenths).toBeGreaterThanOrEqual(invoicedTenths);
          return;
        }

        const derivedTenths = Math.round(Number(result.value[0]!.quantity) * 10);
        expect(derivedTenths).toBe(invoicedTenths - creditedTenths);
        expect(derivedTenths).toBeGreaterThan(0);
      }),
    );
  });
});
