/**
 * ContactService — customers and suppliers.
 *
 * ---------------------------------------------------------------------------
 * THIS EXISTED AS TABLES AND NOTHING ELSE.
 *
 * `contact` has been in the schema since 0002 with no repository module and no
 * route, so every test seeded rows directly and a real user could not add a
 * customer at all. Invoicing needs a `contactId`, which made a clean tenant
 * unable to issue its first invoice — the gap only stayed invisible because
 * fixtures wrote the row themselves.
 * ---------------------------------------------------------------------------
 *
 * The Malaysian identity block is first-class rather than a custom-field bag:
 * TIN and the secondary identifier are MyInvois submission requirements, so
 * they must be capturable at contact creation. Warning a user then is far
 * better than at invoice-issue time, when they are trying to get paid.
 */

import type { TenantContext, Tx } from './client.js';

export class ContactError extends Error {
  constructor(
    readonly code: 'CONTACT_NOT_FOUND' | 'NOT_A_PARTY' | 'DUPLICATE_NAME',
    message: string,
  ) {
    super(message);
    this.name = 'ContactError';
  }
}

export interface CreateContactInput {
  readonly name: string;
  readonly isCustomer?: boolean;
  readonly isSupplier?: boolean;
  /** LHDN tax identification number. Required before e-invoice submission. */
  readonly tin?: string;
  /** BRN, NRIC, PASSPORT or ARMY — MyInvois' secondary identifier types. */
  readonly idType?: string;
  readonly idValue?: string;
  readonly sstNo?: string;
  readonly msicCode?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly defaultCurrency?: string;
  readonly paymentTermsDays?: number;
  readonly creditLimit?: string;
  readonly requiresEinvoice?: boolean;
}

export interface ContactView {
  readonly id: string;
  readonly name: string;
  readonly isCustomer: boolean;
  readonly isSupplier: boolean;
  readonly tin: string | null;
  readonly idType: string | null;
  readonly idValue: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly defaultCurrency: string;
  readonly paymentTermsDays: number;
  readonly requiresEinvoice: boolean;
  readonly isActive: boolean;
  /**
   * What would block a MyInvois submission for this contact, today.
   *
   * Surfaced at creation rather than discovered at submission. An e-invoice
   * rejected by LHDN because a buyer TIN is missing is a problem found when
   * someone is trying to get paid; the same fact reported here is a two-second
   * fix.
   */
  readonly einvoiceGaps: readonly string[];
}

export async function createContact(
  tx: Tx,
  ctx: TenantContext,
  input: CreateContactInput,
): Promise<ContactView> {
  if (input.isCustomer !== true && input.isSupplier !== true) {
    throw new ContactError(
      'NOT_A_PARTY',
      'A contact must be a customer, a supplier, or both. One that is neither cannot ' +
        'appear on an invoice or a bill, and would be invisible everywhere it matters.',
    );
  }

  const [row] = await tx<ContactRow[]>`
      INSERT INTO contact (
          tenant_id, name, is_customer, is_supplier, tin, id_type, id_value,
          sst_no, msic_code, email, phone, default_currency, payment_terms_days,
          credit_limit, requires_einvoice
      )
      VALUES (
          ${ctx.tenantId}, ${input.name},
          ${input.isCustomer ?? false}, ${input.isSupplier ?? false},
          ${input.tin ?? null}, ${input.idType ?? null}, ${input.idValue ?? null},
          ${input.sstNo ?? null}, ${input.msicCode ?? null},
          ${input.email ?? null}, ${input.phone ?? null},
          ${input.defaultCurrency ?? 'MYR'}, ${input.paymentTermsDays ?? 30},
          ${input.creditLimit ?? null}, ${input.requiresEinvoice ?? false}
      )
      RETURNING ${tx(CONTACT_COLUMNS)}
  `;

  return toView(row!);
}

export async function listContacts(
  tx: Tx,
  ctx: TenantContext,
  filter: { role?: 'CUSTOMER' | 'SUPPLIER'; includeInactive?: boolean } = {},
): Promise<ContactView[]> {
  const rows = await tx<ContactRow[]>`
      SELECT ${tx(CONTACT_COLUMNS)}
        FROM contact
       WHERE tenant_id = ${ctx.tenantId}
         AND (${filter.includeInactive ?? false} OR is_active)
         AND (${filter.role ?? null}::text IS NULL
              OR (${filter.role ?? null} = 'CUSTOMER' AND is_customer)
              OR (${filter.role ?? null} = 'SUPPLIER' AND is_supplier))
       ORDER BY name
  `;

  return rows.map(toView);
}

export async function getContact(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<ContactView> {
  const [row] = await tx<ContactRow[]>`
      SELECT ${tx(CONTACT_COLUMNS)} FROM contact
       WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
  `;

  // RLS has already filtered another tenant's row out of this query, so
  // "missing" and "not yours" are indistinguishable here — which is exactly
  // what CLAUDE.md rule 9 wants. The API turns this into a 404 either way.
  if (!row) throw new ContactError('CONTACT_NOT_FOUND', `Contact ${id} not found`);

  return toView(row);
}

const CONTACT_COLUMNS = [
  'id',
  'name',
  'is_customer',
  'is_supplier',
  'tin',
  'id_type',
  'id_value',
  'email',
  'phone',
  'default_currency',
  'payment_terms_days',
  'requires_einvoice',
  'is_active',
] as const;

interface ContactRow {
  id: string;
  name: string;
  is_customer: boolean;
  is_supplier: boolean;
  tin: string | null;
  id_type: string | null;
  id_value: string | null;
  email: string | null;
  phone: string | null;
  default_currency: string;
  payment_terms_days: number;
  requires_einvoice: boolean;
  is_active: boolean;
}

function toView(row: ContactRow): ContactView {
  const gaps: string[] = [];
  if (row.tin === null || row.tin.trim().length === 0) gaps.push('tin');
  if (row.id_type === null || row.id_value === null) gaps.push('idType/idValue');

  return {
    id: row.id,
    name: row.name,
    isCustomer: row.is_customer,
    isSupplier: row.is_supplier,
    tin: row.tin,
    idType: row.id_type,
    idValue: row.id_value,
    email: row.email,
    phone: row.phone,
    defaultCurrency: row.default_currency,
    paymentTermsDays: row.payment_terms_days,
    requiresEinvoice: row.requires_einvoice,
    isActive: row.is_active,
    einvoiceGaps: gaps,
  };
}
