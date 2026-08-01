import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import {
  dedupeHash,
  parseDate,
  parseStatement,
  splitCsvLine,
  type ImportProfile,
} from '../src/statement-import.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);

/** Shaped after a Maybank CSV export: one signed amount column. */
const MAYBANK: ImportProfile = {
  bankName: 'Maybank',
  delimiter: ',',
  dateFormat: 'DD/MM/YYYY',
  amountConvention: 'SIGNED',
  columns: { txnDate: 0, description: 1, amount: 2, runningBalance: 3 },
};

/** Shaped after a CIMB export: separate debit and credit columns. */
const CIMB: ImportProfile = {
  bankName: 'CIMB',
  delimiter: ',',
  dateFormat: 'DD/MM/YYYY',
  amountConvention: 'DEBIT_CREDIT',
  columns: { txnDate: 0, description: 1, debit: 2, credit: 3, runningBalance: 4 },
};

describe('splitCsvLine', () => {
  it('honours quoted fields containing the delimiter', () => {
    // The failure this prevents: a Malaysian bank narrative with a city in it
    // — "IBG TRANSFER FR ALPHA TRADING, KL" — shifts every later column, and
    // a description fragment gets read as the amount.
    expect(splitCsvLine('20/08/2026,"IBG TRANSFER FR ALPHA TRADING, KL",1080.00', ',')).toEqual([
      '20/08/2026',
      'IBG TRANSFER FR ALPHA TRADING, KL',
      '1080.00',
    ]);
  });

  it('handles a doubled quote as a literal quote', () => {
    expect(splitCsvLine('a,"say ""hi""",c', ',')).toEqual(['a', 'say "hi"', 'c']);
  });

  it('preserves empty trailing fields', () => {
    expect(splitCsvLine('a,b,', ',')).toEqual(['a', 'b', '']);
  });

  it('supports a non-comma delimiter', () => {
    expect(splitCsvLine('a;b;c', ';')).toEqual(['a', 'b', 'c']);
  });
});

describe('parseDate', () => {
  it('reads the Malaysian DD/MM/YYYY convention', () => {
    expect(parseDate('05/08/2026', 'DD/MM/YYYY')).toBe('2026-08-05');
    expect(parseDate('5/8/2026', 'DD/MM/YYYY')).toBe('2026-08-05');
  });

  it('reads the other two supported formats', () => {
    expect(parseDate('05-08-2026', 'DD-MM-YYYY')).toBe('2026-08-05');
    expect(parseDate('2026-08-05', 'YYYY-MM-DD')).toBe('2026-08-05');
  });

  it('rejects a date that does not exist rather than rolling it forward', () => {
    // Date.parse turns 31/02 into 3 March, which silently moves a transaction
    // into the next month — and, at a period end, into the next period.
    expect(parseDate('31/02/2026', 'DD/MM/YYYY')).toBeNull();
    expect(parseDate('31/04/2026', 'DD/MM/YYYY')).toBeNull();
  });

  it('does not read a US-format date as a Malaysian one', () => {
    // 08/20/2026 is month-first; as DD/MM it claims month 20.
    expect(parseDate('08/20/2026', 'DD/MM/YYYY')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseDate('', 'DD/MM/YYYY')).toBeNull();
    expect(parseDate('not a date', 'DD/MM/YYYY')).toBeNull();
    expect(parseDate('20/08/26', 'DD/MM/YYYY')).toBeNull();
  });
});

describe('parseStatement — signed amount column', () => {
  const csv = [
    'Date,Description,Amount,Balance',
    '20/08/2026,IBG TRANSFER FR NUSANTARA RETAIL SDN BHD,1080.00,11080.00',
    '21/08/2026,DUITNOW QR PYMT,-250.50,10829.50',
    '22/08/2026,"SERVICE CHARGE, MONTHLY",-5.00,10824.50',
  ].join('\n');

  it('parses every row with the right sign', () => {
    const parsed = parseStatement(csv, MAYBANK, MYR);

    expect(parsed.violations).toEqual([]);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]!.amount.toDecimalString()).toBe('1080.0000');
    expect(parsed.rows[1]!.amount.toDecimalString()).toBe('-250.5000');
    expect(parsed.rows[2]!.description).toBe('SERVICE CHARGE, MONTHLY');
  });

  it('derives the opening and closing balances from the running balance', () => {
    const parsed = parseStatement(csv, MAYBANK, MYR);
    // 11,080.00 less the 1,080.00 that produced it.
    expect(parsed.openingBalance?.toDecimalString()).toBe('10000.0000');
    expect(parsed.closingBalance?.toDecimalString()).toBe('10824.5000');
  });

  it('reports a bad row without losing the good ones', () => {
    const withJunk = [
      'Date,Description,Amount,Balance',
      '20/08/2026,GOOD ROW,100.00,100.00',
      '31/02/2026,IMPOSSIBLE DATE,50.00,150.00',
      '22/08/2026,ANOTHER GOOD ROW,25.00,175.00',
    ].join('\n');

    const parsed = parseStatement(withJunk, MAYBANK, MYR);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.violations).toEqual([{ code: 'BAD_DATE', lineNo: 3, value: '31/02/2026' }]);
  });

  it('reads thousands separators, CR/DR markers and parentheses', () => {
    const messy = [
      'Date,Description,Amount,Balance',
      '20/08/2026,BIG CREDIT,"12,500.00",12500.00',
      '21/08/2026,MARKED DEBIT,500.00DR,12000.00',
      '22/08/2026,BRACKETED,(250.00),11750.00',
      '23/08/2026,MARKED CREDIT,250.00CR,12000.00',
    ].join('\n');

    const parsed = parseStatement(messy, MAYBANK, MYR);
    expect(parsed.violations).toEqual([]);
    expect(parsed.rows.map((r) => r.amount.toDecimalString())).toEqual([
      '12500.0000',
      '-500.0000',
      '-250.0000',
      '250.0000',
    ]);
  });

  it('reports an empty file rather than silently importing nothing', () => {
    expect(parseStatement('Date,Description,Amount,Balance', MAYBANK, MYR).violations).toEqual([
      { code: 'EMPTY_FILE' },
    ]);
  });
});

describe('parseStatement — separate debit and credit columns', () => {
  it('takes the sign from the COLUMN, never from the value', () => {
    const csv = [
      'Date,Description,Debit,Credit,Balance',
      '20/08/2026,CUSTOMER PAYMENT,,1080.00,11080.00',
      '21/08/2026,SUPPLIER PAYMENT,600.00,,10480.00',
    ].join('\n');

    const parsed = parseStatement(csv, CIMB, MYR);
    expect(parsed.violations).toEqual([]);
    expect(parsed.rows[0]!.amount.toDecimalString()).toBe('1080.0000');
    expect(parsed.rows[1]!.amount.toDecimalString()).toBe('-600.0000');
  });

  it('refuses a row with BOTH columns populated instead of picking one', () => {
    // Both populated means the column map is wrong or the file is not what it
    // claims. Guessing which to believe is how half a statement imports with
    // the wrong sign.
    const csv = [
      'Date,Description,Debit,Credit,Balance',
      '20/08/2026,AMBIGUOUS,100.00,100.00,0.00',
    ].join('\n');

    const parsed = parseStatement(csv, CIMB, MYR);
    expect(parsed.rows).toEqual([]);
    expect(parsed.violations).toEqual([{ code: 'BOTH_DEBIT_AND_CREDIT', lineNo: 2 }]);
  });

  it('treats an explicit zero in a column as absent', () => {
    const csv = [
      'Date,Description,Debit,Credit,Balance',
      '20/08/2026,PAYMENT,0.00,1080.00,11080.00',
    ].join('\n');
    expect(parseStatement(csv, CIMB, MYR).rows[0]!.amount.toDecimalString()).toBe('1080.0000');
  });

  it('reports a row with no amount at all', () => {
    const csv = ['Date,Description,Debit,Credit,Balance', '20/08/2026,NOTHING,,,0.00'].join('\n');
    expect(parseStatement(csv, CIMB, MYR).violations).toEqual([{ code: 'NO_AMOUNT', lineNo: 2 }]);
  });
});

describe('de-duplication', () => {
  it('gives a re-imported row the same hash and occurrence', () => {
    const csv = [
      'Date,Description,Amount,Balance',
      '20/08/2026,PAYMENT A,100.00,100.00',
      '21/08/2026,PAYMENT B,200.00,300.00',
    ].join('\n');

    const first = parseStatement(csv, MAYBANK, MYR);
    const second = parseStatement(csv, MAYBANK, MYR);

    expect(second.rows.map((r) => [r.dedupeHash, r.occurrence])).toEqual(
      first.rows.map((r) => [r.dedupeHash, r.occurrence]),
    );
  });

  it('distinguishes two genuinely identical transactions on the same day', () => {
    // Two RM 50 ATM withdrawals, same day, same narrative. These are two real
    // events. A naive hash silently drops the second and understates the bank
    // by RM 50, with no error anywhere.
    const csv = [
      'Date,Description,Amount,Balance',
      '20/08/2026,ATM WITHDRAWAL,-50.00,950.00',
      '20/08/2026,ATM WITHDRAWAL,-50.00,900.00',
    ].join('\n');

    const parsed = parseStatement(csv, MAYBANK, MYR);
    expect(parsed.rows).toHaveLength(2);
    // The running balance differs by construction, so the hashes differ.
    expect(parsed.rows[0]!.dedupeHash).not.toBe(parsed.rows[1]!.dedupeHash);
  });

  it('falls back to an occurrence count when the bank gives no running balance', () => {
    const noBalance: ImportProfile = {
      ...MAYBANK,
      columns: { txnDate: 0, description: 1, amount: 2 },
    };
    const csv = [
      'Date,Description,Amount',
      '20/08/2026,ATM WITHDRAWAL,-50.00',
      '20/08/2026,ATM WITHDRAWAL,-50.00',
    ].join('\n');

    const parsed = parseStatement(csv, noBalance, MYR);
    expect(parsed.rows).toHaveLength(2);
    // The hash alone cannot separate them; the occurrence count does.
    expect(parsed.rows[0]!.dedupeHash).toBe(parsed.rows[1]!.dedupeHash);
    expect(parsed.rows.map((r) => r.occurrence)).toEqual([1, 2]);
  });

  it('is insensitive to narrative whitespace and case', () => {
    const base = { txnDate: '2026-08-20', amount: rm('100.00') };
    expect(dedupeHash({ ...base, description: 'PAYMENT  A' })).toBe(
      dedupeHash({ ...base, description: 'payment a' }),
    );
  });

  it('changes when any component changes (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        (a, b) => {
          fc.pre(a !== b);
          const row = (units: bigint) => ({
            txnDate: '2026-08-20',
            description: 'PAYMENT',
            amount: Money.fromUnits(units, MYR),
          });
          expect(dedupeHash(row(a))).not.toBe(dedupeHash(row(b)));
        },
      ),
    );
  });
});

describe('the profile is explicit, and a wrong one fails visibly', () => {
  it('a mismatched column map produces violations rather than plausible nonsense', () => {
    // The whole reason profiles are explicit rather than sniffed: this file is
    // debit/credit, read with a signed-amount profile. It must NOT quietly
    // import with a description in the amount column.
    const csv = [
      'Date,Description,Debit,Credit,Balance',
      '20/08/2026,CUSTOMER PAYMENT,,1080.00,11080.00',
    ].join('\n');

    const parsed = parseStatement(csv, MAYBANK, MYR);
    expect(parsed.rows).toEqual([]);
    expect(parsed.violations.length).toBeGreaterThan(0);
  });

  it('skips a bank’s title block before the header', () => {
    const csv = [
      'MALAYAN BANKING BERHAD',
      'Statement for account 5141-2233-4455',
      '',
      'Date,Description,Amount,Balance',
      '20/08/2026,PAYMENT,100.00,100.00',
    ].join('\n');

    const parsed = parseStatement(csv, { ...MAYBANK, skipRows: 3 }, MYR);
    expect(parsed.violations).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
  });

  it('never throws, whatever the input (property)', () => {
    // Parsing is total by design: a preview screen has to render something for
    // any file a user drags onto it, including a PDF renamed to .csv.
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (content) => {
        expect(() => parseStatement(content, MAYBANK, MYR)).not.toThrow();
      }),
    );
  });
});
