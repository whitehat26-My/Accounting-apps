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
      | 'ACCOUNT_NOT_FOUND'
      | 'UNKNOWN_UOM_CODE'
      | 'ITEM_IN_USE',
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
  readonly itemType: ItemType;
  readonly unitOfMeasure: string;
  readonly uomCode: string | null;
  readonly classificationCode: string | null;
  readonly isSold: boolean;
  readonly isPurchased: boolean;
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
  readonly itemType?: ItemType;
  readonly unitOfMeasure?: string;
  readonly uomCode?: string;
  readonly classificationCode?: string;
  readonly isSold?: boolean;
  readonly isPurchased?: boolean;
  readonly sale?: { unitPrice?: string; accountId?: string; taxCodeId?: string };
  readonly purchase?: { unitPrice?: string; accountId?: string; taxCodeId?: string };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const SELECT_COLUMNS = `
    i.id, i.code, i.name, i.description, i.item_type, i.unit_of_measure,
    i.uom_code, i.classification_code, i.is_sold, i.is_purchased, i.is_active,
    i.sale_unit_price, i.sale_account_id, i.sale_tax_code_id,
    i.purchase_unit_price, i.purchase_account_id, i.purchase_tax_code_id
`;

interface ItemRow {
  id: string; code: string; name: string; description: string | null;
  item_type: ItemType; unit_of_measure: string; uom_code: string | null;
  classification_code: string | null;
  is_sold: boolean; is_purchased: boolean; is_active: boolean;
  sale_unit_price: string | null; sale_account_id: string | null; sale_tax_code_id: string | null;
  purchase_unit_price: string | null; purchase_account_id: string | null;
  purchase_tax_code_id: string | null;
}

export interface ListItemsOptions {
  /** Substring match on code or name. */
  readonly search?: string;
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

  const [row] = await tx<ItemRow[]>`
      INSERT INTO item (
          tenant_id, code, name, description, item_type, unit_of_measure, uom_code,
          classification_code, is_sold, is_purchased,
          sale_unit_price, sale_account_id, sale_tax_code_id,
          purchase_unit_price, purchase_account_id, purchase_tax_code_id
      ) VALUES (
          ${ctx.tenantId}, ${code}, ${input.name}, ${input.description ?? null},
          ${input.itemType ?? 'SERVICE'}, ${input.unitOfMeasure ?? 'UNIT'},
          ${input.uomCode ?? null}, ${input.classificationCode ?? null},
          ${draft.isSold}, ${draft.isPurchased},
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

  if (code !== current.code) {
    const [clash] = await tx<{ id: string }[]>`
        SELECT id FROM item
         WHERE tenant_id = ${ctx.tenantId} AND code = ${code} AND id <> ${id}
    `;
    if (clash) throw new ItemError('DUPLICATE_CODE', `An item with code ${code} already exists`);
  }

  const [row] = await tx<ItemRow[]>`
      UPDATE item
         SET code                 = ${code},
             name                 = ${input.name},
             description          = ${input.description ?? null},
             item_type            = ${input.itemType ?? current.itemType},
             unit_of_measure      = ${input.unitOfMeasure ?? current.unitOfMeasure},
             uom_code             = ${input.uomCode ?? null},
             classification_code  = ${input.classificationCode ?? null},
             is_sold              = ${draft.isSold},
             is_purchased         = ${draft.isPurchased},
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
async function validate(
  tx: Tx,
  ctx: TenantContext,
  draft: ItemMaster,
  input: UpsertItemInput,
): Promise<void> {
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
    itemType: row.item_type,
    unitOfMeasure: row.unit_of_measure,
    uomCode: row.uom_code,
    classificationCode: row.classification_code,
    isSold: row.is_sold,
    isPurchased: row.is_purchased,
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
