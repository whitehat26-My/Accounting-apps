import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { enterBill } from '../src/bill.js';
import { createItem } from '../src/item.js';
import {
  addRepairPhoto,
  collectRepairJob,
  createRepairJob,
  deleteRepairPhoto,
  getRepairPhoto,
  listRepairPhotos,
  REPAIR_PHOTO_LIMIT,
  REPAIR_PHOTO_MAX_BYTES,
  getRepairJob,
  listRepairBoard,
  listRepairJobs,
  quoteRepairJob,
  setFittedSerials,
  transitionRepairJob,
} from '../src/repair.js';
import { issueInvoice } from '../src/invoice.js';
import { findSerial, stockLevels } from '../src/inventory.js';
import { detectRollupDrift } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * A repair, the way the workshop runs one: laptop in with a dead SSD, quote,
 * approval by WhatsApp, the replacement fitted, paid in cash at collection.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };
let ssdId: string;
let labourId: string;
let jobId: string;

/** A real 1x1 PNG. Its IHDR is what `measureImage` reads. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Evidence, the shape the counter captures it in. */
const attach = (
  job: string,
  kind: 'PHOTO' | 'SIGNATURE',
  stage: 'RECEIVED' | 'DIAGNOSIS' | 'IN_PROGRESS' | 'READY' | 'COLLECTED',
) =>
  withTenant(sql, ctx, (tx) =>
    addRepairPhoto(tx, ctx, {
      repairJobId: job,
      kind,
      stage,
      contentType: 'image/png',
      image: PNG_1PX,
    }),
  );

beforeAll(async () => {
  const db = await createTestDatabase('repair');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Workshop Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };

  const ssd = await withTenant(sql, ctx, (tx) =>
    createItem(tx, ctx, {
      code: 'SSD-500',
      name: '500GB NVMe SSD',
      itemType: 'GOODS',
      isTracked: true,
      isSerialised: true,
      isSold: true,
      isPurchased: true,
      sale: { unitPrice: '220.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
      purchase: { accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! },
    }),
  );
  ssdId = ssd.id;

  const labour = await withTenant(sql, ctx, (tx) =>
    createItem(tx, ctx, {
      code: 'LABOUR-STD',
      name: 'Bench labour',
      itemType: 'SERVICE',
      isSold: true,
      sale: { unitPrice: '80.00', accountId: tenant.accounts['4000']!, taxCodeId: tenant.taxCodes['NONE']! },
    }),
  );
  labourId = labour.id;

  await withTenant(sql, ctx, (tx) =>
    enterBill(tx, ctx, {
      supplierId: tenant.supplierId,
      billNo: 'PARTS-01',
      billDate: '2026-08-03',
      lines: [
        {
          itemId: ssdId,
          quantity: '2',
          unitPrice: '150.00',
          serialNumbers: ['NV-A1', 'NV-A2'],
        },
      ],
      idempotencyKey: randomUUID(),
    }),
  );
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('intake', () => {
  it('takes a device in and numbers the job', async () => {
    const job = await withTenant(sql, ctx, (tx) =>
      createRepairJob(tx, ctx, {
        contactId: tenant.customerId,
        deviceDescription: 'Acer Aspire 5, silver, charger included',
        deviceSerial: 'NXHS8SM00123',
        reportedFault: 'Does not boot; clicking noise from the drive bay',
        receivedOn: '2026-08-04',
        idempotencyKey: randomUUID(),
      }),
    );

    expect(job.jobNo).toMatch(/^JOB-\d{5}$/);
    jobId = job.id;

    const view = await withTenant(sql, ctx, (tx) => getRepairJob(tx, ctx, jobId));
    expect(view.status).toBe('RECEIVED');
  });

  it('replays a double-submitted intake instead of taking the laptop in twice', async () => {
    const key = randomUUID();
    const input = {
      contactId: tenant.customerId,
      deviceDescription: 'The same laptop',
      reportedFault: 'The same fault',
      receivedOn: '2026-08-04',
      idempotencyKey: key,
    };

    const first = await withTenant(sql, ctx, (tx) => createRepairJob(tx, ctx, input));
    const second = await withTenant(sql, ctx, (tx) => createRepairJob(tx, ctx, input));

    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
  });
});

describe('the evidence a job cannot run without', () => {
  const quote = {
    diagnosis: 'Failed HDD.',
    lines: [{ description: 'Replace drive', quantity: '1', unitPrice: '200.00' }],
  };

  it('refuses to name a price for a device nobody photographed', async () => {
    // Intake succeeded above with no photograph at all — deliberately. The
    // gate is on the first commercial act, not on accepting the machine.
    await expect(
      withTenant(sql, ctx, (tx) => quoteRepairJob(tx, ctx, jobId, quote)),
    ).rejects.toThrow(/Photograph the device before quoting/);
  });

  it('takes the intake photograph and the customer signing for its condition', async () => {
    const photo = await attach(jobId, 'PHOTO', 'RECEIVED');
    const signature = await attach(jobId, 'SIGNATURE', 'RECEIVED');

    expect(photo.kind).toBe('PHOTO');
    expect(signature.kind).toBe('SIGNATURE');

    // Both are rows in the same table, with the same digest machinery — a
    // signature is not a second-class piece of evidence.
    const all = await withTenant(sql, ctx, (tx) => listRepairPhotos(tx, ctx, jobId));
    expect(all.map((p) => p.kind).sort()).toEqual(['PHOTO', 'SIGNATURE']);
    expect(all.every((p) => /^[0-9a-f]{64}$/.test(p.digest))).toBe(true);
  });
});

describe('quoting and approval', () => {
  it('quotes parts and labour at agreed prices', async () => {
    const view = await withTenant(sql, ctx, (tx) =>
      quoteRepairJob(tx, ctx, jobId, {
        diagnosis: 'Failed HDD. Replace with 500GB NVMe and clone what is recoverable.',
        lines: [
          // Quoted BELOW the catalogue's 220 — the agreement wins at invoice.
          { itemId: ssdId, description: 'Replace failed drive with 500GB NVMe', quantity: '1', unitPrice: '200.00' },
          { itemId: labourId, description: 'Diagnosis, fitting and data clone', quantity: '1', unitPrice: '120.00' },
        ],
      }),
    );

    expect(view.status).toBe('QUOTED');
    expect(view.lines).toHaveLength(2);
  });

  it('refuses collection before approval', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        collectRepairJob(tx, ctx, jobId, {
          collectDate: '2026-08-05',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/QUOTED/);
  });

  it('records the approval and how it was given', async () => {
    const view = await withTenant(sql, ctx, (tx) =>
      transitionRepairJob(tx, ctx, jobId, {
        to: 'APPROVED',
        approvalNote: 'Approved by WhatsApp, 14:32',
      }),
    );

    expect(view.status).toBe('APPROVED');
    expect(view.approvalNote).toBe('Approved by WhatsApp, 14:32');
  });

  it('refuses COLLECTED as a status change from anywhere', async () => {
    // From APPROVED it is not even reachable, so the transition table refuses
    // first; the collect-specific message fires from READY (checked below).
    await expect(
      withTenant(sql, ctx, (tx) => transitionRepairJob(tx, ctx, jobId, { to: 'COLLECTED' })),
    ).rejects.toThrow(/APPROVED job cannot become COLLECTED/);
  });
});

describe('collection', () => {
  it('moves to READY, then collects cash — invoice, receipt, stock and serial in one', async () => {
    await withTenant(sql, ctx, (tx) => transitionRepairJob(tx, ctx, jobId, { to: 'READY' }));

    // Even from READY, COLLECTED is not a status you can SET — the invoice is
    // the collection, or the work walks out unbilled.
    await expect(
      withTenant(sql, ctx, (tx) => transitionRepairJob(tx, ctx, jobId, { to: 'COLLECTED' })),
    ).rejects.toThrow(/invoicing it/);

    /*
     * Nor without the customer signing for the device leaving. Checked before
     * anything is invoiced, so a missing signature can never leave a job
     * half-collected — an invoice raised against a machine still on the shelf.
     */
    await expect(
      withTenant(sql, ctx, (tx) =>
        collectRepairJob(tx, ctx, jobId, {
          collectDate: '2026-08-06',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/must sign for the device before it leaves/);

    await attach(jobId, 'SIGNATURE', 'COLLECTED');

    /*
     * The exact unit fitted is decided on the bench, so the serial arrives at
     * collection time via a final quote revision... except revising is only
     * legal pre-approval. The serial was NOT set at quote time in this test,
     * so collection must fail asking for it — proving the serialised-part
     * requirement survives the conversion.
     */
    await expect(
      withTenant(sql, ctx, (tx) =>
        collectRepairJob(tx, ctx, jobId, {
          collectDate: '2026-08-06',
          payment: { method: 'CASH', depositAccountId: tenant.accounts['1000']! },
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/serial number/);

    // Name the unit the bench fitted — through the operation that exists for
    // exactly this: serials only, after approval, never the agreed price.
    await withTenant(sql, ctx, (tx) => setFittedSerials(tx, ctx, jobId, 1, ['NV-A1']));

    const collected = await withTenant(sql, ctx, (tx) =>
      collectRepairJob(tx, ctx, jobId, {
        collectDate: '2026-08-06',
        payment: {
          method: 'CASH',
          depositAccountId: tenant.accounts['1000']!,
          tenderedAmount: '350.00',
        },
        idempotencyKey: randomUUID(),
      }),
    );

    // 200 + 120, quoted prices — not the catalogue's 220.
    expect(collected.total).toBe('320.0000');
    expect(collected.changeDue).toBe('30.0000');
    expect(collected.paid).toBe(true);
    expect(collected.invoiceNo).toMatch(/^INV-/);

    const view = await withTenant(sql, ctx, (tx) => getRepairJob(tx, ctx, jobId));
    expect(view.status).toBe('COLLECTED');
    expect(view.invoiceId).toBe(collected.invoiceId);

    // The fitted SSD left stock, by name, bound to this invoice.
    const matches = await withTenant(sql, ctx, (tx) => findSerial(tx, ctx, 'NV-A1'));
    expect(matches[0]!.status).toBe('SOLD');
    expect(matches[0]!.issuedTo?.documentId).toBe(collected.invoiceId);

    const levels = await withTenant(sql, ctx, (tx) => stockLevels(tx, ctx));
    expect(levels.find((l) => l.code === 'SSD-500')?.quantityOnHand).toBe('1.0000');
  });

  it('replays a double-clicked collection instead of invoicing twice', async () => {
    const view = await withTenant(sql, ctx, (tx) => getRepairJob(tx, ctx, jobId));

    // Same key as stored → replay. (A different key on a COLLECTED job is an
    // illegal transition and refused by the state machine.)
    const [job] = await withTenant(sql, ctx, (tx) =>
      tx<{ collect_idempotency_key: string }[]>`
          SELECT collect_idempotency_key FROM repair_job
           WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
      `,
    );

    const replayed = await withTenant(sql, ctx, (tx) =>
      collectRepairJob(tx, ctx, jobId, {
        collectDate: '2026-08-06',
        idempotencyKey: job!.collect_idempotency_key,
      }),
    );

    expect(replayed.invoiceId).toBe(view.invoiceId);
    expect(replayed.total).toBe('320.0000');

    const [invoices] = await withTenant(sql, ctx, (tx) =>
      tx<{ n: string }[]>`
          SELECT COUNT(*)::text AS n FROM invoice WHERE tenant_id = ${ctx.tenantId}
      `,
    );
    expect(invoices!.n).toBe('1');
  });
});

describe('declines and the queue', () => {
  it('declines with a reason, re-quotes cheaper, and shows up in the queue by status', async () => {
    const job = await withTenant(sql, ctx, (tx) =>
      createRepairJob(tx, ctx, {
        contactId: tenant.customerId,
        deviceDescription: 'Dell XPS 13',
        reportedFault: 'Cracked screen',
        receivedOn: '2026-08-05',
        accessories: ['Charger', 'Sleeve'],
        idempotencyKey: randomUUID(),
      }),
    );

    await attach(job.id, 'PHOTO', 'RECEIVED');

    await withTenant(sql, ctx, (tx) =>
      quoteRepairJob(tx, ctx, job.id, {
        diagnosis: 'Panel replacement required',
        lines: [{ itemId: labourId, description: 'OEM panel + fitting', quantity: '1', unitPrice: '850.00' }],
      }),
    );

    await expect(
      withTenant(sql, ctx, (tx) => transitionRepairJob(tx, ctx, job.id, { to: 'DECLINED' })),
    ).rejects.toThrow(/requires a reason/);

    await withTenant(sql, ctx, (tx) =>
      transitionRepairJob(tx, ctx, job.id, { to: 'DECLINED', reason: 'Too expensive for the age of the machine' }),
    );

    // "What about a compatible panel instead?"
    const requoted = await withTenant(sql, ctx, (tx) =>
      quoteRepairJob(tx, ctx, job.id, {
        diagnosis: 'Panel replacement — compatible part',
        lines: [{ itemId: labourId, description: 'Compatible panel + fitting', quantity: '1', unitPrice: '520.00' }],
      }),
    );
    expect(requoted.status).toBe('QUOTED');

    const quoted = await withTenant(sql, ctx, (tx) => listRepairJobs(tx, ctx, { status: 'QUOTED' }));
    expect(quoted.some((j) => j.id === job.id)).toBe(true);

    // What came in with it, carried back out on the view the slip prints from.
    const view = await withTenant(sql, ctx, (tx) => getRepairJob(tx, ctx, job.id));
    expect(view.accessories).toEqual(['Charger', 'Sleeve']);
  });

  it('answers not-found for another tenant’s job', async () => {
    const other = await seedTenant(admin, 'Rival Workshop Sdn Bhd');
    const theirs = await withTenant(
      sql,
      { tenantId: other.tenantId, userId: other.userId },
      (tx) =>
        createRepairJob(tx, { tenantId: other.tenantId, userId: other.userId }, {
          contactId: other.customerId,
          deviceDescription: 'Their machine',
          reportedFault: 'Their problem',
          receivedOn: '2026-08-05',
          idempotencyKey: randomUUID(),
        }),
    );

    await expect(
      withTenant(sql, ctx, (tx) => getRepairJob(tx, ctx, theirs.id)),
    ).rejects.toThrow(/not found/i);
  });
});

describe('the books after the workshop', () => {
  it('rollup drift stays empty', async () => {
    const drift = await withTenant(sql, ctx, (tx) => detectRollupDrift(tx, ctx));
    expect(drift).toEqual([]);
  });
});

/**
 * Photographs — the evidence side of a job.
 *
 * A one-pixel PNG stands in for a phone photograph: what is being tested is the
 * record around the bytes, not the bytes themselves.
 */
describe('repair job photographs', () => {
  let photoJobId: string;

  beforeAll(async () => {
    const job = await withTenant(sql, ctx, (tx) =>
      createRepairJob(tx, ctx, {
        contactId: tenant.customerId,
        deviceDescription: 'Acer Nitro 5, scratched lid',
        reportedFault: 'Will not power on',
        receivedOn: '2026-08-03',
        idempotencyKey: randomUUID(),
      }),
    );
    photoJobId = job.id;
  });

  it('stores a photograph and reads its dimensions from the file itself', async () => {
    const photo = await withTenant(sql, ctx, (tx) =>
      addRepairPhoto(tx, ctx, {
        repairJobId: photoJobId,
        stage: 'RECEIVED',
        caption: 'Scratch on lid, as received',
        contentType: 'image/png',
        image: PNG_1PX,
      }),
    );

    expect(photo.stage).toBe('RECEIVED');
    expect(photo.byteSize).toBe(PNG_1PX.byteLength);
    // Read from the PNG header, not taken on trust from the caller.
    expect(photo.width).toBe(1);
    expect(photo.height).toBe(1);
    expect(photo.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the exact bytes that went in', async () => {
    const [photo] = await withTenant(sql, ctx, (tx) => listRepairPhotos(tx, ctx, photoJobId));
    const fetched = await withTenant(sql, ctx, (tx) =>
      getRepairPhoto(tx, ctx, photoJobId, photo!.id),
    );
    expect(Buffer.compare(fetched.image, PNG_1PX)).toBe(0);
    expect(fetched.contentType).toBe('image/png');
  });

  it('the stored digest really is the hash of the stored bytes', async () => {
    // The property the whole split-table design rests on: the audited metadata
    // row can prove the un-audited bytes were not swapped.
    const { createHash } = await import('node:crypto');
    const [photo] = await withTenant(sql, ctx, (tx) => listRepairPhotos(tx, ctx, photoJobId));
    const fetched = await withTenant(sql, ctx, (tx) =>
      getRepairPhoto(tx, ctx, photoJobId, photo!.id),
    );
    expect(createHash('sha256').update(fetched.image).digest('hex')).toBe(photo!.digest);
  });

  it('refuses a photograph fetched through the wrong job', async () => {
    // The photo id alone is not authority — the (job, photo) pair is.
    const other = await withTenant(sql, ctx, (tx) =>
      createRepairJob(tx, ctx, {
        contactId: tenant.customerId,
        deviceDescription: 'Another machine',
        reportedFault: 'Fan noise',
        receivedOn: '2026-08-03',
        idempotencyKey: randomUUID(),
      }),
    );
    const [photo] = await withTenant(sql, ctx, (tx) => listRepairPhotos(tx, ctx, photoJobId));

    await expect(
      withTenant(sql, ctx, (tx) => getRepairPhoto(tx, ctx, other.id, photo!.id)),
    ).rejects.toThrow(/not found/i);
  });

  it('refuses an image over the size ceiling', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        addRepairPhoto(tx, ctx, {
          repairJobId: photoJobId,
          stage: 'DIAGNOSIS',
          contentType: 'image/jpeg',
          image: Buffer.alloc(REPAIR_PHOTO_MAX_BYTES + 1, 1),
        }),
      ),
    ).rejects.toThrow(/between 1 byte/i);
  });

  it('caps the number of photographs on one job', async () => {
    const fill = async () => {
      const current = await withTenant(sql, ctx, (tx) => listRepairPhotos(tx, ctx, photoJobId));
      for (let i = current.length; i < REPAIR_PHOTO_LIMIT; i++) {
        await withTenant(sql, ctx, (tx) =>
          addRepairPhoto(tx, ctx, {
            repairJobId: photoJobId,
            stage: 'IN_PROGRESS',
            contentType: 'image/png',
            image: PNG_1PX,
          }),
        );
      }
    };
    await fill();

    await expect(
      withTenant(sql, ctx, (tx) =>
        addRepairPhoto(tx, ctx, {
          repairJobId: photoJobId,
          stage: 'IN_PROGRESS',
          contentType: 'image/png',
          image: PNG_1PX,
        }),
      ),
    ).rejects.toThrow(/already has/i);
  });

  it('deleting a photograph takes its bytes with it', async () => {
    const before = await withTenant(sql, ctx, (tx) => listRepairPhotos(tx, ctx, photoJobId));
    const victim = before[0]!;

    await withTenant(sql, ctx, (tx) => deleteRepairPhoto(tx, ctx, photoJobId, victim.id));

    const after = await withTenant(sql, ctx, (tx) => listRepairPhotos(tx, ctx, photoJobId));
    expect(after).toHaveLength(before.length - 1);

    // The CASCADE in 0035 removed the data row too — no orphan bytes.
    const orphans = await withTenant(sql, ctx, (tx) =>
      tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count FROM repair_job_photo_data
           WHERE tenant_id = ${ctx.tenantId} AND photo_id = ${victim.id}
      `,
    );
    expect(orphans[0]!['count']).toBe('0');
  });

  it('freezes the evidence once the machine has gone back', async () => {
    // A closed job's photographs describe something nobody can re-examine.
    // Adding to that record is assertion, not evidence.
    const closed = await withTenant(sql, ctx, (tx) =>
      createRepairJob(tx, ctx, {
        contactId: tenant.customerId,
        deviceDescription: 'Cancelled intake',
        reportedFault: 'Customer changed their mind',
        receivedOn: '2026-08-03',
        idempotencyKey: randomUUID(),
      }),
    );
    await withTenant(sql, ctx, (tx) =>
      transitionRepairJob(tx, ctx, closed.id, { to: 'CANCELLED', reason: 'Withdrawn' }),
    );

    await expect(
      withTenant(sql, ctx, (tx) =>
        addRepairPhoto(tx, ctx, {
          repairJobId: closed.id,
          stage: 'RECEIVED',
          contentType: 'image/png',
          image: PNG_1PX,
        }),
      ),
    ).rejects.toThrow(/closed|cannot be added/i);
  });

  it('writes an audit row naming who added the photograph', async () => {
    const rows = await withTenant(sql, ctx, (tx) =>
      tx<{ action: string; actor_user_id: string | null }[]>`
          SELECT action, actor_user_id FROM audit_log
           WHERE tenant_id = ${ctx.tenantId} AND entity_type = 'repair_job_photo'
           ORDER BY id
      `,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.action === 'CREATE')).toBe(true);
    expect(rows.some((r) => r.action === 'DELETE')).toBe(true);
  });
});

/**
 * The board is a READ, and everything that makes it worth opening comes from
 * one query. These tests exist because each of those lateral joins is a place
 * a silent wrong answer can hide: a warranty that matches the wrong tenant, a
 * photo count that counts the wrong stage, an age off by a day.
 */
describe('the workshop board', () => {
  let laptopId: string;
  let boardJobId: string;

  beforeAll(async () => {
    // A promised item, sold, so there is a real warranty to find.
    const laptop = await withTenant(sql, ctx, (tx) =>
      createItem(tx, ctx, {
        code: 'NB-BOARD',
        name: 'ThinkPad, board fixture',
        itemType: 'GOODS',
        isTracked: true,
        isSerialised: true,
        isSold: true,
        isPurchased: true,
        warrantyMonths: 12,
        sale: {
          unitPrice: '5200.00',
          accountId: tenant.accounts['4000']!,
          taxCodeId: tenant.taxCodes['NONE']!,
        },
        purchase: { accountId: tenant.accounts['5000']!, taxCodeId: tenant.taxCodes['NONE']! },
      }),
    );
    laptopId = laptop.id;

    await withTenant(sql, ctx, (tx) =>
      enterBill(tx, ctx, {
        supplierId: tenant.supplierId,
        billNo: 'PARTS-BOARD',
        billDate: '2026-08-01',
        lines: [{ itemId: laptopId, quantity: '1', unitPrice: '4000.00', serialNumbers: ['TP-9001'] }],
        idempotencyKey: randomUUID(),
      }),
    );

    await withTenant(sql, ctx, (tx) =>
      issueInvoice(tx, ctx, {
        contactId: tenant.customerId,
        issueDate: '2026-08-02',
        lines: [{ itemId: laptopId, quantity: '1', serialNumbers: ['TP-9001'] }],
        idempotencyKey: randomUUID(),
      }),
    );
  }, 60_000);

  it('carries the customer, not just the contact id', async () => {
    const job = await withTenant(sql, ctx, (tx) =>
      createRepairJob(tx, ctx, {
        contactId: tenant.customerId,
        deviceDescription: 'ThinkPad back in',
        // LOWER CASE on purpose: a serial is typed at a counter, and matching
        // it raw is how a warranty silently fails to be found.
        deviceSerial: 'tp-9001',
        reportedFault: 'Fan noise',
        receivedOn: '2026-08-05',
        idempotencyKey: randomUUID(),
      }),
    );
    boardJobId = job.id;

    const cards = await withTenant(sql, ctx, (tx) =>
      listRepairBoard(tx, ctx, { today: '2026-08-08' }),
    );
    const card = cards.find((c) => c.id === boardJobId);
    expect(card).toBeDefined();
    expect(card!.customerName).toBeTruthy();
  });

  it('flashes the warranty for a serial this shop sold, however it was typed', async () => {
    const cards = await withTenant(sql, ctx, (tx) =>
      listRepairBoard(tx, ctx, { today: '2026-08-08' }),
    );
    const card = cards.find((c) => c.id === boardJobId)!;

    expect(card.warranty).not.toBeNull();
    expect(card.warranty!.soldOn).toBe('2026-08-02');
    expect(card.warranty!.expiresOn).toBe('2027-08-02');
    expect(card.warranty!.status).toBe('ACTIVE');
  });

  it('says nothing at all about a device this shop never sold', async () => {
    const job = await withTenant(sql, ctx, (tx) =>
      createRepairJob(tx, ctx, {
        contactId: tenant.customerId,
        deviceDescription: 'Somebody else’s laptop',
        deviceSerial: 'NOT-OURS-1',
        reportedFault: 'Screen flickers',
        receivedOn: '2026-08-06',
        idempotencyKey: randomUUID(),
      }),
    );

    const cards = await withTenant(sql, ctx, (tx) =>
      listRepairBoard(tx, ctx, { today: '2026-08-08' }),
    );
    const card = cards.find((c) => c.id === job.id)!;
    // `null`, never "expired". The board must not imply a promise was made.
    expect(card.warranty).toBeNull();
  });

  it('counts the age in whole days from the date it arrived', async () => {
    const cards = await withTenant(sql, ctx, (tx) =>
      listRepairBoard(tx, ctx, { today: '2026-08-08' }),
    );
    const card = cards.find((c) => c.id === boardJobId)!;
    expect(card.ageDays).toBe(3); // received 05/08, board read on 08/08
  });

  it('reports the intake evidence, which is what gates quoting', async () => {
    const before = await withTenant(sql, ctx, (tx) =>
      listRepairBoard(tx, ctx, { today: '2026-08-08' }),
    );
    expect(before.find((c) => c.id === boardJobId)!.intakePhotoCount).toBe(0);

    await attach(boardJobId, 'PHOTO', 'RECEIVED');
    // A photo at a LATER stage must not satisfy the intake gate — the picture
    // of how it arrived is the one nobody can recreate.
    await attach(boardJobId, 'PHOTO', 'IN_PROGRESS');
    await attach(boardJobId, 'SIGNATURE', 'RECEIVED');

    const after = await withTenant(sql, ctx, (tx) =>
      listRepairBoard(tx, ctx, { today: '2026-08-08' }),
    );
    const card = after.find((c) => c.id === boardJobId)!;
    expect(card.intakePhotoCount).toBe(1);
    expect(card.intakeSignatureCount).toBe(1);
  });

  it('shows another tenant nothing of this one', async () => {
    const other = await seedTenant(admin, 'Rival Repairs Sdn Bhd');
    const otherCtx = { tenantId: other.tenantId, userId: other.userId };
    const cards = await withTenant(sql, otherCtx, (tx) => listRepairBoard(tx, otherCtx));
    expect(cards).toEqual([]);
  });
});
