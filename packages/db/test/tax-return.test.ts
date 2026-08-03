import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import {
  amendTaxReturn,
  getTaxReturn,
  outstandingTaxPeriods,
  prepareTaxReturn,
  setSstRegistration,
  submitTaxReturn,
  taxReturnDocuments,
} from '../src/tax-return.js';
import { issueInvoice } from '../src/invoice.js';
import { issueCreditNote } from '../src/credit-note.js';
import { enterBill } from '../src/bill.js';
import { tenantReadiness } from '../src/readiness.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };

beforeAll(async () => {
  const db = await createTestDatabase('taxreturn');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Filing Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

  await withTenant(sql, ctx, (tx) =>
    setSstRegistration(tx, ctx, {
      regime: 'SST_SERVICE',
      registrationNo: 'W10-1808-32000123',
      cadenceMonths: 2,
      firstPeriodStart: '2026-01-01',
      sourceReference: 'RMCD registration letter 2026-01-15, ref SST-W10-2026-0042',
    }),
  );
}, 60_000);

afterAll(async () => {
  await drop?.();
});

/** An invoice for 1,000 plus 8% service tax, dated in the March–April period. */
async function invoice(unitPrice: string, issueDate = '2026-03-15') {
  return withTenant(sql, ctx, (tx) =>
    issueInvoice(tx, ctx, {
      contactId: tenant.customerId,
      issueDate,
      lines: [
        {
          description: 'Consulting',
          quantity: '1',
          unitPrice,
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['SST-SVC']!,
        },
      ],
      idempotencyKey: randomUUID(),
    }),
  );
}

// ---------------------------------------------------------------------------
// The correctness point, against the real database
// ---------------------------------------------------------------------------

describe('preparing a return', () => {
  it('remits the full output tax and does NOT deduct input tax', async () => {
    /*
     * The assertion the whole module exists for, exercised end to end against a
     * real tax engine rather than hand-built records.
     *
     * SST is not a VAT. Tax paid to a supplier is a cost absorbed into the
     * expense; the return remits output tax in full. A return that subtracted
     * input tax would under-declare by exactly that amount — plausible on the
     * form, reconciling against a P&L built the same wrong way, and a shortfall
     * the business is liable for.
     */
    await invoice('1000.00');

    // A purchase carrying input tax in the same period.
    await withTenant(sql, ctx, (tx) =>
      enterBill(tx, ctx, {
        supplierId: tenant.supplierId,
        billNo: `SUP-${randomUUID().slice(0, 8)}`,
        billDate: '2026-03-20',
        lines: [
          {
            description: 'Subcontracted work',
            quantity: '1',
            unitPrice: '500.00',
            accountId: tenant.accounts['6000']!,
            taxCodeId: tenant.taxCodes['SST-SVC']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const prepared = await withTenant(sql, ctx, (tx) =>
      prepareTaxReturn(tx, ctx, {
        regime: 'SST_SERVICE',
        periodStart: '2026-03-01',
        periodEnd: '2026-04-30',
        idempotencyKey: randomUUID(),
      }),
    );

    // 8% of 1,000.
    expect(prepared.outputTaxCharged.toDecimalString()).toBe('80.0000');
    // 8% of 500 — present, and NOT subtracted.
    expect(prepared.inputTaxAbsorbed.toDecimalString()).toBe('40.0000');
    expect(prepared.netTaxPayable.toDecimalString()).toBe('80.0000');
  });

  it('is refused by the DATABASE if anything ever tries to deduct it', async () => {
    // Not only a rule in the domain and the service. Somebody will eventually
    // try, because every VAT system in the world works the other way.
    await expect(
      admin`
          INSERT INTO tax_return (
              tenant_id, regime, period_start, period_end,
              taxable_supplies, output_tax_charged, output_tax_adjustments,
              net_tax_payable, input_tax_absorbed
          ) VALUES (
              ${ctx.tenantId}, 'SST_SERVICE', '2026-09-01', '2026-10-31',
              1000, 80, 0, 40, 40
          )
      `,
    ).rejects.toThrow(/violates check constraint/);
  });

  it('nets a credit note issued in the same period', async () => {
    const target = await invoice('2000.00', '2026-05-10');

    await withTenant(sql, ctx, (tx) =>
      issueCreditNote(tx, ctx, {
        contactId: tenant.customerId,
        invoiceId: target.id,
        creditDate: '2026-05-20',
        reason: 'RETURN',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitPrice: '500.00',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['SST-SVC']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const prepared = await withTenant(sql, ctx, (tx) =>
      prepareTaxReturn(tx, ctx, {
        regime: 'SST_SERVICE',
        periodStart: '2026-05-01',
        periodEnd: '2026-06-30',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(prepared.outputTaxCharged.toDecimalString()).toBe('160.0000');
    expect(prepared.outputTaxAdjustments.toDecimalString()).toBe('40.0000');
    expect(prepared.netTaxPayable.toDecimalString()).toBe('120.0000');
    expect(prepared.taxableSupplies.toDecimalString()).toBe('1500.0000');
  });

  it('refuses a regime the business is not registered for', async () => {
    // Sales tax and service tax are separate registrations. Preparing a return
    // for one the business does not hold is not a filing.
    await expect(
      withTenant(sql, ctx, (tx) =>
        prepareTaxReturn(tx, ctx, {
          regime: 'SST_SALES',
          periodStart: '2026-03-01',
          periodEnd: '2026-04-30',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/no active SST_SALES registration/);
  });

  it('refuses a second live return for the same period', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        prepareTaxReturn(tx, ctx, {
          regime: 'SST_SERVICE',
          periodStart: '2026-03-01',
          periodEnd: '2026-04-30',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/already covers this period/);
  });

  it('is idempotent on the key', async () => {
    const key = randomUUID();
    const args = {
      regime: 'SST_SERVICE' as const,
      periodStart: '2026-07-01',
      periodEnd: '2026-08-31',
      idempotencyKey: key,
    };

    const first = await withTenant(sql, ctx, (tx) => prepareTaxReturn(tx, ctx, args));
    const second = await withTenant(sql, ctx, (tx) => prepareTaxReturn(tx, ctx, args));
    expect(second.id).toBe(first.id);
  });
});

// ---------------------------------------------------------------------------
// Drill-down
// ---------------------------------------------------------------------------

describe('the drill-down', () => {
  it('lists the documents behind the figures, so a user can check before filing', async () => {
    // 02-core-modules names "SST-02 preparation with drill-down" as the
    // deliverable. A return nobody can drill into is a number a user has to
    // trust.
    const [march] = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string }[]>`
          SELECT id FROM tax_return
           WHERE tenant_id = ${ctx.tenantId} AND period_start = '2026-03-01'
      `,
    );

    const documents = await withTenant(sql, ctx, (tx) =>
      taxReturnDocuments(tx, ctx, march!.id),
    );

    expect(documents.length).toBeGreaterThan(0);
    // Named, not just identified — a UUID is not something a user can check.
    expect(documents.some((d) => d.documentNo?.startsWith('INV-'))).toBe(true);
    // Both directions are shown, because the input tax figure has to be
    // checkable too even though it is not deducted.
    expect(documents.some((d) => d.direction === 'INPUT')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Filing and amending
// ---------------------------------------------------------------------------

describe('filing', () => {
  it('a submitted return cannot be edited', async () => {
    const [march] = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string }[]>`
          SELECT id FROM tax_return
           WHERE tenant_id = ${ctx.tenantId} AND period_start = '2026-03-01'
      `,
    );

    const submitted = await withTenant(sql, ctx, (tx) => submitTaxReturn(tx, ctx, march!.id));
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.submittedBy).toBe(ctx.userId);

    // A return is a statement made to a tax authority on a date. What was said
    // then does not change because the data moved afterwards.
    await expect(
      admin`
          UPDATE tax_return SET net_tax_payable = 1, output_tax_charged = 1
           WHERE id = ${march!.id} AND tenant_id = ${ctx.tenantId}
      `,
    ).rejects.toThrow(/file an amendment/);

    await expect(
      admin`DELETE FROM tax_return WHERE id = ${march!.id} AND tenant_id = ${ctx.tenantId}`,
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('records the filing as a financial event', async () => {
    const [event] = await admin<{ event_type: string; detail: { netTaxPayable: string } }[]>`
        SELECT event_type, detail FROM financial_event_log
         WHERE tenant_id = ${ctx.tenantId} AND event_type = 'TAX_RETURN_SUBMITTED'
         ORDER BY id DESC LIMIT 1
    `;

    expect(event!.event_type).toBe('TAX_RETURN_SUBMITTED');
    expect(event!.detail.netTaxPayable).toBe('80.0000');
  });

  it('amends by superseding, so both the original and the correction survive', async () => {
    const [march] = await withTenant(sql, ctx, (tx) =>
      tx<{ id: string }[]>`
          SELECT id FROM tax_return
           WHERE tenant_id = ${ctx.tenantId} AND period_start = '2026-03-01'
             AND status = 'SUBMITTED'
      `,
    );

    // A late invoice for the same period, found after filing.
    await invoice('500.00', '2026-04-20');

    const amended = await withTenant(sql, ctx, (tx) =>
      amendTaxReturn(tx, ctx, march!.id, {
        reason: 'Invoice INV-00099 was issued late and belongs in this period',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(amended.supersedesId).toBe(march!.id);
    expect(amended.status).toBe('DRAFT');
    // Recomputed from current data, not adjusted by hand: 80 + 40.
    expect(amended.netTaxPayable.toDecimalString()).toBe('120.0000');

    // The original survives, marked superseded. An amendment is only
    // explicable next to the thing it amends.
    const original = await withTenant(sql, ctx, (tx) => getTaxReturn(tx, ctx, march!.id));
    expect(original.status).toBe('SUPERSEDED');
    expect(original.netTaxPayable.toDecimalString()).toBe('80.0000');
  });

  it('refuses to amend something that was never filed', async () => {
    const draft = await withTenant(sql, ctx, (tx) =>
      prepareTaxReturn(tx, ctx, {
        regime: 'SST_SERVICE',
        periodStart: '2026-09-01',
        periodEnd: '2026-10-31',
        idempotencyKey: randomUUID(),
      }),
    );

    await expect(
      withTenant(sql, ctx, (tx) =>
        amendTaxReturn(tx, ctx, draft.id, { reason: 'x', idempotencyKey: randomUUID() }),
      ),
    ).rejects.toThrow(/Only a submitted return can be amended/);
  });
});

// ---------------------------------------------------------------------------
// The gap detector
// ---------------------------------------------------------------------------

describe('periods that were never filed', () => {
  it('lists them, because nothing else would ever mention them', async () => {
    /*
     * A wrong figure gets corrected by an amendment. A period nobody filed at
     * all is invisible by nature — nothing prompts you about a form you did not
     * think about — and it is what draws an assessment.
     */
    const outstanding = await withTenant(sql, ctx, (tx) =>
      outstandingTaxPeriods(tx, ctx, '2026-12-31'),
    );

    const starts = outstanding.map((p) => p.start);

    // January–February was never prepared.
    expect(starts).toContain('2026-01-01');
    // March–April and May–June were, so they are not outstanding.
    expect(starts).not.toContain('2026-03-01');
    expect(starts).not.toContain('2026-05-01');
    // Every entry names the regime, since the two file separately.
    expect(outstanding.every((p) => p.regime === 'SST_SERVICE')).toBe(true);
  });

  it('does not report a period that has not ended yet', async () => {
    // A period still running is current, not outstanding.
    const outstanding = await withTenant(sql, ctx, (tx) =>
      outstandingTaxPeriods(tx, ctx, '2026-02-15'),
    );
    expect(outstanding).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

describe('readiness reports the return capability', () => {
  it('is READY once registered, and blocked without a registration', async () => {
    const ready = await withTenant(sql, ctx, (tx) => tenantReadiness(tx, ctx));
    expect(ready.capabilities.find((c) => c.key === 'sst_return')!.status).toBe('READY');

    const other = await seedTenant(admin, 'Unregistered Sdn Bhd');
    const otherCtx = { tenantId: other.tenantId, userId: other.userId };
    const blocked = await withTenant(sql, otherCtx, (tx) => tenantReadiness(tx, otherCtx));
    const capability = blocked.capabilities.find((c) => c.key === 'sst_return')!;

    expect(capability.status).toBe('BLOCKED');
    expect(capability.source).toMatch(/RMCD/);
    // Honest about the part that is still unconfirmed even when registered.
    expect(capability.behaviourWhenBlocked).toMatch(/FORM LAYOUT is separately/);
  });

  it('refuses a registration with no traceable cycle', async () => {
    const other = await seedTenant(admin, 'Untraceable Sdn Bhd');
    const otherCtx = { tenantId: other.tenantId, userId: other.userId };

    await expect(
      withTenant(sql, otherCtx, (tx) =>
        setSstRegistration(tx, otherCtx, {
          regime: 'SST_SERVICE',
          registrationNo: 'W10-9999',
          cadenceMonths: 2,
          firstPeriodStart: '2026-01-01',
          sourceReference: 'dunno',
        }),
      ),
    ).rejects.toThrow(/where its taxable period cycle was confirmed/);
  });
});
