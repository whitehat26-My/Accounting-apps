import { z } from 'zod';
import { Money, type Permission } from '@emil/domain';
import {
  createContact,
  createItem,
  listAccounts,
  listContacts,
  listItems,
  loadTaxCodes,
  resolveLineFromItem,
  withTenant,
  type Sql,
  type TenantContext,
} from '@emil/db';
import type { AssistantTool } from './provider.js';

/**
 * What the assistant may DO, and the line it may never cross.
 *
 * ---------------------------------------------------------------------------
 * THE ASSISTANT NEVER POSTS MONEY. NOT WITH ANY PROMPT, NOT WITH ANY TOOL.
 *
 * Two kinds of tool live here:
 *
 *   1. Catalogue writes — an item, a contact. Non-financial master data,
 *      executed directly (the same service the screen's form calls), because
 *      an item card with a typo is a two-second edit.
 *
 *   2. Money DRAFTS — an invoice, a cash sale. The tool RESOLVES everything
 *      (which contact, which item, what the payload must be) and hands back a
 *      draft. The web renders it as a card with a Confirm button, and that
 *      button calls the NORMAL endpoint with the USER'S OWN token and
 *      idempotency key. The ledger write happens because a human clicked,
 *      through the same authorised, audited path as typing it in by hand.
 *
 * There is deliberately no third kind. A model that can be talked into
 * posting a journal is a model that WILL be talked into posting a journal.
 * ---------------------------------------------------------------------------
 *
 * Every tool is (a) offered only when the caller holds the permission the
 * equivalent screen needs, and (b) re-checks that permission inside `run` —
 * the filter is UX, the re-check is the guarantee. Failures return sentences,
 * not exceptions: the model reads them and relays or retries sensibly.
 */

export interface RecordedAction {
  readonly type: 'ITEM_CREATED' | 'CONTACT_CREATED';
  readonly id: string;
  readonly label: string;
}

export interface AssistantDraft {
  readonly kind: 'INVOICE' | 'CASH_SALE';
  readonly title: string;
  readonly lines: readonly { label: string; amount: string }[];
  /** POSTed verbatim by the web's Confirm button — shaped for `endpoint`. */
  readonly endpoint: string;
  readonly payload: Record<string, unknown>;
}

export interface Collected {
  readonly actions: RecordedAction[];
  readonly drafts: AssistantDraft[];
}

interface ToolDeps {
  readonly sql: Sql;
  readonly ctx: TenantContext;
  readonly permissions: ReadonlySet<Permission>;
  readonly today: string;
  readonly collected: Collected;
}

const decimal = z.string().regex(/^\d+(\.\d{1,4})?$/, 'a decimal string like "120" or "120.50"');

const itemInput = z.object({
  code: z.string().min(1).max(50).describe('Short unique code, e.g. LAPTOP-ACER-A315'),
  name: z.string().min(1).max(200),
  itemType: z.enum(['GOODS', 'SERVICE']).default('GOODS'),
  salePrice: decimal.optional().describe('Selling price in RM'),
  purchasePrice: decimal.optional().describe('Cost price in RM'),
  isTracked: z.boolean().default(false).describe('Track stock quantities for this item'),
});

const contactInput = z.object({
  name: z.string().min(1).max(200),
  isCustomer: z.boolean().default(true),
  isSupplier: z.boolean().default(false),
  phone: z.string().max(50).optional(),
  email: z.string().email().optional(),
});

const invoiceDraftInput = z.object({
  contactName: z.string().min(1).describe('Customer name as the user said it'),
  lines: z
    .array(
      z.object({
        itemCode: z.string().min(1).describe('Item code or a distinctive part of its name'),
        quantity: decimal.default('1'),
        unitPrice: decimal.optional().describe('Only if the user quoted a price different from the catalogue'),
      }),
    )
    .min(1)
    .max(20),
});

const cashSaleDraftInput = z.object({
  lines: z
    .array(
      z.object({
        itemCode: z.string().min(1).describe('Item code or a distinctive part of its name'),
        quantity: decimal.default('1'),
        unitPrice: decimal.optional(),
      }),
    )
    .min(1)
    .max(20),
  method: z.enum(['CASH', 'CARD', 'DUITNOW', 'TRANSFER']).default('CASH'),
});

export function buildAssistantTools(deps: ToolDeps): AssistantTool[] {
  const tools: AssistantTool[] = [];
  const { permissions } = deps;

  if (permissions.has('item.write')) {
    tools.push({
      name: 'record_item',
      description:
        'Add a product or service to the catalogue. Executes immediately — use it when ' +
        'the user asks to add/register an item, e.g. "add Acer laptop model A315, ' +
        'sell at 1899, cost 1550".',
      schema: itemInput,
      run: guarded(deps, 'item.write', async (raw) => {
        const input = itemInput.parse(raw);
        const item = await withTenant(deps.sql, deps.ctx, async (tx) => {
          // The same defaults the Items screen fills in: revenue 4000,
          // purchases 5000, tax NONE. Without a sale account the item would
          // look created and then refuse to appear on any sale line.
          const accounts = await listAccounts(tx, deps.ctx);
          const revenue = accounts.find((a) => a.code === '4000');
          const purchases = accounts.find((a) => a.code === '5000');
          const none = (await loadTaxCodes(tx, deps.ctx)).find((t) => t.code === 'NONE');
          if (!revenue || !none) {
            throw new Error(
              'the chart of accounts has no revenue account (4000) or NONE tax code yet — ' +
                'finish onboarding first',
            );
          }
          return createItem(tx, deps.ctx, {
            code: input.code,
            name: input.name,
            itemType: input.itemType,
            isSold: true,
            isPurchased: input.itemType === 'GOODS' && purchases !== undefined,
            isTracked: input.itemType === 'GOODS' && input.isTracked,
            sale: {
              accountId: revenue.id,
              taxCodeId: none.id,
              ...(input.salePrice !== undefined ? { unitPrice: input.salePrice } : {}),
            },
            ...(input.itemType === 'GOODS' && purchases !== undefined
              ? {
                  purchase: {
                    accountId: purchases.id,
                    taxCodeId: none.id,
                    ...(input.purchasePrice !== undefined
                      ? { unitPrice: input.purchasePrice }
                      : {}),
                  },
                }
              : {}),
          });
        });
        deps.collected.actions.push({
          type: 'ITEM_CREATED',
          id: item.id,
          label: `Item ${item.code} — ${item.name}`,
        });
        return `Created item ${item.code} (${item.name}). It is in the catalogue now.`;
      }),
    });
  }

  if (permissions.has('contact.write')) {
    tools.push({
      name: 'record_contact',
      description:
        'Add a customer or supplier. Executes immediately — use it when the user asks ' +
        'to add a customer/supplier, e.g. "add customer Encik Rahman, phone 012-3456789".',
      schema: contactInput,
      run: guarded(deps, 'contact.write', async (raw) => {
        const input = contactInput.parse(raw);
        const contact = await withTenant(deps.sql, deps.ctx, (tx) =>
          createContact(tx, deps.ctx, {
            name: input.name,
            isCustomer: input.isCustomer,
            isSupplier: input.isSupplier,
            ...(input.phone !== undefined ? { phone: input.phone } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
          }),
        );
        deps.collected.actions.push({
          type: 'CONTACT_CREATED',
          id: contact.id,
          label: `${input.isSupplier && !input.isCustomer ? 'Supplier' : 'Customer'} ${contact.name}`,
        });
        return `Created contact ${contact.name}.`;
      }),
    });
  }

  if (permissions.has('invoice.create')) {
    tools.push({
      name: 'draft_invoice',
      description:
        'Prepare an invoice DRAFT for the user to confirm. Nothing is recorded until ' +
        'they press Confirm on the card this produces. Use for "invoice Syarikat Maju ' +
        'for 2 units of RAM-8GB" and similar. If the customer or an item cannot be ' +
        'found, this tells you — offer record_contact / record_item first.',
      schema: invoiceDraftInput,
      run: guarded(deps, 'invoice.create', async (raw) => {
        const input = invoiceDraftInput.parse(raw);
        return withTenant(deps.sql, deps.ctx, async (tx) => {
          const contact = await findContact(tx, deps.ctx, input.contactName, 'CUSTOMER');
          if (typeof contact === 'string') return contact;

          const resolved = await resolveDraftLines(tx, deps.ctx, input.lines, 'SALE');
          if (typeof resolved === 'string') return resolved;

          deps.collected.drafts.push({
            kind: 'INVOICE',
            title: `Invoice ${contact.name}`,
            lines: resolved.display,
            endpoint: '/v1/invoices',
            payload: {
              contactId: contact.id,
              issueDate: deps.today,
              lines: resolved.payload,
            },
          });
          return (
            `Draft ready: invoice for ${contact.name} with ${resolved.display.length} line(s), ` +
            `estimated RM ${resolved.estimate} before tax. The user must press Confirm on the ` +
            'card to issue it — tell them to review it there.'
          );
        });
      }),
    });
  }

  if (permissions.has('pos.sale')) {
    tools.push({
      name: 'draft_cash_sale',
      description:
        'Prepare a point-of-sale DRAFT for the user to confirm — for over-the-counter ' +
        'sales like "jual 2 mouse cash" / "sold two mice for cash". Nothing is rung ' +
        'up until they press Confirm on the card this produces.',
      schema: cashSaleDraftInput,
      run: guarded(deps, 'pos.sale', async (raw) => {
        const input = cashSaleDraftInput.parse(raw);
        return withTenant(deps.sql, deps.ctx, async (tx) => {
          const resolved = await resolveDraftLines(tx, deps.ctx, input.lines, 'SALE');
          if (typeof resolved === 'string') return resolved;

          deps.collected.drafts.push({
            kind: 'CASH_SALE',
            title: `${input.method === 'CASH' ? 'Cash sale' : `Sale (${input.method})`}`,
            lines: resolved.display,
            endpoint: '/v1/pos/sales',
            // depositAccountId is attached by the web at confirm time, using
            // the same by-method default the POS screen itself uses.
            payload: {
              saleDate: deps.today,
              method: input.method,
              lines: resolved.payload,
            },
          });
          return (
            `Draft ready: ${input.method} sale, ${resolved.display.length} line(s), estimated ` +
            `RM ${resolved.estimate} before tax. The user must press Confirm on the card to ring it up.`
          );
        });
      }),
    });
  }

  return tools;
}

/** Permission re-check + error-to-sentence wrapper around every tool body. */
function guarded(
  deps: ToolDeps,
  permission: Permission,
  body: (raw: unknown) => Promise<string>,
): (raw: unknown) => Promise<string> {
  return async (raw) => {
    if (!deps.permissions.has(permission)) {
      return `Refused: this user's role does not include ${permission}. Do not retry; suggest they ask whoever manages the books.`;
    }
    try {
      return await body(raw);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return `Invalid input: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      }
      const message = error instanceof Error ? error.message : String(error);
      return `That did not work: ${message}`;
    }
  };
}

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

async function findContact(
  tx: Tx,
  ctx: TenantContext,
  name: string,
  role: 'CUSTOMER' | 'SUPPLIER',
): Promise<{ id: string; name: string } | string> {
  const contacts = await listContacts(tx, ctx, { role });
  const needle = name.trim().toLowerCase();
  const matches = contacts.filter((c) => c.name.toLowerCase().includes(needle));

  if (matches.length === 1) return { id: matches[0]!.id, name: matches[0]!.name };
  if (matches.length === 0) {
    return (
      `No ${role.toLowerCase()} named "${name}" exists. ` +
      (contacts.length > 0
        ? `Closest existing names: ${contacts.slice(0, 5).map((c) => c.name).join(', ')}. `
        : '') +
      'Offer to create them with record_contact first.'
    );
  }
  return (
    `"${name}" matches ${matches.length} contacts: ` +
    `${matches.slice(0, 5).map((c) => c.name).join(', ')}. Ask the user which one they mean.`
  );
}

/**
 * Resolve free-text lines against the catalogue and shape them for the
 * document endpoints — which accept `{itemId, quantity}` and fill in price,
 * account and tax from the item themselves. `resolveLineFromItem` is called
 * here only to FAIL EARLY with a readable reason (inactive item, no sale
 * price) while the model is still in the conversation to fix it.
 *
 * The estimate is `Money` arithmetic (quantity as an exact rational) for the
 * tool result only; the authoritative totals are computed by the ledger when
 * the human confirms.
 */
async function resolveDraftLines(
  tx: Tx,
  ctx: TenantContext,
  lines: readonly { itemCode: string; quantity: string; unitPrice?: string | undefined }[],
  direction: 'SALE',
): Promise<
  | { payload: Record<string, unknown>[]; display: { label: string; amount: string }[]; estimate: string }
  | string
> {
  const payload: Record<string, unknown>[] = [];
  const display: { label: string; amount: string }[] = [];
  let estimate = Money.zero('MYR');

  for (const line of lines) {
    const found = await listItems(tx, ctx, { search: line.itemCode, direction, limit: 5 });
    if (found.length === 0) {
      return (
        `No item matching "${line.itemCode}" is in the catalogue. Offer to add it with ` +
        'record_item first (ask the user for its price).'
      );
    }
    const exact = found.find((i) => i.code.toLowerCase() === line.itemCode.trim().toLowerCase());
    if (found.length > 1 && !exact) {
      return (
        `"${line.itemCode}" matches several items: ` +
        `${found.map((i) => `${i.code} (${i.name})`).join(', ')}. Ask the user which one.`
      );
    }
    const item = exact ?? found[0]!;

    // Throws ItemError with a readable message if the item cannot supply a
    // sale line; `guarded` turns that into a sentence for the model.
    const resolvedLine = await resolveLineFromItem(tx, ctx, item.id, direction, {
      quantity: line.quantity,
      ...(line.unitPrice !== undefined
        ? { unitPrice: Money.fromDecimal(line.unitPrice, 'MYR') }
        : {}),
    });

    payload.push({
      itemId: item.id,
      quantity: line.quantity,
      ...(line.unitPrice !== undefined ? { unitPrice: line.unitPrice } : {}),
    });

    const unit = line.unitPrice ?? item.sale.unitPrice ?? resolvedLine.unitPrice.toDecimalString();

    // Quantity as an exact rational: "2.5" -> 25000/10000. No floats anywhere.
    const [whole = '0', fraction = ''] = line.quantity.split('.');
    const lineTotal = Money.fromDecimal(unit, 'MYR').multiplyRatio(
      BigInt(whole + fraction.padEnd(4, '0')),
      10_000n,
    );
    estimate = estimate.add(lineTotal);

    display.push({
      label: `${line.quantity} × ${item.name} @ RM ${unit}`,
      amount: lineTotal.toDecimalString(),
    });
  }

  return { payload, display, estimate: estimate.toDecimalString() };
}
