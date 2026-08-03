/**
 * The item catalogue — M8, domain layer.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE HAS EXISTED SINCE MIGRATION 0002 WITH NO CODE BEHIND IT.
 *
 * `item` was created in M2 with a sale price, a sale account, a tax code, a
 * unit of measure and a MyInvois classification code. `invoice_line.item_id`
 * and `bill_line.item_id` have accepted an id since the same migration.
 * Nothing has ever written an item, nothing has ever read one, and the
 * `itemId` an invoice line accepts is stored and then ignored.
 *
 * So every invoice line has had to carry a description, a quantity, a unit
 * price, an account, a tax code AND a classification code, typed by hand, every
 * time. That is tedious, and it is also the direct cause of a compliance
 * failure the worker slice made visible: a line with no `classificationCode` is
 * rejected by MyInvois validation, dead-letters its outbox event, and the
 * invoice never reaches LHDN. The catalogue is where that code should come
 * from, once, per item.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * THIS IS A CATALOGUE. IT IS NOT INVENTORY, AND THAT IS A DECISION.
 *
 * There is no quantity on hand here, no stock valuation, no cost of goods sold
 * posted on sale, no reorder level. An item is a set of DEFAULTS for a document
 * line and nothing more.
 *
 * Perpetual inventory is a genuinely different system: it needs a costing
 * method (weighted average, FIFO, standard), it posts to the ledger on
 * movement rather than on invoice, it needs stock takes and variance accounts,
 * and under MPERS §13 the measurement basis has disclosure consequences.
 * Bolting a `quantity_on_hand` column onto this table would produce a number
 * that looks like stock, is maintained by nothing, and would end up on a
 * balance sheet. An item catalogue that is honest about being a catalogue is
 * more useful than an inventory module that is wrong.
 * ---------------------------------------------------------------------------
 *
 * Pure: the item is fetched by the caller and passed in.
 */

import type { Money } from './money.js';
import { err, ok, type Result } from './result.js';

export type ItemType = 'GOODS' | 'SERVICE';

/** Which side of the business a line is on. An item can serve either or both. */
export type TradeDirection = 'SALE' | 'PURCHASE';

/** The defaults an item supplies for one direction. */
export interface ItemSideDefaults {
  readonly unitPrice?: Money;
  readonly accountId?: string;
  readonly taxCodeId?: string;
}

export interface ItemMaster {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly itemType: ItemType;
  /** Free text shown to a human, e.g. "hour", "box of 12". */
  readonly unitOfMeasure: string;
  /**
   * The MyInvois unit-of-measure code.
   *
   * ⚠️ NOT DERIVED FROM `unitOfMeasure`. MyInvois expects a code from a
   * published list, and mapping "box" onto a guess would put an unverified
   * value on a submission to a tax authority. Optional, validated against a
   * reference table that ships EMPTY, and flagged for confirmation against
   * LHDN — the same treatment classification codes and withholding rates get.
   */
  readonly uomCode?: string;
  /** LHDN item classification code, defaulted onto every line for this item. */
  readonly classificationCode?: string;
  /** Longer text used as the default line description; falls back to `name`. */
  readonly description?: string;
  readonly isSold: boolean;
  readonly isPurchased: boolean;
  readonly isActive: boolean;
  readonly sale: ItemSideDefaults;
  readonly purchase: ItemSideDefaults;
}

/** What the caller supplied on the line. Quantity is always theirs. */
export interface LineOverride {
  /** Decimal string. An item has no inherent quantity, so this is required. */
  readonly quantity: string;
  readonly description?: string;
  readonly unitPrice?: Money;
  readonly accountId?: string;
  readonly taxCodeId?: string;
  readonly classificationCode?: string;
  readonly unitOfMeasure?: string;
}

export type FieldSource = 'ITEM' | 'CALLER';

export interface ResolvedLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: Money;
  readonly accountId: string;
  readonly taxCodeId: string;
  readonly classificationCode?: string;
  readonly unitOfMeasure?: string;
  readonly uomCode?: string;
  /**
   * Where each field came from.
   *
   * Returned rather than discarded because "why is this line priced at RM 80"
   * is a question users ask, and "the item says so" and "somebody typed it" are
   * very different answers. It is also what lets an interface show a
   * negotiated price as deliberately overridden rather than as a typo.
   */
  readonly provenance: Readonly<Record<string, FieldSource>>;
}

export type ItemViolation =
  | { readonly code: 'ITEM_INACTIVE'; readonly itemCode: string }
  | {
      readonly code: 'WRONG_DIRECTION';
      readonly itemCode: string;
      readonly direction: TradeDirection;
    }
  | {
      readonly code: 'NO_DEFAULT';
      readonly field: 'unitPrice' | 'accountId' | 'taxCodeId';
      readonly itemCode: string;
      readonly direction: TradeDirection;
    };

/**
 * Fill a document line from an item, letting the caller override anything.
 *
 * ---------------------------------------------------------------------------
 * THE VALUES ARE COPIED ONTO THE LINE, NEVER REFERENCED FROM IT.
 *
 * That is the whole design, and it is the same discipline as versioned tax
 * rates and the stored e-Invoice payload. A May invoice priced at RM 80 must
 * still say RM 80 after the item's price is raised to RM 95 in June —
 * otherwise reprinting last quarter's invoices silently restates revenue, and
 * a document already sent to a customer disagrees with the copy in the system.
 *
 * So this function runs ONCE, at issue, and the resolved values are written to
 * `invoice_line`. `item_id` is retained for reporting — "what did we sell" —
 * and for nothing else.
 * ---------------------------------------------------------------------------
 *
 * The caller always wins. An overridden price is a negotiated price, not a
 * mistake, and is recorded as `CALLER` rather than flagged.
 */
export function resolveLine(
  item: ItemMaster,
  direction: TradeDirection,
  override: LineOverride,
): Result<ResolvedLine, ItemViolation[]> {
  const violations: ItemViolation[] = [];

  if (!item.isActive) {
    // Refused for a NEW line. Existing documents that reference it are
    // untouched — an item is deactivated, never deleted, because deleting one
    // would orphan every historical line that points at it.
    violations.push({ code: 'ITEM_INACTIVE', itemCode: item.code });
  }

  const usable = direction === 'SALE' ? item.isSold : item.isPurchased;
  if (!usable) {
    // A cleaning service bought in is not a cleaning service sold. Silently
    // borrowing the sale account for a purchase line would post an expense to
    // a revenue account, which balances and is wrong.
    violations.push({ code: 'WRONG_DIRECTION', itemCode: item.code, direction });
  }

  if (violations.length > 0) return err(violations);

  const defaults = direction === 'SALE' ? item.sale : item.purchase;
  const provenance: Record<string, FieldSource> = {};

  const pick = <T>(field: string, supplied: T | undefined, fallback: T | undefined): T | undefined => {
    if (supplied !== undefined) {
      provenance[field] = 'CALLER';
      return supplied;
    }
    if (fallback !== undefined) {
      provenance[field] = 'ITEM';
      return fallback;
    }
    return undefined;
  };

  const unitPrice = pick('unitPrice', override.unitPrice, defaults.unitPrice);
  const accountId = pick('accountId', override.accountId, defaults.accountId);
  const taxCodeId = pick('taxCodeId', override.taxCodeId, defaults.taxCodeId);

  // A missing default with no override is refused rather than guessed. There
  // is no sensible fallback for "which revenue account" — posting to a
  // suspense account would produce a balanced ledger nobody can explain.
  for (const [field, value] of [
    ['unitPrice', unitPrice],
    ['accountId', accountId],
    ['taxCodeId', taxCodeId],
  ] as const) {
    if (value === undefined) {
      violations.push({ code: 'NO_DEFAULT', field, itemCode: item.code, direction });
    }
  }

  if (violations.length > 0) return err(violations);

  const description = pick('description', override.description, item.description ?? item.name)!;
  const classificationCode = pick(
    'classificationCode',
    override.classificationCode,
    item.classificationCode,
  );
  const unitOfMeasure = pick('unitOfMeasure', override.unitOfMeasure, item.unitOfMeasure);

  return ok({
    description,
    // Never defaulted. An item has no inherent quantity, and a line that
    // silently became "1" because nobody typed a number is a wrong invoice.
    quantity: override.quantity,
    unitPrice: unitPrice!,
    accountId: accountId!,
    taxCodeId: taxCodeId!,
    ...(classificationCode !== undefined ? { classificationCode } : {}),
    ...(unitOfMeasure !== undefined ? { unitOfMeasure } : {}),
    // Carried from the item only. There is no per-line override, because the
    // code describes the item's unit and not this sale of it.
    ...(item.uomCode !== undefined ? { uomCode: item.uomCode } : {}),
    provenance,
  });
}

// ---------------------------------------------------------------------------
// Item validity
// ---------------------------------------------------------------------------

export type ItemDefectCode =
  | 'BLANK_CODE'
  | 'BLANK_NAME'
  | 'NEITHER_SOLD_NOR_PURCHASED'
  | 'SOLD_WITHOUT_ACCOUNT'
  | 'PURCHASED_WITHOUT_ACCOUNT'
  | 'NEGATIVE_PRICE'
  | 'BLANK_UNIT_OF_MEASURE';

export interface ItemCheck {
  readonly valid: boolean;
  readonly defects: readonly { code: ItemDefectCode; message: string }[];
  /**
   * Not defects — an item is perfectly valid without these — but each one is a
   * document that will be rejected by MyInvois later, at submission, when the
   * user is trying to get paid rather than editing master data.
   */
  readonly einvoiceWarnings: readonly string[];
}

export function checkItem(item: ItemMaster): ItemCheck {
  const defects: { code: ItemDefectCode; message: string }[] = [];
  const einvoiceWarnings: string[] = [];

  const fail = (code: ItemDefectCode, message: string) => defects.push({ code, message });

  if (item.code.trim().length === 0) fail('BLANK_CODE', 'An item needs a code');
  if (item.name.trim().length === 0) fail('BLANK_NAME', 'An item needs a name');
  if (item.unitOfMeasure.trim().length === 0) {
    fail('BLANK_UNIT_OF_MEASURE', 'An item needs a unit of measure, even if it is "unit"');
  }

  if (!item.isSold && !item.isPurchased) {
    fail(
      'NEITHER_SOLD_NOR_PURCHASED',
      `Item ${item.code} is neither sold nor purchased, so no document line can use it`,
    );
  }

  if (item.isSold && item.sale.accountId === undefined) {
    fail(
      'SOLD_WITHOUT_ACCOUNT',
      `Item ${item.code} is marked as sold but has no revenue account, so every ` +
        'invoice line using it would have to supply one',
    );
  }

  if (item.isPurchased && item.purchase.accountId === undefined) {
    fail(
      'PURCHASED_WITHOUT_ACCOUNT',
      `Item ${item.code} is marked as purchased but has no expense account`,
    );
  }

  for (const [label, side] of [['sale', item.sale], ['purchase', item.purchase]] as const) {
    if (side.unitPrice?.isNegative()) {
      // A negative price is a credit note, not a price. Allowing one here
      // produces a document that reduces revenue while calling itself a sale.
      fail('NEGATIVE_PRICE', `Item ${item.code} has a negative ${label} price`);
    }
  }

  /*
   * The point of the catalogue, stated as a warning rather than a defect.
   *
   * An item with no classification code is legal and usable. Every invoice
   * line that takes its defaults from it will then be missing the one field
   * MyInvois rejects a document for — and that rejection arrives asynchronously,
   * days later, as a dead-lettered submission rather than as a form error.
   * Saying so at the point the item is created is the entire value.
   */
  if (item.isSold && item.classificationCode === undefined) {
    einvoiceWarnings.push(
      `Item ${item.code} has no MyInvois classification code. Invoices using it will be ` +
        'rejected at submission unless every line supplies one.',
    );
  }

  if (item.isSold && item.uomCode === undefined) {
    einvoiceWarnings.push(
      `Item ${item.code} has no MyInvois unit-of-measure code. ` +
        'Confirm the applicable code against LHDN rather than deriving it from ' +
        `"${item.unitOfMeasure}".`,
    );
  }

  return { valid: defects.length === 0, defects, einvoiceWarnings };
}

/**
 * Canonical form of an item code.
 *
 * `item` carries `UNIQUE (tenant_id, code)`, and without normalising, `SVC-01`,
 * `svc-01` and `SVC-01 ` are three different items to the database and one item
 * to the person looking at the list. A duplicate item is not merely untidy: two
 * items for one thing means sales of that thing are split across two lines of
 * every report that groups by item.
 *
 * Deliberately conservative — upper-cased and trimmed, with internal
 * whitespace collapsed. It does NOT strip punctuation: hyphens and dots carry
 * meaning in the part numbers Malaysian SMEs migrate in from AutoCount and UBS,
 * and collapsing `A-100` onto `A100` would merge two genuinely different items.
 */
export function normaliseItemCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, ' ');
}

/*
 * NO LINE ARITHMETIC LIVES HERE, DELIBERATELY.
 *
 * A `lineSubtotal(unitPrice, quantity)` belongs on this module by instinct, and
 * writing one would have been a mistake: `computeDocument` in `document.ts`
 * already extends every line, applies the discount, and rounds — under a
 * ROUNDING POLICY that varies by document. A second implementation here would
 * have hardcoded two decimal places and quietly disagreed with the invoice it
 * was supposed to describe, in the third decimal place, on fractional
 * quantities only. That is the hardest possible class of discrepancy to find.
 *
 * This module resolves DEFAULTS. The arithmetic has an owner, and it is not
 * this one.
 */
