/**
 * Maybank payment-advice parser: `Label : value` documents, one payment each.
 *
 * ---------------------------------------------------------------------------
 * BUILT FROM A REAL SAMPLE, AND ONLY WHAT THE SAMPLE SHOWS.
 *
 * The register's §3.7 rule — no guessed column maps — applies to layouts too.
 * This parser reads the exact labels observed on a real Maybank advice
 * (Our Reference, Payment Reference, Details Of Payment, Remitting Bank,
 * Remittance Amount, Total Charges, Total Amount) and treats everything it
 * does not recognise as inert text. Where the sample was silent, the parser
 * refuses rather than guesses:
 *
 *  - DIRECTION: the sample is an incoming deposit (a remitting bank sent us
 *    money), so every advice parses as MONEY IN. An outbound advice sample
 *    must be seen before outbound is supported — a sign guessed wrong books
 *    a receipt as a payment.
 *  - DATE: the sample crop shows no date label. Known Malaysian candidates
 *    are tried (Value Date, Payment Date, Transaction Date, Date); when none
 *    is present the caller's fallback date is used and a violation says so,
 *    so the preview shows the substitution instead of hiding it.
 *  - CHARGES: when Remittance Amount and Total Amount disagree, the record
 *    is REFUSED with both figures, not averaged or picked between. Which one
 *    lands in the account is a fact about the bank, not a guess to make.
 * ---------------------------------------------------------------------------
 *
 * Pure. Produces the same ParsedStatement the CSV path produces, so
 * everything downstream — dedupe, preview, import, rules — is shared.
 */

import { Money, type Currency } from './money.js';
import {
  dedupeHash,
  type ImportViolation,
  type ParsedStatement,
  type ParsedStatementRow,
} from './statement-import.js';

const DATE_LABELS = ['VALUE DATE', 'PAYMENT DATE', 'TRANSACTION DATE', 'DATE'];

/** `31/12/2026` or `2026-12-31` → ISO, or null. */
function adviceDate(value: string): string | null {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  return null;
}

function adviceAmount(value: string): Money | null {
  const cleaned = value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,4})?$/.test(cleaned)) return null;
  return Money.fromDecimal(cleaned, 'MYR');
}

interface AdviceFields {
  readonly fields: Map<string, string>;
  readonly reference: string | undefined;
}

/** Records start at each `Our Reference` line; labels split on the FIRST
 *  colon, because values carry their own (`PAYMENT DESCRIPTIONS : MAKAN`). */
function splitRecords(content: string): AdviceFields[] {
  const records: AdviceFields[] = [];
  let current: Map<string, string> | null = null;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;

    const label = line.slice(0, colon).trim().toUpperCase();
    const value = line.slice(colon + 1).trim();

    if (label === 'OUR REFERENCE') {
      if (current) records.push({ fields: current, reference: current.get('OUR REFERENCE') });
      current = new Map();
    }
    // Text before the first Our Reference — headers, bank letterhead.
    if (current === null) continue;
    if (!current.has(label)) current.set(label, value);
  }
  if (current) records.push({ fields: current, reference: current.get('OUR REFERENCE') });

  return records;
}

export function parsePaymentAdvices(
  content: string,
  currency: Currency,
  options: { readonly fallbackDate?: string } = {},
): ParsedStatement {
  const records = splitRecords(content);
  if (records.length === 0) {
    return { rows: [], violations: [{ code: 'EMPTY_FILE' }] };
  }

  const rows: ParsedStatementRow[] = [];
  const violations: ImportViolation[] = [];
  const seen = new Map<string, number>();

  for (const record of records) {
    const f = record.fields;
    const reference = record.reference;
    if (reference === undefined || reference.length === 0) {
      violations.push({ code: 'ADVICE_NO_REFERENCE' });
      continue;
    }

    const total = f.has('TOTAL AMOUNT') ? adviceAmount(f.get('TOTAL AMOUNT')!) : null;
    if (total === null || total.isZero()) {
      violations.push({ code: 'ADVICE_NO_AMOUNT', reference });
      continue;
    }

    // Refuse a charges discrepancy rather than pick a side.
    const remittance = f.has('REMITTANCE AMOUNT')
      ? adviceAmount(f.get('REMITTANCE AMOUNT')!)
      : null;
    if (remittance !== null && !remittance.equals(total)) {
      violations.push({
        code: 'ADVICE_AMOUNT_MISMATCH',
        reference,
        remittance: remittance.toDecimalString(),
        total: total.toDecimalString(),
      });
      continue;
    }

    let txnDate: string | null = null;
    for (const label of DATE_LABELS) {
      const value = f.get(label);
      if (value !== undefined) {
        txnDate = adviceDate(value);
        if (txnDate !== null) break;
      }
    }
    if (txnDate === null) {
      if (options.fallbackDate === undefined) {
        violations.push({ code: 'ADVICE_NO_DATE', reference });
        continue;
      }
      // Imported, dated by the statement date — and SAID, not hidden.
      violations.push({ code: 'ADVICE_NO_DATE', reference });
      txnDate = options.fallbackDate;
    }

    /* "PAYMENT DESCRIPTIONS :" is Maybank boilerplate inside the value. */
    const details = (f.get('DETAILS OF PAYMENT') ?? '')
      .replace(/^PAYMENT DESCRIPTIONS\s*:\s*/i, '');
    /* The photographed sample spells it "Remiting Bank"; accept the bank's
       spelling and the dictionary's both. */
    const remitting = f.get('REMITTING BANK') ?? f.get('REMITING BANK');
    const paymentRef = f.get('PAYMENT REFERENCE');
    const description = [paymentRef, details, remitting ? `FR ${remitting}` : undefined]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(' ');

    /* The sample is a deposit: a remitting bank sent money IN. Positive. */
    const amount = Money.fromDecimal(total.toDecimalString(), currency);

    const hash = dedupeHash({ txnDate, description, amount });
    const occurrence = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, occurrence);

    rows.push({
      lineNo: rows.length + 1,
      txnDate,
      description,
      reference,
      amount,
      dedupeHash: hash,
      occurrence,
    });
  }

  return { rows, violations };
}
