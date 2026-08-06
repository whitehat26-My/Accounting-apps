import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toCsv } from '@emil/domain';
import {
  archiveJournal,
  archiveLedger,
  proofPack,
  statementOfFinancialPosition,
  statementOfProfitOrLoss,
  trialBalanceCsv,
  trialBalanceReport,
  type TenantContext,
  type Tx,
} from '@emil/db';
import { buildZip, type ZipEntry } from './zip.js';
import { renderFinancialStatementsPdf } from '../pdf/render.js';

/**
 * The hundred-year archive: one file per financial year that needs nothing
 * but eyes to read and one small script to verify.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND WHY IT IS SHAPED THIS WAY.
 *
 * Accounting records in Malaysia must be kept for seven years. Software does
 * not last seven years reliably, and a business outlives several of them: the
 * SQL dump nobody can restore, the SaaS account that lapsed, the laptop that
 * died. Every format here is chosen so that a person in 2076 with no access
 * to this system — an auditor, an heir, a court — can still read the books:
 *
 *   README.txt                what each file is, and how to check the proof
 *   journal.csv               every posted entry, both sides, with the poster
 *   general-ledger.csv        the same movements arranged by account
 *   trial-balance.csv         the year's closing position
 *   financial-statements.pdf  P&L and balance sheet, laid out to be read
 *   proof-pack.json           the audit-chain anchors for the period
 *   verify-proof-pack.mjs     the verifier, TRAVELLING INSIDE THE ARCHIVE
 *
 * The verifier is copied in rather than linked. A proof that depends on
 * fetching a script from a domain nobody renewed is not a proof, and the
 * script is a hundred lines of dependency-free Node.
 * ---------------------------------------------------------------------------
 */

export interface ArchiveYear {
  readonly id: string;
  readonly label: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
}

const VERIFIER = fileURLToPath(new URL('../../../../scripts/verify-proof-pack.mjs', import.meta.url));

export async function buildArchive(
  tx: Tx,
  ctx: TenantContext,
  year: ArchiveYear,
  organisationName: string,
  when: Date,
): Promise<Buffer> {
  const window = { from: year.startDate, to: year.endDate };

  const [entries, ledger, trial, sopl, sofp, proof] = await Promise.all([
    archiveJournal(tx, ctx, window),
    archiveLedger(tx, ctx, window),
    trialBalanceReport(tx, ctx, window),
    statementOfProfitOrLoss(tx, ctx, { from: window.from, to: window.to }),
    statementOfFinancialPosition(tx, ctx, { asOfDate: window.to }),
    proofPack(tx, ctx, { from: window.from, to: window.to }),
  ]);

  const journalCsv = toCsv([
    ['Entry', 'Dated', 'Posted at', 'Posted by', 'Source', 'Description',
     'Account', 'Account name', 'Line description', 'Debit', 'Credit', 'Reverses'],
    ...entries.flatMap((entry) =>
      entry.lines.map((line) => [
        entry.entryNo,
        display(entry.entryDate),
        entry.postedAt,
        entry.postedByName ?? '',
        entry.sourceDocumentType ?? entry.sourceModule,
        entry.description ?? '',
        line.accountCode,
        line.accountName,
        line.description ?? '',
        line.debit,
        line.credit,
        entry.reversalOfId ?? '',
      ]),
    ),
  ]);

  const ledgerCsv = toCsv([
    ['Account', 'Account name', 'Type', 'Entry', 'Dated', 'Description', 'Debit', 'Credit'],
    ...ledger.map((r) => [
      r.code, r.name, r.type, r.entryNo, display(r.entryDate), r.description ?? '',
      r.debit, r.credit,
    ]),
  ]);

  const statements = await renderFinancialStatementsPdf({
    organisationName,
    label: year.label,
    from: window.from,
    to: window.to,
    profitOrLoss: sopl,
    financialPosition: sofp,
  });

  const files: ZipEntry[] = [
    { name: 'README.txt', data: Buffer.from(readme(organisationName, year, entries.length, when), 'utf8') },
    { name: 'journal.csv', data: Buffer.from(journalCsv, 'utf8') },
    { name: 'general-ledger.csv', data: Buffer.from(ledgerCsv, 'utf8') },
    { name: 'trial-balance.csv', data: Buffer.from(trialBalanceCsv(trial, window), 'utf8') },
    { name: 'financial-statements.pdf', data: statements },
    { name: 'proof-pack.json', data: Buffer.from(JSON.stringify(proof, null, 2), 'utf8') },
    { name: 'verify-proof-pack.mjs', data: readFileSync(VERIFIER) },
  ];

  return buildZip(files, when);
}

function display(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function readme(
  organisationName: string,
  year: ArchiveYear,
  entryCount: number,
  when: Date,
): string {
  return `THE BOOKS OF ${organisationName.toUpperCase()}
Financial year ${year.label}: ${display(year.startDate)} to ${display(year.endDate)}
Status at the time this archive was made: ${year.status}
Archive created ${when.toISOString().slice(0, 10)}

This archive is meant to be readable without the software that produced it.
If you are holding it because that software is gone, everything you need is
here, and nothing in it requires an internet connection.

WHAT IS IN THIS FILE
--------------------
journal.csv               Every journal entry posted in this year, one row per
                          line of each entry, with both sides, the date it was
                          dated, the moment it was actually posted, and who
                          posted it. This is the primary record; everything
                          else in this archive can be rebuilt from it.

general-ledger.csv        The same movements, arranged by account instead of
                          by entry.

trial-balance.csv         Every account's closing position for the year.
                          Total debits must equal total credits.

financial-statements.pdf  Profit or loss for the year, and the statement of
                          financial position at its end.

proof-pack.json           Cryptographic anchors taken on the audit trail
                          during this period. See below.

verify-proof-pack.mjs     The program that checks proof-pack.json. It is
                          copied in here on purpose — a proof that depends on
                          downloading its own checker is not a proof.

FORMATS, AND WHY
----------------
The CSV files are stored UNCOMPRESSED inside this archive, so the text is
readable directly from the raw bytes even if the container is damaged and
only part of it can be recovered.

They begin with three bytes (EF BB BF), a UTF-8 byte-order mark. That is not
corruption; it is what makes spreadsheet software read non-English characters
correctly. Any text editor will show the file normally.

Amounts are plain decimal numbers with four decimal places, in Malaysian
Ringgit (MYR), with no thousands separators and no currency symbol. Dates in
the CSV columns marked "Dated" are DD/MM/YYYY. The "Posted at" column is a
full timestamp in UTC, ISO 8601.

HOW TO CHECK NOTHING WAS ALTERED
--------------------------------
The books these files came from are append-only: an entry, once posted, is
never edited or deleted, and a correction is a new entry that points back at
the one it reverses. The audit trail is hash-chained, and proof-pack.json
holds anchor points on that chain.

With Node.js installed:

    node verify-proof-pack.mjs proof-pack.json

If you have TWO archives from different years of the same business, checking
them together is stronger — every anchor they share must be identical:

    node verify-proof-pack.mjs proof-pack.json ../fy2027/proof-pack.json

WHAT THIS ARCHIVE DOES NOT CONTAIN
----------------------------------
The general ledger and the statements built from it — not the underlying
documents. Individual invoice PDFs, receipts, photographs attached to repair
jobs, and customer records are not here. If those matter for your purpose,
they must be exported separately.

This archive holds ${entryCount} journal ${entryCount === 1 ? 'entry' : 'entries'}.
`;
}
