/**
 * TaxReturnService — preparing, filing and amending the SST return.
 *
 * The arithmetic lives in `packages/domain/src/tax-return.ts` and is pure. This
 * module reads the `tax_transaction` rows that every document already writes,
 * hands them to it, and persists the answer.
 */

import {
  checkTaxReturn,
  computeTaxReturn,
  Money,
  taxablePeriods,
  type TaxRegime,
  type TaxReturnFigures,
  type TaxTransactionRecord,
  type TaxablePeriod,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';
import { loadBaseCurrency } from './invoice.js';

export class TaxReturnError extends Error {
  constructor(
    readonly code:
      | 'RETURN_NOT_FOUND'
      | 'NOT_REGISTERED'
      | 'ALREADY_SUBMITTED'
      | 'NOT_SUBMITTED'
      | 'PERIOD_ALREADY_FILED'
      | 'RETURN_INCONSISTENT'
      | 'CITATION_REQUIRED',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'TaxReturnError';
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface SstRegistration {
  readonly id: string;
  readonly regime: TaxRegime;
  readonly registrationNo: string;
  readonly cadenceMonths: number;
  readonly firstPeriodStart: string;
  readonly sourceReference: string;
  readonly isActive: boolean;
}

export interface SetSstRegistrationInput {
  readonly regime: 'SST_SALES' | 'SST_SERVICE';
  readonly registrationNo: string;
  readonly cadenceMonths: number;
  readonly firstPeriodStart: string;
  /** Where the cycle was confirmed. Required — see migration 0019. */
  readonly sourceReference: string;
}

export async function setSstRegistration(
  tx: Tx,
  ctx: TenantContext,
  input: SetSstRegistrationInput,
): Promise<SstRegistration> {
  if (input.sourceReference.trim().length < 8) {
    throw new TaxReturnError(
      'CITATION_REQUIRED',
      'A registration must record where its taxable period cycle was confirmed — for ' +
        'example "RMCD registration letter dated 2026-01-15, ref SST-W10-2026-0042". ' +
        'A cadence nobody can trace produces returns filed for the wrong periods, and ' +
        'a period never filed is what draws an assessment.',
    );
  }

  await tx`
      INSERT INTO sst_registration (
          tenant_id, regime, registration_no, cadence_months,
          first_period_start, source_reference, verified_by
      ) VALUES (
          ${ctx.tenantId}, ${input.regime}, ${input.registrationNo},
          ${input.cadenceMonths}, ${input.firstPeriodStart},
          ${input.sourceReference.trim()}, ${ctx.userId ?? null}
      )
      ON CONFLICT (tenant_id, regime) DO UPDATE
         SET registration_no    = EXCLUDED.registration_no,
             cadence_months     = EXCLUDED.cadence_months,
             first_period_start = EXCLUDED.first_period_start,
             source_reference   = EXCLUDED.source_reference,
             verified_by        = EXCLUDED.verified_by,
             verified_at        = now()
  `;

  const [registration] = await sstRegistrations(tx, ctx).then((all) =>
    all.filter((r) => r.regime === input.regime),
  );
  return registration!;
}

export async function sstRegistrations(
  tx: Tx,
  ctx: TenantContext,
): Promise<SstRegistration[]> {
  const rows = await tx<
    {
      id: string;
      regime: string;
      registration_no: string;
      cadence_months: number;
      first_period_start: Date;
      source_reference: string;
      is_active: boolean;
    }[]
  >`
      SELECT id, regime, registration_no, cadence_months, first_period_start,
             source_reference, is_active
        FROM sst_registration
       WHERE tenant_id = ${ctx.tenantId}
       ORDER BY regime
  `;

  return rows.map((row) => ({
    id: row.id,
    regime: row.regime as TaxRegime,
    registrationNo: row.registration_no,
    cadenceMonths: row.cadence_months,
    firstPeriodStart: toIsoDate(row.first_period_start),
    sourceReference: row.source_reference,
    isActive: row.is_active,
  }));
}

// ---------------------------------------------------------------------------
// Preparing
// ---------------------------------------------------------------------------

export interface TaxReturnView extends TaxReturnFigures {
  readonly id: string;
  readonly status: 'DRAFT' | 'SUBMITTED' | 'SUPERSEDED';
  readonly supersedesId: string | null;
  readonly submittedAt: string | null;
  readonly submittedBy: string | null;
}

export interface PrepareTaxReturnInput {
  readonly regime: 'SST_SALES' | 'SST_SERVICE';
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly idempotencyKey: string;
}

/**
 * Compute a return for a period and store it as a draft.
 *
 * Recomputed from `tax_transaction` every time it is prepared, never
 * accumulated as documents are issued. A running total would drift the moment
 * anything was corrected, and the drift would be invisible: the figure would
 * still look like a plausible return.
 */
export async function prepareTaxReturn(
  tx: Tx,
  ctx: TenantContext,
  input: PrepareTaxReturnInput,
): Promise<TaxReturnView> {
  const existing = await tx<{ id: string }[]>`
      SELECT id FROM tax_return
       WHERE tenant_id = ${ctx.tenantId} AND idempotency_key = ${input.idempotencyKey}
  `;
  if (existing.length > 0) return getTaxReturn(tx, ctx, existing[0]!.id);

  const [registration] = await sstRegistrations(tx, ctx).then((all) =>
    all.filter((r) => r.regime === input.regime && r.isActive),
  );
  if (!registration) {
    throw new TaxReturnError(
      'NOT_REGISTERED',
      `This organisation has no active ${input.regime} registration. Sales tax and ` +
        'service tax are separate regimes with separate registration; a return cannot ' +
        'be prepared for one the business is not registered under.',
    );
  }

  const [filed] = await tx<{ id: string; status: string }[]>`
      SELECT id, status FROM tax_return
       WHERE tenant_id = ${ctx.tenantId} AND regime = ${input.regime}
         AND period_start = ${input.periodStart} AND period_end = ${input.periodEnd}
         AND status <> 'SUPERSEDED'
  `;
  if (filed) {
    throw new TaxReturnError(
      'PERIOD_ALREADY_FILED',
      `A ${filed.status.toLowerCase()} return already covers this period. ` +
        (filed.status === 'SUBMITTED'
          ? 'File an amendment rather than preparing a second one.'
          : 'Delete the draft or amend it.'),
      { existingId: filed.id, status: filed.status },
    );
  }

  const currency = await loadBaseCurrency(tx, ctx);
  const transactions = await taxTransactionsIn(tx, ctx, input.periodStart, input.periodEnd, currency);
  const figures = computeTaxReturn(
    input.regime,
    input.periodStart,
    input.periodEnd,
    transactions,
    currency,
  );

  /*
   * Checked before it is stored, not after.
   *
   * The consistency rules are arithmetic that must hold whatever the inputs, so
   * a failure is a bug in the computation rather than a data problem — and a
   * return that does not add up must never reach a state where it can be filed.
   * A negative net is reported as a warning rather than a violation: it is
   * legitimate after a large cancellation.
   */
  const check = checkTaxReturn(figures);
  const structural = check.violations.filter((v) => !v.startsWith('netTaxPayable is negative'));
  if (structural.length > 0) {
    throw new TaxReturnError('RETURN_INCONSISTENT', 'The computed return does not add up', {
      violations: structural,
    });
  }

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO tax_return (
          tenant_id, regime, period_start, period_end, currency,
          taxable_supplies, output_tax_charged, output_tax_adjustments,
          net_tax_payable, input_tax_absorbed, exempt_supplies, document_count,
          idempotency_key
      ) VALUES (
          ${ctx.tenantId}, ${input.regime}, ${input.periodStart}, ${input.periodEnd},
          ${currency},
          ${figures.taxableSupplies.toDecimalString()},
          ${figures.outputTaxCharged.toDecimalString()},
          ${figures.outputTaxAdjustments.toDecimalString()},
          ${figures.netTaxPayable.toDecimalString()},
          ${figures.inputTaxAbsorbed.toDecimalString()},
          ${figures.exemptSupplies.toDecimalString()},
          ${figures.documentCount},
          ${input.idempotencyKey}
      )
      RETURNING id
  `;

  return getTaxReturn(tx, ctx, row!.id);
}

/**
 * File it.
 *
 * From here the row is immutable — enforced by trigger, not convention. A
 * return is a statement made to a tax authority on a date, and what was said
 * then does not change because the underlying data moved afterwards.
 */
export async function submitTaxReturn(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<TaxReturnView> {
  const current = await getTaxReturn(tx, ctx, id);

  if (current.status !== 'DRAFT') {
    throw new TaxReturnError(
      'ALREADY_SUBMITTED',
      `This return is ${current.status}. Only a draft can be filed.`,
    );
  }

  await tx`
      UPDATE tax_return
         SET status = 'SUBMITTED', submitted_at = now(), submitted_by = ${ctx.userId ?? null}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
  `;

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'TAX_RETURN_SUBMITTED', ${ctx.userId ?? null},
          'tax.write', 'tax_return', ${id},
          ${tx.json({
            regime: current.regime,
            periodStart: current.periodStart,
            periodEnd: current.periodEnd,
            netTaxPayable: current.netTaxPayable.toDecimalString(),
          })}
      )
  `;

  return getTaxReturn(tx, ctx, id);
}

/**
 * Amend a filed return.
 *
 * The original is superseded, never edited, and both remain — an amendment is
 * only explicable next to the thing it amends. The replacement is recomputed
 * from the current transactions rather than adjusted by hand, so it reflects
 * whatever was corrected.
 */
export async function amendTaxReturn(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: { reason: string; idempotencyKey: string },
): Promise<TaxReturnView> {
  const original = await getTaxReturn(tx, ctx, id);

  if (original.status !== 'SUBMITTED') {
    throw new TaxReturnError(
      'NOT_SUBMITTED',
      `Only a submitted return can be amended; this one is ${original.status}.`,
    );
  }

  const currency = await loadBaseCurrency(tx, ctx);
  const transactions = await taxTransactionsIn(
    tx, ctx, original.periodStart, original.periodEnd, currency,
  );
  const figures = computeTaxReturn(
    original.regime,
    original.periodStart,
    original.periodEnd,
    transactions,
    currency,
  );

  // Superseded first: the partial unique index allows only one live return per
  // period, so the original must step aside before the replacement is inserted.
  await tx`
      UPDATE tax_return SET status = 'SUPERSEDED'
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
  `;

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO tax_return (
          tenant_id, regime, period_start, period_end, currency,
          taxable_supplies, output_tax_charged, output_tax_adjustments,
          net_tax_payable, input_tax_absorbed, exempt_supplies, document_count,
          supersedes_id, idempotency_key
      ) VALUES (
          ${ctx.tenantId}, ${original.regime}, ${original.periodStart}, ${original.periodEnd},
          ${currency},
          ${figures.taxableSupplies.toDecimalString()},
          ${figures.outputTaxCharged.toDecimalString()},
          ${figures.outputTaxAdjustments.toDecimalString()},
          ${figures.netTaxPayable.toDecimalString()},
          ${figures.inputTaxAbsorbed.toDecimalString()},
          ${figures.exemptSupplies.toDecimalString()},
          ${figures.documentCount},
          ${id}, ${input.idempotencyKey}
      )
      RETURNING id
  `;

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'TAX_RETURN_AMENDED', ${ctx.userId ?? null},
          'tax.write', 'tax_return', ${row!.id},
          ${tx.json({
            supersedes: id,
            reason: input.reason,
            wasNetTaxPayable: original.netTaxPayable.toDecimalString(),
            nowNetTaxPayable: figures.netTaxPayable.toDecimalString(),
          })}
      )
  `;

  return getTaxReturn(tx, ctx, row!.id);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getTaxReturn(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<TaxReturnView> {
  const [row] = await tx<TaxReturnRow[]>`
      SELECT id, regime, period_start, period_end, status, currency,
             taxable_supplies, output_tax_charged, output_tax_adjustments,
             net_tax_payable, input_tax_absorbed, exempt_supplies, document_count,
             supersedes_id::text, submitted_at, submitted_by::text
        FROM tax_return
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
  `;

  if (!row) throw new TaxReturnError('RETURN_NOT_FOUND', `Tax return ${id} not found`);
  return toView(row);
}

export async function listTaxReturns(
  tx: Tx,
  ctx: TenantContext,
  filter: { regime?: string } = {},
): Promise<TaxReturnView[]> {
  const rows = await tx<TaxReturnRow[]>`
      SELECT id, regime, period_start, period_end, status, currency,
             taxable_supplies, output_tax_charged, output_tax_adjustments,
             net_tax_payable, input_tax_absorbed, exempt_supplies, document_count,
             supersedes_id::text, submitted_at, submitted_by::text
        FROM tax_return
       WHERE tenant_id = ${ctx.tenantId}
         AND (${filter.regime ?? null}::text IS NULL OR regime = ${filter.regime ?? null})
       ORDER BY period_start DESC, regime
  `;

  return rows.map(toView);
}

/**
 * The documents behind a figure.
 *
 * A return nobody can drill into is a number a user has to trust. 02-core-modules
 * lists "SST-02 preparation with drill-down" as the deliverable, and the
 * drill-down is the half that makes the figure checkable before it is filed.
 */
export interface TaxReturnDocument {
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
  readonly documentNo: string | null;
  readonly taxPointDate: string;
  readonly taxableAmount: string;
  readonly taxAmount: string;
  readonly direction: 'OUTPUT' | 'INPUT';
  readonly exemptionReason: string | null;
}

export async function taxReturnDocuments(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<TaxReturnDocument[]> {
  const view = await getTaxReturn(tx, ctx, id);

  const rows = await tx<
    {
      source_document_type: string;
      source_document_id: string;
      document_no: string | null;
      tax_point_date: Date;
      taxable_amount: string;
      tax_amount: string;
      direction: string;
      exemption_reason: string | null;
    }[]
  >`
      SELECT t.source_document_type, t.source_document_id::text,
             COALESCE(i.invoice_no, c.credit_note_no, b.internal_ref, d.debit_note_no)
                 AS document_no,
             t.tax_point_date, t.taxable_amount, t.tax_amount, t.direction,
             t.exemption_reason
        FROM tax_transaction t
        JOIN tax_code tc ON tc.tenant_id = t.tenant_id AND tc.id = t.tax_code_id
        LEFT JOIN invoice     i ON i.tenant_id = t.tenant_id AND i.id = t.source_document_id
        LEFT JOIN credit_note c ON c.tenant_id = t.tenant_id AND c.id = t.source_document_id
        LEFT JOIN bill        b ON b.tenant_id = t.tenant_id AND b.id = t.source_document_id
        LEFT JOIN debit_note  d ON d.tenant_id = t.tenant_id AND d.id = t.source_document_id
       WHERE t.tenant_id = ${ctx.tenantId}
         AND tc.regime = ${view.regime}
         AND t.tax_point_date BETWEEN ${view.periodStart} AND ${view.periodEnd}
       ORDER BY t.tax_point_date, t.source_document_type
  `;

  return rows.map((row) => ({
    sourceDocumentType: row.source_document_type,
    sourceDocumentId: row.source_document_id,
    documentNo: row.document_no,
    taxPointDate: toIsoDate(row.tax_point_date),
    taxableAmount: row.taxable_amount,
    taxAmount: row.tax_amount,
    direction: row.direction as 'OUTPUT' | 'INPUT',
    exemptionReason: row.exemption_reason,
  }));
}

/**
 * Periods that should have been filed and have not been.
 *
 * ---------------------------------------------------------------------------
 * THE MOST USEFUL THING THIS MODULE PRODUCES.
 *
 * A wrong figure on a return gets corrected by an amendment. A period nobody
 * filed at all is what draws an assessment, and it is invisible by nature —
 * nothing prompts you about a form you did not think about. Generating the
 * expected periods from the registration and subtracting the ones that exist
 * turns an absence into a list.
 * ---------------------------------------------------------------------------
 */
export interface OutstandingPeriod extends TaxablePeriod {
  readonly regime: TaxRegime;
}

export async function outstandingTaxPeriods(
  tx: Tx,
  ctx: TenantContext,
  through: string,
): Promise<OutstandingPeriod[]> {
  const registrations = (await sstRegistrations(tx, ctx)).filter((r) => r.isActive);
  const outstanding: OutstandingPeriod[] = [];

  for (const registration of registrations) {
    const expected = taxablePeriods(
      registration.firstPeriodStart,
      registration.cadenceMonths,
      through,
    );

    const filed = await tx<{ period_start: Date; period_end: Date }[]>`
        SELECT period_start, period_end FROM tax_return
         WHERE tenant_id = ${ctx.tenantId} AND regime = ${registration.regime}
           AND status <> 'SUPERSEDED'
    `;

    const filedKeys = new Set(
      filed.map((f) => `${toIsoDate(f.period_start)}|${toIsoDate(f.period_end)}`),
    );

    for (const period of expected) {
      // Only periods that have actually ended. A period still running is not
      // outstanding, it is current.
      if (period.end > through) continue;
      if (filedKeys.has(`${period.start}|${period.end}`)) continue;
      outstanding.push({ ...period, regime: registration.regime });
    }
  }

  return outstanding;
}

// ---------------------------------------------------------------------------

async function taxTransactionsIn(
  tx: Tx,
  ctx: TenantContext,
  from: string,
  to: string,
  currency: string,
): Promise<TaxTransactionRecord[]> {
  const rows = await tx<
    {
      regime: string;
      direction: string;
      source_document_type: string;
      source_document_id: string;
      tax_point_date: Date;
      taxable_amount: string;
      tax_amount: string;
      exemption_reason: string | null;
    }[]
  >`
      SELECT tc.regime, t.direction, t.source_document_type, t.source_document_id::text,
             t.tax_point_date, t.taxable_amount, t.tax_amount, t.exemption_reason
        FROM tax_transaction t
        JOIN tax_code tc ON tc.tenant_id = t.tenant_id AND tc.id = t.tax_code_id
       WHERE t.tenant_id = ${ctx.tenantId}
         AND t.tax_point_date BETWEEN ${from} AND ${to}
  `;

  return rows.map((row) => ({
    regime: row.regime as TaxRegime,
    direction: row.direction as 'OUTPUT' | 'INPUT',
    sourceDocumentType: row.source_document_type,
    sourceDocumentId: row.source_document_id,
    taxPointDate: toIsoDate(row.tax_point_date),
    taxableAmount: Money.fromDecimal(row.taxable_amount, currency),
    taxAmount: Money.fromDecimal(row.tax_amount, currency),
    ...(row.exemption_reason !== null ? { exemptionReason: row.exemption_reason } : {}),
  }));
}

interface TaxReturnRow {
  id: string;
  regime: string;
  period_start: Date;
  period_end: Date;
  status: string;
  currency: string;
  taxable_supplies: string;
  output_tax_charged: string;
  output_tax_adjustments: string;
  net_tax_payable: string;
  input_tax_absorbed: string;
  exempt_supplies: string;
  document_count: number;
  supersedes_id: string | null;
  submitted_at: Date | null;
  submitted_by: string | null;
}

function toView(row: TaxReturnRow): TaxReturnView {
  const money = (v: string) => Money.fromDecimal(v, row.currency);

  return {
    id: row.id,
    regime: row.regime as TaxRegime,
    periodStart: toIsoDate(row.period_start),
    periodEnd: toIsoDate(row.period_end),
    status: row.status as TaxReturnView['status'],
    currency: row.currency,
    taxableSupplies: money(row.taxable_supplies),
    outputTaxCharged: money(row.output_tax_charged),
    outputTaxAdjustments: money(row.output_tax_adjustments),
    netTaxPayable: money(row.net_tax_payable),
    inputTaxAbsorbed: money(row.input_tax_absorbed),
    exemptSupplies: money(row.exempt_supplies),
    documentCount: row.document_count,
    supersedesId: row.supersedes_id,
    submittedAt: row.submitted_at === null ? null : row.submitted_at.toISOString(),
    submittedBy: row.submitted_by,
  };
}
