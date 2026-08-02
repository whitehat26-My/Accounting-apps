import {
  countAdjustment,
  isErr,
  issueStock,
  Money,
  quantityToUnits,
  receiveStock,
  STOCK_QUANTITY_SCALE,
  unitsToQuantity,
  validateJournalEntry,
  weightedAverageCost,
  type JournalLineDraft,
  type StockPool,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { postJournalEntry } from './ledger.js';
import { toIsoDate } from './internal.js';

/**
 * Local rather than imported from `invoice.ts`: `invoice.ts` calls into this
 * module to issue stock, so importing back would be a cycle.
 */
async function loadBaseCurrency(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx<{ base_currency: string }[]>`
      SELECT base_currency FROM organisation WHERE id = ${ctx.tenantId}
  `;
  return row?.base_currency ?? 'MYR';
}

/**
 * Perpetual inventory: the database half.
 *
 * The domain (`packages/domain/src/inventory.ts`) owns the arithmetic — what a
 * receipt does to the pool, what an issue costs, why relief is proportional.
 * This module owns sequencing: `item_stock` is the row a transaction locks, so
 * two concurrent sales of the last unit serialise instead of both succeeding.
 *
 * `stock_movement` is append-only truth; `item_stock` is the cache, exactly as
 * `account_period_balance` caches the journal. `detectStockDrift` recomputes
 * one from the other, and if they ever disagree the movements are right.
 */

export class StockError extends Error {
  constructor(
    readonly code:
      | 'ITEM_NOT_FOUND'
      | 'NOT_TRACKED'
      | 'INSUFFICIENT_STOCK'
      | 'NO_INVENTORY_ACCOUNTS'
      | 'INVALID_QUANTITY'
      | 'STOCK_JOURNAL_INVALID',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'StockError';
  }
}

interface StockAccounts {
  readonly inventoryId: string;
  readonly cogsId: string;
  readonly shrinkageId: string;
}

/**
 * The three accounts perpetual inventory posts to. All-or-nothing: a tenant
 * that has mapped INVENTORY but not COGS could receive stock it can never
 * sell, which is a configuration hole found at the worst moment — mid-sale.
 */
export async function loadStockAccounts(tx: Tx, ctx: TenantContext): Promise<StockAccounts> {
  const rows = await tx<{ role: string; account_id: string }[]>`
      SELECT role, account_id FROM posting_account_map
       WHERE tenant_id = ${ctx.tenantId}
         AND role IN ('INVENTORY', 'COGS', 'STOCK_SHRINKAGE')
  `;
  const byRole = new Map(rows.map((r) => [r.role, r.account_id]));

  const inventoryId = byRole.get('INVENTORY');
  const cogsId = byRole.get('COGS');
  const shrinkageId = byRole.get('STOCK_SHRINKAGE');

  if (!inventoryId || !cogsId || !shrinkageId) {
    const missing = ['INVENTORY', 'COGS', 'STOCK_SHRINKAGE'].filter((r) => !byRole.has(r));
    throw new StockError(
      'NO_INVENTORY_ACCOUNTS',
      `Tracked items need the ${missing.join(', ')} posting role(s) mapped before stock can move.`,
    );
  }

  return { inventoryId, cogsId, shrinkageId };
}

/** itemId → is_tracked, for the ids that exist. Used by bill/invoice wiring. */
export async function trackedItems(
  tx: Tx,
  ctx: TenantContext,
  itemIds: readonly string[],
): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const rows = await tx<{ id: string }[]>`
      SELECT id FROM item
       WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${itemIds as string[]}) AND is_tracked
  `;
  return new Set(rows.map((r) => r.id));
}

/**
 * Lock an item's pool row and return the pool.
 *
 * The ON CONFLICT dance exists because the first movement of a new item has no
 * row to lock. Insert-then-select is safe under concurrency: both racers
 * attempt the insert, one wins, both then queue on FOR UPDATE.
 */
async function lockPool(
  tx: Tx,
  ctx: TenantContext,
  itemId: string,
  baseCurrency: string,
): Promise<StockPool> {
  await tx`
      INSERT INTO item_stock (tenant_id, item_id)
      VALUES (${ctx.tenantId}, ${itemId})
      ON CONFLICT (tenant_id, item_id) DO NOTHING
  `;

  const [row] = await tx<{ quantity_on_hand: string; stock_value: string }[]>`
      SELECT quantity_on_hand, stock_value FROM item_stock
       WHERE tenant_id = ${ctx.tenantId} AND item_id = ${itemId}
         FOR UPDATE
  `;

  return {
    quantityUnits: quantityToUnits(row!.quantity_on_hand)!,
    value: Money.fromDecimal(row!.stock_value, baseCurrency),
  };
}

async function savePool(tx: Tx, ctx: TenantContext, itemId: string, pool: StockPool) {
  await tx`
      UPDATE item_stock
         SET quantity_on_hand = ${unitsToQuantity(pool.quantityUnits)},
             stock_value = ${pool.value.toDecimalString()},
             updated_at = now()
       WHERE tenant_id = ${ctx.tenantId} AND item_id = ${itemId}
  `;
}

interface MovementRow {
  readonly itemId: string;
  readonly movementType: 'RECEIPT' | 'ISSUE' | 'ADJUSTMENT';
  readonly quantityUnits: bigint;
  readonly valueDelta: Money;
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string | null;
  readonly journalEntryId: string | null;
  readonly movedOn: string;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

async function writeMovement(tx: Tx, ctx: TenantContext, m: MovementRow) {
  await tx`
      INSERT INTO stock_movement (
          tenant_id, item_id, movement_type, quantity, value_delta,
          source_document_type, source_document_id, journal_entry_id,
          moved_on, reason, idempotency_key, created_by
      ) VALUES (
          ${ctx.tenantId}, ${m.itemId}, ${m.movementType},
          ${unitsToQuantity(m.quantityUnits)}, ${m.valueDelta.toDecimalString()},
          ${m.sourceDocumentType}, ${m.sourceDocumentId}, ${m.journalEntryId},
          ${m.movedOn}, ${m.reason ?? null}, ${m.idempotencyKey ?? null},
          ${ctx.userId ?? null}
      )
  `;
}

export interface TrackedReceiptLine {
  readonly itemId: string;
  /** Decimal string, e.g. '5' or '2.5'. */
  readonly quantity: string;
  /** What the units actually cost, BASE currency, net of tax. */
  readonly baseCost: Money;
}

/**
 * Receive tracked stock from a bill.
 *
 * No journal is posted HERE: the bill's own journal already carries
 * Dr Inventory / Cr AP, because `enterBill` routes a tracked line's expense
 * account to the INVENTORY role. This records the quantity side and points at
 * that entry, so shelf and ledger cite the same document.
 */
export async function receiveTrackedStock(
  tx: Tx,
  ctx: TenantContext,
  input: {
    readonly sourceDocumentType: 'BILL' | 'OPENING';
    readonly sourceDocumentId: string | null;
    readonly journalEntryId: string | null;
    readonly movedOn: string;
    readonly lines: readonly TrackedReceiptLine[];
  },
): Promise<void> {
  if (input.lines.length === 0) return;
  const baseCurrency = await loadBaseCurrency(tx, ctx);

  // Locked in sorted order so two documents touching the same two items
  // cannot deadlock by locking them in opposite orders.
  const sorted = [...input.lines].sort((a, b) => a.itemId.localeCompare(b.itemId));

  for (const line of sorted) {
    const units = quantityToUnits(line.quantity);
    if (units === null) {
      throw new StockError('INVALID_QUANTITY', `Quantity ${line.quantity} is not a valid amount`);
    }

    const pool = await lockPool(tx, ctx, line.itemId, baseCurrency);
    const result = receiveStock(pool, units, line.baseCost);
    if (isErr(result)) {
      throw new StockError('INVALID_QUANTITY', describeViolation(result.error), result.error);
    }

    await savePool(tx, ctx, line.itemId, result.value.pool);
    await writeMovement(tx, ctx, {
      itemId: line.itemId,
      movementType: 'RECEIPT',
      quantityUnits: units,
      valueDelta: result.value.movementValue,
      sourceDocumentType: input.sourceDocumentType,
      sourceDocumentId: input.sourceDocumentId,
      journalEntryId: input.journalEntryId,
      movedOn: input.movedOn,
    });
  }
}

export interface TrackedIssueLine {
  readonly itemId: string;
  readonly quantity: string;
}

/**
 * Issue tracked stock for an invoice and post the COGS entry.
 *
 * One entry for the whole document — Dr COGS / Cr Inventory at the summed
 * weighted-average relief — posted in the SAME transaction as the sale, so
 * revenue and its cost land in the same period by construction. This is the
 * line that turns "sales were RM 60k" into "we made RM 14k".
 */
export async function issueTrackedStockForInvoice(
  tx: Tx,
  ctx: TenantContext,
  input: {
    readonly invoiceId: string;
    readonly invoiceNo: string;
    readonly entryDate: string;
    readonly idempotencyKey: string;
    readonly lines: readonly TrackedIssueLine[];
  },
): Promise<{ cogsEntryId: string | null; totalCost: string }> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const accounts = await loadStockAccounts(tx, ctx);

  const sorted = [...input.lines].sort((a, b) => a.itemId.localeCompare(b.itemId));

  let totalCost = Money.zero(baseCurrency);
  const applied: { itemId: string; units: bigint; cost: Money; pool: StockPool }[] = [];

  for (const line of sorted) {
    const units = quantityToUnits(line.quantity);
    if (units === null) {
      throw new StockError('INVALID_QUANTITY', `Quantity ${line.quantity} is not a valid amount`);
    }

    const pool = await lockPool(tx, ctx, line.itemId, baseCurrency);
    const result = issueStock(pool, units);

    if (isErr(result)) {
      if (result.error.code === 'INSUFFICIENT_STOCK') {
        const [item] = await tx<{ code: string; name: string }[]>`
            SELECT code, name FROM item
             WHERE tenant_id = ${ctx.tenantId} AND id = ${line.itemId}
        `;
        throw new StockError(
          'INSUFFICIENT_STOCK',
          `Cannot issue ${result.error.requested} of ${item?.code ?? line.itemId} — ` +
            `${result.error.onHand} on hand. Enter the purchase bill first, or post a ` +
            'counted adjustment if the shelf disagrees with the system.',
          result.error,
        );
      }
      throw new StockError('INVALID_QUANTITY', describeViolation(result.error), result.error);
    }

    const cost = result.value.movementValue.negate();
    totalCost = totalCost.add(cost);
    applied.push({ itemId: line.itemId, units, cost, pool: result.value.pool });
  }

  // Zero-cost issues (stock received free, or a pool that was all relief) move
  // quantity but no value; a zero-amount journal line is invalid by design, so
  // there is nothing to post.
  let cogsEntryId: string | null = null;

  if (!totalCost.isZero()) {
    const lines: JournalLineDraft[] = [
      {
        accountId: accounts.cogsId,
        side: 'DEBIT',
        amount: totalCost,
        baseAmount: totalCost,
        description: `Cost of goods sold — ${input.invoiceNo}`,
      },
      {
        accountId: accounts.inventoryId,
        side: 'CREDIT',
        amount: totalCost,
        baseAmount: totalCost,
        description: `Stock relieved at weighted average — ${input.invoiceNo}`,
      },
    ];

    const validated = validateJournalEntry(
      {
        entryDate: input.entryDate,
        description: `COGS for invoice ${input.invoiceNo}`,
        sourceModule: 'SALES',
        sourceDocumentType: 'INVOICE_COGS',
        sourceDocumentId: input.invoiceId,
        lines,
      },
      baseCurrency,
    );
    if (isErr(validated)) {
      throw new StockError('STOCK_JOURNAL_INVALID', 'Generated COGS entry is invalid', validated.error);
    }

    const posted = await postJournalEntry(tx, ctx, validated.value, {
      idempotencyKey: `cogs:${input.idempotencyKey}`,
    });
    cogsEntryId = posted.id;
  }

  for (const a of applied) {
    await savePool(tx, ctx, a.itemId, a.pool);
    await writeMovement(tx, ctx, {
      itemId: a.itemId,
      movementType: 'ISSUE',
      quantityUnits: -a.units,
      valueDelta: a.cost.negate(),
      sourceDocumentType: 'INVOICE',
      sourceDocumentId: input.invoiceId,
      journalEntryId: cogsEntryId,
      movedOn: input.entryDate,
    });
  }

  return { cogsEntryId, totalCost: totalCost.toDecimalString() };
}

export interface CountStockInput {
  readonly itemId: string;
  /** What the shelf actually says. */
  readonly countedQuantity: string;
  readonly countDate: string;
  /** Required: a count with no reason is a write-off nobody explains. */
  readonly reason: string;
  /**
   * Cost per unit for a count UP, when the units being brought in have a known
   * cost the pool cannot supply — opening stock on day one, or found stock
   * whose invoice was never entered. Omitted, a count up is valued at the
   * current weighted average.
   */
  readonly unitCost?: string;
  /**
   * Where the other side of the correction lands. Defaults to the
   * STOCK_SHRINKAGE role. Overridable because not every correction is
   * shrinkage: opening stock offsets to an opening-balance equity account.
   */
  readonly offsetAccountId?: string;
  readonly idempotencyKey: string;
}

export interface CountResult {
  readonly itemId: string;
  /** Signed: negative means stock was written down. */
  readonly quantityDelta: string;
  readonly valueDelta: string;
  readonly journalEntryId: string | null;
  readonly quantityOnHand: string;
  readonly stockValue: string;
}

export async function countStock(
  tx: Tx,
  ctx: TenantContext,
  input: CountStockInput,
): Promise<CountResult> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const accounts = await loadStockAccounts(tx, ctx);

  if (input.reason.trim().length === 0) {
    throw new StockError('INVALID_QUANTITY', 'A stock count requires a reason');
  }

  /*
   * Rule 5, on the movement rather than only the journal: a count can move
   * quantity with zero VALUE (writing down stock that was received free), in
   * which case no journal exists and the ledger's idempotency cannot guard the
   * retry. The movement's own key can, and its state was committed atomically
   * with everything else, so returning it IS returning the first call's result.
   */
  const [prior] = await tx<
    { item_id: string; quantity: string; value_delta: string; journal_entry_id: string | null }[]
  >`
      SELECT item_id, quantity, value_delta, journal_entry_id FROM stock_movement
       WHERE tenant_id = ${ctx.tenantId}
         AND idempotency_key = ${`stock-count:${input.idempotencyKey}`}
  `;
  if (prior) {
    const [current] = await tx<{ quantity_on_hand: string; stock_value: string }[]>`
        SELECT quantity_on_hand, stock_value FROM item_stock
         WHERE tenant_id = ${ctx.tenantId} AND item_id = ${prior.item_id}
    `;
    return {
      itemId: prior.item_id,
      quantityDelta: prior.quantity,
      valueDelta: prior.value_delta,
      journalEntryId: prior.journal_entry_id,
      quantityOnHand: current!.quantity_on_hand,
      stockValue: current!.stock_value,
    };
  }

  const [item] = await tx<{ id: string; code: string; is_tracked: boolean }[]>`
      SELECT id, code, is_tracked FROM item
       WHERE tenant_id = ${ctx.tenantId} AND id = ${input.itemId}
  `;
  if (!item) {
    // Indistinguishable from another tenant's item, per rule 9.
    throw new StockError('ITEM_NOT_FOUND', `Item ${input.itemId} not found`);
  }
  if (!item.is_tracked) {
    throw new StockError('NOT_TRACKED', `Item ${item.code} is not stock-tracked`);
  }

  const counted = quantityToUnits(input.countedQuantity);
  if (counted === null || counted < 0n) {
    throw new StockError(
      'INVALID_QUANTITY',
      `Counted quantity ${input.countedQuantity} is not a valid amount`,
    );
  }

  const pool = await lockPool(tx, ctx, input.itemId, baseCurrency);

  /*
   * A count up with a supplied unit cost bypasses `countAdjustment`'s
   * at-average valuation: the caller is asserting what these units cost, which
   * the pool cannot know. A count down never takes a unit cost — the missing
   * units cost what the average says, whatever anyone wishes they cost.
   */
  const result = (() => {
    const delta = counted - pool.quantityUnits;
    if (delta > 0n && input.unitCost !== undefined) {
      const unitCost = Money.fromDecimal(input.unitCost, baseCurrency);
      // delta is quantity units at STOCK_QUANTITY_SCALE; dividing by the scale
      // factor turns unit cost × scaled quantity back into money.
      const totalCost = unitCost.multiplyRatio(delta, 10n ** BigInt(STOCK_QUANTITY_SCALE));
      const received = receiveStock(pool, delta, totalCost);
      if (isErr(received)) return received;
      return { ok: true as const, value: { ...received.value, deltaUnits: delta } };
    }
    return countAdjustment(pool, counted);
  })();

  if (isErr(result)) {
    throw new StockError('INVALID_QUANTITY', describeViolation(result.error), result.error);
  }

  const { deltaUnits } = result.value;
  const valueDelta = result.value.movementValue;

  let journalEntryId: string | null = null;

  if (!valueDelta.isZero()) {
    const offset = input.offsetAccountId ?? accounts.shrinkageId;
    const amount = valueDelta.abs();

    // Stock DOWN: Dr shrinkage / Cr inventory. Stock UP: the mirror.
    const lines: JournalLineDraft[] = valueDelta.isNegative()
      ? [
          { accountId: offset, side: 'DEBIT', amount, baseAmount: amount },
          { accountId: accounts.inventoryId, side: 'CREDIT', amount, baseAmount: amount },
        ]
      : [
          { accountId: accounts.inventoryId, side: 'DEBIT', amount, baseAmount: amount },
          { accountId: offset, side: 'CREDIT', amount, baseAmount: amount },
        ];

    const validated = validateJournalEntry(
      {
        entryDate: input.countDate,
        description: `Stock count ${item.code}: ${input.reason}`,
        sourceModule: 'SYSTEM',
        sourceDocumentType: 'STOCK_COUNT',
        lines,
      },
      baseCurrency,
    );
    if (isErr(validated)) {
      throw new StockError('STOCK_JOURNAL_INVALID', 'Generated count entry is invalid', validated.error);
    }

    const posted = await postJournalEntry(tx, ctx, validated.value, {
      idempotencyKey: `stock-count:${input.idempotencyKey}`,
    });

    /*
     * The movement-level replay check above already returned for a genuine
     * retry, and the journal and movement commit atomically — so a replayed
     * journal HERE can only mean the key was reused for a different count.
     * Refuse, as the year-end close does for the same shape of reuse.
     */
    if (posted.replayed) {
      throw new StockError(
        'INVALID_QUANTITY',
        `Idempotency key ${input.idempotencyKey} was already used for a different stock count.`,
      );
    }

    journalEntryId = posted.id;
  }

  if (deltaUnits !== 0n) {
    await savePool(tx, ctx, input.itemId, result.value.pool);
    await writeMovement(tx, ctx, {
      itemId: input.itemId,
      movementType: 'ADJUSTMENT',
      quantityUnits: deltaUnits,
      valueDelta,
      sourceDocumentType: 'STOCK_COUNT',
      sourceDocumentId: null,
      journalEntryId,
      movedOn: input.countDate,
      reason: input.reason,
      idempotencyKey: `stock-count:${input.idempotencyKey}`,
    });

    await tx`
        INSERT INTO financial_event_log (
            tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
        ) VALUES (
            ${ctx.tenantId}, 'STOCK_COUNTED', ${ctx.userId ?? null}, 'stock.adjust',
            'item', ${input.itemId},
            ${tx.json({
              itemCode: item.code,
              countedQuantity: input.countedQuantity,
              quantityDelta: unitsToQuantity(deltaUnits),
              valueDelta: valueDelta.toDecimalString(),
              reason: input.reason,
              journalEntryId,
            })}
        )
    `;
  }

  return {
    itemId: input.itemId,
    quantityDelta: unitsToQuantity(deltaUnits),
    valueDelta: valueDelta.toDecimalString(),
    journalEntryId,
    quantityOnHand: unitsToQuantity(result.value.pool.quantityUnits),
    stockValue: result.value.pool.value.toDecimalString(),
  };
}

// ------------------------------------------------------------------- reading

export interface StockLevel {
  readonly itemId: string;
  readonly code: string;
  readonly name: string;
  readonly quantityOnHand: string;
  readonly stockValue: string;
  readonly weightedAverageCost: string;
}

export async function stockLevels(tx: Tx, ctx: TenantContext): Promise<StockLevel[]> {
  const baseCurrency = await loadBaseCurrency(tx, ctx);
  const rows = await tx<
    { item_id: string; code: string; name: string; quantity_on_hand: string; stock_value: string }[]
  >`
      SELECT i.id AS item_id, i.code, i.name, s.quantity_on_hand, s.stock_value
        FROM item i
        JOIN item_stock s ON s.tenant_id = i.tenant_id AND s.item_id = i.id
       WHERE i.tenant_id = ${ctx.tenantId} AND i.is_tracked
       ORDER BY i.code
  `;

  return rows.map((r) => {
    const pool: StockPool = {
      quantityUnits: quantityToUnits(r.quantity_on_hand)!,
      value: Money.fromDecimal(r.stock_value, baseCurrency),
    };
    return {
      itemId: r.item_id,
      code: r.code,
      name: r.name,
      quantityOnHand: r.quantity_on_hand,
      stockValue: r.stock_value,
      weightedAverageCost: weightedAverageCost(pool).toDecimalString(),
    };
  });
}

export interface StockMovementView {
  readonly id: string;
  readonly movementType: string;
  readonly quantity: string;
  readonly valueDelta: string;
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string | null;
  readonly journalEntryId: string | null;
  readonly movedOn: string;
  readonly reason: string | null;
}

export async function stockMovements(
  tx: Tx,
  ctx: TenantContext,
  itemId: string,
): Promise<StockMovementView[]> {
  const [item] = await tx<{ id: string }[]>`
      SELECT id FROM item WHERE tenant_id = ${ctx.tenantId} AND id = ${itemId}
  `;
  if (!item) {
    throw new StockError('ITEM_NOT_FOUND', `Item ${itemId} not found`);
  }

  const rows = await tx<
    {
      id: string; movement_type: string; quantity: string; value_delta: string;
      source_document_type: string; source_document_id: string | null;
      journal_entry_id: string | null; moved_on: Date; reason: string | null;
    }[]
  >`
      SELECT id, movement_type, quantity, value_delta, source_document_type,
             source_document_id, journal_entry_id, moved_on, reason
        FROM stock_movement
       WHERE tenant_id = ${ctx.tenantId} AND item_id = ${itemId}
       ORDER BY created_at, id
  `;

  return rows.map((r) => ({
    id: r.id,
    movementType: r.movement_type,
    quantity: r.quantity,
    valueDelta: r.value_delta,
    sourceDocumentType: r.source_document_type,
    sourceDocumentId: r.source_document_id,
    journalEntryId: r.journal_entry_id,
    movedOn: toIsoDate(r.moved_on),
    reason: r.reason,
  }));
}

/**
 * The canary. Recomputes every pool from its movements; rows returned mean the
 * cache is wrong and the movements are right — rebuild the cache, never "fix"
 * the movements to match. The stock twin of `detectRollupDrift`.
 */
export async function detectStockDrift(
  tx: Tx,
  ctx: TenantContext,
): Promise<
  { itemId: string; cachedQuantity: string; actualQuantity: string; cachedValue: string; actualValue: string }[]
> {
  return tx`
      WITH actual AS (
          SELECT item_id,
                 SUM(quantity)    AS quantity,
                 SUM(value_delta) AS value
            FROM stock_movement
           WHERE tenant_id = ${ctx.tenantId}
           GROUP BY item_id
      )
      SELECT COALESCE(s.item_id, a.item_id)          AS "itemId",
             COALESCE(s.quantity_on_hand, 0)::text   AS "cachedQuantity",
             COALESCE(a.quantity, 0)::text           AS "actualQuantity",
             COALESCE(s.stock_value, 0)::text        AS "cachedValue",
             COALESCE(a.value, 0)::text              AS "actualValue"
        FROM item_stock s
        FULL OUTER JOIN actual a ON a.item_id = s.item_id
       WHERE COALESCE(s.quantity_on_hand, 0) IS DISTINCT FROM COALESCE(a.quantity, 0)
          OR COALESCE(s.stock_value, 0)      IS DISTINCT FROM COALESCE(a.value, 0)
  ` as unknown as Promise<
    { itemId: string; cachedQuantity: string; actualQuantity: string; cachedValue: string; actualValue: string }[]
  >;
}

// ------------------------------------------------------------------ internal

function describeViolation(v: { code: string }): string {
  switch (v.code) {
    case 'NON_POSITIVE_QUANTITY':
      return 'Stock movements need a positive quantity';
    case 'NEGATIVE_COST':
      return 'A receipt cannot carry a negative cost';
    case 'INSUFFICIENT_STOCK':
      return 'Not enough stock on hand';
    default:
      return v.code;
  }
}
