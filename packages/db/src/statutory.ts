/**
 * StatutoryService — the values this system refuses to invent.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE EXISTS SO THAT UNBLOCKING IS DATA, NOT CODE.
 *
 * `wht_rate` has shipped empty since migration 0010, and CLAUDE.md is explicit
 * about why: Malaysian withholding depends on the payment type and on any
 * applicable double taxation agreement, and a plausible-looking wrong rate is
 * worse than an explicit gap because the payer carries the liability for
 * under-withholding.
 *
 * That was correct and incomplete. There was no way to enter a rate either —
 * no service, no route — so "it just needs the verified figures" was not true:
 * it needed the verified figures AND somebody to write this file. Which meant
 * the gap could not be closed by the person who actually has the ruling in
 * front of them, only by a developer.
 *
 * Now it can. And because `legislation_ref` is NOT NULL with a length floor,
 * the figure cannot enter without saying which ruling it came from.
 * ---------------------------------------------------------------------------
 */

import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';

export class StatutoryError extends Error {
  constructor(
    readonly code:
      | 'RATE_NOT_FOUND'
      | 'OVERLAPPING_VALIDITY'
      | 'CITATION_REQUIRED'
      | 'INVALID_RATE',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'StatutoryError';
  }
}

export interface WithholdingRateView {
  readonly id: string;
  readonly paymentType: string;
  /** ISO 3166-1 alpha-2, or null for the domestic rate. */
  readonly countryCode: string | null;
  readonly rateBasisPoints: number;
  readonly ratePercent: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  /** The primary source. NOT NULL by database constraint. */
  readonly legislationRef: string;
  readonly verifiedBy: string | null;
  readonly verifiedAt: string;
}

export interface SetWithholdingRateInput {
  /** e.g. 'ROYALTY', 'INTEREST', 'TECHNICAL_SERVICES', 'CONTRACT_PAYMENT'. */
  readonly paymentType: string;
  /** Omit for the domestic rate; set for a treaty rate. */
  readonly countryCode?: string;
  /** Basis points. 1000 = 10%. Never a float, and never a percentage string. */
  readonly rateBasisPoints: number;
  readonly validFrom: string;
  readonly validTo?: string;
  /**
   * Where this rate comes from. Required, and the database enforces a length
   * floor so it cannot be satisfied with "n/a".
   */
  readonly legislationRef: string;
}

/**
 * Record a withholding rate.
 *
 * ---------------------------------------------------------------------------
 * EFFECTIVE-DATED, AND NON-OVERLAPPING BY CONSTRUCTION.
 *
 * Rates change, and a payment must be withheld at the rate in force on its
 * payment date — not the current one. So a rate is never edited; a new version
 * is recorded with its own validity window, exactly as `tax_rate_version`
 * already works for SST. CLAUDE.md rule 7.
 *
 * Overlaps are refused rather than resolved. Two rates covering one date for
 * one payment type is not a configuration a resolver should pick between: the
 * answer would depend on ordering, and the person entering the second one is
 * the only person who knows which is right.
 * ---------------------------------------------------------------------------
 */
export async function setWithholdingRate(
  tx: Tx,
  ctx: TenantContext,
  input: SetWithholdingRateInput,
): Promise<WithholdingRateView> {
  if (!Number.isInteger(input.rateBasisPoints) || input.rateBasisPoints < 0) {
    throw new StatutoryError(
      'INVALID_RATE',
      'A withholding rate is whole basis points — 1000 is 10%. A fractional or ' +
        'negative rate is a mistake, not a rounding question.',
    );
  }

  if (input.rateBasisPoints > 10_000) {
    throw new StatutoryError(
      'INVALID_RATE',
      `${input.rateBasisPoints} basis points is over 100%: withholding more than the ` +
        'payment is never correct, and this is almost always a percentage entered ' +
        'where basis points were expected.',
    );
  }

  if (input.legislationRef.trim().length < 8) {
    // Also a database CHECK. Raised here so the message names the field and
    // says what a citation looks like, rather than surfacing a constraint name.
    throw new StatutoryError(
      'CITATION_REQUIRED',
      'A withholding rate must cite its source — for example "LHDN Public Ruling ' +
        '11/2018 s4.2" or "MY-SG DTA Article 12(2)". A rate whose origin nobody ' +
        'recorded cannot be re-checked when the law changes, and the payer carries ' +
        'the liability for getting it wrong.',
    );
  }

  /*
   * Overlap detection.
   *
   * Two windows overlap unless one ends before the other starts. NULL valid_to
   * means "still in force", so it overlaps anything at or after its start.
   */
  const clashes = await tx<{ id: string; valid_from: Date; valid_to: Date | null }[]>`
      SELECT id, valid_from, valid_to
        FROM wht_rate
       WHERE tenant_id = ${ctx.tenantId}
         AND payment_type = ${input.paymentType}
         AND country_code IS NOT DISTINCT FROM ${input.countryCode ?? null}
         AND (valid_to IS NULL OR valid_to >= ${input.validFrom}::date)
         AND (${input.validTo ?? null}::date IS NULL
              OR valid_from <= ${input.validTo ?? null}::date)
  `;

  if (clashes.length > 0) {
    throw new StatutoryError(
      'OVERLAPPING_VALIDITY',
      `A ${input.paymentType} rate already covers ${input.validFrom}. Close the existing ` +
        'window first — two rates in force on one date means the amount withheld ' +
        'depends on which row is read first.',
      {
        overlapping: clashes.map((c) => ({
          id: c.id,
          validFrom: toIsoDate(c.valid_from),
          validTo: c.valid_to === null ? null : toIsoDate(c.valid_to),
        })),
      },
    );
  }

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO wht_rate (
          tenant_id, payment_type, country_code, rate_basis_points,
          valid_from, valid_to, legislation_ref, verified_by
      ) VALUES (
          ${ctx.tenantId}, ${input.paymentType}, ${input.countryCode ?? null},
          ${input.rateBasisPoints}, ${input.validFrom}, ${input.validTo ?? null},
          ${input.legislationRef.trim()}, ${ctx.userId ?? null}
      )
      RETURNING id
  `;

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'STATUTORY_RATE_CHANGED', ${ctx.userId ?? null},
          'tax.write', 'wht_rate', ${row!.id},
          ${tx.json({
            paymentType: input.paymentType,
            countryCode: input.countryCode ?? null,
            rateBasisPoints: input.rateBasisPoints,
            validFrom: input.validFrom,
            validTo: input.validTo ?? null,
            legislationRef: input.legislationRef.trim(),
          })}
      )
  `;

  const [view] = await listWithholdingRates(tx, ctx).then((all) =>
    all.filter((r) => r.id === row!.id),
  );
  return view!;
}

export async function listWithholdingRates(
  tx: Tx,
  ctx: TenantContext,
): Promise<WithholdingRateView[]> {
  const rows = await tx<
    {
      id: string;
      payment_type: string;
      country_code: string | null;
      rate_basis_points: number;
      valid_from: Date;
      valid_to: Date | null;
      legislation_ref: string;
      verified_by: string | null;
      verified_at: Date;
    }[]
  >`
      SELECT id, payment_type, country_code, rate_basis_points, valid_from, valid_to,
             legislation_ref, verified_by::text, verified_at
        FROM wht_rate
       WHERE tenant_id = ${ctx.tenantId}
       ORDER BY payment_type, country_code NULLS FIRST, valid_from DESC
  `;

  return rows.map((row) => ({
    id: row.id,
    paymentType: row.payment_type,
    countryCode: row.country_code,
    rateBasisPoints: row.rate_basis_points,
    // Presentation only. The engine works in basis points throughout.
    ratePercent: `${(row.rate_basis_points / 100).toFixed(2)}%`,
    validFrom: toIsoDate(row.valid_from),
    validTo: row.valid_to === null ? null : toIsoDate(row.valid_to),
    legislationRef: row.legislation_ref,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at.toISOString(),
  }));
}

/**
 * Close a rate's validity window.
 *
 * The only permitted change to a rate that is already in force. Nothing edits
 * `rate_basis_points`: a payment withheld last month was withheld at whatever
 * was in force then, and rewriting the row would make the historic figure
 * unexplainable.
 */
export async function endWithholdingRate(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  validTo: string,
): Promise<WithholdingRateView> {
  const [row] = await tx<{ id: string; valid_from: Date }[]>`
      SELECT id, valid_from FROM wht_rate
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
  `;
  if (!row) throw new StatutoryError('RATE_NOT_FOUND', `Withholding rate ${id} not found`);

  if (validTo < toIsoDate(row.valid_from)) {
    throw new StatutoryError(
      'INVALID_RATE',
      `A rate cannot end on ${validTo}, before it began on ${toIsoDate(row.valid_from)}`,
    );
  }

  await tx`
      UPDATE wht_rate SET valid_to = ${validTo}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
  `;

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'STATUTORY_RATE_CHANGED', ${ctx.userId ?? null},
          'tax.write', 'wht_rate', ${id}, ${tx.json({ endedOn: validTo })}
      )
  `;

  const [view] = await listWithholdingRates(tx, ctx).then((all) =>
    all.filter((r) => r.id === id),
  );
  return view!;
}
