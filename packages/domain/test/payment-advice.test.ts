import { describe, expect, it } from 'vitest';
import { parsePaymentAdvices } from '../src/payment-advice.js';

/**
 * The parser against the REAL sample the owner photographed — a Maybank
 * advice for an RM 10.00 BSN deposit described "MAKAN" — transcribed
 * verbatim, including the colon inside the details value and the zeroed
 * foreign-amount block that must be ignored.
 */

const SAMPLE = `
Our Reference             : 202605183294290
Payment Reference         : DEPOSIT
Branch                    : IBS BANGSAR BARU
Details Of Payment        : PAYMENT DESCRIPTIONS : MAKAN
Remiting Bank             : BANK SIMPANAN

FOREIGN AMOUNT INFORMATION

Instructed Currency       : NA
Gross Amount              : 0.00
Agent charges             : 0.00
Nett                      : 0.00
Rate 1                    : 0.00
Rate 2                    : 0.00

LOCAL AMOUNT INFORMATION

Payment Currency          : NA
Remittance Amount         : 10.00
Charges - Commission      : 0.00
Charges - Postage         : 0.00
Charges - Stamp Duty      : 0.00
Charges - Service Charge  : 0.00
Total Charges             : 0.00
Total Amount              : 10.00
Nett Amount               : 0.00
`;

/* The photographed document spells it "Remiting Bank"; a corrected spelling
   may appear on other exports, so the parser is tested with both. */
const SAMPLE_CORRECT_SPELLING = SAMPLE.replace('Remiting Bank', 'Remitting Bank');

describe('parsePaymentAdvices — the photographed sample', () => {
  it('reads one incoming RM 10.00 with the reference and a readable narrative', () => {
    const parsed = parsePaymentAdvices(SAMPLE_CORRECT_SPELLING, 'MYR', {
      fallbackDate: '2026-08-03',
    });

    expect(parsed.rows).toHaveLength(1);
    const row = parsed.rows[0]!;
    expect(row.reference).toBe('202605183294290');
    expect(row.amount.toDecimalString()).toBe('10.0000');
    // Boilerplate stripped, remitting bank kept — this is what the matcher
    // and the human both read.
    expect(row.description).toBe('DEPOSIT MAKAN FR BANK SIMPANAN');
    // No date label in the sample: dated by the fallback, and SAID.
    expect(row.txnDate).toBe('2026-08-03');
    expect(parsed.violations).toEqual([
      { code: 'ADVICE_NO_DATE', reference: '202605183294290' },
    ]);
  });

  it('reads the sample VERBATIM — the bank\'s own "Remiting" spelling included', () => {
    const parsed = parsePaymentAdvices(SAMPLE, 'MYR', { fallbackDate: '2026-08-03' });
    expect(parsed.rows[0]!.description).toBe('DEPOSIT MAKAN FR BANK SIMPANAN');
  });

  it('uses the advice\'s own date when one is present, with no violation', () => {
    const dated = SAMPLE_CORRECT_SPELLING.replace(
      'Our Reference             : 202605183294290',
      'Our Reference             : 202605183294290\nValue Date                : 18/05/2026',
    );
    const parsed = parsePaymentAdvices(dated, 'MYR');

    expect(parsed.rows[0]!.txnDate).toBe('2026-05-18');
    expect(parsed.violations).toEqual([]);
  });

  it('refuses a charges discrepancy with both figures, never picking a side', () => {
    const mismatched = SAMPLE_CORRECT_SPELLING.replace(
      'Total Amount              : 10.00',
      'Total Amount              : 9.50',
    );
    const parsed = parsePaymentAdvices(mismatched, 'MYR', { fallbackDate: '2026-08-03' });

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.violations).toEqual([
      {
        code: 'ADVICE_AMOUNT_MISMATCH',
        reference: '202605183294290',
        remittance: '10.0000',
        total: '9.5000',
      },
    ]);
  });

  it('splits a file of several advices on Our Reference', () => {
    const second = SAMPLE_CORRECT_SPELLING
      .replace('202605183294290', '202605183294291')
      .replace('MAKAN', 'SEWA KEDAI')
      .replace('Remittance Amount         : 10.00', 'Remittance Amount         : 1500.00')
      .replace('Total Amount              : 10.00', 'Total Amount              : 1500.00');

    const parsed = parsePaymentAdvices(
      `${SAMPLE_CORRECT_SPELLING}\n${second}`,
      'MYR',
      { fallbackDate: '2026-08-03' },
    );

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.map((r) => r.reference)).toEqual([
      '202605183294290',
      '202605183294291',
    ]);
    expect(parsed.rows[1]!.amount.toDecimalString()).toBe('1500.0000');
  });

  it('ignores letterhead before the first record and reports an empty file honestly', () => {
    expect(parsePaymentAdvices('MALAYAN BANKING BERHAD\nPage 1 of 1', 'MYR').violations)
      .toEqual([{ code: 'EMPTY_FILE' }]);
  });
});
