/**
 * The SST return — M5's actual deliverable.
 *
 * ---------------------------------------------------------------------------
 * THE TAX ENGINE EXISTED TO PRODUCE THIS, AND IT DID NOT PRODUCE IT.
 *
 * `computeTax()` has decided the tax on every line since M5, and every invoice,
 * bill, credit note and debit note writes `tax_transaction` rows. Nothing ever
 * aggregated them into the thing a registered business must actually file. The
 * engine's whole purpose was a return nobody could produce.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS HERE ARE NOT WHAT A GST BACKGROUND EXPECTS. BOTH ARE THE POINT.
 *
 * 1. SST IS NOT A VAT, SO THERE IS NO INPUT TAX CREDIT.
 *
 *    Under a VAT or GST, a registered business offsets the tax it paid on
 *    purchases against the tax it charged, and remits the difference. Under
 *    Malaysian SST it does not: tax paid to a supplier is a COST, absorbed into
 *    the expense, and the return remits the OUTPUT tax in full.
 *
 *    A return that subtracts input tax would under-declare by exactly the input
 *    tax — a number that looks entirely plausible on the form, reconciles
 *    against a P&L built the same wrong way, and is a shortfall the business is
 *    liable for. `netTaxPayable` therefore never touches input tax, and
 *    `inputTaxAbsorbed` is reported separately and labelled as what it is: a
 *    cost already in the accounts, shown so the figure can be checked, never
 *    so it can be deducted.
 *
 * 2. SALES TAX AND SERVICE TAX ARE SEPARATE REGIMES.
 *
 *    They have different registration, different scope and different returns.
 *    A business can be registered for one, the other, or both. Summing them
 *    into a single "SST" figure produces a number that is not any return —
 *    which is what `outputTaxForPeriod()` did before this module, because it
 *    aggregated `tax_transaction` with no regime filter at all.
 * ---------------------------------------------------------------------------
 *
 * ⚠️ WHAT THIS MODULE DOES NOT DECIDE. The arithmetic below is verifiable and
 * verified. The SST-02 FORM ITSELF is not: box numbers, the mapping of these
 * figures onto them, the taxable period cadence and the filing due date must be
 * confirmed against RMCD. Those are configuration carrying provenance, exactly
 * as withholding rates are, and `readiness` reports the capability as blocked
 * until they are supplied. This module computes what is owed; it does not claim
 * to know which box it goes in.
 */

import { Money, sumMoney, type Currency } from './money.js';
import type { TaxRegime } from './tax.js';

/** One `tax_transaction` row, as the return sees it. */
export interface TaxTransactionRecord {
  readonly regime: TaxRegime;
  readonly direction: 'OUTPUT' | 'INPUT';
  /** The document that produced it — used for the drill-down, and for signs. */
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
  readonly taxPointDate: string;
  readonly taxableAmount: Money;
  readonly taxAmount: Money;
  /** Present when the supply was exempt; the certificate is the evidence. */
  readonly exemptionReason?: string;
}

/**
 * What counts as a reduction is decided by the SIGN, not by the document type.
 *
 * ---------------------------------------------------------------------------
 * THE STORED CONVENTION IS ALREADY SIGNED, AND THIS MODULE FIRST ASSUMED
 * OTHERWISE.
 *
 * `credit-note.ts` writes its `tax_transaction` rows NEGATED — both the taxable
 * amount and the tax. So a credit note already arrives as a negative supply,
 * and a version of this module that re-derived the sign from a list of document
 * types produced a return whose components did not add up. The integration test
 * against the real engine caught it; the unit test, which built its own rows
 * with the wrong convention, agreed with the bug.
 *
 * Keying on the sign is also the more durable choice: a document type added
 * later that reduces a supply is handled with no change here, whereas a list is
 * something a new document type escapes silently.
 *
 * The discriminator is the TAXABLE amount rather than the tax, because a credit
 * note against an exempt supply carries a negative taxable amount and zero tax.
 * ---------------------------------------------------------------------------
 */
function isReduction(t: TaxTransactionRecord): boolean {
  return t.taxableAmount.isNegative() || t.taxAmount.isNegative();
}

export interface TaxReturnFigures {
  readonly regime: TaxRegime;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: Currency;

  /** Value of taxable supplies made, net of credit notes. */
  readonly taxableSupplies: Money;
  /** Tax charged on those supplies, before adjustments. */
  readonly outputTaxCharged: Money;
  /** Reduction from credit notes whose tax point falls in this period. */
  readonly outputTaxAdjustments: Money;
  /** What must be remitted. Output tax only — see the header. */
  readonly netTaxPayable: Money;

  /**
   * Tax paid to suppliers in the period.
   *
   * ---------------------------------------------------------------------------
   * REPORTED, NEVER DEDUCTED.
   *
   * Present so the figure can be checked against the accounts, and because a
   * user who has filed GST returns will look for it and should find it
   * explicitly labelled rather than absent and assumed forgotten. It is already
   * a cost in the P&L. Subtracting it from `netTaxPayable` would under-declare
   * the return by exactly this amount.
   * ---------------------------------------------------------------------------
   */
  readonly inputTaxAbsorbed: Money;

  /** Supplies made with an exemption certificate, declared but not taxed. */
  readonly exemptSupplies: Money;

  readonly documentCount: number;
}

/**
 * Compute a return from the tax transactions falling in its period.
 *
 * Pure, and total: given the same rows it produces the same figures, and it
 * reads nothing but its arguments. Selection by tax point — not invoice date,
 * not payment date — because the tax point is what decides which period a
 * supply belongs to, and it is already stored per transaction.
 */
export function computeTaxReturn(
  regime: TaxRegime,
  periodStart: string,
  periodEnd: string,
  transactions: readonly TaxTransactionRecord[],
  currency: Currency = 'MYR',
): TaxReturnFigures {
  const inPeriod = transactions.filter(
    (t) =>
      t.regime === regime &&
      t.taxPointDate >= periodStart &&
      t.taxPointDate <= periodEnd,
  );

  const output = inPeriod.filter((t) => t.direction === 'OUTPUT');
  const input = inPeriod.filter((t) => t.direction === 'INPUT');

  const charged = output.filter((t) => !isReduction(t));
  const reducing = output.filter(isReduction);

  const exempt = charged.filter((t) => t.exemptionReason !== undefined);
  const taxed = charged.filter((t) => t.exemptionReason === undefined);

  const outputTaxCharged = sumMoney(taxed.map((t) => t.taxAmount), currency);
  // Stated positive. The rows are stored negative, and a return that reported a
  // negative "adjustment" would read as an increase.
  const outputTaxAdjustments = sumMoney(reducing.map((t) => t.taxAmount), currency).abs();

  const grossSupplies = sumMoney(taxed.map((t) => t.taxableAmount), currency);
  const creditedSupplies = sumMoney(reducing.map((t) => t.taxableAmount), currency).abs();

  return {
    regime,
    periodStart,
    periodEnd,
    currency,
    taxableSupplies: grossSupplies.subtract(creditedSupplies),
    outputTaxCharged,
    outputTaxAdjustments,
    // Output tax, less credit notes. Input tax is deliberately absent.
    netTaxPayable: outputTaxCharged.subtract(outputTaxAdjustments),
    // Also signed at source: a debit note reduces what was absorbed.
    inputTaxAbsorbed: sumMoney(input.map((t) => t.taxAmount), currency),
    exemptSupplies: sumMoney(exempt.map((t) => t.taxableAmount), currency),
    documentCount: new Set(inPeriod.map((t) => t.sourceDocumentId)).size,
  };
}

/**
 * Whether a computed return is internally consistent.
 *
 * The arithmetic that must hold whatever the inputs, checked rather than
 * assumed — the same treatment the ledger invariants get. A return that fails
 * this is a bug in this module, not a data problem, and it should be impossible
 * to file one.
 */
export interface TaxReturnCheck {
  readonly consistent: boolean;
  readonly violations: readonly string[];
}

export function checkTaxReturn(figures: TaxReturnFigures): TaxReturnCheck {
  const violations: string[] = [];

  if (!figures.netTaxPayable.equals(
    figures.outputTaxCharged.subtract(figures.outputTaxAdjustments),
  )) {
    violations.push('netTaxPayable is not outputTaxCharged less outputTaxAdjustments');
  }

  if (figures.netTaxPayable.isNegative()) {
    // Possible and legitimate: a period with more credit notes than sales. It
    // is a refund claim rather than a payment, and it is worth flagging because
    // it is unusual enough to be a data-entry error most of the time.
    violations.push(
      'netTaxPayable is negative — credit notes exceed supplies in this period. ' +
        'Legitimate after a large cancellation, and worth checking before filing.',
    );
  }

  if (figures.outputTaxCharged.isNegative() || figures.outputTaxAdjustments.isNegative()) {
    violations.push('Tax components must be stated positive; the signs are applied here');
  }

  if (figures.periodEnd < figures.periodStart) {
    violations.push('The period ends before it starts');
  }

  return { consistent: violations.length === 0, violations };
}

/**
 * The taxable periods for a cadence.
 *
 * ⚠️ THE CADENCE IS NOT DECIDED HERE. Malaysian SST taxable periods are
 * commonly described as bi-monthly, and a business may be assigned a different
 * cycle by RMCD. This function generates periods for whatever cadence it is
 * given; which cadence applies to a given registration is configuration that
 * must be confirmed against RMCD, and it carries provenance for that reason.
 *
 * Generating them rather than storing them means a period cannot be silently
 * skipped — a gap in a filing history is the thing that draws an assessment.
 */
export interface TaxablePeriod {
  readonly start: string;
  readonly end: string;
  readonly label: string;
}

export function taxablePeriods(
  firstPeriodStart: string,
  cadenceMonths: number,
  through: string,
): TaxablePeriod[] {
  if (cadenceMonths < 1 || !Number.isInteger(cadenceMonths)) {
    throw new Error(`A taxable period cadence must be whole months; got ${cadenceMonths}`);
  }

  const periods: TaxablePeriod[] = [];
  const [year, month] = firstPeriodStart.split('-').map(Number) as [number, number, number];

  let cursorYear = year;
  let cursorMonth = month;

  // Bounded by `through` rather than by a count: a caller asking for periods up
  // to a date should not also have to work out how many that is.
  for (let guard = 0; guard < 1200; guard++) {
    const start = iso(cursorYear, cursorMonth, 1);
    if (start > through) break;

    const endMonthIndex = cursorMonth + cadenceMonths - 1;
    const endYear = cursorYear + Math.floor((endMonthIndex - 1) / 12);
    const endMonth = ((endMonthIndex - 1) % 12) + 1;
    const end = iso(endYear, endMonth, daysInMonth(endYear, endMonth));

    periods.push({ start, end, label: `${start} to ${end}` });

    const nextIndex = cursorMonth + cadenceMonths;
    cursorYear += Math.floor((nextIndex - 1) / 12);
    cursorMonth = ((nextIndex - 1) % 12) + 1;
  }

  return periods;
}

/** Which taxable period a date falls in, or null if it precedes the first. */
export function periodFor(
  date: string,
  firstPeriodStart: string,
  cadenceMonths: number,
): TaxablePeriod | null {
  return (
    taxablePeriods(firstPeriodStart, cadenceMonths, date).find(
      (p) => date >= p.start && date <= p.end,
    ) ?? null
  );
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  // UTC, and day 0 of the next month — the standard trick, and correct across
  // leap years without a table.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
