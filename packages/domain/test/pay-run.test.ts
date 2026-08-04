import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import {
  ageAt,
  buildCp39File,
  buildPayRunJournal,
  Cp39Error,
  type Cp39Detail,
  type PayRunAccounts,
  type PayRunJournalLine,
} from '../src/pay-run.js';

/**
 * Pay-run rules: the journal a month posts, and the CP39 file it files.
 *
 * The CP39 assertions are byte-level on purpose. Exhibit 4 of the committed
 * IRBM specification gives field positions, record lengths (57 and 136) and a
 * worked padding example; a file that is one character off is not "mostly
 * right", it is rejected by the bank upload. So the tests measure, they do not
 * eyeball.
 */

const ACCOUNTS: PayRunAccounts = {
  wagesExpense: 'acc-wages',
  employerStatutoryExpense: 'acc-employer',
  epfPayable: 'acc-epf',
  socsoPayable: 'acc-socso',
  eisPayable: 'acc-eis',
  pcbPayable: 'acc-pcb',
  netWagesPayable: 'acc-net',
};

const rm = (value: string) => Money.fromDecimal(value, 'MYR');

/** A line the way the engines produce one: net = gross − every deduction. */
function line(input: {
  gross: string;
  epfEmployee: string;
  epfEmployer: string;
  socsoEmployee: string;
  socsoEmployer: string;
  eisEmployee: string;
  eisEmployer: string;
  pcb: string;
}): PayRunJournalLine {
  const net = rm(input.gross)
    .subtract(rm(input.epfEmployee))
    .subtract(rm(input.socsoEmployee))
    .subtract(rm(input.eisEmployee))
    .subtract(rm(input.pcb));
  return {
    gross: rm(input.gross),
    epfEmployee: rm(input.epfEmployee),
    epfEmployer: rm(input.epfEmployer),
    socsoEmployee: rm(input.socsoEmployee),
    socsoEmployer: rm(input.socsoEmployer),
    eisEmployee: rm(input.eisEmployee),
    eisEmployer: rm(input.eisEmployer),
    pcb: rm(input.pcb),
    netPay: net,
  };
}

const technician = () =>
  line({
    gross: '6000.00',
    epfEmployee: '660.00',
    epfEmployer: '720.00',
    socsoEmployee: '74.40',
    socsoEmployer: '104.15',
    eisEmployee: '11.90',
    eisEmployer: '11.90',
    pcb: '207.50',
  });

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

describe('the pay-run journal', () => {
  it('posts the August staff list and balances to the sen', () => {
    const assistant = line({
      gross: '2500.00',
      epfEmployee: '275.00',
      epfEmployer: '325.00',
      socsoEmployee: '30.60',
      socsoEmployer: '42.85',
      eisEmployee: '4.90',
      eisEmployer: '4.90',
      pcb: '0.00',
    });

    const draft = buildPayRunJournal(
      [technician(), assistant],
      ACCOUNTS,
      '2026-08-31',
      'MYR',
      'RUN-00001',
      'run-id',
    );

    const by = (accountId: string) => draft.lines.find((l) => l.accountId === accountId);

    expect(by('acc-wages')).toMatchObject({ side: 'DEBIT' });
    expect(by('acc-wages')!.amount.toDecimalString()).toBe('8500.0000');
    // Employer shares: (720+325) + (104.15+42.85) + (11.90+4.90)
    expect(by('acc-employer')!.amount.toDecimalString()).toBe('1208.8000');
    // Each payable carries BOTH sides of its scheme — one bank payment to one
    // authority clears one balance.
    expect(by('acc-epf')!.amount.toDecimalString()).toBe('1980.0000');
    expect(by('acc-socso')!.amount.toDecimalString()).toBe('252.0000');
    expect(by('acc-eis')!.amount.toDecimalString()).toBe('33.6000');
    expect(by('acc-pcb')!.amount.toDecimalString()).toBe('207.5000');

    const debits = draft.lines
      .filter((l) => l.side === 'DEBIT')
      .reduce((t, l) => t.add(l.amount), Money.zero('MYR'));
    const credits = draft.lines
      .filter((l) => l.side === 'CREDIT')
      .reduce((t, l) => t.add(l.amount), Money.zero('MYR'));
    expect(debits.toDecimalString()).toBe(credits.toDecimalString());
  });

  it('omits a payable nobody owes instead of posting a zero line', () => {
    // A staff of one 62-year-old: no EIS, no PCB. The validator rejects
    // non-positive lines, so a zero line is absence, not an error.
    const senior = line({
      gross: '3000.00',
      epfEmployee: '0.00',
      epfEmployer: '120.00',
      socsoEmployee: '18.35',
      socsoEmployer: '36.70',
      eisEmployee: '0.00',
      eisEmployer: '0.00',
      pcb: '0.00',
    });

    const draft = buildPayRunJournal([senior], ACCOUNTS, '2026-08-31', 'MYR', 'RUN-2', 'id');
    const accounts = draft.lines.map((l) => l.accountId);
    expect(accounts).not.toContain('acc-eis');
    expect(accounts).not.toContain('acc-pcb');
    expect(accounts).toContain('acc-epf');
  });

  it('balances for ANY staff list where net = gross minus deductions', () => {
    // The property the whole posting rests on. Amounts are integers of sen so
    // the generator cannot invent sub-sen precision the engines never produce.
    const sen = (max: number) => fc.integer({ min: 0, max }).map((n) => (n / 100).toFixed(2));
    const arbitraryLine = fc
      .record({
        gross: sen(3_000_000),
        epfEmployee: sen(50_000),
        epfEmployer: sen(50_000),
        socsoEmployee: sen(10_000),
        socsoEmployer: sen(10_000),
        eisEmployee: sen(5_000),
        eisEmployer: sen(5_000),
        pcb: sen(100_000),
      })
      .map(line);

    fc.assert(
      fc.property(fc.array(arbitraryLine, { minLength: 1, maxLength: 20 }), (lines) => {
        const draft = buildPayRunJournal(lines, ACCOUNTS, '2026-08-31', 'MYR', 'R', 'id');
        const total = (side: 'DEBIT' | 'CREDIT') =>
          draft.lines
            .filter((l) => l.side === side)
            .reduce((t, l) => t.add(l.amount), Money.zero('MYR'));
        return total('DEBIT').toDecimalString() === total('CREDIT').toDecimalString();
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Age at the month that matters
// ---------------------------------------------------------------------------

describe('ageAt', () => {
  it('counts completed years only', () => {
    expect(ageAt('1966-09-15', '2026-08-01')).toBe(59);
    expect(ageAt('1966-08-01', '2026-08-01')).toBe(60);
    expect(ageAt('1966-07-20', '2026-08-01')).toBe(60);
  });

  it('flips the schedules at the 60th birthday month, not the year', () => {
    // Born 15/09/1966: the August 2026 run is Part A wages; September's is
    // Part E. This is why age is computed per month and never stored.
    const before = ageAt('1966-09-15', '2026-08-01');
    const after = ageAt('1966-09-15', '2026-10-01');
    expect(before).toBe(59);
    expect(after).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// CP39
// ---------------------------------------------------------------------------

const nurul: Cp39Detail = {
  tin: '531367080',
  name: 'NURUL HUDA BINTI AHMAD',
  newIc: '900101-14-5566',
  countryCode: 'MY',
  mtd: '207.50',
  employeeNo: 'SGT-004',
};

describe('the CP39 file', () => {
  it('lays out header and detail at the exhibit’s exact widths', () => {
    const file = buildCp39File('9012345678', 2026, 8, [nurul]);
    const [header, detail, trailing] = file.content.split('\r\n');

    expect(header).toHaveLength(57);
    expect(detail).toHaveLength(136);
    expect(trailing).toBe(''); // file ends with a record terminator

    // Header fields, by position (1-indexed in the exhibit, 0-indexed here).
    expect(header![0]).toBe('H');
    expect(header!.slice(1, 11)).toBe('9012345678'); // HQ employer no
    expect(header!.slice(11, 21)).toBe('9012345678');
    expect(header!.slice(21, 25)).toBe('2026');
    expect(header!.slice(25, 27)).toBe('08');
    expect(header!.slice(27, 37)).toBe('0000020750'); // RM207.50, implied 2dp
    expect(header!.slice(37, 42)).toBe('00001');
    expect(header!.slice(42, 52)).toBe('0000000000'); // CP38 — not tracked
    expect(header!.slice(52, 57)).toBe('00000');
  });

  it('pads the TIN exactly as the exhibit’s own example shows', () => {
    // "IG 531367080 to be filled as 00531367080" — page 43. The prefix is
    // dropped, the digits left-padded with zeroes to 11.
    const file = buildCp39File('9012345678', 2026, 8, [nurul]);
    const detail = file.content.split('\r\n')[1]!;
    expect(detail.slice(1, 12)).toBe('00531367080');
  });

  it('writes the IC without dashes and the name space-padded', () => {
    const file = buildCp39File('9012345678', 2026, 8, [nurul]);
    const detail = file.content.split('\r\n')[1]!;

    expect(detail.slice(12, 72)).toBe('NURUL HUDA BINTI AHMAD'.padEnd(60, ' '));
    expect(detail.slice(84, 96)).toBe('900101145566');
    expect(detail.slice(108, 110)).toBe('MY');
    expect(detail.slice(110, 118)).toBe('00020750');
    expect(detail.slice(126, 136)).toBe('SGT-004   ');
  });

  it('leaves an absent IC as spaces — twelve zeroes would read as an IC', () => {
    const foreign: Cp39Detail = {
      tin: '87654321',
      name: 'JOHN SMITH',
      passportNo: 'A1234567',
      countryCode: 'GB',
      mtd: '900.00',
    };
    const detail = buildCp39File('9012345678', 2026, 8, [foreign]).content.split('\r\n')[1]!;
    expect(detail.slice(84, 96)).toBe(' '.repeat(12));
    expect(detail.slice(96, 108)).toBe('A1234567    ');
  });

  it('names the file the way e-PCB expects: employer, month, year', () => {
    const file = buildCp39File('9012345678', 2026, 8, [nurul]);
    expect(file.filename).toBe('901234567808_2026.txt');
  });

  it('files only employees with a deduction, and the header total matches', () => {
    /*
     * Most shop wages attract no PCB — a RM2,500 assistant deducts nothing.
     * LHDN wants the deductions, not the roster, and the header totals must
     * equal the sum of the detail records or the upload is rejected.
     */
    const noTax: Cp39Detail = { ...nurul, name: 'AHMAD', tin: '111', mtd: '0.00' };
    const file = buildCp39File('9012345678', 2026, 8, [nurul, noTax]);
    const records = file.content.split('\r\n').filter((l) => l.length > 0);

    expect(records).toHaveLength(2); // header + one detail
    expect(records[0]!.slice(37, 42)).toBe('00001');
    expect(records[0]!.slice(27, 37)).toBe('0000020750');
  });

  it('refuses a deduction for an employee with no TIN, naming the fix', () => {
    const noTin: Cp39Detail = { ...nurul, tin: '' };
    expect(() => buildCp39File('9012345678', 2026, 8, [noTin])).toThrow(Cp39Error);
    expect(() => buildCp39File('9012345678', 2026, 8, [noTin])).toThrow(/staff record/);
  });

  it('refuses a malformed employer number rather than filing it', () => {
    expect(() => buildCp39File('E 901234567', 2026, 8, [nurul])).toThrow(Cp39Error);
    expect(() => buildCp39File('', 2026, 8, [nurul])).toThrow(/employer number/);
  });

  it('every record in a generated file is exactly its specified length', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            tin: fc.integer({ min: 1, max: 99_999_999_999 }).map(String),
            name: fc.string({ minLength: 1, maxLength: 80 }).map((s) =>
              s.replace(/[\r\n]/g, ' '),
            ),
            countryCode: fc.constant('MY'),
            mtd: fc.integer({ min: 1, max: 9_999_999 }).map((n) => (n / 100).toFixed(2)),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (details) => {
          const file = buildCp39File('1234567890', 2026, 12, details as Cp39Detail[]);
          const [header, ...rest] = file.content.split('\r\n').filter((l) => l.length > 0);
          return header!.length === 57 && rest.every((r) => r.length === 136);
        },
      ),
      { numRuns: 200 },
    );
  });
});
