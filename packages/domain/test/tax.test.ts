import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money, sumMoney } from '../src/money.js';
import { isErr, isOk, unwrap } from '../src/result.js';
import {
  computeTax,
  resolveRateVersion,
  type EntityTaxProfile,
  type TaxCode,
} from '../src/tax.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);

/**
 * Fixtures only. These are NOT authoritative Malaysian rates — the real values
 * come from an effective-dated table and must be verified against RMCD. The
 * point of the fixtures is to exercise rate *versioning*, not to assert what
 * the statutory rate is.
 */
const SERVICE_TAX: TaxCode = {
  id: 'tc-svc',
  code: 'SST-SVC',
  name: 'Service tax',
  regime: 'SST_SERVICE',
  inputTreatment: 'COST',
  versions: [
    { rateBasisPoints: 600n, validFrom: '2018-09-01', validTo: '2024-02-29' },
    { rateBasisPoints: 800n, validFrom: '2024-03-01', validTo: null },
  ],
};

const SALES_TAX: TaxCode = {
  id: 'tc-sales',
  code: 'SST-SALES',
  name: 'Sales tax',
  regime: 'SST_SALES',
  inputTreatment: 'COST',
  versions: [{ rateBasisPoints: 1000n, validFrom: '2018-09-01', validTo: null }],
};

const EXEMPT: TaxCode = {
  id: 'tc-none',
  code: 'NONE',
  name: 'Out of scope',
  regime: 'NONE',
  inputTreatment: 'COST',
  versions: [],
};

/** A hypothetical recoverable code — exists to prove the branch, not the law. */
const RECOVERABLE: TaxCode = {
  id: 'tc-rec',
  code: 'REC',
  name: 'Recoverable input tax',
  regime: 'SST_SALES',
  inputTreatment: 'RECOVERABLE',
  versions: [{ rateBasisPoints: 600n, validFrom: '2018-09-01', validTo: null }],
};

const CODES = [SERVICE_TAX, SALES_TAX, EXEMPT, RECOVERABLE];
const REGISTERED: EntityTaxProfile = { isRegistered: true };

function compute(
  lines: { lineId: string; taxCodeId: string; amount: string }[],
  overrides: Partial<Parameters<typeof computeTax>[0]> = {},
) {
  return computeTax({
    lines: lines.map((l) => ({ lineId: l.lineId, taxCodeId: l.taxCodeId, amount: rm(l.amount) })),
    taxPointDate: '2026-08-01',
    direction: 'OUTPUT',
    amountsAreTaxInclusive: false,
    taxCodes: CODES,
    entity: REGISTERED,
    ...overrides,
  });
}

describe('rate resolution is effective-dated', () => {
  it('picks the version in force on the tax point, not the latest one', () => {
    expect(resolveRateVersion(SERVICE_TAX, '2023-06-15')?.rateBasisPoints).toBe(600n);
    expect(resolveRateVersion(SERVICE_TAX, '2026-08-01')?.rateBasisPoints).toBe(800n);
  });

  it('handles the exact boundary dates', () => {
    expect(resolveRateVersion(SERVICE_TAX, '2024-02-29')?.rateBasisPoints).toBe(600n);
    expect(resolveRateVersion(SERVICE_TAX, '2024-03-01')?.rateBasisPoints).toBe(800n);
  });

  it('returns nothing before the regime existed', () => {
    expect(resolveRateVersion(SERVICE_TAX, '2015-01-01')).toBeUndefined();
  });

  it('reprints a historic document at its historic rate', () => {
    const old = unwrap(compute([{ lineId: 'l1', taxCodeId: 'tc-svc', amount: '1000.00' }], {
      taxPointDate: '2023-06-15',
    }));
    const current = unwrap(compute([{ lineId: 'l1', taxCodeId: 'tc-svc', amount: '1000.00' }]));

    expect(old.totalTax.toDecimalString()).toBe('60.0000');
    expect(current.totalTax.toDecimalString()).toBe('80.0000');
  });

  it('errors rather than guessing when no rate is in effect', () => {
    const result = compute([{ lineId: 'l1', taxCodeId: 'tc-svc', amount: '100' }], {
      taxPointDate: '2015-01-01',
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error[0]).toMatchObject({ code: 'NO_RATE_IN_EFFECT' });
    }
  });
});

describe('tax-exclusive and tax-inclusive entry', () => {
  it('adds tax to an exclusive amount', () => {
    const c = unwrap(compute([{ lineId: 'l1', taxCodeId: 'tc-svc', amount: '1000.00' }]));
    expect(c.lines[0]!.taxableAmount.toDecimalString()).toBe('1000.0000');
    expect(c.lines[0]!.taxAmount.toDecimalString()).toBe('80.0000');
  });

  it('extracts tax from an inclusive amount', () => {
    // RM 1,080 inclusive at 8% is RM 1,000 net + RM 80 tax — not 1080 + 86.40.
    const c = unwrap(
      compute([{ lineId: 'l1', taxCodeId: 'tc-svc', amount: '1080.00' }], {
        amountsAreTaxInclusive: true,
      }),
    );
    expect(c.lines[0]!.taxAmount.toDecimalString()).toBe('80.0000');
    expect(c.lines[0]!.taxableAmount.toDecimalString()).toBe('1000.0000');
  });

  it('inclusive and exclusive agree on the gross for the same net (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 100_000_0000n }), (units) => {
        const net = Money.fromUnits(units, MYR).roundToExponent(2);
        const exclusive = unwrap(
          computeTax({
            lines: [{ lineId: 'l', taxCodeId: 'tc-svc', amount: net }],
            taxPointDate: '2026-08-01',
            direction: 'OUTPUT',
            amountsAreTaxInclusive: false,
            taxCodes: CODES,
            entity: REGISTERED,
          }),
        );
        const gross = net.add(exclusive.totalTax);

        const inclusive = unwrap(
          computeTax({
            lines: [{ lineId: 'l', taxCodeId: 'tc-svc', amount: gross }],
            taxPointDate: '2026-08-01',
            direction: 'OUTPUT',
            amountsAreTaxInclusive: true,
            taxCodes: CODES,
            entity: REGISTERED,
          }),
        );

        // Round-tripping must not drift by more than the rounding unit.
        const drift = inclusive.totalTax.subtract(exclusive.totalTax).abs();
        expect(drift.compare(rm('0.01'))).toBeLessThanOrEqual(0);
      }),
    );
  });
});

describe('exemptions and registration', () => {
  it('charges no output tax when the tenant is not SST-registered', () => {
    const c = unwrap(
      compute([{ lineId: 'l1', taxCodeId: 'tc-svc', amount: '1000.00' }], {
        entity: { isRegistered: false },
      }),
    );
    expect(c.totalTax.isZero()).toBe(true);
    expect(c.lines[0]!.exemptionReason).toBe('NOT_REGISTERED');
  });

  it('honours an exemption certificate and records its number', () => {
    const c = unwrap(
      compute([{ lineId: 'l1', taxCodeId: 'tc-svc', amount: '1000.00' }], {
        entity: {
          isRegistered: true,
          exemptions: [
            { certificateNo: 'EX-2026-001', validFrom: '2026-01-01', validTo: '2026-12-31', taxCodeIds: ['tc-svc'] },
          ],
        },
      }),
    );
    expect(c.totalTax.isZero()).toBe(true);
    expect(c.lines[0]!.exemptionReason).toBe('CERTIFICATE');
    expect(c.lines[0]!.certificateNo).toBe('EX-2026-001');
  });

  it('ignores an expired certificate', () => {
    const c = unwrap(
      compute([{ lineId: 'l1', taxCodeId: 'tc-svc', amount: '1000.00' }], {
        entity: {
          isRegistered: true,
          exemptions: [
            { certificateNo: 'EX-2024-001', validFrom: '2024-01-01', validTo: '2024-12-31', taxCodeIds: ['tc-svc'] },
          ],
        },
      }),
    );
    expect(c.totalTax.toDecimalString()).toBe('80.0000');
  });

  it('treats an out-of-scope code as zero-rated', () => {
    const c = unwrap(compute([{ lineId: 'l1', taxCodeId: 'tc-none', amount: '1000.00' }]));
    expect(c.totalTax.isZero()).toBe(true);
    expect(c.lines[0]!.exemptionReason).toBe('ZERO_RATED');
  });
});

describe('SST is not a VAT — input treatment', () => {
  it('marks SST input tax as a COST, not a recoverable asset', () => {
    const c = unwrap(
      compute([{ lineId: 'l1', taxCodeId: 'tc-svc', amount: '1000.00' }], { direction: 'INPUT' }),
    );
    expect(c.lines[0]!.inputTreatment).toBe('COST');
  });

  it('still supports RECOVERABLE where a relief provides for it', () => {
    const c = unwrap(
      compute([{ lineId: 'l1', taxCodeId: 'tc-rec', amount: '1000.00' }], { direction: 'INPUT' }),
    );
    expect(c.lines[0]!.inputTreatment).toBe('RECOVERABLE');
  });
});

describe('rounding policy', () => {
  // 33.33 at 8% is 2.6664 — the case where LINE and DOCUMENT rounding diverge.
  const threeLines = [
    { lineId: 'l1', taxCodeId: 'tc-svc', amount: '33.33' },
    { lineId: 'l2', taxCodeId: 'tc-svc', amount: '33.33' },
    { lineId: 'l3', taxCodeId: 'tc-svc', amount: '33.34' },
  ];

  it('LINE rounding: each line rounds, the document is their sum', () => {
    const c = unwrap(compute(threeLines, { policy: { level: 'LINE', mode: 'HALF_UP', exponent: 2 } }));
    expect(c.lines.map((l) => l.taxAmount.toDecimalString())).toEqual([
      '2.6700', '2.6700', '2.6700',
    ]);
    expect(c.totalTax.toDecimalString()).toBe('8.0100');
  });

  it('DOCUMENT rounding: the total rounds, lines are distributed to match', () => {
    const c = unwrap(compute(threeLines, { policy: { level: 'DOCUMENT', mode: 'HALF_UP', exponent: 2 } }));
    expect(c.totalTax.toDecimalString()).toBe('8.0000');
    // Whatever the distribution, the lines must still sum to the total.
    expect(sumMoney(c.lines.map((l) => l.taxAmount), MYR).equals(c.totalTax)).toBe(true);
  });

  it('lines always sum to the document total under either policy (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 1_000_0000n }), { minLength: 1, maxLength: 15 }),
        fc.constantFrom('LINE' as const, 'DOCUMENT' as const),
        (amounts, level) => {
          const c = unwrap(
            computeTax({
              lines: amounts.map((units, i) => ({
                lineId: `l${i}`,
                taxCodeId: 'tc-svc',
                amount: Money.fromUnits(units, MYR).roundToExponent(2),
              })),
              taxPointDate: '2026-08-01',
              direction: 'OUTPUT',
              amountsAreTaxInclusive: false,
              taxCodes: CODES,
              entity: REGISTERED,
              policy: { level, mode: 'HALF_UP', exponent: 2 },
            }),
          );
          expect(sumMoney(c.lines.map((l) => l.taxAmount), MYR).equals(c.totalTax)).toBe(true);
        },
      ),
    );
  });
});

describe('summary — what the SST return and the e-invoice payload consume', () => {
  it('groups by tax code and rate', () => {
    const c = unwrap(
      compute([
        { lineId: 'l1', taxCodeId: 'tc-svc', amount: '1000.00' },
        { lineId: 'l2', taxCodeId: 'tc-svc', amount: '500.00' },
        { lineId: 'l3', taxCodeId: 'tc-sales', amount: '200.00' },
        { lineId: 'l4', taxCodeId: 'tc-none', amount: '99.00' },
      ]),
    );

    expect(c.summary).toHaveLength(3);

    const svc = c.summary.find((s) => s.taxCodeId === 'tc-svc')!;
    expect(svc.taxableAmount.toDecimalString()).toBe('1500.0000');
    expect(svc.taxAmount.toDecimalString()).toBe('120.0000');

    const sales = c.summary.find((s) => s.taxCodeId === 'tc-sales')!;
    expect(sales.taxAmount.toDecimalString()).toBe('20.0000');

    expect(c.totalTax.toDecimalString()).toBe('140.0000');
  });

  it('summary totals always reconcile to the document totals (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            units: fc.bigInt({ min: 1n, max: 100_0000n }),
            taxCodeId: fc.constantFrom('tc-svc', 'tc-sales', 'tc-none'),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (rows) => {
          const c = unwrap(
            computeTax({
              lines: rows.map((r, i) => ({
                lineId: `l${i}`,
                taxCodeId: r.taxCodeId,
                amount: Money.fromUnits(r.units, MYR).roundToExponent(2),
              })),
              taxPointDate: '2026-08-01',
              direction: 'OUTPUT',
              amountsAreTaxInclusive: false,
              taxCodes: CODES,
              entity: REGISTERED,
            }),
          );

          expect(sumMoney(c.summary.map((s) => s.taxAmount), MYR).equals(c.totalTax)).toBe(true);
          expect(sumMoney(c.summary.map((s) => s.taxableAmount), MYR).equals(c.totalTaxable)).toBe(true);
        },
      ),
    );
  });
});

describe('validation', () => {
  it('rejects an unknown tax code rather than defaulting to zero', () => {
    const result = compute([{ lineId: 'l1', taxCodeId: 'does-not-exist', amount: '100' }]);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]).toMatchObject({ code: 'UNKNOWN_TAX_CODE' });
  });

  it('rejects an empty document', () => {
    expect(isErr(compute([]))).toBe(true);
  });

  it('rejects a malformed tax point date', () => {
    const result = compute([{ lineId: 'l1', taxCodeId: 'tc-svc', amount: '100' }], {
      taxPointDate: '01/08/2026',
    });
    expect(isErr(result)).toBe(true);
  });

  it('rejects mixed currencies within one document', () => {
    const result = computeTax({
      lines: [
        { lineId: 'l1', taxCodeId: 'tc-svc', amount: rm('100') },
        { lineId: 'l2', taxCodeId: 'tc-svc', amount: Money.fromDecimal('100', 'USD') },
      ],
      taxPointDate: '2026-08-01',
      direction: 'OUTPUT',
      amountsAreTaxInclusive: false,
      taxCodes: CODES,
      entity: REGISTERED,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]).toMatchObject({ code: 'MIXED_CURRENCY' });
  });

  it('is a pure function — same inputs, same output', () => {
    const args = [{ lineId: 'l1', taxCodeId: 'tc-svc', amount: '1234.56' }];
    const a = unwrap(compute(args));
    const b = unwrap(compute(args));
    expect(a.totalTax.toDecimalString()).toBe(b.totalTax.toDecimalString());
    expect(isOk(compute(args))).toBe(true);
  });
});
