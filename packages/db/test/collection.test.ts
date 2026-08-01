import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, referenceMatch, type ImportProfile } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import {
  confirmCollection,
  createPaymentLink,
  FakeGateway,
  loadGatewayConfig,
  markGatewayEventProcessed,
  markPaymentLinkViewed,
  recordGatewayEvent,
  recordSettlement,
  resolvePaymentLink,
  unsettledCollections,
} from '../src/collection.js';
import { issueInvoice } from '../src/invoice.js';
import { createBankAccount, importStatement } from '../src/bank.js';
import { confirmMatch, suggestForAccount } from '../src/reconciliation.js';
import { detectRollupDrift } from '../src/ledger.js';
import { accountingEquationAt } from '../src/report.js';
import { hashToken } from '../src/identity.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await createTestDatabase('collection');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const MAYBANK: ImportProfile = {
  bankName: 'Maybank',
  delimiter: ',',
  dateFormat: 'DD/MM/YYYY',
  amountConvention: 'SIGNED',
  columns: { txnDate: 0, description: 1, amount: 2, runningBalance: 3 },
};

interface Fixture {
  readonly tenant: Tenant;
  readonly ctx: { tenantId: string; userId: string };
  readonly bankAccountId: string;
}

/** A tenant with FPX wired up: clearing account, fee account, settlement bank. */
async function collectionTenant(name: string): Promise<Fixture> {
  const tenant = await seedTenant(admin, name);
  const ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

  const bank = await withTenant(sql, ctx, (tx) =>
    createBankAccount(tx, ctx, {
      name: 'Maybank Current',
      bankName: 'Malayan Banking Berhad',
      glAccountId: tenant.accounts['1000']!,
      openingBalance: '0',
      openingDate: '2026-01-01',
    }),
  );

  await withTenant(sql, ctx, async (tx) => {
    await tx`
        INSERT INTO payment_gateway_config (
            tenant_id, provider, display_name, clearing_account_id,
            fee_account_id, settlement_bank_account_id
        )
        VALUES (
            ${ctx.tenantId}, 'FPX', 'Test FPX Gateway',
            ${tenant.accounts['1200']!}, ${tenant.accounts['6100']!}, ${bank.id}
        )
    `;
  });

  return { tenant, ctx, bankAccountId: bank.id };
}

/** An invoice for RM 1,080 — RM 1,000 plus 8% service tax. */
async function issueOne(
  f: Fixture,
  unitPrice = '1000.00',
): Promise<{ id: string; invoiceNo: string; total: string }> {
  return withTenant(sql, f.ctx, async (tx) => {
    const invoice = await issueInvoice(tx, f.ctx, {
      contactId: f.tenant.customerId,
      issueDate: '2026-08-03',
      lines: [
        {
          description: 'Consulting',
          quantity: '1',
          unitPrice,
          accountId: f.tenant.accounts['4000']!,
          taxCodeId: f.tenant.taxCodes['SST-SVC']!,
        },
      ],
      idempotencyKey: randomUUID(),
    });
    return { id: invoice.id, invoiceNo: invoice.invoiceNo, total: invoice.total };
  });
}

/**
 * A GL account's base-currency balance, debit-positive.
 *
 * Read on the ADMIN connection, which bypasses RLS. That is deliberate: an
 * assertion helper filtering by tenant_id itself proves the numbers are right
 * even if a policy is wrong, so a broken policy fails the isolation tests
 * rather than quietly zeroing every balance assertion in this file.
 */
async function accountBalance(f: Fixture, accountId: string): Promise<string> {
  const [row] = await admin<{ balance: string }[]>`
      -- Cast to the storage scale so an account with no lines reads '0.0000'
      -- like every other balance, rather than a bare integer '0'.
      SELECT COALESCE(SUM(l.base_debit - l.base_credit), 0)::numeric(19,4)::text AS balance
        FROM journal_line l
       WHERE l.tenant_id = ${f.ctx.tenantId} AND l.account_id = ${accountId}
  `;
  return row!.balance;
}

// ---------------------------------------------------------------------------
// Pay links
// ---------------------------------------------------------------------------

describe('payment links', () => {
  it('stores only a digest, and returns the token once', async () => {
    // A pay link is a bearer credential — whoever holds the URL sees an
    // invoice. Same class of asset as a session or an API key, so it gets the
    // same treatment: a database leak must not yield working links.
    const f = await collectionTenant('link_digest');
    const invoice = await issueOne(f);

    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    const [row] = await admin<{ token_hash: string }[]>`
        SELECT token_hash FROM payment_link WHERE id = ${link.id}
    `;

    expect(row!.token_hash).not.toBe(link.token);
    expect(row!.token_hash).toBe(hashToken(link.token));

    // The raw token appears nowhere in the row.
    const [dump] = await admin<{ body: string }[]>`
        SELECT to_jsonb(pl)::text AS body FROM payment_link pl WHERE pl.id = ${link.id}
    `;
    expect(dump!.body).not.toContain(link.token);
  });

  it('derives a reference the matching engine can find', async () => {
    // The join with M4. A random reference would be invisible when the money
    // arrives as a plain DuitNow Transfer rather than through the gateway.
    const f = await collectionTenant('link_reference');
    const invoice = await issueOne(f);

    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    expect(referenceMatch(invoice.invoiceNo, `IBG TRANSFER FR X ${link.reference}`)).toBe('EXACT');
  });

  it('resolves by token with no tenant context at all', async () => {
    // The pay page has no session, so RLS denies everything —
    // find_payment_link_by_digest is SECURITY DEFINER for the same reason the
    // login lookup is.
    const f = await collectionTenant('link_resolve');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    const resolved = await resolvePaymentLink(sql, link.token);

    expect(resolved).not.toBeNull();
    expect(resolved!.invoiceNo).toBe(invoice.invoiceNo);
    expect(resolved!.amount).toBe('1080.0000');
    expect(resolved!.merchantName).toBe('link_resolve');
    expect(resolved!.expired).toBe(false);
  });

  it('returns nothing for an unknown token', async () => {
    expect(await resolvePaymentLink(sql, 'not-a-real-token')).toBeNull();
  });

  it('reports an expired link rather than hiding it', async () => {
    // An expired link must still RESOLVE internally: a payment can confirm
    // minutes after expiry while the payer was mid-flow at their bank, and
    // that money is real. The route refuses it; the lookup does not.
    const f = await collectionTenant('link_expired');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, {
        invoiceId: invoice.id,
        expiresInDays: 1,
        idempotencyKey: randomUUID(),
      }),
    );

    await admin`
        UPDATE payment_link SET expires_at = now() - interval '1 hour' WHERE id = ${link.id}
    `;

    const resolved = await resolvePaymentLink(sql, link.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.expired).toBe(true);
  });

  it('counts views without blocking anything', async () => {
    const f = await collectionTenant('link_views');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    await withTenant(sql, f.ctx, (tx) => markPaymentLinkViewed(tx, f.ctx, link.id));
    await withTenant(sql, f.ctx, (tx) => markPaymentLinkViewed(tx, f.ctx, link.id));

    const [row] = await admin<{ view_count: number; status: string }[]>`
        SELECT view_count, status FROM payment_link WHERE id = ${link.id}
    `;
    expect(row!.view_count).toBe(2);
    expect(row!.status).toBe('VIEWED');
  });
});

// ---------------------------------------------------------------------------
// Webhook intake
// ---------------------------------------------------------------------------

describe('gateway_event — the webhook idempotency guarantee', () => {
  it('rejects a replayed provider event id at the database', async () => {
    // Not in a cache: a cache eviction or a restart would silently drop the
    // guarantee, and a double-processed PAID settles an invoice twice.
    const f = await collectionTenant('event_replay');
    const eventId = `evt_${randomUUID()}`;

    const first = await withTenant(sql, f.ctx, (tx) =>
      recordGatewayEvent(tx, f.ctx, {
        provider: 'FPX',
        providerEventId: eventId,
        eventType: 'PAID',
        raw: { hello: 'world' },
      }),
    );
    const second = await withTenant(sql, f.ctx, (tx) =>
      recordGatewayEvent(tx, f.ctx, {
        provider: 'FPX',
        providerEventId: eventId,
        eventType: 'PAID',
        raw: { hello: 'world' },
      }),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);

    const [stored] = await admin<{ count: string }[]>`
        SELECT count(*)::text FROM gateway_event WHERE provider_event_id = ${eventId}
    `;
    expect(stored!.count).toBe('1');
  });

  it('lets two tenants receive the same provider event id', async () => {
    // The key is (tenant, provider, event id). Two tenants on the same provider
    // legitimately see distinct events that happen to share an id namespace.
    const a = await collectionTenant('event_tenant_a');
    const b = await collectionTenant('event_tenant_b');
    const eventId = `evt_${randomUUID()}`;

    const forA = await withTenant(sql, a.ctx, (tx) =>
      recordGatewayEvent(tx, a.ctx, {
        provider: 'FPX',
        providerEventId: eventId,
        eventType: 'PAID',
        raw: {},
      }),
    );
    const forB = await withTenant(sql, b.ctx, (tx) =>
      recordGatewayEvent(tx, b.ctx, {
        provider: 'FPX',
        providerEventId: eventId,
        eventType: 'PAID',
        raw: {},
      }),
    );

    expect(forA.replayed).toBe(false);
    expect(forB.replayed).toBe(false);
  });

  it('is append-only: the payload cannot be rewritten or deleted', async () => {
    // This table is evidence of what a third party told us and when. An edited
    // webhook log cannot be used to reconstruct a disputed payment.
    const f = await collectionTenant('event_immutable');
    const event = await withTenant(sql, f.ctx, (tx) =>
      recordGatewayEvent(tx, f.ctx, {
        provider: 'FPX',
        providerEventId: `evt_${randomUUID()}`,
        eventType: 'PAID',
        amount: '1080.0000',
        raw: { original: true },
      }),
    );

    await expect(
      admin`UPDATE gateway_event SET amount = '9999.0000' WHERE id = ${event.id}`,
    ).rejects.toThrow(/append-only/);

    await expect(
      admin`DELETE FROM gateway_event WHERE id = ${event.id}`,
    ).rejects.toThrow(/append-only/);
  });

  it('permits exactly one mutation: marking the event processed', async () => {
    const f = await collectionTenant('event_processed');
    const event = await withTenant(sql, f.ctx, (tx) =>
      recordGatewayEvent(tx, f.ctx, {
        provider: 'FPX',
        providerEventId: `evt_${randomUUID()}`,
        eventType: 'PAID',
        raw: {},
      }),
    );

    await withTenant(sql, f.ctx, (tx) => markGatewayEventProcessed(tx, f.ctx, event.id));

    const [row] = await admin<{ processed_at: Date | null }[]>`
        SELECT processed_at FROM gateway_event WHERE id = ${event.id}
    `;
    expect(row!.processed_at).not.toBeNull();

    // And it is a one-way door: it cannot be cleared again.
    await expect(
      admin`UPDATE gateway_event SET processed_at = NULL WHERE id = ${event.id}`,
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------------------
// Confirming a collection — the clearing-account treatment
// ---------------------------------------------------------------------------

describe('confirmCollection', () => {
  it('debits the CLEARING account and leaves the bank untouched', async () => {
    // The whole point of the module. The naive Dr Bank / Cr AR overstates the
    // bank for two days and guarantees the eventual bank line never matches.
    const f = await collectionTenant('confirm_clearing');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    await withTenant(sql, f.ctx, (tx) =>
      confirmCollection(tx, f.ctx, {
        paymentLinkId: link.id,
        provider: 'FPX',
        providerRef: 'fpx_abc123',
        amount: '1080.00',
        paidAt: '2026-08-03T14:32:00.000Z',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(await accountBalance(f, f.tenant.accounts['1200']!)).toBe('1080.0000');
    expect(await accountBalance(f, f.tenant.accounts['1000']!)).toBe('0.0000');
    expect(await accountBalance(f, f.tenant.accounts['1100']!)).toBe('0.0000');

    const [inv] = await admin<{ status: string; amount_due: string }[]>`
        SELECT status, amount_due FROM invoice WHERE id = ${invoice.id}
    `;
    expect(inv!.status).toBe('PAID');
    expect(inv!.amount_due).toBe('0.0000');
  });

  it('settles the customer when they pay, not when the bank shows it', async () => {
    // What the customer believes, and what they will say on the phone. An aged
    // receivables report has to agree with it.
    const f = await collectionTenant('confirm_ageing');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    await withTenant(sql, f.ctx, (tx) =>
      confirmCollection(tx, f.ctx, {
        paymentLinkId: link.id,
        provider: 'FPX',
        providerRef: 'fpx_ageing',
        amount: '1080.00',
        paidAt: '2026-08-03T14:32:00.000Z',
        idempotencyKey: randomUUID(),
      }),
    );

    const [link_] = await admin<{ status: string; payment_id: string | null }[]>`
        SELECT status, payment_id FROM payment_link WHERE id = ${link.id}
    `;
    expect(link_!.status).toBe('PAID');
    expect(link_!.payment_id).not.toBeNull();

    // gateway_txn_id was declared in 0003 and never written until this slice.
    const [payment] = await admin<{ gateway_txn_id: string | null }[]>`
        SELECT gateway_txn_id FROM payment WHERE id = ${link_!.payment_id}
    `;
    expect(payment!.gateway_txn_id).toBe('fpx_ageing');
  });

  it('books a fee reported at confirmation as its own expense', async () => {
    // Never netted. Netting produces the same profit, so nothing looks wrong,
    // and the business never learns what it pays its payment provider.
    const f = await collectionTenant('confirm_fee');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    await withTenant(sql, f.ctx, (tx) =>
      confirmCollection(tx, f.ctx, {
        paymentLinkId: link.id,
        provider: 'FPX',
        providerRef: 'fpx_fee',
        amount: '1080.00',
        fee: '1.00',
        paidAt: '2026-08-03T14:32:00.000Z',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(await accountBalance(f, f.tenant.accounts['6100']!)).toBe('1.0000');
    // Gross in, fee out: 1080 - 1 left awaiting settlement.
    expect(await accountBalance(f, f.tenant.accounts['1200']!)).toBe('1079.0000');
    // AR still relieved at the full 1,080 — the customer paid 1,080.
    expect(await accountBalance(f, f.tenant.accounts['1100']!)).toBe('0.0000');
  });

  it('is idempotent on the key', async () => {
    const f = await collectionTenant('confirm_idempotent');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    const key = randomUUID();
    const args = {
      paymentLinkId: link.id,
      provider: 'FPX',
      providerRef: 'fpx_dup',
      amount: '1080.00',
      paidAt: '2026-08-03T14:32:00.000Z',
      idempotencyKey: key,
    };

    const first = await withTenant(sql, f.ctx, (tx) => confirmCollection(tx, f.ctx, args));
    const second = await withTenant(sql, f.ctx, (tx) => confirmCollection(tx, f.ctx, args));

    expect(first.receipt.replayed).toBe(false);
    expect(second.receipt.replayed).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id);
    expect(await accountBalance(f, f.tenant.accounts['1200']!)).toBe('1080.0000');
  });

  it('refuses a stale webhook even though it would otherwise be valid', async () => {
    // A signature does not expire on its own, so age is the only thing between
    // a captured payload and it being replayed a month later.
    const f = await collectionTenant('confirm_stale');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    await expect(
      withTenant(sql, f.ctx, (tx) =>
        confirmCollection(tx, f.ctx, {
          paymentLinkId: link.id,
          provider: 'FPX',
          providerRef: 'fpx_stale',
          amount: '1080.00',
          paidAt: '2026-07-03T14:32:00.000Z',
          sentAt: '2026-07-03T14:32:00.000Z',
          now: '2026-08-03T14:32:00.000Z',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/replay window/);
  });

  it('refuses to collect through a provider with no clearing account', async () => {
    // The failure this module exists to prevent: with no clearing account there
    // is nowhere to put money received and not yet banked, and the only
    // fallback would be to book straight to bank.
    const f = await collectionTenant('confirm_unconfigured');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    await expect(
      withTenant(sql, f.ctx, (tx) =>
        confirmCollection(tx, f.ctx, {
          paymentLinkId: link.id,
          provider: 'BILLPLZ',
          providerRef: 'x',
          amount: '1080.00',
          paidAt: '2026-08-03T14:32:00.000Z',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/No active payment gateway/);
  });
});

// ---------------------------------------------------------------------------
// Settlement, and the junction with the M4 matching engine
// ---------------------------------------------------------------------------

describe('settlement', () => {
  it('rejects a batch whose parts do not add up', async () => {
    // Accepting it would leave an unexplained residue in the clearing account
    // that nobody would ever trace back.
    const f = await collectionTenant('settle_unbalanced');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );
    const confirmed = await withTenant(sql, f.ctx, (tx) =>
      confirmCollection(tx, f.ctx, {
        paymentLinkId: link.id,
        provider: 'FPX',
        providerRef: 'fpx_1',
        amount: '1080.00',
        paidAt: '2026-08-03T14:32:00.000Z',
        idempotencyKey: randomUUID(),
      }),
    );

    await expect(
      withTenant(sql, f.ctx, (tx) =>
        recordSettlement(tx, f.ctx, {
          provider: 'FPX',
          providerBatchId: 'BATCH-BAD',
          settlementDate: '2026-08-05',
          bankAccountId: f.bankAccountId,
          reportedNet: '1000.00',
          items: [{ paymentId: confirmed.receipt.id, gross: '1080.00', fee: '1.00' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/does not add up/);
  });

  it('refuses to settle a payment twice', async () => {
    const f = await collectionTenant('settle_twice');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );
    const confirmed = await withTenant(sql, f.ctx, (tx) =>
      confirmCollection(tx, f.ctx, {
        paymentLinkId: link.id,
        provider: 'FPX',
        providerRef: 'fpx_1',
        amount: '1080.00',
        paidAt: '2026-08-03T14:32:00.000Z',
        idempotencyKey: randomUUID(),
      }),
    );

    const batch = {
      provider: 'FPX',
      settlementDate: '2026-08-05',
      bankAccountId: f.bankAccountId,
      reportedNet: '1079.00',
      items: [{ paymentId: confirmed.receipt.id, gross: '1080.00', fee: '1.00' }],
    };

    await withTenant(sql, f.ctx, (tx) =>
      recordSettlement(tx, f.ctx, {
        ...batch,
        providerBatchId: 'BATCH-1',
        idempotencyKey: randomUUID(),
      }),
    );

    // A different batch claiming the same payment. Allowing it would credit
    // the clearing account twice and overstate the bank.
    await expect(
      withTenant(sql, f.ctx, (tx) =>
        recordSettlement(tx, f.ctx, {
          ...batch,
          providerBatchId: 'BATCH-2',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow();
  });

  it('THE JUNCTION: three collections settle as one bank line the matcher finds', async () => {
    // Where M2 and M4 meet, and the reason this slice is shaped the way it is.
    // Three customers pay on Monday; the gateway settles once on Wednesday,
    // net of fees, as a SINGLE line. If the clearing treatment or the amounts
    // were wrong, it fails here rather than in production.
    const f = await collectionTenant('settle_junction');

    const collections: { paymentId: string; gross: string }[] = [];
    for (const price of ['1000.00', '2000.00', '3000.00']) {
      const invoice = await issueOne(f, price);
      const link = await withTenant(sql, f.ctx, (tx) =>
        createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
      );
      const confirmed = await withTenant(sql, f.ctx, (tx) =>
        confirmCollection(tx, f.ctx, {
          paymentLinkId: link.id,
          provider: 'FPX',
          providerRef: `fpx_${price}`,
          amount: invoice.total,
          paidAt: '2026-08-03T14:32:00.000Z',
          idempotencyKey: randomUUID(),
        }),
      );
      collections.push({ paymentId: confirmed.receipt.id, gross: invoice.total });
    }

    // 1,080 + 2,160 + 3,240 = 6,480 gross, in the clearing account, bank still zero.
    expect(await accountBalance(f, f.tenant.accounts['1200']!)).toBe('6480.0000');
    expect(await accountBalance(f, f.tenant.accounts['1000']!)).toBe('0.0000');

    const awaiting = await withTenant(sql, f.ctx, (tx) =>
      unsettledCollections(tx, f.ctx, 'FPX'),
    );
    expect(awaiting).toHaveLength(3);

    // Wednesday: one settlement, RM 3.00 of fees, RM 6,477 into the bank.
    const settlement = await withTenant(sql, f.ctx, (tx) =>
      recordSettlement(tx, f.ctx, {
        provider: 'FPX',
        providerBatchId: 'FPX-20260805-001',
        settlementDate: '2026-08-05',
        bankAccountId: f.bankAccountId,
        reportedNet: '6477.00',
        items: collections.map((c) => ({
          paymentId: c.paymentId,
          gross: c.gross,
          fee: '1.00',
        })),
        idempotencyKey: randomUUID(),
      }),
    );

    expect(settlement.net).toBe('6477.0000');
    expect(settlement.fees).toBe('3.0000');

    // The property that matters: the clearing account is back to zero. A
    // residue means money was recognised and never banked.
    expect(await accountBalance(f, f.tenant.accounts['1200']!)).toBe('0.0000');
    expect(await accountBalance(f, f.tenant.accounts['1000']!)).toBe('6477.0000');
    expect(await accountBalance(f, f.tenant.accounts['6100']!)).toBe('3.0000');

    // The bank statement: ONE line for the whole batch, as the bank sees it.
    await withTenant(sql, f.ctx, (tx) =>
      importStatement(tx, f.ctx, {
        bankAccountId: f.bankAccountId,
        statementDate: '2026-08-05',
        profile: MAYBANK,
        content: [
          'Date,Description,Amount,Balance',
          '05/08/2026,FPX SETTLEMENT FPX-20260805-001,6477.00,6477.00',
        ].join('\n'),
        idempotencyKey: randomUUID(),
      }),
    );

    const suggestions = await withTenant(sql, f.ctx, (tx) =>
      suggestForAccount(tx, f.ctx, f.bankAccountId),
    );

    const [bankLine] = await admin<{ id: string; amount: string }[]>`
        SELECT id, amount FROM bank_transaction WHERE tenant_id = ${f.ctx.tenantId}
    `;
    expect(bankLine!.amount).toBe('6477.0000');

    // The settlement journal is what the line matches — one entry, one amount.
    const forLine = suggestions.get(bankLine!.id) ?? [];
    expect(forLine.length).toBeGreaterThan(0);

    // The settlement journal, not the three payments. Those were deposited
    // into clearing and sum to the GROSS — matching them here would
    // double-count every receipt in the batch.
    const best = forLine[0]!;
    expect(best.kind).toBe('JOURNAL');
    expect(best.candidateIds).toEqual([settlement.journalEntryId]);

    await withTenant(sql, f.ctx, (tx) =>
      confirmMatch(tx, f.ctx, {
        bankTransactionId: bankLine!.id,
        matchedType: 'JOURNAL',
        matchedId: settlement.journalEntryId,
        amount: '6477.0000',
        method: 'MANUAL',
      }),
    );

    // Invariants: the equation still balances and the rollups have not drifted.
    const equation = await withTenant(sql, f.ctx, (tx) =>
      accountingEquationAt(tx, f.ctx, '2026-12-31'),
    );
    expect(equation.balances).toBe(true);

    const drift = await withTenant(sql, f.ctx, (tx) => detectRollupDrift(tx, f.ctx));
    expect(drift).toEqual([]);

    // And every collection is now accounted for.
    const stillAwaiting = await withTenant(sql, f.ctx, (tx) =>
      unsettledCollections(tx, f.ctx, 'FPX'),
    );
    expect(stillAwaiting).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('does not leak collection data across tenants', async () => {
    const a = await collectionTenant('isolate_a');
    const b = await collectionTenant('isolate_b');

    const invoice = await issueOne(a);
    const link = await withTenant(sql, a.ctx, (tx) =>
      createPaymentLink(tx, a.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    const seenByB = await withTenant(sql, b.ctx, (tx) =>
      tx<{ id: string }[]>`SELECT id FROM payment_link WHERE id = ${link.id}`,
    );
    expect(seenByB).toEqual([]);

    // Tenant B cannot confirm tenant A's link either — it is simply not there.
    await expect(
      withTenant(sql, b.ctx, (tx) =>
        confirmCollection(tx, b.ctx, {
          paymentLinkId: link.id,
          provider: 'FPX',
          providerRef: 'x',
          amount: '1080.00',
          paidAt: '2026-08-03T14:32:00.000Z',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/not found/);
  });

  it('keeps gateway configuration tenant-scoped', async () => {
    const a = await collectionTenant('config_a');
    const b = await collectionTenant('config_b');

    const forA = await withTenant(sql, a.ctx, (tx) => loadGatewayConfig(tx, a.ctx, 'FPX'));
    const forB = await withTenant(sql, b.ctx, (tx) => loadGatewayConfig(tx, b.ctx, 'FPX'));

    expect(forA.clearingAccountId).not.toBe(forB.clearingAccountId);
  });
});

// ---------------------------------------------------------------------------
// The port, with no credentials
// ---------------------------------------------------------------------------

describe('FakeGateway', () => {
  it('drives the flow end to end without any provider credentials', async () => {
    // Not a stub standing in for a missing Billplz client — no concrete adapter
    // ships with this slice at all. This is what makes the whole path
    // exercisable anyway.
    const gateway = new FakeGateway();
    const f = await collectionTenant('fake_gateway');
    const invoice = await issueOne(f);
    const link = await withTenant(sql, f.ctx, (tx) =>
      createPaymentLink(tx, f.ctx, { invoiceId: invoice.id, idempotencyKey: randomUUID() }),
    );

    const handle = await gateway.createPayment({
      amount: Money.fromDecimal('1080.00', 'MYR'),
      reference: link.reference,
      description: `Invoice ${invoice.invoiceNo}`,
      returnUrl: 'https://app.invalid/paid',
      callbackUrl: 'https://app.invalid/webhook',
    });

    expect(handle.redirectUrl).toContain(handle.providerRef);
    expect(gateway.requestFor(handle.providerRef)?.reference).toBe(link.reference);

    const event = gateway.parseEvent(
      JSON.stringify({
        eventId: 'evt_fake_1',
        providerRef: handle.providerRef,
        type: 'PAID',
        amount: '1080.00',
        fee: '1.00',
        sentAt: '2026-08-03T14:32:00.000Z',
      }),
    );

    expect(event.type).toBe('PAID');
    expect(event.amount.toDecimalString()).toBe('1080.0000');
    expect(event.fee?.toDecimalString()).toBe('1.0000');
  });
});
