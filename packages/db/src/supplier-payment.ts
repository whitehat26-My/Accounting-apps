import {
  ageItems,
  autoAllocate,
  buildSettlementJournal,
  buildWithholdingPaymentJournal,
  computeWithholding,
  DEFAULT_AGEING_BUCKETS,
  isErr,
  Money,
  Rate,
  resolveWithholdingRate,
  settlementStatus,
  toBase,
  validateJournalEntry,
  validateReceipt,
  type AgeingBucket,
  type AgeingItem,
  type AgeingReport,
  type AllocationStrategy,
  type OpenDocument,
  type PaymentMethod,
  type SettlementAllocation,
  type WithholdingComputation,
  type WithholdingRate,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';
import { loadBaseCurrency, resolveRate } from './invoice.js';
import { toIsoDate } from './internal.js';

/**
 * PaymentService.paySupplier() — money out against open bills (M3).
 *
 * The outbound mirror of `recordReceipt()`, and it reuses the same domain
 * functions rather than copying them. `validateReceipt` and `autoAllocate`
 * were already document-agnostic; `buildSettlementJournal` takes a direction
 * and derives the FX line as the balancing figure, so nothing here decides
 * which way a gain or a loss points.
 *
 * That reuse is the whole design. A hand-written payables copy of the receipts
 * logic must swap every debit and credit, which INVERTS the sign of the
 * realised FX difference — and a mislabelled FX gain looks entirely plausible
 * on a P&L. Sharing the code makes that class of mistake unrepresentable.
 */

export interface PaySupplierInput {
  readonly supplierId: string;
  readonly paymentDate: string;
  /** Decimal string. Never a float. */
  readonly amount: string;
  readonly method: PaymentMethod;
  /** The bank account the money left. Named for symmetry with receipts. */
  readonly depositAccountId: string;
  readonly allocations?: readonly { billId: string; amount: string }[];
  readonly allocationStrategy?: AllocationStrategy;
  readonly reference?: string;
  readonly currency?: string;
  readonly fxRate?: string;
  /**
   * Withholding, when the payment is to a non-resident and a rate has been
   * loaded. Omit for the ordinary case — which is every case until a verified
   * LHDN rate is present, since `wht_rate` ships empty.
   */
  readonly withholding?: {
    readonly paymentType: string;
    readonly countryCode?: string;
  };
  readonly idempotencyKey: string;
}

export interface SupplierPaymentResult {
  readonly id: string;
  readonly paymentNo: string;
  readonly amount: string;
  readonly allocatedTotal: string;
  readonly unallocated: string;
  readonly journalEntryId: string;
  /** Signed base-currency amount: positive a gain, negative a loss. */
  readonly realisedFx: string | null;
  readonly withheld: string | null;
  readonly settledBills: readonly { billId: string; status: string; amountDue: string }[];
  readonly replayed: boolean;
}

export class SupplierPaymentError extends Error {
  constructor(
    readonly code:
      | 'SUPPLIER_NOT_FOUND'
      | 'NO_POSTING_ACCOUNTS'
      | 'PAYMENT_INVALID'
      | 'NO_WHT_RATE'
      | 'NO_WHT_ACCOUNT'
      | 'JOURNAL_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'SupplierPaymentError';
  }
}

export async function paySupplier(
  tx: Tx,
  ctx: TenantContext,
  input: PaySupplierInput,
): Promise<SupplierPaymentResult> {
  // ---- Idempotency ---------------------------------------------------------
  const existing = await tx<
    {
      id: string;
      payment_no: string;
      amount: string;
      unallocated_amount: string;
      journal_entry_id: string;
      realised_fx: string | null;
    }[]
  >`
      SELECT id, payment_no, amount, unallocated_amount, journal_entry_id, realised_fx
        FROM payment
       WHERE tenant_id = ${ctx.tenantId} AND idempotency_key = ${input.idempotencyKey}
  `;

  if (existing.length > 0) {
    const row = existing[0]!;
    const currency = input.currency ?? 'MYR';
    const amount = Money.fromDecimal(row.amount, currency);
    const unallocated = Money.fromDecimal(row.unallocated_amount, currency);
    const [wht] = await tx<{ withheld_amount: string }[]>`
        SELECT withheld_amount FROM withholding_transaction
         WHERE tenant_id = ${ctx.tenantId} AND payment_id = ${row.id}
    `;
    return {
      id: row.id,
      paymentNo: row.payment_no,
      amount: row.amount,
      allocatedTotal: amount.subtract(unallocated).toDecimalString(),
      unallocated: row.unallocated_amount,
      journalEntryId: row.journal_entry_id,
      realisedFx: row.realised_fx,
      withheld: wht?.withheld_amount ?? null,
      settledBills: [],
      replayed: true,
    };
  }

  const currency = input.currency ?? 'MYR';
  const amount = Money.fromDecimal(input.amount, currency);

  const [supplier] = await tx<{ id: string; is_supplier: boolean }[]>`
      SELECT id, is_supplier FROM contact
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.supplierId}
  `;
  if (!supplier) {
    throw new SupplierPaymentError(
      'SUPPLIER_NOT_FOUND',
      `Contact ${input.supplierId} not found`,
    );
  }

  const accountsPayableId = await loadRequiredAccount(tx, ctx, 'AP');
  const fxAccountId = await loadOptionalAccount(tx, ctx, 'FX_GAIN_LOSS');

  // ---- Read live balances, locked for update -------------------------------
  // FOR UPDATE for the same reason receipts take it: two concurrent payments
  // against one bill would otherwise both read the same amount_due and both
  // allocate it.
  const openRows = await tx<
    {
      id: string;
      internal_ref: string;
      bill_date: Date;
      due_date: Date;
      amount_due: string;
      total: string;
      amount_paid: string;
      fx_rate: string;
    }[]
  >`
      SELECT id, internal_ref, bill_date, due_date, amount_due, total, amount_paid, fx_rate
        FROM bill
       WHERE tenant_id = ${ctx.tenantId}
         AND supplier_id = ${input.supplierId}
         AND status IN ('ENTERED','PART_PAID')
         AND amount_due > 0
       ORDER BY bill_date, internal_ref
         FOR UPDATE
  `;

  // Each bill carries the rate its AP was booked at, and that is the rate it
  // must be relieved at — the payables half of ledger invariant #13.
  const openBillDocuments: OpenDocument[] = openRows.map((r) => ({
    documentId: r.id,
    documentNo: r.internal_ref,
    issueDate: toIsoDate(r.bill_date),
    dueDate: toIsoDate(r.due_date),
    amountDue: Money.fromDecimal(r.amount_due, currency),
    bookedRate: Rate.fromDecimal(r.fx_rate),
  }));

  const allocations: SettlementAllocation[] = input.allocations
    ? input.allocations.map((a) => ({
        documentId: a.billId,
        amount: Money.fromDecimal(a.amount, currency),
      }))
    : autoAllocate(amount, openBillDocuments, input.allocationStrategy ?? 'OLDEST_FIRST');

  // ---- Validate (pure domain) ---------------------------------------------
  const validated = validateReceipt(
    {
      contactId: input.supplierId,
      paymentDate: input.paymentDate,
      amount,
      method: input.method,
      depositAccountId: input.depositAccountId,
      allocations,
      ...(input.reference !== undefined ? { reference: input.reference } : {}),
    },
    openBillDocuments,
  );

  if (isErr(validated)) {
    throw new SupplierPaymentError(
      'PAYMENT_INVALID',
      'Supplier payment failed validation',
      validated.error,
    );
  }
  const settlement = validated.value;

  // ---- Withholding ---------------------------------------------------------
  const withholding = input.withholding
    ? await resolveWithholdingForPayment(tx, ctx, input, amount)
    : null;

  // ---- Post ----------------------------------------------------------------
  const [numbered] = await tx<{ allocate_document_number: string }[]>`
      SELECT allocate_document_number('PAYMENT')
  `;
  const paymentNo = numbered!.allocate_document_number;

  // Minted up front for the same reason receipts do it: `payment.journal_entry_id`
  // is NOT NULL, so the entry must post first, yet the entry's
  // source_document_id has to point back at this payment.
  const [generated] = await tx<{ id: string }[]>`SELECT gen_random_uuid() AS id`;
  const paymentId = generated!.id;

  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const settlementRate = await resolveSettlementRate(
    tx,
    ctx,
    currency,
    baseCurrency,
    input.paymentDate,
    input.fxRate,
  );

  const journalDraft =
    withholding !== null
      ? buildWithholdingPaymentJournal(
          withholding.computation,
          {
            accountsPayableId,
            bankAccountId: input.depositAccountId,
            withholdingPayableId: withholding.payableAccountId,
          },
          {
            entryDate: input.paymentDate,
            description: `Payment ${paymentNo} (net of withholding)`,
            documentType: 'PAYMENT',
            documentId: paymentId,
            contactId: input.supplierId,
            ...(settlementRate.isOne()
              ? {}
              : { toBase: (m: Money) => toBase(m, settlementRate, baseCurrency) }),
          },
        )
      : buildSettlementJournal(
          'OUTBOUND',
          settlement,
          {
            controlAccountId: accountsPayableId,
            ...(fxAccountId ? { fxGainLossId: fxAccountId } : {}),
          },
          {
            entryDate: input.paymentDate,
            description: `Payment ${paymentNo}`,
            documentType: 'PAYMENT',
            documentId: paymentId,
          },
          { baseCurrency, settlementRate, openDocuments: openBillDocuments },
        );

  if (journalDraft === null) {
    throw new SupplierPaymentError(
      'PAYMENT_INVALID',
      'A zero-value payment has nothing to record',
    );
  }

  const validJournal = validateJournalEntry(journalDraft, baseCurrency);
  if (isErr(validJournal)) {
    throw new SupplierPaymentError(
      'JOURNAL_INVALID',
      'Generated journal is invalid',
      validJournal.error,
    );
  }

  const posted = await postJournalEntry(tx, ctx, validJournal.value, {
    idempotencyKey: `supplier-payment:${input.idempotencyKey}`,
    emitEvent: {
      type: 'payment.sent',
      payload: {
        paymentNo,
        amount: amount.toDecimalString(),
        contactId: input.supplierId,
      },
    },
  });

  // Derived from what was actually posted rather than recomputed: the journal
  // is the truth. Debit to the FX account is a loss, whichever direction the
  // settlement went.
  const fxLine = fxAccountId
    ? journalDraft.lines.find((l) => l.accountId === fxAccountId)
    : undefined;
  const realisedFxAmount = fxLine
    ? fxLine.side === 'CREDIT'
      ? fxLine.baseAmount
      : fxLine.baseAmount.negate()
    : null;

  await tx`
      INSERT INTO payment (
          tenant_id, id, payment_no, contact_id, direction, payment_date, method,
          deposit_account_id, currency, amount, unallocated_amount, reference,
          journal_entry_id, idempotency_key, recorded_by, fx_rate, base_amount, realised_fx
      ) VALUES (
          ${ctx.tenantId}, ${paymentId}, ${paymentNo}, ${input.supplierId}, 'OUTBOUND',
          ${input.paymentDate}, ${input.method}, ${input.depositAccountId},
          ${currency}, ${amount.toDecimalString()},
          ${settlement.unallocated.toDecimalString()}, ${input.reference ?? null},
          ${posted.id}, ${input.idempotencyKey}, ${ctx.userId ?? null},
          ${settlementRate.toDecimalString()},
          ${toBase(amount, settlementRate, baseCurrency).toDecimalString()},
          ${realisedFxAmount ? realisedFxAmount.toDecimalString() : null}
      )
  `;

  if (withholding !== null) {
    await tx`
        INSERT INTO withholding_transaction (
            tenant_id, payment_id, contact_id, payment_type, country_code,
            rate_basis_points, gross_amount, withheld_amount, payment_date
        ) VALUES (
            ${ctx.tenantId}, ${paymentId}, ${input.supplierId},
            ${withholding.computation.paymentType},
            ${withholding.computation.countryCode},
            ${Number(withholding.computation.rateBasisPoints)},
            ${withholding.computation.grossAmount.toDecimalString()},
            ${withholding.computation.withheldAmount.toDecimalString()},
            ${input.paymentDate}
        )
    `;
  }

  // ---- Apply allocations ---------------------------------------------------
  const settledBills: { billId: string; status: string; amountDue: string }[] = [];

  for (const allocation of settlement.allocations) {
    await tx`
        INSERT INTO payment_allocation (tenant_id, payment_id, bill_id, amount)
        VALUES (${ctx.tenantId}, ${paymentId}, ${allocation.documentId},
                ${allocation.amount.toDecimalString()})
    `;

    const source = openRows.find((r) => r.id === allocation.documentId)!;
    const total = Money.fromDecimal(source.total, currency);
    const newPaid = Money.fromDecimal(source.amount_paid, currency).add(allocation.amount);
    const status = billStatusFor(total, newPaid);

    await tx`
        UPDATE bill
           SET amount_paid = ${newPaid.toDecimalString()}, status = ${status}
         WHERE tenant_id = ${ctx.tenantId} AND id = ${allocation.documentId}
    `;

    settledBills.push({
      billId: allocation.documentId,
      status,
      amountDue: total.subtract(newPaid).toDecimalString(),
    });
  }

  return {
    id: paymentId,
    paymentNo,
    amount: amount.toDecimalString(),
    allocatedTotal: settlement.allocatedTotal.toDecimalString(),
    unallocated: settlement.unallocated.toDecimalString(),
    journalEntryId: posted.id,
    realisedFx: realisedFxAmount ? realisedFxAmount.toDecimalString() : null,
    withheld: withholding ? withholding.computation.withheldAmount.toDecimalString() : null,
    settledBills,
    replayed: false,
  };
}

/**
 * `settlementStatus()` speaks invoice vocabulary — ISSUED / PART_PAID / PAID.
 * A bill's unsettled state is ENTERED, so the one differing term is translated
 * here rather than by widening the domain function's return type, which would
 * push a persistence concern into a pure module.
 */
function billStatusFor(total: Money, paid: Money): string {
  const status = settlementStatus(total, paid);
  return status === 'ISSUED' ? 'ENTERED' : status;
}

// ---------------------------------------------------------------------------
// Ageing
// ---------------------------------------------------------------------------

/**
 * Aged payables as at a date, in base currency at booked rates.
 *
 * Reconstructed from history exactly as `agedReceivables()` is, and bucketed by
 * the same shared domain function — so a creditors report and a debtors report
 * cannot disagree about what "31-60 days" means.
 */
export async function agedPayables(
  tx: Tx,
  ctx: TenantContext,
  asOfDate: string,
  buckets: readonly AgeingBucket[] = DEFAULT_AGEING_BUCKETS,
): Promise<AgeingReport> {
  const items = await openPayablesAsAt(tx, ctx, asOfDate);
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  return ageItems(items, asOfDate, baseCurrency, buckets);
}

export async function openPayablesAsAt(
  tx: Tx,
  ctx: TenantContext,
  asOfDate: string,
): Promise<AgeingItem[]> {
  const rows = await tx<
    {
      id: string;
      internal_ref: string;
      supplier_id: string;
      due_date: Date;
      outstanding_base: string;
    }[]
  >`
      SELECT b.id,
             b.internal_ref,
             b.supplier_id,
             b.due_date,
             ROUND(
                 (b.total
                  - COALESCE(paid.amount, 0)
                  - COALESCE(debited.amount, 0)) * b.fx_rate, 4
             )::text AS outstanding_base
        FROM bill b
        LEFT JOIN LATERAL (
             SELECT SUM(a.amount) AS amount
               FROM payment_allocation a
               JOIN payment p
                 ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
              WHERE a.tenant_id = b.tenant_id
                AND a.bill_id = b.id
                AND p.payment_date <= ${asOfDate}::date
        ) paid ON TRUE
        LEFT JOIN LATERAL (
             SELECT SUM(da.amount) AS amount
               FROM debit_note_allocation da
               JOIN debit_note dn
                 ON dn.tenant_id = da.tenant_id AND dn.id = da.debit_note_id
              WHERE da.tenant_id = b.tenant_id
                AND da.bill_id = b.id
                AND dn.status = 'ISSUED'
                AND dn.debit_date <= ${asOfDate}::date
        ) debited ON TRUE
       WHERE b.tenant_id = ${ctx.tenantId}
         AND b.status <> 'DRAFT'
         AND b.status <> 'VOIDED'
         AND b.bill_date <= ${asOfDate}::date
       ORDER BY b.due_date, b.internal_ref
  `;

  const baseCurrency = await loadBaseCurrency(tx, ctx);

  return rows
    .map((r) => ({
      documentId: r.id,
      documentNo: r.internal_ref,
      contactId: r.supplier_id,
      dueDate: toIsoDate(r.due_date),
      outstanding: Money.fromDecimal(r.outstanding_base, baseCurrency),
    }))
    .filter((i) => !i.outstanding.isZero());
}

// ------------------------------------------------------------------ internals

async function resolveWithholdingForPayment(
  tx: Tx,
  ctx: TenantContext,
  input: PaySupplierInput,
  amount: Money,
): Promise<{ computation: WithholdingComputation; payableAccountId: string }> {
  const spec = input.withholding!;
  const countryCode = spec.countryCode ?? null;

  const rows = await tx<
    {
      id: string;
      payment_type: string;
      country_code: string | null;
      rate_basis_points: number;
      valid_from: Date;
      valid_to: Date | null;
      legislation_ref: string | null;
    }[]
  >`
      SELECT id, payment_type, country_code, rate_basis_points,
             valid_from, valid_to, legislation_ref
        FROM wht_rate
       WHERE tenant_id = ${ctx.tenantId} AND payment_type = ${spec.paymentType}
  `;

  const rates: WithholdingRate[] = rows.map((r) => ({
    id: r.id,
    paymentType: r.payment_type,
    countryCode: r.country_code,
    rateBasisPoints: BigInt(r.rate_basis_points),
    validFrom: toIsoDate(r.valid_from),
    validTo: r.valid_to ? toIsoDate(r.valid_to) : null,
    ...(r.legislation_ref ? { legislationRef: r.legislation_ref } : {}),
  }));

  const rate = resolveWithholdingRate(rates, spec.paymentType, countryCode, input.paymentDate);

  if (!rate) {
    // Deliberately a hard failure. `wht_rate` ships empty because Malaysian
    // withholding rates depend on payment type and treaty and must be verified
    // against LHDN. Falling back to zero would silently under-withhold, and the
    // payer carries that liability.
    throw new SupplierPaymentError(
      'NO_WHT_RATE',
      `No withholding rate configured for payment type "${spec.paymentType}"` +
        `${countryCode ? ` and country ${countryCode}` : ''} on ${input.paymentDate}. ` +
        'Load a rate verified against LHDN before withholding on this payment.',
    );
  }

  const payableAccountId = await loadOptionalAccount(tx, ctx, 'WHT_PAYABLE');
  if (!payableAccountId) {
    throw new SupplierPaymentError(
      'NO_WHT_ACCOUNT',
      'Posting account for role WHT_PAYABLE is not configured for this organisation',
    );
  }

  const computed = computeWithholding(amount, rate);
  if (isErr(computed)) {
    throw new SupplierPaymentError(
      'PAYMENT_INVALID',
      'Withholding computation failed',
      computed.error,
    );
  }

  return { computation: computed.value, payableAccountId };
}

async function resolveSettlementRate(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
  baseCurrency: string,
  date: string,
  explicit?: string,
): Promise<Rate> {
  try {
    return await resolveRate(tx, ctx, currency, baseCurrency, date, explicit);
  } catch (error) {
    throw new SupplierPaymentError(
      'PAYMENT_INVALID',
      error instanceof Error ? error.message : 'Could not resolve an exchange rate',
    );
  }
}

async function loadOptionalAccount(
  tx: Tx,
  ctx: TenantContext,
  role: string,
): Promise<string | undefined> {
  const [row] = await tx<{ account_id: string }[]>`
      SELECT account_id FROM posting_account_map
       WHERE tenant_id = ${ctx.tenantId} AND role = ${role}
  `;
  return row?.account_id;
}

async function loadRequiredAccount(
  tx: Tx,
  ctx: TenantContext,
  role: string,
): Promise<string> {
  const accountId = await loadOptionalAccount(tx, ctx, role);
  if (!accountId) {
    throw new SupplierPaymentError(
      'NO_POSTING_ACCOUNTS',
      `Posting account for role ${role} is not configured for this organisation`,
    );
  }
  return accountId;
}
