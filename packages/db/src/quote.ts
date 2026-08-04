import {
  checkQuoteTransition,
  describeQuoteViolation,
  isErr,
  quoteHasLapsed,
  type QuoteStatus,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { issueInvoice, type IssueInvoiceLine } from './invoice.js';
import { toIsoDate } from './internal.js';

/**
 * Sales quotes: offer, answer, and the one conversion that touches money.
 *
 * The domain owns which transitions are legal; this module owns persistence and
 * `convertQuoteToInvoice`, which is the ONLY place a quote becomes an
 * accounting fact. It does so through `issueInvoice` — the same path a typed
 * invoice takes — so a quoted sale and a typed sale post identically, and the
 * tax, FX, stock and numbering behaviour cannot drift between them.
 */

export class QuoteError extends Error {
  constructor(
    readonly code:
      | 'QUOTE_NOT_FOUND'
      | 'CONTACT_NOT_FOUND'
      | 'ILLEGAL_TRANSITION'
      | 'QUOTE_NOT_EDITABLE'
      | 'QUOTE_NOT_CONVERTIBLE',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'QuoteError';
  }
}

export interface QuoteLineInput {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly itemId?: string;
  readonly accountId?: string;
  readonly taxCodeId?: string;
  readonly discountBasisPoints?: number;
}

export interface QuoteView {
  readonly id: string;
  readonly quoteNo: string;
  readonly contactId: string;
  readonly status: QuoteStatus;
  readonly quoteDate: string;
  readonly validUntil: string | null;
  /** Computed, not stored: whether it has lapsed as of the date asked. */
  readonly lapsed: boolean;
  readonly currency: string;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly amountsAreTaxInclusive: boolean;
  readonly invoiceId: string | null;
  readonly declineReason: string | null;
  /** Sum of quantity × unit price after line discount. Presentation only. */
  readonly subtotal: string;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly description: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly itemId: string | null;
    readonly discountBasisPoints: number;
  }[];
}

export interface CreateQuoteInput {
  readonly contactId: string;
  readonly quoteDate: string;
  readonly validUntil?: string;
  readonly currency?: string;
  readonly reference?: string;
  readonly notes?: string;
  readonly amountsAreTaxInclusive?: boolean;
  readonly lines: readonly QuoteLineInput[];
  readonly idempotencyKey: string;
}

export async function createQuote(
  tx: Tx,
  ctx: TenantContext,
  input: CreateQuoteInput,
): Promise<{ id: string; quoteNo: string; replayed: boolean }> {
  const [existing] = await tx<{ id: string; quote_no: string }[]>`
      SELECT id, quote_no FROM sales_quote
       WHERE tenant_id = ${ctx.tenantId} AND created_idempotency_key = ${input.idempotencyKey}
  `;
  if (existing) return { id: existing.id, quoteNo: existing.quote_no, replayed: true };

  const [contact] = await tx<{ id: string }[]>`
      SELECT id FROM contact WHERE tenant_id = ${ctx.tenantId} AND id = ${input.contactId}
  `;
  // Indistinguishable from another tenant's contact — rule 9.
  if (!contact) throw new QuoteError('CONTACT_NOT_FOUND', `Contact ${input.contactId} not found`);

  // Self-provision the sequence, the same way repair jobs do: every tenant
  // created before this table existed has no QUOTE row, and
  // `allocate_document_number` throws on a missing one.
  await tx`
      INSERT INTO number_sequence (tenant_id, document_type, prefix, next_value, padding)
      VALUES (${ctx.tenantId}, 'QUOTE', 'QUO-', 1, 5)
      ON CONFLICT (tenant_id, document_type) DO NOTHING
  `;
  const [numbered] = await tx<{ allocate_document_number: string }[]>`
      SELECT allocate_document_number('QUOTE')
  `;

  const [quote] = await tx<{ id: string; quote_no: string }[]>`
      INSERT INTO sales_quote (
          tenant_id, quote_no, contact_id, quote_date, valid_until, currency,
          reference, notes, amounts_are_tax_inclusive, created_by,
          created_idempotency_key
      ) VALUES (
          ${ctx.tenantId}, ${numbered!.allocate_document_number}, ${input.contactId},
          ${input.quoteDate}, ${input.validUntil ?? null}, ${input.currency ?? 'MYR'},
          ${input.reference ?? null}, ${input.notes ?? null},
          ${input.amountsAreTaxInclusive ?? false}, ${ctx.userId ?? null},
          ${input.idempotencyKey}
      )
      RETURNING id, quote_no
  `;

  await replaceLines(tx, ctx, quote!.id, input.lines);
  return { id: quote!.id, quoteNo: quote!.quote_no, replayed: false };
}

/**
 * Rewrite the lines of a quote that has not yet been answered.
 *
 * Replaces the whole set rather than patching: a quote is one document, not an
 * accumulation of edits, and the customer is looking at a single version of it.
 * Legal only while DRAFT — once SENT, the figures are what the customer was
 * shown, and changing them silently would make the record a lie. Revising a
 * sent quote means declining or re-drafting it, which the state machine allows.
 */
export async function updateQuoteLines(
  tx: Tx,
  ctx: TenantContext,
  quoteId: string,
  lines: readonly QuoteLineInput[],
): Promise<QuoteView> {
  const quote = await lockQuote(tx, ctx, quoteId);
  if (quote.status !== 'DRAFT') {
    throw new QuoteError(
      'QUOTE_NOT_EDITABLE',
      `Quote ${quote.quote_no} is ${quote.status}. Only a DRAFT can be rewritten — the ` +
        'figures on a sent quote are what the customer was shown.',
    );
  }
  await replaceLines(tx, ctx, quoteId, lines);
  await touch(tx, ctx, quoteId);
  return getQuote(tx, ctx, quoteId);
}

export interface QuoteTransitionInput {
  readonly to: QuoteStatus;
  readonly reason?: string;
}

export async function transitionQuote(
  tx: Tx,
  ctx: TenantContext,
  quoteId: string,
  input: QuoteTransitionInput,
): Promise<QuoteView> {
  const quote = await lockQuote(tx, ctx, quoteId);

  const [tally] = await tx<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM sales_quote_line
       WHERE tenant_id = ${ctx.tenantId} AND sales_quote_id = ${quoteId}
  `;

  const check = checkQuoteTransition(quote.status as QuoteStatus, input.to, {
    lineCount: Number(tally!.count),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  if (isErr(check)) {
    throw new QuoteError('ILLEGAL_TRANSITION', describeQuoteViolation(check.error), check.error);
  }

  // `now()` stays SQL rather than becoming a parameter: passed as a value it is
  // the string "now()", which the driver tries to read as a date and rejects.
  await tx`
      UPDATE sales_quote
         SET status         = ${input.to},
             accepted_at    = CASE WHEN ${input.to} = 'ACCEPTED' THEN now() ELSE NULL END,
             declined_at    = CASE WHEN ${input.to} = 'DECLINED' THEN now() ELSE NULL END,
             decline_reason = ${input.to === 'DECLINED' ? (input.reason ?? null) : null},
             updated_at     = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${quoteId}
  `;

  return getQuote(tx, ctx, quoteId);
}

export interface ConvertQuoteInput {
  readonly issueDate: string;
  readonly dueDate?: string;
  readonly idempotencyKey: string;
}

/**
 * Turn an accepted quote into an invoice.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY PLACE A QUOTE BECOMES MONEY, AND IT DELEGATES.
 *
 * Everything here is bookkeeping ABOUT the conversion; the invoice itself is
 * built by `issueInvoice`, unchanged. That is deliberate — a parallel invoice
 * path would be a second place for tax points, FX, stock relief, serial
 * consumption and numbering to be got subtly wrong, and the two would drift the
 * first time one was fixed.
 *
 * Only an ACCEPTED quote converts. Billing a quote the customer never agreed to
 * is how a shop invoices work nobody ordered.
 * ---------------------------------------------------------------------------
 */
export async function convertQuoteToInvoice(
  tx: Tx,
  ctx: TenantContext,
  quoteId: string,
  input: ConvertQuoteInput,
): Promise<{ invoiceId: string; invoiceNo: string; replayed: boolean }> {
  const quote = await lockQuote(tx, ctx, quoteId);

  // Idempotent: a double-clicked "convert" must not raise two invoices.
  if (quote.invoice_id !== null) {
    const [inv] = await tx<{ invoice_no: string }[]>`
        SELECT invoice_no FROM invoice
         WHERE tenant_id = ${ctx.tenantId} AND id = ${quote.invoice_id}
    `;
    return { invoiceId: quote.invoice_id, invoiceNo: inv?.invoice_no ?? '', replayed: true };
  }

  if (quote.status !== 'ACCEPTED') {
    throw new QuoteError(
      'QUOTE_NOT_CONVERTIBLE',
      `Quote ${quote.quote_no} is ${quote.status}. Only an ACCEPTED quote may be invoiced — ` +
        'billing one the customer never agreed to is how work nobody ordered gets charged for.',
    );
  }

  const lines = await tx<LineRow[]>`
      SELECT line_no, item_id, description, quantity, unit_price, account_id,
             tax_code_id, discount_basis_points
        FROM sales_quote_line
       WHERE tenant_id = ${ctx.tenantId} AND sales_quote_id = ${quoteId}
       ORDER BY line_no
  `;

  const invoiceLines: IssueInvoiceLine[] = lines.map((l) => ({
    quantity: l.quantity,
    description: l.description,
    unitPrice: l.unit_price,
    ...(l.item_id !== null ? { itemId: l.item_id } : {}),
    ...(l.account_id !== null ? { accountId: l.account_id } : {}),
    ...(l.tax_code_id !== null ? { taxCodeId: l.tax_code_id } : {}),
    ...(l.discount_basis_points > 0 ? { discountBasisPoints: l.discount_basis_points } : {}),
  }));

  const invoice = await issueInvoice(tx, ctx, {
    contactId: quote.contact_id,
    issueDate: input.issueDate,
    currency: quote.currency,
    amountsAreTaxInclusive: quote.amounts_are_tax_inclusive,
    lines: invoiceLines,
    // Namespaced under the quote's own key so a replay of the CONVERSION and a
    // replay of a hand-typed invoice cannot collide on the same key.
    idempotencyKey: `quote:${input.idempotencyKey}`,
    ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    ...(quote.reference !== null ? { reference: quote.reference } : {}),
  });

  // `viaConversion` is what lets INVOICED be reached at all — the domain
  // refuses it from any other caller.
  const check = checkQuoteTransition(quote.status as QuoteStatus, 'INVOICED', {
    viaConversion: true,
  });
  if (isErr(check)) {
    throw new QuoteError('ILLEGAL_TRANSITION', describeQuoteViolation(check.error), check.error);
  }

  await tx`
      UPDATE sales_quote
         SET status = 'INVOICED', invoice_id = ${invoice.id},
             convert_idempotency_key = ${input.idempotencyKey}, updated_at = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${quoteId}
  `;

  return { invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, replayed: false };
}

export async function getQuote(
  tx: Tx,
  ctx: TenantContext,
  quoteId: string,
  today?: string,
): Promise<QuoteView> {
  const [quote] = await tx<QuoteRow[]>`
      SELECT id, quote_no, contact_id, status, quote_date, valid_until, currency,
             reference, notes, amounts_are_tax_inclusive, invoice_id, decline_reason
        FROM sales_quote
       WHERE tenant_id = ${ctx.tenantId} AND id = ${quoteId}
  `;
  if (!quote) throw new QuoteError('QUOTE_NOT_FOUND', `Quote ${quoteId} not found`);

  const lines = await tx<LineRow[]>`
      SELECT line_no, item_id, description, quantity, unit_price, account_id,
             tax_code_id, discount_basis_points
        FROM sales_quote_line
       WHERE tenant_id = ${ctx.tenantId} AND sales_quote_id = ${quoteId}
       ORDER BY line_no
  `;

  return toView(quote, lines, today ?? toIsoDate(new Date()));
}

export interface ListQuotesFilter {
  readonly status?: QuoteStatus;
  readonly contactId?: string;
}

export async function listQuotes(
  tx: Tx,
  ctx: TenantContext,
  filter: ListQuotesFilter = {},
  today?: string,
): Promise<QuoteView[]> {
  const rows = await tx<QuoteRow[]>`
      SELECT id, quote_no, contact_id, status, quote_date, valid_until, currency,
             reference, notes, amounts_are_tax_inclusive, invoice_id, decline_reason
        FROM sales_quote
       WHERE tenant_id = ${ctx.tenantId}
         ${filter.status !== undefined ? tx`AND status = ${filter.status}` : tx``}
         ${filter.contactId !== undefined ? tx`AND contact_id = ${filter.contactId}` : tx``}
       ORDER BY quote_date DESC, quote_no DESC
  `;
  // Listed without their lines: a list screen shows who, when and how much, and
  // fetching every line for every row is the query that makes the page crawl
  // once a shop has a year of quotes.
  return rows.map((r) => toView(r, [], today ?? toIsoDate(new Date())));
}

// ---------------------------------------------------------------------------

interface QuoteRow {
  id: string;
  quote_no: string;
  contact_id: string;
  status: string;
  quote_date: Date;
  valid_until: Date | null;
  currency: string;
  reference: string | null;
  notes: string | null;
  amounts_are_tax_inclusive: boolean;
  invoice_id: string | null;
  decline_reason: string | null;
}

interface LineRow {
  line_no: number;
  item_id: string | null;
  description: string;
  quantity: string;
  unit_price: string;
  account_id: string | null;
  tax_code_id: string | null;
  discount_basis_points: number;
}

function toView(q: QuoteRow, lines: LineRow[], today: string): QuoteView {
  const validUntil = q.valid_until ? toIsoDate(q.valid_until) : null;
  return {
    id: q.id,
    quoteNo: q.quote_no,
    contactId: q.contact_id,
    status: q.status as QuoteStatus,
    quoteDate: toIsoDate(q.quote_date),
    validUntil,
    // Only an unanswered quote can lapse; an accepted one holds its price.
    lapsed:
      (q.status === 'SENT' || q.status === 'DRAFT') && quoteHasLapsed(validUntil, today),
    currency: q.currency,
    reference: q.reference,
    notes: q.notes,
    amountsAreTaxInclusive: q.amounts_are_tax_inclusive,
    invoiceId: q.invoice_id,
    declineReason: q.decline_reason,
    subtotal: subtotalOf(lines),
    lines: lines.map((l) => ({
      lineNo: l.line_no,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      itemId: l.item_id,
      discountBasisPoints: l.discount_basis_points,
    })),
  };
}

/**
 * A presentation subtotal, in minor units throughout.
 *
 * Deliberately NOT the invoice total: tax is computed at the tax point by the
 * TaxEngine when the invoice is issued, and duplicating that here would give a
 * quote screen a second opinion about tax. This is "what the lines add up to",
 * which is what a quote shows.
 */
function subtotalOf(lines: LineRow[]): string {
  let cents = 0n;
  for (const l of lines) {
    const qty = BigInt(Math.round(Number(l.quantity) * 10000));
    const price = BigInt(Math.round(Number(l.unit_price) * 100));
    const gross = (qty * price) / 10000n;
    const discount = (gross * BigInt(l.discount_basis_points)) / 10000n;
    cents += gross - discount;
  }
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

async function replaceLines(
  tx: Tx,
  ctx: TenantContext,
  quoteId: string,
  lines: readonly QuoteLineInput[],
): Promise<void> {
  await tx`
      DELETE FROM sales_quote_line
       WHERE tenant_id = ${ctx.tenantId} AND sales_quote_id = ${quoteId}
  `;
  for (const [index, line] of lines.entries()) {
    await tx`
        INSERT INTO sales_quote_line (
            tenant_id, sales_quote_id, line_no, item_id, description,
            quantity, unit_price, account_id, tax_code_id, discount_basis_points
        ) VALUES (
            ${ctx.tenantId}, ${quoteId}, ${index + 1}, ${line.itemId ?? null},
            ${line.description}, ${line.quantity}, ${line.unitPrice},
            ${line.accountId ?? null}, ${line.taxCodeId ?? null},
            ${line.discountBasisPoints ?? 0}
        )
    `;
  }
}

async function touch(tx: Tx, ctx: TenantContext, quoteId: string): Promise<void> {
  await tx`
      UPDATE sales_quote SET updated_at = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${quoteId}
  `;
}

async function lockQuote(tx: Tx, ctx: TenantContext, quoteId: string): Promise<QuoteRow> {
  const [quote] = await tx<QuoteRow[]>`
      SELECT id, quote_no, contact_id, status, quote_date, valid_until, currency,
             reference, notes, amounts_are_tax_inclusive, invoice_id, decline_reason
        FROM sales_quote
       WHERE tenant_id = ${ctx.tenantId} AND id = ${quoteId}
       FOR UPDATE
  `;
  if (!quote) throw new QuoteError('QUOTE_NOT_FOUND', `Quote ${quoteId} not found`);
  return quote;
}
