import {
  benford,
  duplicatePayments,
  oddTimings,
  roundNumberShare,
  thresholdHugging,
  type Finding,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { businessToday } from './internal.js';

/**
 * The second pair of eyes, fed from the books.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY, AND IT NEVER TOUCHES A DOCUMENT.
 *
 * Nothing here blocks a payment, flags a record, or writes a status. It looks
 * at what has already happened and produces sentences. That is deliberate: an
 * automated control that stops work will be worked around within a fortnight,
 * and then the shop has both the original risk AND a habit of bypassing
 * controls. What this can do is make a person look — and a person looking is
 * the actual control.
 *
 * Every finding carries its innocent explanation from the domain module, and
 * the screen shows both. See `packages/domain/src/fraud-watch.ts`.
 * ---------------------------------------------------------------------------
 */

export interface WatchReport {
  readonly asOf: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly findings: readonly Finding[];
  /** Shown even when empty, so "we looked" is visible and not inferred. */
  readonly checksRun: readonly string[];
  readonly duplicates: readonly {
    readonly party: string;
    readonly amount: string;
    readonly documents: readonly string[];
    readonly daysApart: number;
  }[];
}

export async function fraudWatch(
  tx: Tx,
  ctx: TenantContext,
  window: { from: string; to: string },
): Promise<WatchReport> {
  const findings: Finding[] = [];

  // ---- Sales amounts, for shape tests -------------------------------------
  const invoices = await tx<{ total: string }[]>`
      SELECT total::text FROM invoice
       WHERE tenant_id = ${ctx.tenantId}
         AND status NOT IN ('DRAFT', 'VOIDED')
         AND issue_date BETWEEN ${window.from} AND ${window.to}
  `;
  const saleAmounts = invoices.map((r) => r.total);

  const digits = benford(saleAmounts);
  if (digits.finding) findings.push(digits.finding);

  const round = roundNumberShare(saleAmounts);
  if (round.finding) findings.push(round.finding);

  // ---- Supplier payments, for duplicates ----------------------------------
  const bills = await tx<
    { party: string; amount: string; document: string; bill_date: Date }[]
  >`
      SELECT c.name AS party, b.total::text AS amount, b.bill_no AS document, b.bill_date
        FROM bill b
        JOIN contact c ON c.tenant_id = b.tenant_id AND c.id = b.supplier_id
       WHERE b.tenant_id = ${ctx.tenantId}
         AND b.status NOT IN ('DRAFT', 'VOIDED')
         AND b.bill_date BETWEEN ${window.from} AND ${window.to}
  `;
  const duplicates = duplicatePayments(
    bills.map((b) => ({
      party: b.party,
      amount: b.amount,
      document: b.document,
      date: b.bill_date.toISOString().slice(0, 10),
    })),
  );
  if (duplicates.finding) findings.push(duplicates.finding);

  // ---- Approval-limit hugging ---------------------------------------------
  const [rule] = await tx<{ min_amount: string }[]>`
      SELECT min_amount::text FROM approval_rule
       WHERE tenant_id = ${ctx.tenantId} AND is_active
       ORDER BY min_amount
       LIMIT 1
  `;
  if (rule) {
    const hugging = thresholdHugging(bills.map((b) => b.amount), rule.min_amount);
    if (hugging.finding) findings.push(hugging.finding);
  }

  // ---- When journals were actually posted ---------------------------------
  /*
   * `occurred_at` is when the row was WRITTEN; `entry_date` is the accounting
   * date the person chose. The gap between them is the backdating, and the
   * hour is taken in Asia/Kuala_Lumpur because 3am matters only in the shop's
   * own night (rule 8).
   */
  const entries = await tx<
    { reference: string; entry_date: Date; hour_kl: number; backdated_days: number }[]
  >`
      SELECT e.entry_no AS reference,
             e.entry_date,
             EXTRACT(HOUR FROM e.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::int AS hour_kl,
             GREATEST(0, (e.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date - e.entry_date)::int
                                                                     AS backdated_days
        FROM journal_entry e
       WHERE e.tenant_id = ${ctx.tenantId}
         AND e.entry_date BETWEEN ${window.from} AND ${window.to}
  `;
  const timings = oddTimings(
    entries.map((e) => ({
      reference: e.reference,
      entryDate: e.entry_date.toISOString().slice(0, 10),
      postedAtHourKl: e.hour_kl,
      backdatedDays: e.backdated_days,
    })),
  );
  if (timings.finding) findings.push(timings.finding);

  /*
   * NOT CHECKED: supplier bank details changed shortly before a payment —
   * the shape of invoice-redirection fraud, and the check this module most
   * wants to run.
   *
   * It cannot be built: `contact` does not store bank details at all, so
   * there is nothing for the audit log to have recorded a change to. Writing
   * the query anyway would return zero rows forever and read as "checked,
   * nothing found" — a silent no-op is worse than an absent check, because
   * it is indistinguishable from a clean result.
   *
   * Recorded in the settlement register with its unblocker: decide whether
   * supplier bank details are stored at all (the same argument migration 0041
   * settled for employees by keeping only the last four digits), then this
   * check is a dozen lines against `audit_log`.
   */

  return {
    asOf: businessToday(),
    window,
    findings,
    checksRun: [
      'First-digit distribution of sales (Benford)',
      'Round-number clustering',
      'Duplicate supplier payments',
      'Bills just under the approval limit',
      'Journals posted late at night or heavily backdated',
    ],
    duplicates: duplicates.duplicates,
  };
}
