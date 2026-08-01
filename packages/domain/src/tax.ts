/**
 * The tax engine — M5.
 *
 * One place answers "what tax applies to this line, at this date, for this
 * entity". Nothing else in the system may hardcode a rate.
 *
 * A pure function over value objects: no IO, no database, no clock. That is
 * what makes it exhaustively testable, and tax is the module where a
 * table-driven test suite pays for itself on day one.
 *
 * ---------------------------------------------------------------------------
 * SST IS NOT A VAT. This is the single most consequential modelling decision
 * in the product.
 *
 * Malaysia replaced GST with SST in 2018. SST is two distinct single-stage
 * taxes (sales tax on goods, service tax on prescribed services), and input
 * tax is generally NOT creditable down the chain the way VAT/GST input tax is.
 * A product localised from a VAT jurisdiction retrofits an input/output credit
 * engine, books input tax as a recoverable asset, and misstates both the P&L
 * and the balance sheet for every Malaysian customer.
 *
 * So `TaxCode.inputTreatment` is explicit and mandatory, and the default for
 * SST is `COST` — the tax is absorbed into the expense or asset it was
 * incurred on. `RECOVERABLE` exists because specific reliefs and future
 * regimes need it, not because it is the norm.
 * ---------------------------------------------------------------------------
 *
 * ⚠️ Every rate and threshold is DATA, supplied by the caller from an
 * effective-dated table. There are no rate constants in this file, by design.
 * See docs/architecture/05-malaysia-localization.md §5.2.
 */

import { Money, sumMoney, type Currency, type RoundingMode } from './money.js';
import { err, ok, type Result } from './result.js';

/** Basis points: 1 bp = 0.01%. 8% = 800bp. Exact, no floats. */
export type BasisPoints = bigint;

const BP_DENOMINATOR = 10_000n;

export type TaxRegime = 'SST_SALES' | 'SST_SERVICE' | 'WHT' | 'NONE';

export type TaxDirection = 'OUTPUT' | 'INPUT';

/**
 * What happens to input (purchase-side) tax.
 *
 *  - `COST`        — absorbed into the expense/asset. The SST default.
 *  - `RECOVERABLE` — claimable from the authority; posts to an asset account.
 */
export type InputTreatment = 'COST' | 'RECOVERABLE';

/** One validity window of a tax code's rate. Rates change; history must not. */
export interface TaxRateVersion {
  readonly rateBasisPoints: BasisPoints;
  /** Inclusive lower bound, YYYY-MM-DD. */
  readonly validFrom: string;
  /** Inclusive upper bound, or null for "still in force". */
  readonly validTo: string | null;
  /** e.g. a gazette or order reference. Carried for audit, never for logic. */
  readonly legislationRef?: string;
}

export interface TaxCode {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly regime: TaxRegime;
  readonly inputTreatment: InputTreatment;
  /** Ordered or unordered; resolution picks by date, not by position. */
  readonly versions: readonly TaxRateVersion[];
}

/** A customer- or supplier-specific exemption, evidenced by a certificate. */
export interface TaxExemption {
  readonly certificateNo: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  /** Tax code ids this certificate covers. Empty = covers all. */
  readonly taxCodeIds: readonly string[];
}

export interface EntityTaxProfile {
  /** False when the tenant is below the registration threshold. */
  readonly isRegistered: boolean;
  readonly exemptions?: readonly TaxExemption[];
}

/**
 * Where rounding happens. This changes cents, so it is an explicit decision
 * rather than an emergent property of the implementation.
 *
 *  - `LINE`     — round each line's tax, document tax is their sum.
 *  - `DOCUMENT` — compute lines unrounded, round the document total, then
 *                 distribute back across lines so they still sum exactly.
 */
export type RoundingLevel = 'LINE' | 'DOCUMENT';

export interface TaxPolicy {
  readonly level: RoundingLevel;
  readonly mode: RoundingMode;
  /** Decimal places to round to. 2 for MYR. */
  readonly exponent: number;
}

export const DEFAULT_TAX_POLICY: TaxPolicy = {
  level: 'LINE',
  mode: 'HALF_UP',
  exponent: 2,
};

export interface TaxableLine {
  readonly lineId: string;
  readonly taxCodeId: string;
  /**
   * The line amount. Interpreted as tax-exclusive (net) or tax-inclusive
   * (gross) according to `TaxComputationInput.amountsAreTaxInclusive`.
   */
  readonly amount: Money;
}

export interface TaxComputationInput {
  readonly lines: readonly TaxableLine[];
  /** The date whose rates apply. NOT today — the document's tax point. */
  readonly taxPointDate: string;
  readonly direction: TaxDirection;
  readonly amountsAreTaxInclusive: boolean;
  readonly taxCodes: readonly TaxCode[];
  readonly entity: EntityTaxProfile;
  readonly policy?: TaxPolicy;
}

export type ExemptionReason =
  | 'NOT_REGISTERED'
  | 'CERTIFICATE'
  | 'ZERO_RATED';

export interface ComputedTaxLine {
  readonly lineId: string;
  readonly taxCodeId: string;
  readonly rateBasisPoints: BasisPoints;
  /** The amount tax was charged on. */
  readonly taxableAmount: Money;
  readonly taxAmount: Money;
  readonly direction: TaxDirection;
  readonly inputTreatment: InputTreatment;
  readonly exemptionReason?: ExemptionReason;
  readonly certificateNo?: string;
}

/** Per-tax-code totals — what the SST return and the e-invoice payload need. */
export interface TaxSummaryRow {
  readonly taxCodeId: string;
  readonly code: string;
  readonly rateBasisPoints: BasisPoints;
  readonly taxableAmount: Money;
  readonly taxAmount: Money;
}

export interface TaxComputation {
  readonly lines: readonly ComputedTaxLine[];
  readonly summary: readonly TaxSummaryRow[];
  readonly totalTaxable: Money;
  readonly totalTax: Money;
  readonly currency: Currency;
}

export type TaxViolation =
  | { readonly code: 'UNKNOWN_TAX_CODE'; readonly lineId: string; readonly taxCodeId: string }
  | { readonly code: 'NO_RATE_IN_EFFECT'; readonly lineId: string; readonly taxCodeId: string; readonly taxPointDate: string }
  | { readonly code: 'MIXED_CURRENCY'; readonly lineId: string; readonly expected: Currency; readonly found: Currency }
  | { readonly code: 'WITHHOLDING_IS_NOT_A_DOCUMENT_TAX'; readonly lineId: string; readonly taxCodeId: string }
  | { readonly code: 'INVALID_TAX_POINT_DATE'; readonly value: string }
  | { readonly code: 'NO_LINES' };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve the rate version in force on `date`.
 *
 * Exported because the same resolution is needed when reprinting a historic
 * document: a 2024 invoice must reprint with the 2024 rate, forever.
 */
export function resolveRateVersion(
  taxCode: TaxCode,
  date: string,
): TaxRateVersion | undefined {
  return taxCode.versions.find(
    (v) => date >= v.validFrom && (v.validTo === null || date <= v.validTo),
  );
}

function findExemption(
  entity: EntityTaxProfile,
  taxCodeId: string,
  date: string,
): TaxExemption | undefined {
  return entity.exemptions?.find(
    (e) =>
      date >= e.validFrom &&
      (e.validTo === null || date <= e.validTo) &&
      (e.taxCodeIds.length === 0 || e.taxCodeIds.includes(taxCodeId)),
  );
}

/**
 * Compute tax for a document.
 *
 * Pure. Give it the same inputs and it returns the same output, forever —
 * which is exactly the property a tax audit three years from now depends on.
 */
export function computeTax(
  input: TaxComputationInput,
): Result<TaxComputation, TaxViolation[]> {
  const policy = input.policy ?? DEFAULT_TAX_POLICY;
  const violations: TaxViolation[] = [];

  if (!ISO_DATE.test(input.taxPointDate) || Number.isNaN(Date.parse(input.taxPointDate))) {
    violations.push({ code: 'INVALID_TAX_POINT_DATE', value: input.taxPointDate });
  }
  if (input.lines.length === 0) {
    violations.push({ code: 'NO_LINES' });
    return err(violations);
  }

  const currency = input.lines[0]!.amount.currency;
  const codesById = new Map(input.taxCodes.map((c) => [c.id, c]));

  interface Working {
    readonly line: TaxableLine;
    readonly taxCode: TaxCode;
    readonly rateBasisPoints: BasisPoints;
    readonly exemptionReason?: ExemptionReason;
    readonly certificateNo?: string;
  }

  const working: Working[] = [];

  for (const line of input.lines) {
    if (line.amount.currency !== currency) {
      violations.push({
        code: 'MIXED_CURRENCY',
        lineId: line.lineId,
        expected: currency,
        found: line.amount.currency,
      });
      continue;
    }

    const taxCode = codesById.get(line.taxCodeId);
    if (!taxCode) {
      violations.push({ code: 'UNKNOWN_TAX_CODE', lineId: line.lineId, taxCodeId: line.taxCodeId });
      continue;
    }

    // An unregistered tenant charges no output tax at all — the SST fields are
    // not merely zero, they do not apply.
    if (input.direction === 'OUTPUT' && !input.entity.isRegistered) {
      working.push({ line, taxCode, rateBasisPoints: 0n, exemptionReason: 'NOT_REGISTERED' });
      continue;
    }

    const exemption = findExemption(input.entity, taxCode.id, input.taxPointDate);
    if (exemption) {
      working.push({
        line,
        taxCode,
        rateBasisPoints: 0n,
        exemptionReason: 'CERTIFICATE',
        certificateNo: exemption.certificateNo,
      });
      continue;
    }

    if (taxCode.regime === 'NONE') {
      working.push({ line, taxCode, rateBasisPoints: 0n, exemptionReason: 'ZERO_RATED' });
      continue;
    }

    // Withholding is NOT a document tax and must never reach this engine.
    //
    // It is a deduction from a PAYMENT to a non-resident, recognised when the
    // payment is made, and a liability owed to LHDN — not a charge added to a
    // bill at its tax point. Left unguarded, a WHT code falls through to the
    // ordinary rate path below and is computed exactly like SST: added as a
    // positive amount to the document total. The result looks entirely
    // plausible and overstates both the expense and the payable.
    //
    // See packages/domain/src/withholding.ts for where it belongs.
    if (taxCode.regime === 'WHT') {
      violations.push({
        code: 'WITHHOLDING_IS_NOT_A_DOCUMENT_TAX',
        lineId: line.lineId,
        taxCodeId: taxCode.id,
      });
      continue;
    }

    const version = resolveRateVersion(taxCode, input.taxPointDate);
    if (!version) {
      // Deliberately an error, not a fallback to 0% or to the latest rate.
      // Silently guessing a rate is how a product ships a wrong tax figure.
      violations.push({
        code: 'NO_RATE_IN_EFFECT',
        lineId: line.lineId,
        taxCodeId: taxCode.id,
        taxPointDate: input.taxPointDate,
      });
      continue;
    }

    working.push({ line, taxCode, rateBasisPoints: version.rateBasisPoints });
  }

  if (violations.length > 0) return err(violations);

  // --- unrounded computation ------------------------------------------------
  const unrounded = working.map((w) => {
    const { taxable, tax } = input.amountsAreTaxInclusive
      ? splitInclusive(w.line.amount, w.rateBasisPoints)
      : splitExclusive(w.line.amount, w.rateBasisPoints);
    return { ...w, taxable, tax };
  });

  // --- rounding -------------------------------------------------------------
  let taxAmounts: Money[];

  if (policy.level === 'LINE') {
    taxAmounts = unrounded.map((u) => u.tax.roundToExponent(policy.exponent, policy.mode));
  } else {
    // Round the document total, then distribute across lines in proportion to
    // their unrounded tax so the lines still sum EXACTLY to that total.
    const documentTax = sumMoney(
      unrounded.map((u) => u.tax),
      currency,
    ).roundToExponent(policy.exponent, policy.mode);

    const weights = unrounded.map((u) => (u.tax.units < 0n ? -u.tax.units : u.tax.units));
    taxAmounts = weights.every((w) => w === 0n)
      ? unrounded.map(() => Money.zero(currency))
      : documentTax.allocate(weights);
  }

  const lines: ComputedTaxLine[] = unrounded.map((u, i) => ({
    lineId: u.line.lineId,
    taxCodeId: u.taxCode.id,
    rateBasisPoints: u.rateBasisPoints,
    taxableAmount: input.amountsAreTaxInclusive
      ? u.line.amount.subtract(taxAmounts[i]!)
      : u.taxable.roundToExponent(policy.exponent, policy.mode),
    taxAmount: taxAmounts[i]!,
    direction: input.direction,
    inputTreatment: u.taxCode.inputTreatment,
    ...(u.exemptionReason !== undefined ? { exemptionReason: u.exemptionReason } : {}),
    ...(u.certificateNo !== undefined ? { certificateNo: u.certificateNo } : {}),
  }));

  // --- summary --------------------------------------------------------------
  const byCode = new Map<string, { code: TaxCode; rate: BasisPoints; taxable: Money; tax: Money }>();
  for (const [i, computed] of lines.entries()) {
    const taxCode = working[i]!.taxCode;
    const key = `${computed.taxCodeId}:${computed.rateBasisPoints}`;
    const current = byCode.get(key) ?? {
      code: taxCode,
      rate: computed.rateBasisPoints,
      taxable: Money.zero(currency),
      tax: Money.zero(currency),
    };
    byCode.set(key, {
      ...current,
      taxable: current.taxable.add(computed.taxableAmount),
      tax: current.tax.add(computed.taxAmount),
    });
  }

  const summary: TaxSummaryRow[] = [...byCode.values()].map((s) => ({
    taxCodeId: s.code.id,
    code: s.code.code,
    rateBasisPoints: s.rate,
    taxableAmount: s.taxable,
    taxAmount: s.tax,
  }));

  return ok({
    lines,
    summary,
    totalTaxable: sumMoney(lines.map((l) => l.taxableAmount), currency),
    totalTax: sumMoney(lines.map((l) => l.taxAmount), currency),
    currency,
  });
}

// ------------------------------------------------------------------ internals

/** net → { taxable: net, tax: net * rate }. */
function splitExclusive(net: Money, rate: BasisPoints): { taxable: Money; tax: Money } {
  return { taxable: net, tax: net.multiplyRatio(rate, BP_DENOMINATOR, 'DOWN') };
}

/**
 * gross → { taxable: gross - tax, tax: gross * rate / (10000 + rate) }.
 *
 * Extracting rather than adding: an RM 108.00 tax-inclusive line at 8% is
 * RM 100.00 net + RM 8.00 tax, not RM 108.00 + RM 8.64.
 */
function splitInclusive(gross: Money, rate: BasisPoints): { taxable: Money; tax: Money } {
  const tax = gross.multiplyRatio(rate, BP_DENOMINATOR + rate, 'DOWN');
  return { taxable: gross.subtract(tax), tax };
}
