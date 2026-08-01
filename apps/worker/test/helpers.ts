import { randomUUID } from 'node:crypto';
import { issueInvoice, withTenant, type Sql, type TenantContext } from '@emil/db';
import { seedTenant, type Tenant } from '@emil/db/testing';

export { createTestDatabase, seedTenant, type Tenant } from '@emil/db/testing';

/**
 * A tenant that is actually able to submit e-Invoices.
 *
 * The seeded fixture stops short of this on purpose — most tenants will never
 * enable MyInvois — so the identity block LHDN requires has to be filled in
 * here. Mirrors `packages/db/test/einvoice.test.ts`; a divergent second setup
 * would mean the worker exercised a document shape nothing else has.
 */
export async function seedEInvoiceTenant(admin: Sql, name: string): Promise<Tenant> {
  const tenant = await seedTenant(admin, name);
  const ctx = { tenantId: tenant.tenantId };

  await admin`
      INSERT INTO einvoice_classification_code (code, description)
      VALUES ('022', 'Others')
      ON CONFLICT DO NOTHING
  `;

  await withTenant(admin, ctx, (tx) => tx`
      INSERT INTO einvoice_config (tenant_id, is_enabled, cancellation_window_hours, tin_pattern)
      VALUES (${tenant.tenantId}, TRUE, 72, '^C\\d{10}$')
  `);

  await withTenant(admin, ctx, (tx) => tx`
      UPDATE organisation
         SET tin = 'C1234567890', ssm_registration_no = '202301012345', msic_code = '62010',
             address_line1 = 'Level 12, Menara ABC', city = 'Kuala Lumpur',
             postcode = '50450', state_code = '14', country_code = 'MY'
       WHERE id = ${tenant.tenantId}
  `);

  await withTenant(admin, ctx, (tx) => tx`
      INSERT INTO contact_address (tenant_id, contact_id, address_type, line1, city,
                                   postcode, state_code, country_code)
      VALUES (${tenant.tenantId}, ${tenant.customerId}, 'BILLING',
              'No 8, Jalan Perdana', 'Kuala Lumpur', '50450', '14', 'MY')
  `);

  return tenant;
}

/**
 * Issue an invoice through the real service, which emits `invoice.issued` to
 * the outbox as a side effect of posting the ledger entry.
 *
 * Driving the emitter rather than inserting the event by hand is the point: a
 * test that hand-crafted the outbox row would still pass if `issueInvoice`
 * stopped emitting, which is exactly the regression that would make the whole
 * relay pointless.
 */
export async function issueInvoiceFor(
  sql: Sql,
  tenant: Tenant,
  options: { classificationCode?: string | null; unitPrice?: string } = {},
): Promise<{ id: string; invoiceNo: string }> {
  const ctx: TenantContext = { tenantId: tenant.tenantId, userId: tenant.userId };
  const code = options.classificationCode === undefined ? '022' : options.classificationCode;

  const invoice = await withTenant(sql, ctx, (tx) =>
    issueInvoice(tx, ctx, {
      contactId: tenant.customerId,
      issueDate: '2026-08-05',
      lines: [
        {
          description: 'Consulting services',
          quantity: '1',
          unitPrice: options.unitPrice ?? '1000.00',
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['SST-SVC']!,
          ...(code !== null ? { classificationCode: code } : {}),
        },
      ],
      idempotencyKey: randomUUID(),
    }),
  );

  return { id: invoice.id, invoiceNo: invoice.invoiceNo };
}

export interface OutboxRow {
  readonly id: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly eventType: string;
}

export async function outboxRows(admin: Sql, tenantId: string): Promise<OutboxRow[]> {
  const rows = await admin<
    { id: string; status: string; attempts: number; last_error: string | null; event_type: string }[]
  >`
      SELECT id, status, attempts, last_error, event_type
        FROM outbox_event
       WHERE tenant_id = ${tenantId}
       ORDER BY created_at
  `;

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    attempts: r.attempts,
    lastError: r.last_error,
    eventType: r.event_type,
  }));
}

/** Make every pending event immediately claimable again, ignoring its lease. */
export async function releaseLeases(admin: Sql): Promise<void> {
  await admin`UPDATE outbox_event SET available_at = now() - INTERVAL '1 second' WHERE status = 'PENDING'`;
}
