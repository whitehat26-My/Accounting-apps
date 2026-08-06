import type { TenantContext, Tx } from './client.js';

/**
 * The full year, unpaged, for the hundred-year archive.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `journalReport`.
 *
 * That function caps at 2,000 entries and reports `truncated: true`, which is
 * right for a screen: nobody scrolls 40,000 rows, and the flag tells them the
 * list is partial. An ARCHIVE cannot do that. A file that silently holds the
 * first 2,000 entries of a year, handed to somebody in 2076 as "the year",
 * is worse than no file — it looks complete. So this reads every posted
 * entry in the window, and the caller holds the lot in memory: a shop's year
 * is thousands of rows, which is a few megabytes of strings.
 * ---------------------------------------------------------------------------
 */

export interface ArchiveLine {
  readonly accountCode: string;
  readonly accountName: string;
  readonly description: string | null;
  readonly debit: string;
  readonly credit: string;
}

export interface ArchiveEntry {
  readonly entryNo: string;
  readonly entryDate: string;
  readonly postedAt: string;
  readonly description: string | null;
  readonly sourceModule: string;
  readonly sourceDocumentType: string | null;
  readonly reversalOfId: string | null;
  readonly postedByName: string | null;
  readonly lines: readonly ArchiveLine[];
}

export async function archiveJournal(
  tx: Tx,
  ctx: TenantContext,
  window: { readonly from: string; readonly to: string },
): Promise<ArchiveEntry[]> {
  const rows = await tx<
    {
      entry_id: string;
      entry_no: string;
      entry_date: Date;
      posted_at: Date;
      description: string | null;
      source_module: string;
      source_document_type: string | null;
      reversal_of_id: string | null;
      posted_by_name: string | null;
      account_code: string;
      account_name: string;
      line_description: string | null;
      debit: string;
      credit: string;
    }[]
  >`
      SELECT e.id AS entry_id, e.entry_no, e.entry_date, e.posted_at, e.description,
             e.source_module, e.source_document_type, e.reversal_of_id,
             act.full_name AS posted_by_name,
             a.code AS account_code, a.name AS account_name,
             l.description AS line_description,
             l.base_debit::text AS debit, l.base_credit::text AS credit
        FROM journal_entry e
        JOIN journal_line l ON l.tenant_id = e.tenant_id AND l.journal_entry_id = e.id
        JOIN account a      ON a.tenant_id = e.tenant_id AND a.id = l.account_id
        LEFT JOIN LATERAL audit_actor(e.posted_by) act ON TRUE
       WHERE e.tenant_id = ${ctx.tenantId}
         AND e.posted_at IS NOT NULL
         AND e.entry_date >= ${window.from}
         AND e.entry_date <= ${window.to}
       ORDER BY e.entry_date, e.entry_no, l.line_no
  `;

  const byEntry = new Map<string, ArchiveEntry & { lines: ArchiveLine[] }>();
  for (const r of rows) {
    let entry = byEntry.get(r.entry_id);
    if (!entry) {
      entry = {
        entryNo: r.entry_no,
        entryDate: r.entry_date.toISOString().slice(0, 10),
        postedAt: r.posted_at.toISOString(),
        description: r.description,
        sourceModule: r.source_module,
        sourceDocumentType: r.source_document_type,
        reversalOfId: r.reversal_of_id,
        postedByName: r.posted_by_name,
        lines: [],
      };
      byEntry.set(r.entry_id, entry);
    }
    entry.lines.push({
      accountCode: r.account_code,
      accountName: r.account_name,
      description: r.line_description,
      debit: r.debit,
      credit: r.credit,
    });
  }

  return [...byEntry.values()];
}

/** Every account's movement in the window — the general ledger, one file. */
export interface ArchiveLedgerRow {
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly entryNo: string;
  readonly entryDate: string;
  readonly description: string | null;
  readonly debit: string;
  readonly credit: string;
}

export async function archiveLedger(
  tx: Tx,
  ctx: TenantContext,
  window: { readonly from: string; readonly to: string },
): Promise<ArchiveLedgerRow[]> {
  const rows = await tx<
    {
      code: string;
      name: string;
      type: string;
      entry_no: string;
      entry_date: Date;
      description: string | null;
      debit: string;
      credit: string;
    }[]
  >`
      SELECT a.code, a.name, a.type, e.entry_no, e.entry_date,
             COALESCE(l.description, e.description) AS description,
             l.base_debit::text AS debit, l.base_credit::text AS credit
        FROM journal_line l
        JOIN journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
        JOIN account a       ON a.tenant_id = l.tenant_id AND a.id = l.account_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND e.posted_at IS NOT NULL
         AND e.entry_date >= ${window.from}
         AND e.entry_date <= ${window.to}
       ORDER BY a.code, e.entry_date, e.entry_no
  `;

  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    type: r.type,
    entryNo: r.entry_no,
    entryDate: r.entry_date.toISOString().slice(0, 10),
    description: r.description,
    debit: r.debit,
    credit: r.credit,
  }));
}
