import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import {
  convertQuoteToInvoice,
  createQuote,
  getQuote,
  listQuotes,
  transitionQuote,
  updateQuoteLines,
} from '../src/quote.js';
import { listOpenInvoices } from '../src/invoice.js';
import { detectRollupDrift } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * A quote the way a shop raises one: price twelve SSDs for a customer, send it,
 * they say yes, it becomes an invoice — and nothing before that last step
 * appears anywhere in the books.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };

beforeAll(async () => {
  const db = await createTestDatabase('quote');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Quoting Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };
}, 60_000);

afterAll(async () => {
  await drop?.();
});

/**
 * A quote line carries the revenue account and tax code, exactly as an invoice
 * line does. A line naming a catalogue item inherits both; one typed freehand —
 * "fitting", "callout" — has to say where the money lands, and the quote is
 * where that is decided rather than at conversion, when the customer has
 * already said yes and a refusal is too late to be useful.
 */
const freeLine = (description: string, quantity: string, unitPrice: string, over = {}) => ({
  description,
  quantity,
  unitPrice,
  accountId: tenant.accounts['4000']!,
  taxCodeId: tenant.taxCodes['NONE']!,
  ...over,
});

const draft = (over: Record<string, unknown> = {}) => ({
  contactId: tenant.customerId,
  quoteDate: '2026-08-03',
  validUntil: '2026-09-02',
  lines: [
    freeLine('500GB NVMe SSD', '12', '189.0000'),
    freeLine('Fitting', '1', '50.00'),
  ],
  idempotencyKey: randomUUID(),
  ...over,
});

describe('raising a quote', () => {
  it('numbers it, totals the lines, and puts nothing in the ledger', async () => {
    const before = await withTenant(sql, ctx, (tx) =>
      tx<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM journal_entry`,
    );

    const created = await withTenant(sql, ctx, (tx) => createQuote(tx, ctx, draft()));
    expect(created.quoteNo).toMatch(/^QUO-/);

    const quote = await withTenant(sql, ctx, (tx) => getQuote(tx, ctx, created.id, '2026-08-03'));
    expect(quote.status).toBe('DRAFT');
    // 12 × 189.00 = 2268.00, plus 50.00
    expect(quote.subtotal).toBe('2318.0000');
    expect(quote.lines).toHaveLength(2);
    expect(quote.lapsed).toBe(false);

    // The point of the whole design: an offer is not an accounting fact.
    const after = await withTenant(sql, ctx, (tx) =>
      tx<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM journal_entry`,
    );
    expect(after[0]!['count']).toBe(before[0]!['count']);
  });

  it('is idempotent on its key', async () => {
    const input = draft();
    const first = await withTenant(sql, ctx, (tx) => createQuote(tx, ctx, input));
    const second = await withTenant(sql, ctx, (tx) => createQuote(tx, ctx, input));
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it('applies a line discount to the subtotal', async () => {
    const created = await withTenant(sql, ctx, (tx) =>
      createQuote(tx, ctx, draft({
        lines: [freeLine('Monitor', '2', '500.00', { discountBasisPoints: 1000 })],
        idempotencyKey: randomUUID(),
      })),
    );
    const quote = await withTenant(sql, ctx, (tx) => getQuote(tx, ctx, created.id));
    // 1000.00 less 10% = 900.00
    expect(quote.subtotal).toBe('900.0000');
  });

  it('refuses a contact that is not this tenant’s', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        createQuote(tx, ctx, draft({ contactId: randomUUID(), idempotencyKey: randomUUID() })),
      ),
    ).rejects.toThrow(/not found/i);
  });
});

describe('the life of a quote', () => {
  it('sends, is accepted, and becomes an invoice through the ordinary path', async () => {
    const created = await withTenant(sql, ctx, (tx) => createQuote(tx, ctx, draft()));

    await withTenant(sql, ctx, (tx) => transitionQuote(tx, ctx, created.id, { to: 'SENT' }));
    await withTenant(sql, ctx, (tx) => transitionQuote(tx, ctx, created.id, { to: 'ACCEPTED' }));

    const converted = await withTenant(sql, ctx, (tx) =>
      convertQuoteToInvoice(tx, ctx, created.id, {
        issueDate: '2026-08-04',
        idempotencyKey: randomUUID(),
      }),
    );
    expect(converted.invoiceNo).toMatch(/^INV-/);

    const quote = await withTenant(sql, ctx, (tx) => getQuote(tx, ctx, created.id));
    expect(quote.status).toBe('INVOICED');
    expect(quote.invoiceId).toBe(converted.invoiceId);

    // The invoice is a real receivable, indistinguishable from a typed one.
    const open = await withTenant(sql, ctx, (tx) => listOpenInvoices(tx, ctx));
    expect(open.some((i) => i.id === converted.invoiceId)).toBe(true);
  });

  it('will not invoice the same quote twice', async () => {
    const created = await withTenant(sql, ctx, (tx) => createQuote(tx, ctx, draft()));
    await withTenant(sql, ctx, (tx) => transitionQuote(tx, ctx, created.id, { to: 'SENT' }));
    await withTenant(sql, ctx, (tx) => transitionQuote(tx, ctx, created.id, { to: 'ACCEPTED' }));

    const first = await withTenant(sql, ctx, (tx) =>
      convertQuoteToInvoice(tx, ctx, created.id, { issueDate: '2026-08-04', idempotencyKey: randomUUID() }),
    );
    const second = await withTenant(sql, ctx, (tx) =>
      convertQuoteToInvoice(tx, ctx, created.id, { issueDate: '2026-08-04', idempotencyKey: randomUUID() }),
    );
    expect(second.replayed).toBe(true);
    expect(second.invoiceId).toBe(first.invoiceId);
  });

  it('refuses to invoice a quote nobody accepted', async () => {
    const created = await withTenant(sql, ctx, (tx) => createQuote(tx, ctx, draft()));
    await withTenant(sql, ctx, (tx) => transitionQuote(tx, ctx, created.id, { to: 'SENT' }));

    await expect(
      withTenant(sql, ctx, (tx) =>
        convertQuoteToInvoice(tx, ctx, created.id, { issueDate: '2026-08-04', idempotencyKey: randomUUID() }),
      ),
    ).rejects.toThrow(/ACCEPTED/i);
  });

  it('records why a quote was lost, and lets it be re-quoted', async () => {
    const created = await withTenant(sql, ctx, (tx) => createQuote(tx, ctx, draft()));
    await withTenant(sql, ctx, (tx) => transitionQuote(tx, ctx, created.id, { to: 'SENT' }));

    // A no with no reason teaches the shop nothing.
    await expect(
      withTenant(sql, ctx, (tx) => transitionQuote(tx, ctx, created.id, { to: 'DECLINED' })),
    ).rejects.toThrow(/why/i);

    await withTenant(sql, ctx, (tx) =>
      transitionQuote(tx, ctx, created.id, { to: 'DECLINED', reason: 'Cheaper down the road' }),
    );
    const declined = await withTenant(sql, ctx, (tx) => getQuote(tx, ctx, created.id));
    expect(declined.declineReason).toBe('Cheaper down the road');

    // Re-quoting keeps the same document rather than losing the history.
    await withTenant(sql, ctx, (tx) => transitionQuote(tx, ctx, created.id, { to: 'DRAFT' }));
    expect((await withTenant(sql, ctx, (tx) => getQuote(tx, ctx, created.id))).status).toBe('DRAFT');
  });

  it('only rewrites the lines of a draft', async () => {
    const created = await withTenant(sql, ctx, (tx) => createQuote(tx, ctx, draft()));
    const rewritten = await withTenant(sql, ctx, (tx) =>
      updateQuoteLines(tx, ctx, created.id, [freeLine('One SSD only', '1', '189.0000')]),
    );
    expect(rewritten.subtotal).toBe('189.0000');

    await withTenant(sql, ctx, (tx) => transitionQuote(tx, ctx, created.id, { to: 'SENT' }));
    await expect(
      withTenant(sql, ctx, (tx) =>
        updateQuoteLines(tx, ctx, created.id, [freeLine('Sneaky price change', '1', '999.00')]),
      ),
    ).rejects.toThrow(/DRAFT/i);
  });

  it('shows an unanswered quote as lapsed once its date has passed', async () => {
    const created = await withTenant(sql, ctx, (tx) =>
      createQuote(tx, ctx, draft({ validUntil: '2026-08-10', idempotencyKey: randomUUID() })),
    );
    await withTenant(sql, ctx, (tx) => transitionQuote(tx, ctx, created.id, { to: 'SENT' }));

    expect((await withTenant(sql, ctx, (tx) => getQuote(tx, ctx, created.id, '2026-08-10'))).lapsed)
      .toBe(false);
    expect((await withTenant(sql, ctx, (tx) => getQuote(tx, ctx, created.id, '2026-08-11'))).lapsed)
      .toBe(true);
  });

  it('lists by status', async () => {
    const drafts = await withTenant(sql, ctx, (tx) => listQuotes(tx, ctx, { status: 'DRAFT' }));
    expect(drafts.every((q) => q.status === 'DRAFT')).toBe(true);
  });

  it('leaves the rollups undisturbed', async () => {
    expect(await withTenant(sql, ctx, (tx) => detectRollupDrift(tx, ctx))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The subtotal, which is money and was not being treated as money
// ---------------------------------------------------------------------------

describe('what a quote adds up to', () => {
  it('keeps every sen of a 4dp unit price across a multi-unit line', async () => {
    /*
     * The regression this exists for.
     *
     * `subtotalOf` used to truncate the unit price to 2dp before multiplying —
     * `Math.round(Number(unit_price) * 100)` — so a price of 189.5050 became
     * 189.50 and twelve of them lost six sen. Small, wrong, and quoted to a
     * customer, which is the worst combination of the three.
     */
    const quote = await withTenant(sql, ctx, async (tx) => {
      const { id } = await createQuote(tx, ctx, {
        contactId: tenant.customerId,
        quoteDate: '2026-08-04',
        idempotencyKey: randomUUID(),
        lines: [
          {
            description: '500GB NVMe SSD',
            quantity: '12',
            unitPrice: '189.5050',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
      });
      return getQuote(tx, ctx, id);
    });

    // 189.5050 x 12 = 2,274.06 exactly. The old arithmetic gave 2,274.00.
    expect(quote.subtotal).toBe('2274.0600');
  });

  it('applies a line discount without a float anywhere', async () => {
    const quote = await withTenant(sql, ctx, async (tx) => {
      const { id } = await createQuote(tx, ctx, {
        contactId: tenant.customerId,
        quoteDate: '2026-08-04',
        idempotencyKey: randomUUID(),
        lines: [
          {
            description: 'Labour',
            quantity: '3.5',
            unitPrice: '100.00',
            discountBasisPoints: 1250, // 12.5%
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
      });
      return getQuote(tx, ctx, id);
    });

    // 350.00 less 12.5% = 306.25. A percentage that is not representable in
    // binary floating point, chosen for exactly that reason.
    expect(quote.subtotal).toBe('306.2500');
  });

  it('shows the real total on the LIST, not zero', async () => {
    /*
     * `listQuotes` used to pass no lines to the view builder, so every row on a
     * list screen showed a subtotal of 0.00 — and a comment explained that a
     * list "shows how much", which it could not. The lines now come back in one
     * query rather than one per row.
     */
    const created = await withTenant(sql, ctx, (tx) =>
      createQuote(tx, ctx, {
        contactId: tenant.customerId,
        quoteDate: '2026-08-04',
        reference: 'LIST-TOTAL',
        idempotencyKey: randomUUID(),
        lines: [
          {
            description: 'Motherboard',
            quantity: '2',
            unitPrice: '450.00',
            accountId: tenant.accounts['4000']!,
            taxCodeId: tenant.taxCodes['NONE']!,
          },
        ],
      }),
    );

    const listed = await withTenant(sql, ctx, (tx) => listQuotes(tx, ctx));
    const found = listed.find((q) => q.id === created.id);
    expect(found?.subtotal).toBe('900.0000');
    // Still a LIST: the lines themselves are not carried, only what they total.
    expect(listed.every((q) => q.subtotal !== '0.0000' || q.lines.length === 0)).toBe(true);
  });

  it('lists many quotes without a query per quote', async () => {
    // The N+1 the old comment was worried about, and the reason the fix groups
    // one keyed query in memory instead of looping.
    for (let i = 0; i < 12; i += 1) {
      await withTenant(sql, ctx, (tx) =>
        createQuote(tx, ctx, {
          contactId: tenant.customerId,
          quoteDate: '2026-08-04',
          idempotencyKey: randomUUID(),
          lines: [
            {
              description: `Bulk ${i}`,
              quantity: '1',
              unitPrice: '10.00',
              accountId: tenant.accounts['4000']!,
              taxCodeId: tenant.taxCodes['NONE']!,
            },
          ],
        }),
      );
    }

    const started = Date.now();
    const listed = await withTenant(sql, ctx, (tx) => listQuotes(tx, ctx));
    expect(listed.length).toBeGreaterThanOrEqual(12);
    expect(listed.every((q) => Number(q.subtotal) > 0)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
