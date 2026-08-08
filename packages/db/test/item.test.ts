import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql, type TenantContext } from '../src/client.js';
import {
  createItem,
  getItem,
  listItems,
  resolveLineFromItem,
  setItemActive,
  updateItem,
} from '../src/item.js';
import { issueInvoice } from '../src/invoice.js';
import { enterBill } from '../src/bill.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('item');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Item Sdn Bhd');

  await admin`
      INSERT INTO einvoice_classification_code (code, description)
      VALUES ('022', 'Others') ON CONFLICT DO NOTHING
  `;
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const ctx = (): TenantContext => ({ tenantId: tenant.tenantId, userId: tenant.userId });
const run = <T>(fn: (tx: Parameters<typeof getItem>[0]) => Promise<T>) =>
  withTenant(sql, ctx(), fn);

let sequence = 0;
const uniqueCode = (prefix: string) => `${prefix}-${(sequence += 1).toString().padStart(3, '0')}`;

async function makeItem(over: Parameters<typeof createItem>[2] | Record<string, unknown> = {}) {
  const input = {
    code: uniqueCode('SVC'),
    name: 'Consulting',
    unitOfMeasure: 'hour',
    classificationCode: '022',
    sale: {
      unitPrice: '250.00',
      accountId: tenant.accounts['4000']!,
      taxCodeId: tenant.taxCodes['SST-SVC']!,
    },
    ...(over as Record<string, unknown>),
  } as Parameters<typeof createItem>[2];

  return run((tx) => createItem(tx, ctx(), input));
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

describe('creating an item', () => {
  it('stores it and derives the direction from which side was filled in', async () => {
    const created = await makeItem();

    expect(created.isSold).toBe(true);
    // Nobody filled in the purchase block, so the item is not purchasable —
    // which is what stops it lending its revenue account to a bill line.
    expect(created.isPurchased).toBe(false);
    expect(created.sale.accountId).toBe(tenant.accounts['4000']);
  });

  it('normalises the code, so one thing cannot become two items', async () => {
    const code = uniqueCode('svc');
    const created = await makeItem({ code: `  ${code} ` });

    expect(created.code).toBe(code.toUpperCase());

    // The second attempt is refused rather than creating a near-duplicate that
    // splits this item's sales across two lines of every report.
    await expect(makeItem({ code: code.toUpperCase() })).rejects.toThrow(/already exists/);
  });

  it('one barcode, one item — the second claim is refused and names the first', async () => {
    const first = await makeItem({ barcode: '9556001234567' });
    expect(first.barcode).toBe('9556001234567');

    await expect(makeItem({ barcode: '9556001234567' })).rejects.toMatchObject({
      code: 'DUPLICATE_BARCODE',
    });

    // The exact lookup the scanner lane uses: one hit, and only the one.
    const found = await withTenant(sql, ctx(), (tx) =>
      listItems(tx, ctx(), { barcode: '9556001234567' }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(first.id);
    const none = await withTenant(sql, ctx(), (tx) =>
      listItems(tx, ctx(), { barcode: '955600123456' }), // one digit short: no substring match
    );
    expect(none).toHaveLength(0);
  });

  it('refuses a sold item with no revenue account', async () => {
    await expect(
      makeItem({ isSold: true, sale: { unitPrice: '10.00' } }),
    ).rejects.toThrow(/no revenue account/);
  });

  it('refuses an account belonging to another tenant', async () => {
    const other = await seedTenant(admin, 'Item Other Sdn Bhd');
    // RLS already filtered it out, so this is indistinguishable from a
    // made-up id — which is the point.
    await expect(
      makeItem({
        sale: {
          unitPrice: '10.00',
          accountId: other.accounts['4000']!,
          taxCodeId: tenant.taxCodes['SST-SVC']!,
        },
      }),
    ).rejects.toThrow(/No account/);
  });

  it('refuses an unknown classification code', async () => {
    await expect(makeItem({ classificationCode: '999' })).rejects.toThrow(
      /not a known MyInvois classification code/,
    );
  });

  it('refuses ANY unit-of-measure code, because the list ships empty', async () => {
    /*
     * Deliberate, and the message says so. `einvoice_uom_code` is seeded empty
     * pending LHDN's published reference data — so until it is loaded, no code
     * can be verified and none is accepted. Refusing beats storing an
     * unverifiable value that will be submitted to a tax authority.
     */
    await expect(makeItem({ uomCode: 'HUR' })).rejects.toThrow(
      /must be loaded from LHDN reference data/,
    );
  });

  it('accepts a UOM code once the reference list is loaded', async () => {
    await admin`
        INSERT INTO einvoice_uom_code (code, description, source_reference)
        VALUES ('HUR', 'Hour', 'FIXTURE ONLY — not verified against LHDN')
        ON CONFLICT DO NOTHING
    `;

    const created = await makeItem({ uomCode: 'HUR' });
    expect(created.uomCode).toBe('HUR');
  });

  it('warns about a missing classification code without refusing the item', async () => {
    const created = await makeItem({ classificationCode: undefined });

    expect(created.classificationCode).toBeNull();
    // Legal and usable; every invoice using it will be rejected at submission.
    // Saying so here is the whole value of the field living on the item.
    expect(created.einvoiceWarnings.join(' ')).toMatch(/classification code/);
  });
});

describe('editing and retiring', () => {
  it('does NOT change an invoice already issued', async () => {
    /*
     * THE ASSERTION THE WHOLE DESIGN RESTS ON.
     *
     * The resolved values are copied onto `invoice_line` at issue, so raising
     * the price in June leaves May's invoice reading RM 250. Referencing the
     * item instead would silently restate last quarter's revenue and make a
     * reprint disagree with the copy the customer already has.
     */
    const created = await makeItem();

    const invoice = await run((tx) =>
      issueInvoice(tx, ctx(), {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [{ itemId: created.id, quantity: '2' }],
        idempotencyKey: randomUUID(),
      }),
    );

    await run((tx) =>
      updateItem(tx, ctx(), created.id, {
        code: created.code,
        name: created.name,
        classificationCode: '022',
        sale: {
          unitPrice: '400.00',
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['SST-SVC']!,
        },
      }),
    );

    const [stored] = await run((tx) =>
      tx<{ unit_price: string; taxable_amount: string }[]>`
          SELECT unit_price, taxable_amount FROM invoice_line
           WHERE tenant_id = ${tenant.tenantId} AND invoice_id = ${invoice.id}
      `,
    );

    expect(stored!.unit_price).toBe('250.0000');
    expect(stored!.taxable_amount).toBe('500.0000');
  });

  it('deactivates rather than deletes, and keeps it out of the picker', async () => {
    const created = await makeItem();
    await run((tx) => setItemActive(tx, ctx(), created.id, false));

    const active = await run((tx) => listItems(tx, ctx(), {}));
    expect(active.map((i) => i.id)).not.toContain(created.id);

    // Still findable — "why can I not see the item I used last year" has to
    // have an answer, and the row is what a historical line points at.
    const all = await run((tx) => listItems(tx, ctx(), { includeInactive: true }));
    expect(all.map((i) => i.id)).toContain(created.id);
    expect((await run((tx) => getItem(tx, ctx(), created.id))).isActive).toBe(false);
  });

  it('refuses a deactivated item on a NEW line', async () => {
    const created = await makeItem();
    await run((tx) => setItemActive(tx, ctx(), created.id, false));

    await expect(
      run((tx) =>
        resolveLineFromItem(tx, ctx(), created.id, 'SALE', { quantity: '1' }),
      ),
    ).rejects.toThrow(/deactivated/);
  });

  it('does not confirm that another tenant’s item exists', async () => {
    const other = await seedTenant(admin, 'Item Theirs Sdn Bhd');
    const theirs = await withTenant(sql, { tenantId: other.tenantId, userId: other.userId }, (tx) =>
      createItem(tx, { tenantId: other.tenantId, userId: other.userId }, {
        code: 'THEIRS-1',
        name: 'Theirs',
        sale: {
          unitPrice: '1.00',
          accountId: other.accounts['4000']!,
          taxCodeId: other.taxCodes['SST-SVC']!,
        },
      }),
    );

    await expect(run((tx) => getItem(tx, ctx(), theirs.id))).rejects.toThrow(/No item/);
  });
});

// ---------------------------------------------------------------------------
// The line that made the catalogue worth building
// ---------------------------------------------------------------------------

describe('issuing an invoice from an item', () => {
  it('needs nothing but an id and a quantity', async () => {
    const created = await makeItem();

    const invoice = await run((tx) =>
      issueInvoice(tx, ctx(), {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [{ itemId: created.id, quantity: '3' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const [stored] = await run((tx) =>
      tx<
        {
          description: string; unit_price: string; account_id: string;
          tax_code_id: string; classification_code: string | null;
          unit_of_measure: string | null; item_id: string | null;
        }[]
      >`
          SELECT description, unit_price, account_id, tax_code_id,
                 classification_code, unit_of_measure, item_id
            FROM invoice_line
           WHERE tenant_id = ${tenant.tenantId} AND invoice_id = ${invoice.id}
      `,
    );

    expect(stored).toMatchObject({
      description: 'Consulting',
      unit_price: '250.0000',
      account_id: tenant.accounts['4000'],
      tax_code_id: tenant.taxCodes['SST-SVC'],
      unit_of_measure: 'hour',
      item_id: created.id,
    });

    // The field whose absence dead-letters the MyInvois submission days later.
    expect(stored!.classification_code).toBe('022');
  });

  it('still lets the caller override the price', async () => {
    const created = await makeItem();

    const invoice = await run((tx) =>
      issueInvoice(tx, ctx(), {
        contactId: tenant.customerId,
        issueDate: '2026-08-05',
        lines: [{ itemId: created.id, quantity: '1', unitPrice: '199.00' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const [stored] = await run((tx) =>
      tx<{ unit_price: string }[]>`
          SELECT unit_price FROM invoice_line
           WHERE tenant_id = ${tenant.tenantId} AND invoice_id = ${invoice.id}
      `,
    );

    expect(stored!.unit_price).toBe('199.0000');
  });

  it('refuses a line with neither an item nor the fields, naming what is missing', async () => {
    await expect(
      run((tx) =>
        issueInvoice(tx, ctx(), {
          contactId: tenant.customerId,
          issueDate: '2026-08-05',
          lines: [{ quantity: '1', description: 'Ad hoc' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/must supply unitPrice, accountId, taxCodeId/);
  });

  it('refuses to convert a base-currency item price onto a foreign invoice', async () => {
    /*
     * `item.sale_unit_price` is NUMERIC with no currency column, so it is MYR.
     * Defaulting RM 250 onto a USD invoice would produce a line reading $250 —
     * a four-fold overstatement that stays arithmetically consistent through
     * the ledger, the tax computation and every statement, and is therefore
     * invisible to every check this system has.
     */
    const created = await makeItem();

    await expect(
      run((tx) =>
        issueInvoice(tx, ctx(), {
          contactId: tenant.customerId,
          issueDate: '2026-08-05',
          currency: 'USD',
          fxRate: '4.20',
          lines: [{ itemId: created.id, quantity: '1' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/must supply its own unit price/);
  });

  it('refuses an item that is sold but not purchased on a BILL line', async () => {
    // Would otherwise post an expense to a revenue account: balanced, and wrong.
    const created = await makeItem();

    await expect(
      run((tx) =>
        enterBill(tx, ctx(), {
          supplierId: tenant.supplierId,
          billNo: `B-${randomUUID().slice(0, 8)}`,
          billDate: '2026-08-05',
          lines: [{ itemId: created.id, quantity: '1' }],
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/not marked as purchased/);
  });

  it('fills a bill line from an item that IS purchased', async () => {
    const created = await makeItem({
      code: uniqueCode('BUY'),
      name: 'Office supplies',
      isSold: false,
      isPurchased: true,
      sale: {},
      purchase: {
        unitPrice: '45.50',
        accountId: tenant.accounts['6000']!,
        taxCodeId: tenant.taxCodes['NONE']!,
      },
    });

    const bill = await run((tx) =>
      enterBill(tx, ctx(), {
        supplierId: tenant.supplierId,
        billNo: `B-${randomUUID().slice(0, 8)}`,
        billDate: '2026-08-05',
        lines: [{ itemId: created.id, quantity: '4' }],
        idempotencyKey: randomUUID(),
      }),
    );

    const [stored] = await run((tx) =>
      tx<{ description: string; unit_price: string; account_id: string }[]>`
          SELECT description, unit_price, account_id FROM bill_line
           WHERE tenant_id = ${tenant.tenantId} AND bill_id = ${bill.id}
      `,
    );

    expect(stored).toMatchObject({
      description: 'Office supplies',
      unit_price: '45.5000',
      account_id: tenant.accounts['6000'],
    });
  });
});

describe('searching the catalogue', () => {
  it('matches on code or name', async () => {
    await makeItem({ code: uniqueCode('FIND'), name: 'Distinctive widget' });

    expect((await run((tx) => listItems(tx, ctx(), { search: 'Distinctive' }))).length)
      .toBeGreaterThanOrEqual(1);
    expect((await run((tx) => listItems(tx, ctx(), { search: 'FIND' }))).length)
      .toBeGreaterThanOrEqual(1);
  });

  it('filters by direction, so an invoice picker shows only sellable items', async () => {
    const purchaseOnly = await makeItem({
      code: uniqueCode('BUYONLY'),
      isSold: false,
      isPurchased: true,
      sale: {},
      purchase: {
        unitPrice: '1.00',
        accountId: tenant.accounts['6000']!,
        taxCodeId: tenant.taxCodes['NONE']!,
      },
    });

    const sellable = await run((tx) => listItems(tx, ctx(), { direction: 'SALE' }));
    expect(sellable.map((i) => i.id)).not.toContain(purchaseOnly.id);

    const buyable = await run((tx) => listItems(tx, ctx(), { direction: 'PURCHASE' }));
    expect(buyable.map((i) => i.id)).toContain(purchaseOnly.id);
  });
});
