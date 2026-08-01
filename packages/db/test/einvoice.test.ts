import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isErr, validateForSubmission } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { issueInvoice } from '../src/invoice.js';
import { issueCreditNote } from '../src/credit-note.js';
import {
  applyEvent,
  buildCreditNoteDocument,
  buildInvoiceDocument,
  cancelSubmission,
  complianceSummary,
  dueForAttempt,
  EInvoiceError,
  loadConfig,
  queueSubmission,
  scheduleRetry,
} from '../src/einvoice.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('einvoice');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin);

  // Reference data and per-tenant config — both data, not constants.
  await admin`
      INSERT INTO einvoice_classification_code (code, description)
      VALUES ('022', 'Others'), ('001', 'Breastfeeding equipment')
      ON CONFLICT DO NOTHING
  `;

  await withTenant(admin, { tenantId: tenant.tenantId }, (tx) => tx`
      INSERT INTO einvoice_config (tenant_id, is_enabled, cancellation_window_hours, tin_pattern)
      VALUES (${tenant.tenantId}, TRUE, 72, '^C\\d{10}$')
  `);

  // The supplier identity block MyInvois requires.
  await withTenant(admin, { tenantId: tenant.tenantId }, (tx) => tx`
      UPDATE organisation
         SET tin = 'C1234567890', ssm_registration_no = '202301012345', msic_code = '62010',
             address_line1 = 'Level 12, Menara ABC', city = 'Kuala Lumpur',
             postcode = '50450', state_code = '14', country_code = 'MY'
       WHERE id = ${tenant.tenantId}
  `);

  await withTenant(admin, { tenantId: tenant.tenantId }, (tx) => tx`
      INSERT INTO contact_address (tenant_id, contact_id, address_type, line1, city, postcode, state_code, country_code)
      VALUES (${tenant.tenantId}, ${tenant.customerId}, 'BILLING',
              'No 8, Jalan Perdana', 'Kuala Lumpur', '50450', '14', 'MY')
  `);
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

/**
 * `null` means "omit the classification code" — NOT `undefined`, which would
 * trigger the parameter default and silently produce a valid document.
 */
async function issue(classificationCode: string | null = '022') {
  return withTenant(sql, ctx(), (tx) =>
    issueInvoice(tx, ctx(), {
      contactId: tenant.customerId,
      issueDate: '2026-08-05',
      lines: [
        {
          description: 'Consulting services',
          quantity: '1',
          unitPrice: '1000.00',
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['SST-SVC']!,
          ...(classificationCode !== null ? { classificationCode } : {}),
        },
      ],
      idempotencyKey: randomUUID(),
    }),
  );
}

describe('configuration is data', () => {
  it('loads the per-tenant cancellation window rather than a constant', async () => {
    const config = await withTenant(sql, ctx(), (tx) => loadConfig(tx, ctx()));
    expect(config.isEnabled).toBe(true);
    expect(config.cancellationWindowHours).toBe(72);
    expect(config.environment).toBe('SANDBOX');
  });

  it('defaults to disabled for a tenant with no config row', async () => {
    const other = await seedTenant(admin, 'No Config Sdn Bhd');
    const config = await withTenant(sql, { tenantId: other.tenantId }, (tx) =>
      loadConfig(tx, { tenantId: other.tenantId }),
    );
    expect(config.isEnabled).toBe(false);
  });

  it('refuses to queue when e-Invoice is not enabled', async () => {
    const other = await seedTenant(admin, 'Disabled Sdn Bhd');
    const otherCtx = { tenantId: other.tenantId, userId: other.userId };

    const invoice = await withTenant(sql, otherCtx, (tx) =>
      issueInvoice(tx, otherCtx, {
        contactId: other.customerId,
        issueDate: '2026-08-05',
        lines: [{
          description: 'Services',
          quantity: '1',
          unitPrice: '100.00',
          accountId: other.accounts['4000']!,
          taxCodeId: other.taxCodes['NONE']!,
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    await expect(
      withTenant(sql, otherCtx, async (tx) => {
        const doc = await buildInvoiceDocument(tx, otherCtx, invoice.id);
        return queueSubmission(tx, otherCtx, doc, invoice.id);
      }),
    ).rejects.toThrow(/not enabled/i);
  });
});

describe('building the document from ledger data', () => {
  it('assembles supplier, buyer, lines and totals', async () => {
    const invoice = await issue();

    const doc = await withTenant(sql, ctx(), (tx) =>
      buildInvoiceDocument(tx, ctx(), invoice.id),
    );

    expect(doc.documentType).toBe('INVOICE');
    expect(doc.documentNo).toBe(invoice.invoiceNo);
    expect(doc.supplier.tin).toBe('C1234567890');
    expect(doc.supplier.msicCode).toBe('62010');
    expect(doc.buyer.tin).toBe('C9876543210');
    expect(doc.buyer.address.postcode).toBe('50450');
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]!.classificationCode).toBe('022');
    expect(doc.lines[0]!.taxRateBasisPoints).toBe(800n);
    expect(doc.total.toDecimalString()).toBe('1080.0000');
  });

  it('totals always reconcile to the lines it built', async () => {
    const invoice = await issue();
    const doc = await withTenant(sql, ctx(), (tx) => buildInvoiceDocument(tx, ctx(), invoice.id));

    // The document assembled from the ledger must pass the same arithmetic
    // checks LHDN applies. If issueInvoice and this builder ever disagree on
    // rounding, this is where it surfaces.
    const result = validateForSubmission(doc, { tinPattern: /^C\d{10}$/ });
    expect(result.ok, JSON.stringify(result.ok ? {} : result.error)).toBe(true);
  });

  it('carries the original reference on a credit note', async () => {
    const invoice = await issue();

    const credit = await withTenant(sql, ctx(), (tx) =>
      issueCreditNote(tx, ctx(), {
        contactId: tenant.customerId,
        invoiceId: invoice.id,
        creditDate: '2026-08-20',
        reason: 'RETURN',
        lines: [{
          description: 'Returned',
          quantity: '1',
          unitPrice: '100.00',
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['SST-SVC']!,
          classificationCode: '022',
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    const doc = await withTenant(sql, ctx(), (tx) =>
      buildCreditNoteDocument(tx, ctx(), credit.id),
    );

    expect(doc.documentType).toBe('CREDIT_NOTE');
    expect(doc.originalReference?.documentNo).toBe(invoice.invoiceNo);
    expect(doc.originalReference?.reason).toBe('RETURN');
  });

  it('refuses to build from a draft or missing document', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) => buildInvoiceDocument(tx, ctx(), randomUUID())),
    ).rejects.toThrow(EInvoiceError);
  });
});

describe('queueing validates before it queues', () => {
  it('queues a complete document and stores the exact payload', async () => {
    const invoice = await issue();

    const queued = await withTenant(sql, ctx(), async (tx) => {
      const doc = await buildInvoiceDocument(tx, ctx(), invoice.id);
      return queueSubmission(tx, ctx(), doc, invoice.id);
    });

    expect(queued.status).toBe('QUEUED');

    const [payload] = await withTenant(sql, ctx(), (tx) =>
      tx<{ payload_hash: Uint8Array; document: { documentNo: string } }[]>`
          SELECT payload_hash, document FROM einvoice_payload
           WHERE tenant_id = ${tenant.tenantId} AND submission_id = ${queued.id}
      `,
    );

    expect(payload!.payload_hash.length).toBe(32);
    expect(payload!.document.documentNo).toBe(invoice.invoiceNo);
  });

  it('refuses a line with no classification code, at queue time', async () => {
    const invoice = await issue(null);

    await expect(
      withTenant(sql, ctx(), async (tx) => {
        const doc = await buildInvoiceDocument(tx, ctx(), invoice.id);
        return queueSubmission(tx, ctx(), doc, invoice.id);
      }),
    ).rejects.toThrow(/cannot be submitted/i);
  });

  it('surfaces every violation rather than the first', async () => {
    const invoice = await issue(null);

    try {
      await withTenant(sql, ctx(), async (tx) => {
        const doc = await buildInvoiceDocument(tx, ctx(), invoice.id);
        // Blank the buyer TIN too, so there are at least two problems.
        return queueSubmission(
          tx,
          ctx(),
          { ...doc, buyer: { ...doc.buyer, tin: '' } },
          invoice.id,
        );
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const detail = (error as EInvoiceError).detail as { code: string }[];
      const codes = new Set(detail.map((d) => d.code));
      expect(codes.has('MISSING_CLASSIFICATION_CODE')).toBe(true);
      expect(codes.has('MISSING_BUYER_TIN')).toBe(true);
    }
  });

  it('re-queueing after a fix increments the attempt and keeps both payloads', async () => {
    const invoice = await issue();

    const first = await withTenant(sql, ctx(), async (tx) => {
      const doc = await buildInvoiceDocument(tx, ctx(), invoice.id);
      return queueSubmission(tx, ctx(), doc, invoice.id);
    });

    const second = await withTenant(sql, ctx(), async (tx) => {
      const doc = await buildInvoiceDocument(tx, ctx(), invoice.id);
      return queueSubmission(tx, ctx(), doc, invoice.id);
    });

    expect(second.id).toBe(first.id);
    expect(second.attemptCount).toBe(first.attemptCount + 1);

    const payloads = await withTenant(sql, ctx(), (tx) =>
      tx`SELECT attempt_no FROM einvoice_payload
          WHERE tenant_id = ${tenant.tenantId} AND submission_id = ${first.id}`,
    );
    expect(payloads.length).toBe(2);
  });
});

describe('the submission lifecycle', () => {
  async function queued() {
    const invoice = await issue();
    return withTenant(sql, ctx(), async (tx) => {
      const doc = await buildInvoiceDocument(tx, ctx(), invoice.id);
      return queueSubmission(tx, ctx(), doc, invoice.id);
    });
  }

  it('walks QUEUED -> SUBMITTED -> VALID and records the LHDN identifiers', async () => {
    const submission = await queued();

    await withTenant(sql, ctx(), (tx) =>
      applyEvent(tx, ctx(), submission.id, { type: 'ACCEPTED', submissionUid: 'SUB-1' }),
    );

    const status = await withTenant(sql, ctx(), (tx) =>
      applyEvent(tx, ctx(), submission.id, {
        type: 'VALIDATED',
        lhdnUuid: 'UUID-1',
        longId: 'LONG-1',
        validatedAt: '2026-08-05T10:00:00Z',
      }),
    );

    expect(status).toBe('VALID');

    const [row] = await withTenant(sql, ctx(), (tx) =>
      tx<{ status: string; lhdn_uuid: string; long_id: string }[]>`
          SELECT status, lhdn_uuid, long_id FROM einvoice_submission
           WHERE tenant_id = ${tenant.tenantId} AND id = ${submission.id}
      `,
    );
    expect(row).toMatchObject({ status: 'VALID', lhdn_uuid: 'UUID-1', long_id: 'LONG-1' });
  });

  it('refuses an illegal transition', async () => {
    const submission = await queued();

    await expect(
      withTenant(sql, ctx(), (tx) =>
        applyEvent(tx, ctx(), submission.id, { type: 'CANCELLED', reason: 'too early' }),
      ),
    ).rejects.toThrow(/Cannot apply CANCELLED/i);
  });

  it('records a rejection and allows resubmission after correction', async () => {
    const submission = await queued();

    await withTenant(sql, ctx(), (tx) =>
      applyEvent(tx, ctx(), submission.id, { type: 'SUBMIT' }),
    );
    const invalid = await withTenant(sql, ctx(), (tx) =>
      applyEvent(tx, ctx(), submission.id, {
        type: 'REJECTED_BY_VALIDATION',
        errorCode: 'CF321',
        detail: { field: 'buyer.tin' },
      }),
    );
    expect(invalid).toBe('INVALID');

    const requeued = await withTenant(sql, ctx(), (tx) =>
      applyEvent(tx, ctx(), submission.id, { type: 'RETRY' }, 'SYSTEM'),
    );
    expect(requeued).toBe('QUEUED');
  });

  it('appends every transition to the compliance log', async () => {
    const submission = await queued();
    await withTenant(sql, ctx(), (tx) =>
      applyEvent(tx, ctx(), submission.id, { type: 'SUBMIT' }),
    );

    const events = await withTenant(sql, ctx(), (tx) =>
      tx<{ event_type: string; from_status: string | null; to_status: string }[]>`
          SELECT event_type, from_status, to_status FROM einvoice_status_event
           WHERE tenant_id = ${tenant.tenantId} AND submission_id = ${submission.id}
           ORDER BY id
      `,
    );

    expect(events.map((e) => e.to_status)).toEqual(['QUEUED', 'SUBMITTED']);
  });

  it('keeps the status log append-only', async () => {
    await expect(
      admin.unsafe(`UPDATE einvoice_status_event SET to_status = 'VALID'`),
    ).rejects.toThrow(/append-only/i);
  });

  it('keeps the payload record append-only', async () => {
    await expect(
      admin.unsafe(`DELETE FROM einvoice_payload`),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses to rewrite an LHDN-assigned UUID', async () => {
    const submission = await queued();
    await withTenant(sql, ctx(), (tx) =>
      applyEvent(tx, ctx(), submission.id, { type: 'ACCEPTED', submissionUid: 'SUB-X' }),
    );
    await withTenant(sql, ctx(), (tx) =>
      applyEvent(tx, ctx(), submission.id, {
        type: 'VALIDATED', lhdnUuid: 'UUID-X', longId: 'LONG-X',
        validatedAt: '2026-08-05T10:00:00Z',
      }),
    );

    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          UPDATE einvoice_submission SET lhdn_uuid = 'FORGED'
           WHERE tenant_id = ${tenant.tenantId} AND id = ${submission.id}
      `),
    ).rejects.toThrow(/assigned by LHDN/i);
  });
});

describe('the cancellation window', () => {
  async function validatedSubmission(validatedAt: string) {
    const invoice = await issue();
    const submission = await withTenant(sql, ctx(), async (tx) => {
      const doc = await buildInvoiceDocument(tx, ctx(), invoice.id);
      return queueSubmission(tx, ctx(), doc, invoice.id);
    });

    await withTenant(sql, ctx(), (tx) =>
      applyEvent(tx, ctx(), submission.id, { type: 'ACCEPTED', submissionUid: 'S' }),
    );
    await withTenant(sql, ctx(), (tx) =>
      applyEvent(tx, ctx(), submission.id, {
        type: 'VALIDATED', lhdnUuid: randomUUID(), longId: 'L', validatedAt,
      }),
    );
    return submission;
  }

  it('allows cancellation inside the window', async () => {
    const submission = await validatedSubmission('2026-08-05T10:00:00Z');

    const status = await withTenant(sql, ctx(), (tx) =>
      cancelSubmission(tx, ctx(), submission.id, 'Wrong buyer', '2026-08-06T10:00:00Z'),
    );
    expect(status).toBe('CANCELLED');
  });

  it('refuses once the window has closed, pointing at the credit note path', async () => {
    const submission = await validatedSubmission('2026-08-05T10:00:00Z');

    await expect(
      withTenant(sql, ctx(), (tx) =>
        cancelSubmission(tx, ctx(), submission.id, 'Too late', '2026-08-30T10:00:00Z'),
      ),
    ).rejects.toThrow(/window .* closed[\s\S]*credit note/i);
  });
});

describe('retry scheduling and the work queue', () => {
  it('backs off exponentially', async () => {
    const invoice = await issue();
    const submission = await withTenant(sql, ctx(), async (tx) => {
      const doc = await buildInvoiceDocument(tx, ctx(), invoice.id);
      return queueSubmission(tx, ctx(), doc, invoice.id);
    });

    const now = '2026-08-05T10:00:00Z';
    const first = await withTenant(sql, ctx(), (tx) =>
      scheduleRetry(tx, ctx(), submission.id, now),
    );
    const second = await withTenant(sql, ctx(), (tx) =>
      scheduleRetry(tx, ctx(), submission.id, now),
    );

    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
  });

  it('hides a submission until its next attempt is due', async () => {
    const other = await seedTenant(admin, 'Retry Queue Sdn Bhd');
    const otherCtx = { tenantId: other.tenantId, userId: other.userId };

    await withTenant(admin, otherCtx, (tx) => tx`
        INSERT INTO einvoice_config (tenant_id, is_enabled) VALUES (${other.tenantId}, TRUE)
    `);
    await withTenant(admin, otherCtx, (tx) => tx`
        UPDATE organisation
           SET tin = 'C1111111111', ssm_registration_no = '1', msic_code = '62010',
               address_line1 = 'A', city = 'KL', postcode = '50000', state_code = '14'
         WHERE id = ${other.tenantId}
    `);
    await withTenant(admin, otherCtx, (tx) => tx`
        INSERT INTO contact_address (tenant_id, contact_id, address_type, line1, city, postcode, state_code, country_code)
        VALUES (${other.tenantId}, ${other.customerId}, 'BILLING', 'A', 'KL', '50000', '14', 'MY')
    `);

    const invoice = await withTenant(sql, otherCtx, (tx) =>
      issueInvoice(tx, otherCtx, {
        contactId: other.customerId,
        issueDate: '2026-08-05',
        lines: [{
          description: 'Services',
          quantity: '1',
          unitPrice: '100.00',
          accountId: other.accounts['4000']!,
          taxCodeId: other.taxCodes['NONE']!,
          classificationCode: '022',
        }],
        idempotencyKey: randomUUID(),
      }),
    );

    const submission = await withTenant(sql, otherCtx, async (tx) => {
      const doc = await buildInvoiceDocument(tx, otherCtx, invoice.id);
      return queueSubmission(tx, otherCtx, doc, invoice.id);
    });

    expect(
      await withTenant(sql, otherCtx, (tx) => dueForAttempt(tx, otherCtx, '2026-08-05T10:00:00Z')),
    ).toHaveLength(1);

    await withTenant(sql, otherCtx, (tx) =>
      scheduleRetry(tx, otherCtx, submission.id, '2026-08-05T10:00:00Z'),
    );

    // Not due yet...
    expect(
      await withTenant(sql, otherCtx, (tx) => dueForAttempt(tx, otherCtx, '2026-08-05T10:00:30Z')),
    ).toHaveLength(0);

    // ...and due again once the backoff elapses.
    expect(
      await withTenant(sql, otherCtx, (tx) => dueForAttempt(tx, otherCtx, '2026-08-05T11:00:00Z')),
    ).toHaveLength(1);
  });
});

describe('compliance dashboard', () => {
  it('counts submissions by state', async () => {
    const summary = await withTenant(sql, ctx(), (tx) => complianceSummary(tx, ctx()));
    expect(summary.length).toBeGreaterThan(0);
    for (const row of summary) {
      expect(row.count).toBeGreaterThan(0);
    }
  });
});

describe('issuance is never blocked by LHDN', () => {
  it('an invoice issues and posts even when it can never be submitted', async () => {
    // No classification code: submission will be refused. The invoice must
    // still exist, be posted, and be sendable to the customer.
    const invoice = await issue(null);

    expect(invoice.journalEntryId).toBeTruthy();

    const [row] = await withTenant(sql, ctx(), (tx) =>
      tx<{ status: string }[]>`
          SELECT status FROM invoice WHERE tenant_id = ${tenant.tenantId} AND id = ${invoice.id}
      `,
    );
    expect(row!.status).toBe('ISSUED');

    await expect(
      withTenant(sql, ctx(), async (tx) => {
        const doc = await buildInvoiceDocument(tx, ctx(), invoice.id);
        return queueSubmission(tx, ctx(), doc, invoice.id);
      }),
    ).rejects.toThrow();
  });
});
