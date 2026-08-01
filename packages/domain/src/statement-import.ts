/**
 * Bank statement import — parsing and de-duplication.
 *
 * Malaysia has no broad open banking, so CSV import is the product, not a
 * fallback. That makes this the code every user meets on their first day, and
 * the code most likely to meet a file nobody anticipated.
 *
 * ---------------------------------------------------------------------------
 * SAVED PROFILES, NOT DIALECT SNIFFING.
 *
 * Guessing a CSV's shape is right most of the time, and the failure mode when
 * it is wrong is silent: a column misread as an amount imports a plausible
 * statement with wrong numbers, and the user finds out at year end. So the
 * profile is explicit per bank, parsing is total, and the caller previews rows
 * before anything is written. A wrong profile then fails visibly, in front of
 * the person who can fix it.
 * ---------------------------------------------------------------------------
 *
 * Pure: no IO, no clock. Parsing returns rows and violations; the caller
 * decides what to persist.
 */

import { Money, type Currency } from './money.js';

/** How a bank writes amounts. Both conventions are common in Malaysia. */
export type AmountConvention =
  /** One signed column: -250.00 is money out. */
  | 'SIGNED'
  /** Separate debit and credit columns, both positive. */
  | 'DEBIT_CREDIT';

export interface ImportProfile {
  readonly id?: string;
  readonly bankName: string;
  readonly delimiter: string;
  /** Rows to skip before the header — banks pad statements with title blocks. */
  readonly skipRows?: number;
  readonly hasHeader?: boolean;
  /** `DD/MM/YYYY` is the Malaysian convention. Also accepts `YYYY-MM-DD`, `DD-MM-YYYY`. */
  readonly dateFormat: 'DD/MM/YYYY' | 'DD-MM-YYYY' | 'YYYY-MM-DD';
  readonly amountConvention: AmountConvention;
  /** Zero-based column indexes. */
  readonly columns: {
    readonly txnDate: number;
    readonly description: number;
    readonly amount?: number;
    readonly debit?: number;
    readonly credit?: number;
    readonly valueDate?: number;
    readonly reference?: number;
    readonly runningBalance?: number;
  };
}

export interface ParsedStatementRow {
  readonly lineNo: number;
  readonly txnDate: string;
  readonly valueDate?: string;
  readonly description: string;
  readonly reference?: string;
  /** Signed: positive money in, negative money out. */
  readonly amount: Money;
  readonly runningBalance?: Money;
  readonly dedupeHash: string;
  /**
   * Which occurrence of an otherwise identical row this is, within the file.
   * See `dedupeHash` below for why this exists.
   */
  readonly occurrence: number;
}

export type ImportViolation =
  | { readonly code: 'EMPTY_FILE' }
  | { readonly code: 'MISSING_COLUMN'; readonly lineNo: number; readonly column: string }
  | { readonly code: 'BAD_DATE'; readonly lineNo: number; readonly value: string }
  | { readonly code: 'BAD_AMOUNT'; readonly lineNo: number; readonly value: string }
  | { readonly code: 'BOTH_DEBIT_AND_CREDIT'; readonly lineNo: number }
  | { readonly code: 'NO_AMOUNT'; readonly lineNo: number };

export interface ParsedStatement {
  readonly rows: readonly ParsedStatementRow[];
  /**
   * Rows that could not be parsed. Reported rather than thrown: one malformed
   * line in a 400-line statement should not cost the user the other 399, and
   * a preview that shows exactly which lines failed is more useful than an
   * exception naming the first one.
   */
  readonly violations: readonly ImportViolation[];
  readonly openingBalance?: Money;
  readonly closingBalance?: Money;
}

/**
 * Parse a statement against an explicit profile.
 *
 * Never throws on bad data. A caller previews `rows` and `violations` together
 * and decides whether the profile is right before importing anything.
 */
export function parseStatement(
  content: string,
  profile: ImportProfile,
  currency: Currency,
): ParsedStatement {
  const lines = content.split(/\r?\n/);
  const skip = profile.skipRows ?? 0;
  const headerRows = profile.hasHeader === false ? 0 : 1;

  const body = lines.slice(skip + headerRows).filter((l) => l.trim().length > 0);
  if (body.length === 0) {
    return { rows: [], violations: [{ code: 'EMPTY_FILE' }] };
  }

  const rows: ParsedStatementRow[] = [];
  const violations: ImportViolation[] = [];
  const seen = new Map<string, number>();

  for (const [index, line] of body.entries()) {
    const lineNo = skip + headerRows + index + 1;
    const fields = splitCsvLine(line, profile.delimiter);

    const parsed = parseRow(fields, lineNo, profile, currency, violations);
    if (parsed === null) continue;

    // Occurrence disambiguates rows that are genuinely identical: two RM 50
    // ATM withdrawals on the same day with the same narrative are two real
    // transactions, not a duplicated import. See `dedupeHash`.
    const occurrence = (seen.get(parsed.dedupeHash) ?? 0) + 1;
    seen.set(parsed.dedupeHash, occurrence);

    rows.push({ ...parsed, occurrence });
  }

  const balances = rows.map((r) => r.runningBalance).filter((b): b is Money => b !== undefined);
  const first = rows[0];
  const last = rows[rows.length - 1];

  return {
    rows,
    violations,
    // The opening balance is the first row's running balance BEFORE that row,
    // which is why the row's own amount comes back off it.
    ...(balances.length === rows.length && first?.runningBalance
      ? { openingBalance: first.runningBalance.subtract(first.amount) }
      : {}),
    ...(last?.runningBalance ? { closingBalance: last.runningBalance } : {}),
  };
}

function parseRow(
  fields: readonly string[],
  lineNo: number,
  profile: ImportProfile,
  currency: Currency,
  violations: ImportViolation[],
): Omit<ParsedStatementRow, 'occurrence'> | null {
  const at = (index: number | undefined): string | undefined =>
    index === undefined ? undefined : fields[index]?.trim();

  const rawDate = at(profile.columns.txnDate);
  if (rawDate === undefined || rawDate.length === 0) {
    violations.push({ code: 'MISSING_COLUMN', lineNo, column: 'txnDate' });
    return null;
  }

  const txnDate = parseDate(rawDate, profile.dateFormat);
  if (txnDate === null) {
    violations.push({ code: 'BAD_DATE', lineNo, value: rawDate });
    return null;
  }

  const rawValueDate = at(profile.columns.valueDate);
  const valueDate = rawValueDate ? parseDate(rawValueDate, profile.dateFormat) : null;

  const description = at(profile.columns.description) ?? '';

  const amount = parseAmount(fields, lineNo, profile, currency, violations);
  if (amount === null) return null;

  const rawBalance = at(profile.columns.runningBalance);
  let runningBalance: Money | undefined;
  if (rawBalance !== undefined && rawBalance.length > 0) {
    const parsed = toMoney(rawBalance, currency);
    if (parsed === null) {
      violations.push({ code: 'BAD_AMOUNT', lineNo, value: rawBalance });
      return null;
    }
    runningBalance = parsed;
  }

  const reference = at(profile.columns.reference);

  return {
    lineNo,
    txnDate,
    ...(valueDate !== null ? { valueDate } : {}),
    description,
    ...(reference !== undefined && reference.length > 0 ? { reference } : {}),
    amount,
    ...(runningBalance !== undefined ? { runningBalance } : {}),
    dedupeHash: dedupeHash({
      txnDate,
      description,
      amount,
      ...(runningBalance !== undefined ? { runningBalance } : {}),
    }),
  };
}

function parseAmount(
  fields: readonly string[],
  lineNo: number,
  profile: ImportProfile,
  currency: Currency,
  violations: ImportViolation[],
): Money | null {
  const at = (index: number | undefined): string =>
    index === undefined ? '' : (fields[index]?.trim() ?? '');

  if (profile.amountConvention === 'SIGNED') {
    const raw = at(profile.columns.amount);
    if (raw.length === 0) {
      violations.push({ code: 'NO_AMOUNT', lineNo });
      return null;
    }
    const amount = toMoney(raw, currency);
    if (amount === null) {
      violations.push({ code: 'BAD_AMOUNT', lineNo, value: raw });
      return null;
    }
    return amount;
  }

  const rawDebit = at(profile.columns.debit);
  const rawCredit = at(profile.columns.credit);
  const hasDebit = rawDebit.length > 0 && rawDebit !== '0' && rawDebit !== '0.00';
  const hasCredit = rawCredit.length > 0 && rawCredit !== '0' && rawCredit !== '0.00';

  if (hasDebit && hasCredit) {
    // Both columns populated means the profile's column map is wrong, or the
    // file is not what it claims. Either way, guessing which one to believe is
    // how a statement imports with the wrong sign on half its rows.
    violations.push({ code: 'BOTH_DEBIT_AND_CREDIT', lineNo });
    return null;
  }

  if (!hasDebit && !hasCredit) {
    violations.push({ code: 'NO_AMOUNT', lineNo });
    return null;
  }

  const raw = hasDebit ? rawDebit : rawCredit;
  const parsed = toMoney(raw, currency);
  if (parsed === null) {
    violations.push({ code: 'BAD_AMOUNT', lineNo, value: raw });
    return null;
  }

  // A debit column is money OUT. Both columns carry positive figures, so the
  // sign comes from which column it was in, never from the value.
  return hasDebit ? parsed.abs().negate() : parsed.abs();
}

/**
 * The de-duplication key for a statement row.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RUNNING BALANCE IS PART OF IT, AND WHY AN OCCURRENCE COUNT IS TOO.
 *
 * Re-importing an overlapping statement has to be safe — users do it
 * constantly, because they download this month and last month and forget which
 * rows they already had. Hashing date + amount + description gets most of the
 * way there.
 *
 * It breaks on genuinely identical transactions: two RM 50 ATM withdrawals on
 * the same day with the same narrative are two real events, and a naive hash
 * silently drops the second — understating the bank by RM 50 with no error
 * anywhere. The running balance separates them, because it differs by
 * construction, which is why it is in the hash when the bank provides it.
 *
 * When the bank does NOT provide a running balance, the occurrence count is
 * the fallback: the second identical row in the file is a distinct row. Its
 * limitation is honest and worth stating — a re-imported file that begins
 * PART-WAY through a run of identical rows will renumber them and re-import
 * one. Rare, and visible in the preview, unlike the silent loss it replaces.
 * ---------------------------------------------------------------------------
 *
 * A plain deterministic string rather than a cryptographic digest: this is a
 * collision key inside one bank account, not a security boundary, and a
 * readable key is one you can debug from a database row.
 */
export function dedupeHash(row: {
  txnDate: string;
  description: string;
  amount: Money;
  runningBalance?: Money;
}): string {
  return [
    row.txnDate,
    row.amount.toDecimalString(),
    row.description.toUpperCase().replace(/\s+/g, ' ').trim(),
    row.runningBalance?.toDecimalString() ?? '',
  ].join('|');
}

// ------------------------------------------------------------------ internals

/**
 * Split one CSV line, honouring double-quoted fields.
 *
 * Bank narratives contain commas — `IBG TRANSFER FR ALPHA TRADING, KL` — so a
 * plain `split(',')` shifts every subsequent column and reads a description
 * fragment as an amount. Written out rather than pulled from a library because
 * it is fifteen lines and the dependency would be doing exactly this.
 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields;
}

/** `DD/MM/YYYY` and friends to ISO. Returns null rather than guessing. */
export function parseDate(value: string, format: ImportProfile['dateFormat']): string | null {
  const trimmed = value.trim();

  if (format === 'YYYY-MM-DD') {
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && isRealDate(trimmed) ? trimmed : null;
  }

  const separator = format === 'DD/MM/YYYY' ? '/' : '-';
  const parts = trimmed.split(separator);
  if (parts.length !== 3) return null;

  const [day, month, year] = parts;
  if (!/^\d{1,2}$/.test(day!) || !/^\d{1,2}$/.test(month!) || !/^\d{4}$/.test(year!)) {
    return null;
  }

  const iso = `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
  return isRealDate(iso) ? iso : null;
}

/**
 * Rejects 31/02/2026 — which `Date.parse` happily rolls forward to 3 March,
 * silently moving a transaction into the next month and the next period.
 */
function isRealDate(iso: string): boolean {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

/**
 * A bank's amount text to `Money`.
 *
 * Handles thousands separators, a trailing `CR`/`DR` marker, and parentheses
 * for negatives — all of which appear in Malaysian bank exports.
 */
function toMoney(value: string, currency: Currency): Money | null {
  let text = value.trim().toUpperCase().replace(/,/g, '').replace(/\s+/g, '');
  if (text.length === 0) return null;

  let negative = false;

  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  }

  if (text.endsWith('CR')) {
    text = text.slice(0, -2);
  } else if (text.endsWith('DR')) {
    negative = true;
    text = text.slice(0, -2);
  }

  text = text.replace(/^(RM|MYR)/, '');

  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }

  if (!/^\d+(\.\d+)?$/.test(text)) return null;

  try {
    const amount = Money.fromDecimal(text, currency);
    return negative ? amount.negate() : amount;
  } catch {
    return null;
  }
}
