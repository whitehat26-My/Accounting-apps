import {
  promiseStatus,
  warrantyWindow,
  EXPIRING_SOON_DAYS,
  type PromiseStatus,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { businessToday } from './internal.js';

/**
 * The promises register — what this shop still owes the people it sold to.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS STORED. EVERY ROW HERE IS DERIVED, AND THAT IS THE DESIGN.
 *
 * A sold `stock_unit` already knows everything a warranty needs:
 *
 *     stock_unit (serial, status SOLD, issued_movement_id)
 *       → stock_movement (moved_on = the sale date, source_document_id)
 *         → invoice → contact (who to answer to)
 *       → item (warranty_months = the length of the promise)
 *
 * So the register is a join, not a table. Three bugs cannot happen as a
 * result: a promise that was never created on sale, one that outlives the
 * return that voided it, and one that disagrees with the invoice it came
 * from. A returned unit goes back to IN_STOCK through `bringSerialsIn` and
 * simply stops matching — no compensating write, nothing to forget.
 *
 * The cost is that a promise NOT implied by a serialised sale cannot be
 * expressed: an extended warranty sold separately, or goodwill on a cable
 * that carries no serial. That is stated in the register (§5.21) with its
 * unblocker rather than half-built here.
 * ---------------------------------------------------------------------------
 */

export interface Promise_ {
  /**
   * The physical unit. A promise belongs to one THING, not to an invoice
   * line — two laptops on one invoice are two promises the moment one is
   * returned — so this is what the printed card is keyed and fingerprinted on.
   */
  readonly unitId: string;
  readonly serialNo: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly customerName: string | null;
  readonly invoiceId: string | null;
  readonly invoiceNo: string | null;
  readonly soldOn: string;
  readonly expiresOn: string;
  readonly status: PromiseStatus;
  readonly warrantyMonths: number;
  /** Repair jobs booked in against this serial — the claims, if any. */
  readonly claims: number;
}

export interface PromisesRegister {
  readonly today: string;
  readonly promises: readonly Promise_[];
  readonly active: number;
  readonly expiringSoon: number;
  readonly expiringSoonDays: number;
}

interface Row {
  unit_id: string;
  serial_no: string;
  item_id: string;
  item_code: string;
  item_name: string;
  warranty_months: number;
  customer_name: string | null;
  invoice_id: string | null;
  invoice_no: string | null;
  sold_on: Date;
  claims: string;
}

/*
 * `device_serial` on a repair job is deliberately free text (0029:27-30) — the
 * device on the counter is usually not something this shop sold. So the join
 * back to a tracked unit normalises the repair's side the way `normaliseSerial`
 * normalises the stock side: trimmed, collapsed, uppercased. Matching raw
 * would silently miss every serial a technician typed in lower case.
 */
const CLAIMS = `
    SELECT COUNT(*)
      FROM repair_job r
     WHERE r.tenant_id = u.tenant_id
       AND upper(regexp_replace(btrim(r.device_serial), '\\s+', ' ', 'g')) = u.serial_no
       AND r.received_on >= m.moved_on
`;

export async function warrantyRegister(
  tx: Tx,
  ctx: TenantContext,
  options: { readonly today?: string } = {},
): Promise<PromisesRegister> {
  const today = options.today ?? businessToday();

  const rows = await tx<Row[]>`
      SELECT u.id AS unit_id, u.serial_no,
             i.id AS item_id, i.code AS item_code, i.name AS item_name,
             i.warranty_months, c.name AS customer_name,
             inv.id AS invoice_id, inv.invoice_no, m.moved_on AS sold_on,
             (${tx.unsafe(CLAIMS)})::text AS claims
        FROM stock_unit u
        JOIN item i           ON i.tenant_id = u.tenant_id AND i.id = u.item_id
        JOIN stock_movement m ON m.tenant_id = u.tenant_id AND m.id = u.issued_movement_id
        LEFT JOIN invoice inv ON inv.tenant_id = u.tenant_id
                             AND m.source_document_type = 'INVOICE'
                             AND inv.id = m.source_document_id
        LEFT JOIN contact c   ON c.tenant_id = inv.tenant_id AND c.id = inv.contact_id
       WHERE u.tenant_id = ${ctx.tenantId}
         AND u.status = 'SOLD'
         AND i.warranty_months > 0
       ORDER BY m.moved_on DESC, u.serial_no
  `;

  const promises = rows.map((r) => {
    const soldOn = r.sold_on.toISOString().slice(0, 10);
    const window = warrantyWindow(soldOn, r.warranty_months);
    return {
      unitId: r.unit_id,
      serialNo: r.serial_no,
      itemId: r.item_id,
      itemCode: r.item_code,
      itemName: r.item_name,
      customerName: r.customer_name,
      invoiceId: r.invoice_id,
      invoiceNo: r.invoice_no,
      soldOn,
      expiresOn: window.expiresOn,
      status: promiseStatus(today, window),
      warrantyMonths: r.warranty_months,
      claims: Number(r.claims),
    };
  });

  return {
    today,
    promises,
    active: promises.filter((p) => p.status !== 'EXPIRED').length,
    expiringSoon: promises.filter((p) => p.status === 'EXPIRING_SOON').length,
    expiringSoonDays: EXPIRING_SOON_DAYS,
  };
}

/**
 * The question actually asked at the counter: someone is standing there with a
 * device, is it still covered?
 *
 * Answers for a serial this shop never sold too — with `promise: null` rather
 * than a 404. "We have no record of selling this" is a real answer to the
 * question, and one the person at the counter needs.
 */
/**
 * The same promise, found by the unit rather than by the serial.
 *
 * Exists because the fingerprint is keyed on `stock_unit.id`: a serial is
 * unique per ITEM, not per tenant (0028), so two different products can carry
 * the same manufacturer serial and only the unit id identifies one promise.
 */
export async function warrantyForUnit(
  tx: Tx,
  ctx: TenantContext,
  unitId: string,
  options: { readonly today?: string } = {},
): Promise<Promise_ | null> {
  const register = await warrantyRegister(tx, ctx, options);
  return register.promises.find((p) => p.unitId === unitId) ?? null;
}

export async function warrantyForSerial(
  tx: Tx,
  ctx: TenantContext,
  serialNo: string,
  options: { readonly today?: string } = {},
): Promise<{ serialNo: string; promise: Promise_ | null }> {
  const normalised = serialNo.trim().replace(/\s+/g, ' ').toUpperCase();
  const register = await warrantyRegister(tx, ctx, options);
  return {
    serialNo: normalised,
    promise: register.promises.find((p) => p.serialNo === normalised) ?? null,
  };
}
