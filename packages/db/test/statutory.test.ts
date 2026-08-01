import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import {
  endWithholdingRate,
  listWithholdingRates,
  setWithholdingRate,
} from '../src/statutory.js';
import { tenantReadiness } from '../src/readiness.js';
import { seedSandboxStatutoryValues } from '../src/sandbox.js';
import { createBankAccount } from '../src/bank.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };

beforeAll(async () => {
  const db = await createTestDatabase('statutory');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Statutory Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const CITATION = 'LHDN Public Ruling 11/2018 s4.2';

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

describe('a statutory rate cannot enter without its source', () => {
  it('records a rate with a citation', async () => {
    const rate = await withTenant(sql, ctx, (tx) =>
      setWithholdingRate(tx, ctx, {
        paymentType: 'ROYALTY',
        rateBasisPoints: 1000,
        validFrom: '2026-01-01',
        legislationRef: CITATION,
      }),
    );

    expect(rate.ratePercent).toBe('10.00%');
    expect(rate.legislationRef).toBe(CITATION);
    // Who entered it, not just what. The rate is only as good as the person
    // who can be asked where it came from.
    expect(rate.verifiedBy).toBe(ctx.userId);
  });

  it('refuses a rate whose citation is not a citation', async () => {
    // The whole mechanism. Once a figure is in the table, nothing else can tell
    // a verified value from a guess someone made under time pressure — so the
    // citation is part of the row, with a length floor so "n/a" will not do.
    await expect(
      withTenant(sql, ctx, (tx) =>
        setWithholdingRate(tx, ctx, {
          paymentType: 'INTEREST',
          rateBasisPoints: 1500,
          validFrom: '2026-01-01',
          legislationRef: 'guess',
        }),
      ),
    ).rejects.toThrow(/must cite its source/);
  });

  it('is enforced by the database, not only by the service', async () => {
    // A convention in the service layer is exactly what gets skipped at 6pm on
    // a filing deadline. This is a CHECK constraint.
    await expect(
      admin`
          INSERT INTO wht_rate (tenant_id, payment_type, rate_basis_points,
                                valid_from, legislation_ref)
          VALUES (${ctx.tenantId}, 'BYPASS', 1000, '2026-01-01', 'n/a')
      `,
    ).rejects.toThrow(/legislation_ref/);
  });

  it('refuses a percentage entered where basis points belong', async () => {
    // 10 basis points is 0.1%, and someone typing 10 meant 10%. The one that
    // must be caught is the reverse: a percentage above 100 in a basis-point
    // field would withhold more than the payment.
    await expect(
      withTenant(sql, ctx, (tx) =>
        setWithholdingRate(tx, ctx, {
          paymentType: 'CONTRACT_PAYMENT',
          rateBasisPoints: 15_000,
          validFrom: '2026-01-01',
          legislationRef: CITATION,
        }),
      ),
    ).rejects.toThrow(/over 100%/);
  });
});

// ---------------------------------------------------------------------------
// Effective dating
// ---------------------------------------------------------------------------

describe('rates are effective-dated, never edited', () => {
  it('refuses a second rate overlapping the first', async () => {
    // Two rates in force on one date means the amount withheld depends on which
    // row is read first. That is not a configuration a resolver should pick
    // between; the person entering the second one knows which is right.
    await expect(
      withTenant(sql, ctx, (tx) =>
        setWithholdingRate(tx, ctx, {
          paymentType: 'ROYALTY',
          rateBasisPoints: 1200,
          validFrom: '2026-06-01',
          legislationRef: 'LHDN Public Ruling 12/2026 s2.1',
        }),
      ),
    ).rejects.toThrow(/already covers/);
  });

  it('accepts a successor once the earlier window is closed', async () => {
    const [royalty] = await withTenant(sql, ctx, (tx) => listWithholdingRates(tx, ctx)).then(
      (all) => all.filter((r) => r.paymentType === 'ROYALTY'),
    );

    await withTenant(sql, ctx, (tx) =>
      endWithholdingRate(tx, ctx, royalty!.id, '2026-05-31'),
    );

    const successor = await withTenant(sql, ctx, (tx) =>
      setWithholdingRate(tx, ctx, {
        paymentType: 'ROYALTY',
        rateBasisPoints: 1200,
        validFrom: '2026-06-01',
        legislationRef: 'LHDN Public Ruling 12/2026 s2.1',
      }),
    );

    expect(successor.ratePercent).toBe('12.00%');

    // Both survive. A payment withheld in March was withheld at 10% and the
    // row that says so must still be there to explain it.
    const all = await withTenant(sql, ctx, (tx) => listWithholdingRates(tx, ctx));
    const royalties = all.filter((r) => r.paymentType === 'ROYALTY');
    expect(royalties).toHaveLength(2);
    expect(royalties.map((r) => r.ratePercent).sort()).toEqual(['10.00%', '12.00%']);
  });

  it('keeps a domestic and a treaty rate apart', async () => {
    // A treaty rate for the same payment type is not an overlap: it applies to
    // a different counterparty country.
    const treaty = await withTenant(sql, ctx, (tx) =>
      setWithholdingRate(tx, ctx, {
        paymentType: 'ROYALTY',
        countryCode: 'SG',
        rateBasisPoints: 800,
        validFrom: '2026-01-01',
        legislationRef: 'MY-SG Double Taxation Agreement Article 12(2)',
      }),
    );

    expect(treaty.countryCode).toBe('SG');
  });

  it('records every change as a financial event', async () => {
    const events = await admin<{ event_type: string }[]>`
        SELECT event_type FROM financial_event_log
         WHERE tenant_id = ${ctx.tenantId} AND event_type = 'STATUTORY_RATE_CHANGED'
    `;
    // Seeding a rate decides how much of a supplier's money is retained and
    // remitted to LHDN. It belongs on the list an auditor asks about by name.
    expect(events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

describe('readiness answers what this tenant cannot do', () => {
  it('reports the capabilities that ship inert, and why', async () => {
    const readiness = await withTenant(sql, ctx, (tx) => tenantReadiness(tx, ctx));

    const byKey = new Map(readiness.capabilities.map((c) => [c.key, c]));

    // Withholding is configured on this tenant by the tests above.
    expect(byKey.get('withholding')!.status).toBe('READY');

    // These are not, and each says what would fix it and who has it.
    for (const key of ['duitnow_qr', 'gateway_collections', 'einvoice_submission']) {
      const capability = byKey.get(key)!;
      expect(capability.status, key).toBe('BLOCKED');
      expect(capability.blockedBy, key).toBeTruthy();
      expect(capability.source, key).toBeTruthy();
    }

    // The one that matters most is explicit about why it is stricter.
    expect(byKey.get('duitnow_qr')!.behaviourWhenBlocked).toMatch(/pays the wrong party/);
    expect(readiness.fullyOperational).toBe(false);
  });

  it('reads the same configuration the feature reads', async () => {
    // A readiness check maintained beside the code drifts from it, and then
    // reports ready for something that refuses. This one moves when the
    // configuration moves.
    const before = await withTenant(sql, ctx, (tx) => tenantReadiness(tx, ctx));
    expect(before.capabilities.find((c) => c.key === 'statement_import')!.status).toBe('BLOCKED');

    await withTenant(sql, ctx, (tx) =>
      createBankAccount(tx, ctx, {
        name: 'Maybank Current',
        bankName: 'Malayan Banking Berhad',
        glAccountId: tenant.accounts['1000']!,
        openingBalance: '0',
        openingDate: '2026-01-01',
      }),
    );

    const after = await withTenant(sql, ctx, (tx) => tenantReadiness(tx, ctx));
    const importCapability = after.capabilities.find((c) => c.key === 'statement_import')!;
    // Still blocked, but for a DIFFERENT reason — which is the point: the check
    // tracks the actual state rather than a static list.
    expect(importCapability.blockedBy).toMatch(/import profile/);
  });
});

// ---------------------------------------------------------------------------
// Sandbox values
// ---------------------------------------------------------------------------

describe('sandbox values cannot be mistaken for verified ones', () => {
  it('seeds values that announce themselves, and readiness says SANDBOX not READY', async () => {
    const other = await seedTenant(admin, 'Sandboxed Sdn Bhd');
    const sandboxCtx = { tenantId: other.tenantId, userId: other.userId };

    const seeded = await withTenant(sql, sandboxCtx, (tx) =>
      seedSandboxStatutoryValues(tx, sandboxCtx),
    );
    expect(seeded.withholdingRates).toBeGreaterThan(0);

    const rates = await withTenant(sql, sandboxCtx, (tx) => listWithholdingRates(tx, sandboxCtx));

    for (const rate of rates) {
      // 99%. Nobody files that, which is exactly why it was chosen.
      expect(rate.ratePercent).toBe('99.00%');
      expect(rate.legislationRef).toMatch(/^SANDBOX/);
      expect(rate.legislationRef).toMatch(/NOT VERIFIED AGAINST LHDN/);
    }

    // The assertion this whole arrangement exists for: a fake value must never
    // report as verified.
    const readiness = await withTenant(sql, sandboxCtx, (tx) =>
      tenantReadiness(tx, sandboxCtx),
    );
    const withholding = readiness.capabilities.find((c) => c.key === 'withholding')!;
    expect(withholding.status).toBe('SANDBOX');
    expect(withholding.status).not.toBe('READY');
    expect(withholding.blockedBy).toMatch(/sandbox values/);
  });

  it('does not overwrite a real rate a tenant already entered', async () => {
    // Seeding is additive and skips what exists. A sandbox value replacing a
    // verified one would be the worst possible direction for this to fail.
    const before = await withTenant(sql, ctx, (tx) => listWithholdingRates(tx, ctx));
    await withTenant(sql, ctx, (tx) => seedSandboxStatutoryValues(tx, ctx));
    const after = await withTenant(sql, ctx, (tx) => listWithholdingRates(tx, ctx));

    const royalty = after.filter((r) => r.paymentType === 'ROYALTY' && r.countryCode === null);
    expect(royalty.every((r) => !r.legislationRef.startsWith('SANDBOX'))).toBe(true);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });
});
