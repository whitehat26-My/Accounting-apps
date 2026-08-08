import {
  checkItem,
  isErr,
  Money,
  normaliseItemCode,
  resolveLine,
  type ItemMaster,
  type ItemType,
  type LineOverride,
  type ResolvedLine,
  type TradeDirection,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { loadBaseCurrency } from './invoice.js';

/**
 * The item catalogue — M8, persistence layer.
 *
 * The domain module decides what an item means and how a line resolves from
 * one. This layer stores it, and owns the two things storage decides: code
 * uniqueness, and the fact that an item is DEACTIVATED rather than deleted.
 */

export class ItemError extends Error {
  constructor(
    readonly code:
      | 'ITEM_NOT_FOUND'
      | 'ITEM_INVALID'
      | 'DUPLICATE_CODE'
      | 'DUPLICATE_BARCODE'
      | 'ACCOUNT_NOT_FOUND'
      | 'UNKNOWN_UOM_CODE'
      | 'ITEM_IN_USE'
      | 'ITEM_HAS_STOCK',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ItemError';
  }
}

export interface ItemView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  /** What the scanner reads off the shelf. Null for services and odd lots. */
  readonly barcode: string | null;
  readonly itemType: ItemType;
  readonly unitOfMeasure: string;
  readonly uomCode: string | null;
  readonly classificationCode: string | null;
  readonly isSold: boolean;
  readonly isPurchased: boolean;
  /** Perpetual inventory: quantities and weighted-average cost are kept. */
  readonly isTracked: boolean;
  /** Every unit carries a serial. Requires isTracked. */
  readonly isSerialised: boolean;
  /** Months promised when a serialised unit sells. 0 = no promise. */
  readonly warrantyMonths: number;
  readonly isActive: boolean;
  readonly sale: { unitPrice: string | null; accountId: string | null; taxCodeId: string | null };
  readonly purchase: { unitPrice: string | null; accountId: string | null; taxCodeId: string | null };
  /** Non-blocking, and the reason the catalogue exists — see `checkItem`. */
  readonly einvoiceWarnings: readonly string[];
}

export interface UpsertItemInput {
  readonly code: string;
  readonly name: string;
  readonly description?: string;
  readonly barcode?: string;
  readonly itemType?: ItemType;
  readonly unitOfMeasure?: string;
  readonly uomCode?: string;
  readonly classificationCode?: string;
  readonly isSold?: boolean;
  readonly isPurchased?: boolean;
  readonly isTracked?: boolean;
  readonly isSerialised?: boolean;
  readonly warrantyMonths?: number;
  readonly sale?: { unitPrice?: string; accountId?: string; taxCodeId?: string };
  readonly purchase?: { unitPrice?: string; accountId?: string; taxCodeId?: string };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SELECT_COLUMNS = `
    i.id, i.code, i.name, i.description, i.barcode, i.item_type, i.unit_of_measure,
    i.uom_code, i.classification_code, i.is_sold, i.is_purchased, i.is_tracked,
    i.is_serialised, i.warranty_months, i.is_active,
    i.sale_unit_price, i.sale_account_id, i.sale_tax_code_id,
    i.purchase_unit_price, i.purchase_account_id, i.purchase_tax_code_id
`;

interface ItemRow {
  id: string; code: string; name: string; description: string | null;
  barcode: string | null;
  item_type: ItemType; unit_of_measure: string; uom_code: string | null;
  classification_code: string | null;
  is_sold: boolean; is_purchased: boolean; is_tracked: boolean; is_serialised: boolean;
  warranty_months: number;
  is_active: boolean;
  sale_unit_price: string | null; sale_account_id: string | null; sale_tax_code_id: string | null;
  purchase_unit_price: string | null; purchase_account_id: string | null;
  purchase_tax_code_id: string | null;
}

export interface ListItemsOptions {
  /** Substring match on code or name. */
  readonly search?: string;
  /**
   * EXACT match on the barcode — the scanner lane's lookup. Exact, not
   * substring: a scanner types the whole code, and "8888" matching four
   * different EANs by substring would add the wrong item to a sale.
   */
  readonly barcode?: string;
  readonly direction?: TradeDirection;
  readonly includeInactive?: boolean;
  readonly limit?: number;
}

export async function listItems(
  tx: Tx,
  ctx: TenantContext,
  options: ListItemsOptions = {},
): Promise<ItemView[]> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const search = options.search?.trim();

  const rows = await tx<ItemRow[]>`
      SELECT ${tx.unsafe(SELECT_COLUMNS)}
        FROM item i
       WHERE i.tenant_id = ${ctx.tenantId}
         AND (${options.includeInactive ?? false} OR i.is_active)
         AND (${options.direction ?? null}::text IS NULL
              OR (${options.direction ?? null} = 'SALE'     AND i.is_sold)
              OR (${options.direction ?? null} = 'PURCHASE' AND i.is_purchased))
         AND (${search ?? null}::text IS NULL
              OR i.code ILIKE ${'%' + (search ?? '') + '%'}
              OR i.name ILIKE ${'%' + (search ?? '') + '%'})
         AND (${options.barcode ?? null}::text IS NULL OR i.barcode = ${options.barcode ?? null})
       ORDER BY i.code
       LIMIT ${Math.min(options.limit ?? 200, 500)}
  `;

  return rows.map((r) => toView(r, baseCurrency));
}

export async function getItem(tx: Tx, ctx: TenantContext, id: string): Promise<ItemView> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const [row] = await tx<ItemRow[]>`
      SELECT ${tx.unsafe(SELECT_COLUMNS)}
        FROM item i
       WHERE i.tenant_id = ${ctx.tenantId} AND i.id = ${id}
  `;

  // 404 rather than a distinguishable "not yours" — CLAUDE.md §9.
  if (!row) throw new ItemError('ITEM_NOT_FOUND', `No item ${id}`);
  return toView(row, baseCurrency);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createItem(
  tx: Tx,
  ctx: TenantContext,
  input: UpsertItemInput,
): Promise<ItemView> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const code = normaliseItemCode(input.code);

  const draft = draftFrom(input, code, baseCurrency);
  await validate(tx, ctx, draft, input);

  const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM item WHERE tenant_id = ${ctx.tenantId} AND code = ${code}
  `;
  if (existing) {
    throw new ItemError(
      'DUPLICATE_CODE',
      `An item with code ${code} already exists. Two items for one thing splits its ` +
        'sales across two lines of every report that groups by item.',
    );
  }
  await assertBarcodeFree(tx, ctx, input.barcode);

  const [row] = await tx<ItemRow[]>`
      INSERT INTO item (
          tenant_id, code, name, description, barcode, item_type, unit_of_measure, uom_code,
          classification_code, is_sold, is_purchased, is_tracked, is_serialised,
          warranty_months,
          sale_unit_price, sale_account_id, sale_tax_code_id,
          purchase_unit_price, purchase_account_id, purchase_tax_code_id
      ) VALUES (
          ${ctx.tenantId}, ${code}, ${input.name}, ${input.description ?? null},
          ${input.barcode ?? null},
          ${input.itemType ?? 'SERVICE'}, ${input.unitOfMeasure ?? 'UNIT'},
          ${input.uomCode ?? null}, ${input.classificationCode ?? null},
          ${draft.isSold}, ${draft.isPurchased}, ${input.isTracked ?? false},
          ${input.isSerialised ?? false},
          ${input.warrantyMonths ?? 0},
          ${input.sale?.unitPrice ?? null}, ${input.sale?.accountId ?? null},
          ${input.sale?.taxCodeId ?? null},
          ${input.purchase?.unitPrice ?? null}, ${input.purchase?.accountId ?? null},
          ${input.purchase?.taxCodeId ?? null}
      )
      RETURNING ${tx.unsafe(SELECT_COLUMNS.replace(/i\./g, ''))}
  `;

  return toView(row!, baseCurrency);
}

/**
 * Edit an item.
 *
 * ---------------------------------------------------------------------------
 * CHANGES ARE NOT RETROACTIVE, AND THAT IS THE POINT.
 *
 * Raising a price here does NOT change any invoice already issued. The
 * resolved values were copied onto `invoice_line` at issue, so history is
 * untouched — which is why `item_id` must never be joined to for an amount.
 *
 * That is also why there is no confirmation prompt or version history on this
 * operation: it cannot damage anything that already happened. The audit
 * trigger from 0016 records the before-and-after regardless.
 * ---------------------------------------------------------------------------
 */
export async function updateItem(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  input: UpsertItemInput,
): Promise<ItemView> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const current = await getItem(tx, ctx, id);
  const code = normaliseItemCode(input.code);

  const draft = draftFrom(input, code, baseCurrency);
  await validate(tx, ctx, draft, input);

  /*
   * Untracking an item that still holds stock is refused. The pool's value is
   * sitting on the balance sheet in the INVENTORY account; flipping the flag
   * would strand that value with no movement path left to relieve it — an
   * asset the system can no longer explain. Count the stock to zero first (the
   * write-off says where the value went), then untrack.
   */
  if (current.isTracked && input.isTracked === false) {
    const [stock] = await tx<{ quantity_on_hand: string; stock_value: string }[]>`
        SELECT quantity_on_hand, stock_value FROM item_stock
         WHERE tenant_id = ${ctx.tenantId} AND item_id = ${id}
    `;
    if (stock && (Number(stock.quantity_on_hand) !== 0 || Number(stock.stock_value) !== 0)) {
      throw new ItemError(
        'ITEM_HAS_STOCK',
        `Item ${current.code} still has ${stock.quantity_on_hand} on hand worth ` +
          `${stock.stock_value}. Count it to zero before untracking, so the write-down ` +
          'says where the value went.',
      );
    }
  }

  /*
   * Toggling serial tracking is only possible through an empty shelf, in
   * EITHER direction. Turning it ON with stock on hand would leave units the
   * system holds no serials for — serial drift by construction. Turning it OFF
   * with units IN_STOCK would strand unit records nothing can ever issue.
   * Count to zero, flip the flag, count back in (with serials, if turning on).
   */
  const serialisedChanging =
    input.isSerialised !== undefined && input.isSerialised !== current.isSerialised;
  if (serialisedChanging) {
    const [stock] = await tx<{ quantity_on_hand: string }[]>`
        SELECT quantity_on_hand FROM item_stock
         WHERE tenant_id = ${ctx.tenantId} AND item_id = ${id}
    `;
    if (stock && Number(stock.quantity_on_hand) !== 0) {
      throw new ItemError(
        'ITEM_HAS_STOCK',
        `Item ${current.code} has ${stock.quantity_on_hand} on hand. Serial tracking can ` +
          'only be switched on or off through an empty shelf — count to zero first, then ' +
          'count back in.',
      );
    }
  }

  if (code !== current.code) {
    const [clash] = await tx<{ id: string }[]>`
        SELECT id FROM item
         WHERE tenant_id = ${ctx.tenantId} AND code = ${code} AND id <> ${id}
    `;
    if (clash) throw new ItemError('DUPLICATE_CODE', `An item with code ${code} already exists`);
  }

  await assertBarcodeFree(tx, ctx, input.barcode, id);

  const [row] = await tx<ItemRow[]>`
      UPDATE item
         SET code                 = ${code},
             name                 = ${input.name},
             description          = ${input.description ?? null},
             barcode              = ${input.barcode ?? null},
             item_type            = ${input.itemType ?? current.itemType},
             unit_of_measure      = ${input.unitOfMeasure ?? current.unitOfMeasure},
             uom_code             = ${input.uomCode ?? null},
             classification_code  = ${input.classificationCode ?? null},
             is_sold              = ${draft.isSold},
             is_purchased         = ${draft.isPurchased},
             is_tracked           = ${input.isTracked ?? current.isTracked},
             is_serialised        = ${input.isSerialised ?? current.isSerialised},
             warranty_months      = ${input.warrantyMonths ?? current.warrantyMonths},
             sale_unit_price      = ${input.sale?.unitPrice ?? null},
             sale_account_id      = ${input.sale?.accountId ?? null},
             sale_tax_code_id     = ${input.sale?.taxCodeId ?? null},
             purchase_unit_price  = ${input.purchase?.unitPrice ?? null},
             purchase_account_id  = ${input.purchase?.accountId ?? null},
             purchase_tax_code_id = ${input.purchase?.taxCodeId ?? null},
             updated_at           = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
      RETURNING ${tx.unsafe(SELECT_COLUMNS.replace(/i\./g, ''))}
  `;

  return toView(row!, baseCurrency);
}

/**
 * Retire an item, or bring it back.
 *
 * DEACTIVATION, never deletion. Every invoice and bill line that used the item
 * carries its id, and deleting the row would either fail on the foreign key or
 * — worse, if somebody added a cascade — silently strip the link between a
 * historical document and what was actually sold.
 */
export async function setItemActive(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  isActive: boolean,
): Promise<ItemView> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const [row] = await tx<ItemRow[]>`
      UPDATE item SET is_active = ${isActive}, updated_at = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
      RETURNING ${tx.unsafe(SELECT_COLUMNS.replace(/i\./g, ''))}
  `;

  if (!row) throw new ItemError('ITEM_NOT_FOUND', `No item ${id}`);
  return toView(row, baseCurrency);
}

// ---------------------------------------------------------------------------
// The reason the catalogue exists
// ---------------------------------------------------------------------------

/**
 * Resolve a document line's fields from an item.
 *
 * Called by `issueInvoice` and `enterBill` when a line carries an `itemId`.
 * The resolved values are then written to the line — copied, never referenced.
 */
export async function resolveLineFromItem(
  tx: Tx,
  ctx: TenantContext,
  itemId: string,
  direction: TradeDirection,
  override: LineOverride,
): Promise<ResolvedLine> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  const [row] = await tx<ItemRow[]>`
      SELECT ${tx.unsafe(SELECT_COLUMNS)}
        FROM item i
       WHERE i.tenant_id = ${ctx.tenantId} AND i.id = ${itemId}
  `;

  if (!row) throw new ItemError('ITEM_NOT_FOUND', `No item ${itemId}`);

  const resolved = resolveLine(toMaster(row, baseCurrency), direction, override);

  if (isErr(resolved)) {
    throw new ItemError(
      'ITEM_INVALID',
      `Item ${row.code} cannot supply this line: ` +
        resolved.error.map(describeViolation).join('; '),
      resolved.error,
    );
  }

  return resolved.value;
}

// ------------------------------------------------------------------ internals

function describeViolation(v: { code: string; field?: string; direction?: string }): string {
  switch (v.code) {
    case 'ITEM_INACTIVE':
      return 'it has been deactivated';
    case 'WRONG_DIRECTION':
      return `it is not marked as ${v.direction === 'SALE' ? 'sold' : 'purchased'}`;
    case 'NO_DEFAULT':
      return `it has no default ${v.field} for a ${v.direction?.toLowerCase()} line, and none was supplied`;
    default:
      return v.code;
  }
}

function draftFrom(
  input: UpsertItemInput,
  code: string,
  baseCurrency: string,
): ItemMaster {
  const side = (s?: { unitPrice?: string; accountId?: string; taxCodeId?: string }) => ({
    ...(s?.unitPrice !== undefined
      ? { unitPrice: Money.fromDecimal(s.unitPrice, baseCurrency) }
      : {}),
    ...(s?.accountId !== undefined ? { accountId: s.accountId } : {}),
    ...(s?.taxCodeId !== undefined ? { taxCodeId: s.taxCodeId } : {}),
  });

  // Defaulted from whether the caller supplied that side's account, which is
  // what a user means when they fill in the sale block and leave purchase
  // blank. Explicit flags still win.
  const isSold = input.isSold ?? input.sale?.accountId !== undefined;
  const isPurchased = input.isPurchased ?? input.purchase?.accountId !== undefined;

  return {
    id: 'draft',
    code,
    name: input.name,
    itemType: input.itemType ?? 'SERVICE',
    unitOfMeasure: input.unitOfMeasure ?? 'UNIT',
    ...(input.uomCode !== undefined ? { uomCode: input.uomCode } : {}),
    ...(input.classificationCode !== undefined
      ? { classificationCode: input.classificationCode }
      : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    isSold,
    isPurchased,
    isActive: true,
    sale: side(input.sale),
    purchase: side(input.purchase),
  };
}

/**
 * Everything that has to be true before the row is written.
 *
 * The domain check catches structure; these three catch references, which are
 * database facts the pure layer cannot know. All of them are ALSO database
 * constraints — the point of doing them here is a message naming the item and
 * the field, rather than a constraint violation naming neither.
 */
/**
 * Friendlier than the partial unique index it duplicates — the index still
 * catches the concurrent race; this catches the common case with a message
 * that names the OTHER item, which is what the person at the form needs.
 */
async function assertBarcodeFree(
  tx: Tx,
  ctx: TenantContext,
  barcode: string | undefined,
  excludeId?: string,
): Promise<void> {
  if (barcode === undefined) return;
  const [taken] = await tx<{ code: string; name: string }[]>`
      SELECT code, name FROM item
       WHERE tenant_id = ${ctx.tenantId} AND barcode = ${barcode}
         AND (${excludeId ?? null}::uuid IS NULL OR id <> ${excludeId ?? null})
  `;
  if (taken) {
    throw new ItemError(
      'DUPLICATE_BARCODE',
      `Barcode ${barcode} is already on ${taken.code} — ${taken.name}. One barcode, ` +
        'one item: a scanner cannot ask which of two you meant.',
    );
  }
}

async function validate(
  tx: Tx,
  ctx: TenantContext,
  draft: ItemMaster,
  input: UpsertItemInput,
): Promise<void> {
  // Friendlier than the database CHECK it duplicates: the constraint names a
  // column, this names the decision.
  if (input.isSerialised === true && input.isTracked === false) {
    throw new ItemError(
      'ITEM_INVALID',
      'A serialised item must be stock-tracked: serials are identity for units, and ' +
        'without tracking there are no units to identify.',
    );
  }

  const check = checkItem(draft);
  if (!check.valid) {
    throw new ItemError(
      'ITEM_INVALID',
      check.defects.map((d) => d.message).join('; '),
      check.defects,
    );
  }

  const accountIds = [input.sale?.accountId, input.purchase?.accountId].filter(
    (id): id is string => id !== undefined,
  );

  for (const accountId of accountIds) {
    const [account] = await tx<{ id: string; is_active: boolean }[]>`
        SELECT id, is_active FROM account
         WHERE tenant_id = ${ctx.tenantId} AND id = ${accountId}
    `;
    if (!account) {
      throw new ItemError('ACCOUNT_NOT_FOUND', `No account ${accountId}`);
    }
    if (!account.is_active) {
      throw new ItemError(
        'ACCOUNT_NOT_FOUND',
        `Account ${accountId} is inactive, so an item cannot default postings to it`,
      );
    }
  }

  if (input.uomCode !== undefined) {
    const [uom] = await tx<{ code: string }[]>`
        SELECT code FROM einvoice_uom_code WHERE code = ${input.uomCode} AND is_active
    `;
    if (!uom) {
      // The reference table ships EMPTY pending LHDN's published list, so this
      // fires for every code until it is loaded. That is the intended
      // behaviour: refusing an unverifiable code beats storing one that will be
      // submitted to a tax authority.
      throw new ItemError(
        'UNKNOWN_UOM_CODE',
        `'${input.uomCode}' is not a known MyInvois unit-of-measure code. ` +
          'The code list must be loaded from LHDN reference data before it can be used.',
      );
    }
  }

  if (input.classificationCode !== undefined) {
    const [code] = await tx<{ code: string }[]>`
        SELECT code FROM einvoice_classification_code
         WHERE code = ${input.classificationCode} AND is_active
    `;
    if (!code) {
      throw new ItemError(
        'ITEM_INVALID',
        `'${input.classificationCode}' is not a known MyInvois classification code`,
      );
    }
  }
}

function toMaster(row: ItemRow, baseCurrency: string): ItemMaster {
  const price = (v: string | null) =>
    v === null ? {} : { unitPrice: Money.fromDecimal(v, baseCurrency) };

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    itemType: row.item_type,
    unitOfMeasure: row.unit_of_measure,
    ...(row.uom_code !== null ? { uomCode: row.uom_code } : {}),
    ...(row.classification_code !== null
      ? { classificationCode: row.classification_code }
      : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    isSold: row.is_sold,
    isPurchased: row.is_purchased,
    isActive: row.is_active,
    sale: {
      ...price(row.sale_unit_price),
      ...(row.sale_account_id !== null ? { accountId: row.sale_account_id } : {}),
      ...(row.sale_tax_code_id !== null ? { taxCodeId: row.sale_tax_code_id } : {}),
    },
    purchase: {
      ...price(row.purchase_unit_price),
      ...(row.purchase_account_id !== null ? { accountId: row.purchase_account_id } : {}),
      ...(row.purchase_tax_code_id !== null ? { taxCodeId: row.purchase_tax_code_id } : {}),
    },
  };
}

function toView(row: ItemRow, baseCurrency: string): ItemView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    barcode: row.barcode,
    itemType: row.item_type,
    unitOfMeasure: row.unit_of_measure,
    uomCode: row.uom_code,
    classificationCode: row.classification_code,
    isSold: row.is_sold,
    isPurchased: row.is_purchased,
    isTracked: row.is_tracked,
    isSerialised: row.is_serialised,
    warrantyMonths: row.warranty_months,
    isActive: row.is_active,
    sale: {
      unitPrice: row.sale_unit_price,
      accountId: row.sale_account_id,
      taxCodeId: row.sale_tax_code_id,
    },
    purchase: {
      unitPrice: row.purchase_unit_price,
      accountId: row.purchase_account_id,
      taxCodeId: row.purchase_tax_code_id,
    },
    einvoiceWarnings: checkItem(toMaster(row, baseCurrency)).einvoiceWarnings,
  };
}
