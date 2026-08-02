import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import { isErr, unwrap } from '../src/result.js';
import {
  checkItem,
  normaliseItemCode,
  resolveLine,
  type ItemMaster,
  type LineOverride,
} from '../src/item.js';

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

const item = (over: Partial<ItemMaster> = {}): ItemMaster => ({
  id: 'item-1',
  code: 'SVC-01',
  name: 'Consulting',
  itemType: 'SERVICE',
  unitOfMeasure: 'hour',
  classificationCode: '022',
  isSold: true,
  isPurchased: false,
  isActive: true,
  sale: { unitPrice: rm('250.00'), accountId: 'acct-4000', taxCodeId: 'tax-svc' },
  purchase: {},
  ...over,
});

const line = (over: Partial<LineOverride> = {}): LineOverride => ({ quantity: '2', ...over });

// ---------------------------------------------------------------------------
// The gap the catalogue closes
// ---------------------------------------------------------------------------

describe('resolving a line from an item', () => {
  it('supplies everything but the quantity', () => {
    const resolved = unwrap(resolveLine(item(), 'SALE', line()));

    expect(resolved.description).toBe('Consulting');
    expect(resolved.unitPrice.equals(rm('250.00'))).toBe(true);
    expect(resolved.accountId).toBe('acct-4000');
    expect(resolved.taxCodeId).toBe('tax-svc');
    expect(resolved.unitOfMeasure).toBe('hour');
    expect(resolved.quantity).toBe('2');
  });

  it('supplies the MyInvois classification code, which is the whole point', () => {
    /*
     * A line with no classification code is rejected by MyInvois validation,
     * dead-letters its outbox event, and never reaches LHDN — days after the
     * invoice was issued and the customer was sent it. The person raising the
     * invoice has no reason to know the code exists. The catalogue does.
     */
    expect(unwrap(resolveLine(item(), 'SALE', line())).classificationCode).toBe('022');
  });

  it('never defaults the quantity', () => {
    // An item has no inherent quantity. A line that silently became "1"
    // because nobody typed a number is a wrong invoice, not a convenience.
    const resolved = unwrap(resolveLine(item(), 'SALE', line({ quantity: '7.5' })));
    expect(resolved.quantity).toBe('7.5');
    expect(resolved.provenance['quantity']).toBeUndefined();
  });

  it('lets the caller override anything, and records that they did', () => {
    // A negotiated price is not a mistake. Reporting the provenance is what
    // lets an interface show it as deliberate rather than as a typo.
    const resolved = unwrap(
      resolveLine(item(), 'SALE', line({ unitPrice: rm('200.00'), description: 'Discounted rate' })),
    );

    expect(resolved.unitPrice.equals(rm('200.00'))).toBe(true);
    expect(resolved.provenance['unitPrice']).toBe('CALLER');
    expect(resolved.provenance['description']).toBe('CALLER');
    // Untouched fields still say where they came from.
    expect(resolved.provenance['accountId']).toBe('ITEM');
  });

  it('prefers the item description over its name when both exist', () => {
    // `name` is the label in a picker; `description` is what a customer reads.
    const resolved = unwrap(
      resolveLine(item({ description: 'Senior consulting, per hour' }), 'SALE', line()),
    );
    expect(resolved.description).toBe('Senior consulting, per hour');
  });
});

// ---------------------------------------------------------------------------
// What it refuses
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('will not lend a sale account to a purchase line', () => {
    /*
     * The failure that would otherwise balance and be wrong: posting an
     * expense to a revenue account. A cleaning service bought in is not the
     * cleaning service you sell.
     */
    const result = resolveLine(item(), 'PURCHASE', line());

    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error).toContainEqual({
      code: 'WRONG_DIRECTION',
      itemCode: 'SVC-01',
      direction: 'PURCHASE',
    });
  });

  it('refuses a deactivated item for a NEW line', () => {
    const result = resolveLine(item({ isActive: false }), 'SALE', line());
    expect(isErr(result) && result.error[0]).toMatchObject({ code: 'ITEM_INACTIVE' });
  });

  it('refuses when a default is missing and nothing was supplied', () => {
    // There is no sensible fallback for "which revenue account". Posting to a
    // suspense account produces a balanced ledger nobody can explain.
    const bare = item({ sale: { unitPrice: rm('250.00') } });
    const result = resolveLine(bare, 'SALE', line());

    expect(isErr(result) && result.error.map((v) => 'field' in v && v.field).sort()).toEqual([
      'accountId',
      'taxCodeId',
    ]);
  });

  it('accepts the same bare item when the caller supplies the gaps', () => {
    const bare = item({ sale: { unitPrice: rm('250.00') } });
    const resolved = unwrap(
      resolveLine(bare, 'SALE', line({ accountId: 'acct-4000', taxCodeId: 'tax-svc' })),
    );

    expect(resolved.accountId).toBe('acct-4000');
    expect(resolved.provenance['accountId']).toBe('CALLER');
  });

  it('reports every violation at once rather than the first', () => {
    const result = resolveLine(item({ isActive: false, isSold: false }), 'SALE', line());
    expect(isErr(result) && result.error.map((v) => v.code).sort()).toEqual([
      'ITEM_INACTIVE',
      'WRONG_DIRECTION',
    ]);
  });
});

describe('an item usable on both sides', () => {
  const both = item({
    isPurchased: true,
    purchase: { unitPrice: rm('120.00'), accountId: 'acct-5000', taxCodeId: 'tax-none' },
  });

  it('resolves each direction from its own defaults', () => {
    const sale = unwrap(resolveLine(both, 'SALE', line()));
    const purchase = unwrap(resolveLine(both, 'PURCHASE', line()));

    expect(sale.unitPrice.equals(rm('250.00'))).toBe(true);
    expect(sale.accountId).toBe('acct-4000');
    expect(purchase.unitPrice.equals(rm('120.00'))).toBe(true);
    expect(purchase.accountId).toBe('acct-5000');
  });
});

// ---------------------------------------------------------------------------
// Item validity
// ---------------------------------------------------------------------------

describe('checkItem', () => {
  it('accepts an ordinary sold item', () => {
    expect(checkItem(item()).valid).toBe(true);
  });

  it('refuses an item marked sold with no revenue account', () => {
    const check = checkItem(item({ sale: { unitPrice: rm('10.00') } }));
    expect(check.valid).toBe(false);
    expect(check.defects.map((d) => d.code)).toContain('SOLD_WITHOUT_ACCOUNT');
  });

  it('refuses an item that is neither sold nor purchased', () => {
    const check = checkItem(item({ isSold: false, isPurchased: false }));
    expect(check.defects.map((d) => d.code)).toContain('NEITHER_SOLD_NOR_PURCHASED');
  });

  it('refuses a negative price, which is a credit note and not a price', () => {
    const check = checkItem(
      item({ sale: { unitPrice: rm('-10.00'), accountId: 'a', taxCodeId: 't' } }),
    );
    expect(check.defects.map((d) => d.code)).toContain('NEGATIVE_PRICE');
  });

  it('WARNS about a missing classification code without blocking the item', () => {
    /*
     * The distinction that matters. An item with no classification code is
     * legal and usable — but every invoice using it will be rejected by
     * MyInvois days later, asynchronously, as a dead-lettered submission
     * rather than as a form error. Saying so when the item is created is the
     * entire value of having the field here.
     */
    const check = checkItem(item({ classificationCode: undefined }));

    expect(check.valid).toBe(true);
    expect(check.einvoiceWarnings.join(' ')).toMatch(/classification code/);
  });

  it('WARNS about a missing UOM code rather than deriving one from the unit', () => {
    // "box", "carton" and "ctn" are one thing to a human and three strings
    // here. Inferring a MyInvois code from free text would put an unverified
    // value on a submission to a tax authority.
    const check = checkItem(item({ unitOfMeasure: 'box' }));
    expect(check.einvoiceWarnings.join(' ')).toMatch(/unit-of-measure code/);
    expect(check.einvoiceWarnings.join(' ')).toMatch(/against LHDN/);
  });
});

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

describe('normaliseItemCode', () => {
  it('folds case and trims, because two items for one thing splits every report', () => {
    expect(normaliseItemCode('  svc-01 ')).toBe('SVC-01');
    expect(normaliseItemCode('Svc-01')).toBe('SVC-01');
  });

  it('collapses internal whitespace', () => {
    expect(normaliseItemCode('PART  A  1')).toBe('PART A 1');
  });

  it('KEEPS punctuation, because part numbers carry it', () => {
    // Collapsing `A-100` onto `A100` would merge two genuinely different items
    // in a chart migrated from AutoCount or UBS.
    expect(normaliseItemCode('A-100')).toBe('A-100');
    expect(normaliseItemCode('A.100')).toBe('A.100');
    expect(normaliseItemCode('A-100')).not.toBe(normaliseItemCode('A100'));
  });

  it('PROPERTY: normalising is idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const once = normaliseItemCode(raw);
        expect(normaliseItemCode(once)).toBe(once);
      }),
    );
  });
});
