import { Money, type Currency } from './money.js';
import type { JournalEntryDraft, JournalLineDraft } from './journal-entry.js';

/**
 * Pay runs — the pure rules: what a month of payroll posts, and what gets
 * filed.
 *
 * ---------------------------------------------------------------------------
 * Everything here is arithmetic and formatting over figures the statutory
 * engines already computed. Nothing recomputes a contribution: a pay-run line
 * arrives with its EPF/SOCSO/EIS/PCB amounts frozen, and this module only
 * aggregates them into a balanced journal and serialises them into the CP39
 * submission file. If a figure is wrong here, it was wrong on the payslip too
 * — which is the property that makes the whole thing auditable.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Age, computed at the month it matters
// ---------------------------------------------------------------------------

/**
 * Completed years of age at a date.
 *
 * Not stored on the employee, ever: EPF Part E, SOCSO Category 2 and the EIS
 * exclusion all switch at 60, so the age that matters is the age AT THE
 * CONTRIBUTION MONTH. A run prepared for the month of someone's 60th birthday
 * uses the post-60 schedules from that month on, with nobody remembering to
 * update anything.
 */
export function ageAt(dateOfBirth: string, asOf: string): number {
  const [birthYear, birthMonth, birthDay] = dateOfBirth.split('-').map(Number);
  const [year, month, day] = asOf.split('-').map(Number);
  let age = year! - birthYear!;
  if (month! < birthMonth! || (month === birthMonth && day! < birthDay!)) age -= 1;
  return age;
}

// ---------------------------------------------------------------------------
// The journal a confirmed run posts
// ---------------------------------------------------------------------------

/** The slice of a pay-run line the journal needs. All figures already final. */
export interface PayRunJournalLine {
  readonly gross: Money;
  readonly epfEmployee: Money;
  readonly epfEmployer: Money;
  readonly socsoEmployee: Money;
  readonly socsoEmployer: Money;
  readonly eisEmployee: Money;
  readonly eisEmployer: Money;
  readonly pcb: Money;
  readonly netPay: Money;
}

/** The seven posting accounts a pay run needs, resolved by the caller. */
export interface PayRunAccounts {
  readonly wagesExpense: string;
  readonly employerStatutoryExpense: string;
  readonly epfPayable: string;
  readonly socsoPayable: string;
  readonly eisPayable: string;
  readonly pcbPayable: string;
  readonly netWagesPayable: string;
}

/**
 * The month's payroll as one balanced journal entry.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, AND WHY EACH LINE IS WHERE IT IS.
 *
 *   Dr  Wages and salaries          Σ gross            what the staff earned
 *   Dr  Employer statutory expense  Σ employer shares  what employing them costs on top
 *   Cr  EPF payable                 employee + employer EPF     owed to KWSP
 *   Cr  SOCSO payable               employee + employer SOCSO   owed to PERKESO
 *   Cr  EIS payable                 employee + employer EIS     owed to PERKESO
 *   Cr  PCB payable                 Σ MTD                       owed to LHDN
 *   Cr  Net wages payable           Σ net pay                   owed to the staff
 *
 * Each authority gets its own payable because each is settled by its own bank
 * payment, and a transfer to PERKESO must clear PERKESO's balance — a blended
 * "statutory payable" would leave the Banking screen matching one payment
 * against a number that is never quite right.
 *
 * Balance is by construction, not by chance: net = gross − deductions, and
 * every deduction lands in exactly one payable alongside its employer share,
 * whose expense is the other debit. The validator still checks — this comment
 * is an explanation, not a substitute.
 * ---------------------------------------------------------------------------
 */
export function buildPayRunJournal(
  lines: readonly PayRunJournalLine[],
  accounts: PayRunAccounts,
  entryDate: string,
  currency: Currency,
  runNo: string,
  payRunId: string,
): JournalEntryDraft {
  const zero = Money.zero(currency);
  const sum = (pick: (line: PayRunJournalLine) => Money): Money =>
    lines.reduce((total, line) => total.add(pick(line)), zero);

  const gross = sum((l) => l.gross);
  const employerShare = sum((l) => l.epfEmployer)
    .add(sum((l) => l.socsoEmployer))
    .add(sum((l) => l.eisEmployer));
  const epf = sum((l) => l.epfEmployee).add(sum((l) => l.epfEmployer));
  const socso = sum((l) => l.socsoEmployee).add(sum((l) => l.socsoEmployer));
  const eis = sum((l) => l.eisEmployee).add(sum((l) => l.eisEmployer));
  const pcb = sum((l) => l.pcb);
  const net = sum((l) => l.netPay);

  const draftLines: JournalLineDraft[] = [];
  const add = (accountId: string, side: 'DEBIT' | 'CREDIT', amount: Money): void => {
    // A zero line is omitted, not posted: `validateJournalEntry` rejects
    // non-positive amounts, and a month where nobody is EIS-liable (all staff
    // over 60) is a real month, not an error.
    if (amount.isZero()) return;
    draftLines.push({ accountId, side, amount, baseAmount: amount });
  };

  add(accounts.wagesExpense, 'DEBIT', gross);
  add(accounts.employerStatutoryExpense, 'DEBIT', employerShare);
  add(accounts.epfPayable, 'CREDIT', epf);
  add(accounts.socsoPayable, 'CREDIT', socso);
  add(accounts.eisPayable, 'CREDIT', eis);
  add(accounts.pcbPayable, 'CREDIT', pcb);
  add(accounts.netWagesPayable, 'CREDIT', net);

  return {
    entryDate,
    description: `Payroll ${runNo}`,
    sourceModule: 'SYSTEM',
    sourceDocumentType: 'PAY_RUN',
    sourceDocumentId: payRunId,
    lines: draftLines,
  };
}

// ---------------------------------------------------------------------------
// CP39 — the monthly PCB submission file
// ---------------------------------------------------------------------------

/**
 * Serialise a month's deductions into LHDN's CP39 text file.
 *
 * ---------------------------------------------------------------------------
 * SOURCE: Exhibit 4, "Specification Format for MTD Text File Data", page 43 of
 * the MTD Computerised Calculation specification 2026 (committed at
 * docs/research/sources/lhdn-mtd-computerised-specification-2026.pdf). This is
 * the file an employer uploads to e-PCB Plus or internet banking; the field
 * positions below are that page transcribed, and the tests assert the record
 * lengths (57 and 136) and the exhibit's own worked example — TIN
 * "IG 531367080" is filed as "00531367080".
 *
 * Amounts are IMPLIED-DECIMAL: "right justify with zeroes and with 2 decimal
 * point" means RM 207.50 is written as the digits 20750, zero-padded — no
 * decimal point appears in the file. That is the long-standing CP39 convention
 * and the field widths only make sense this way (a 10-char amount with a
 * literal point could not hold the stated magnitudes).
 *
 * CP38 columns are filled with zeros: this system does not track CP38
 * instalment orders, and the register says so. A shop served with one needs to
 * handle it before relying on this file.
 * ---------------------------------------------------------------------------
 */
export interface Cp39Detail {
  /** LHDN Tax Identification Number, digits only. */
  readonly tin: string;
  readonly name: string;
  /** New NRIC, digits only, no dashes. Optional. */
  readonly newIc?: string;
  /** Old IC, if the person has one. Optional. */
  readonly oldIc?: string;
  readonly passportNo?: string;
  /** ISO 3166 alpha-2, e.g. 'MY'. */
  readonly countryCode: string;
  /** The month's MTD, a decimal string. */
  readonly mtd: string;
  readonly employeeNo?: string;
}

export interface Cp39File {
  readonly filename: string;
  readonly content: string;
}

export class Cp39Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Cp39Error';
  }
}

/** RM 207.50 → '20750', then zero-padded to `width`. Throws if it cannot fit. */
function impliedDecimal(amount: string, width: number, field: string): string {
  if (!/^\d+(\.\d{1,4})?$/.test(amount)) {
    throw new Cp39Error(`${field} is not a non-negative decimal amount: "${amount}"`);
  }
  const [whole = '0', fraction = ''] = amount.split('.');
  // The file carries sen; the wire carries 4dp. The extra places are always
  // zero for MTD (the deduction is rounded to 5 sen upstream), and anything
  // else here is a bug worth stopping on rather than silently truncating.
  if (fraction.length > 2 && Number(fraction.slice(2)) !== 0) {
    throw new Cp39Error(`${field} has sub-sen precision (${amount}) — CP39 carries sen.`);
  }
  const sen = `${whole}${fraction.padEnd(2, '0').slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  if (sen.length > width) {
    throw new Cp39Error(`${field} ${amount} does not fit in ${width} digits.`);
  }
  return sen.padStart(width, '0');
}

function numeric(value: string, width: number, field: string): string {
  if (!/^\d*$/.test(value)) {
    throw new Cp39Error(`${field} must be digits only, got "${value}"`);
  }
  if (value.length > width) {
    throw new Cp39Error(`${field} "${value}" is longer than ${width} digits.`);
  }
  return value.padStart(width, '0');
}

function alpha(value: string, width: number, field: string): string {
  if (value.length > width) {
    // Names longer than the field are truncated, not refused — the exhibit
    // gives the field 60 characters and a long name is not an error.
    if (field === 'name') return value.slice(0, width);
    throw new Cp39Error(`${field} "${value}" is longer than ${width} characters.`);
  }
  return value.padEnd(width, ' ');
}

export function buildCp39File(
  employerNo: string,
  year: number,
  month: number,
  details: readonly Cp39Detail[],
): Cp39File {
  if (!/^\d{1,10}$/.test(employerNo)) {
    throw new Cp39Error(
      `The LHDN employer number must be up to 10 digits; got "${employerNo}". ` +
        'Set it under Payroll settings — the E number on the employer tax file.',
    );
  }
  if (month < 1 || month > 12) throw new Cp39Error(`${month} is not a month.`);

  const mm = String(month).padStart(2, '0');

  /*
   * Only employees with a deduction appear. A zero-MTD employee is normal (most
   * shop wages attract no PCB) and LHDN wants the deductions, not the roster —
   * the totals in the header must equal the sum of the details.
   */
  const rows = details.filter((d) => Number(d.mtd) > 0);

  const totalMtd = rows
    .reduce((total, d) => total.add(Money.fromDecimal(d.mtd, 'MYR')), Money.zero('MYR'))
    .toDecimalString();

  // Header — 57 characters, per the exhibit. HQ number and employer number are
  // the same for a single-branch employer, which a five-person shop is.
  const header =
    'H' +
    numeric(employerNo, 10, 'employer number') +
    numeric(employerNo, 10, 'employer number') +
    String(year).padStart(4, '0') +
    mm +
    impliedDecimal(totalMtd, 10, 'total MTD') +
    numeric(String(rows.length), 5, 'record count') +
    impliedDecimal('0', 10, 'total CP38') +
    numeric('0', 5, 'CP38 count');

  const detailLines = rows.map((d) => {
    if (!/^\d{1,11}$/.test(d.tin.replace(/\D/g, '') || '')) {
      throw new Cp39Error(
        `Employee "${d.name}" has no usable TIN. CP39 identifies people by Tax ` +
          'Identification Number — add it on the staff record.',
      );
    }
    // "Leave it blank if not applicable" (exhibit note on both IC fields):
    // absent means SPACES, not zeroes — twelve zeroes would read as an IC.
    const newIcDigits = (d.newIc ?? '').replace(/\D/g, '');
    return (
      'D' +
      numeric(d.tin.replace(/\D/g, ''), 11, 'TIN') +
      alpha(d.name, 60, 'name') +
      alpha(d.oldIc ?? '', 12, 'old IC') +
      (newIcDigits === '' ? ' '.repeat(12) : numeric(newIcDigits, 12, 'new IC')) +
      alpha(d.passportNo ?? '', 12, 'passport') +
      alpha(d.countryCode, 2, 'country') +
      impliedDecimal(d.mtd, 8, 'MTD') +
      impliedDecimal('0', 8, 'CP38') +
      alpha(d.employeeNo ?? '', 10, 'employee number')
    );
  });

  return {
    filename: `${employerNo}${mm}_${year}.txt`,
    content: [header, ...detailLines].join('\r\n') + '\r\n',
  };
}
