import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessTokenFor,
  call,
  callRaw,
  createTestApi,
  pdfText,
  makeUser,
  seedTenant,
  type TestApi,
  type Tenant,
} from './helpers.js';

/**
 * A repair over HTTP, end to end: intake, quote, approve, name the fitted
 * unit, collect cash. Driven as SALES — the counter runs the workshop queue.
 */

let api: TestApi;
let tenant: Tenant;
let token: string;
let itemId: string;
let jobId: string;

beforeAll(async () => {
  api = await createTestApi('repairs');
  tenant = await seedTenant(api.admin, 'Repairs Routes Sdn Bhd');
  const owner = await makeUser(api, { tenantId: tenant.tenantId, role: 'OWNER' });
  const ownerToken = (await accessTokenFor(api, owner.refreshToken, tenant.tenantId)).accessToken;

  const sales = await makeUser(api, { tenantId: tenant.tenantId, role: 'SALES' });
  ({ accessToken: token } = await accessTokenFor(api, sales.refreshToken, tenant.tenantId));

  const created = await call(api, {
    method: 'POST',
    url: '/v1/items',
    token: ownerToken,
    tenantId: tenant.tenantId,
    body: {
      code: 'RAM-16G',
      name: '16GB DDR5 SO-DIMM',
      itemType: 'GOODS',
      isTracked: true,
      isSerialised: true,
      isSold: true,
      isPurchased: true,
      sale: { unitPrice: '300.00', accountId: tenant.accounts['4000'], taxCodeId: tenant.taxCodes['NONE'] },
      purchase: { accountId: tenant.accounts['5000'], taxCodeId: tenant.taxCodes['NONE'] },
    },
  });
  itemId = created.body['id'] as string;

  await call(api, {
    method: 'POST',
    url: '/v1/bills',
    token: ownerToken,
    tenantId: tenant.tenantId,
    body: {
      supplierId: tenant.supplierId,
      billNo: 'RAM-SUP-1',
      billDate: '2026-08-03',
      lines: [{ itemId, quantity: '2', unitPrice: '210.00', serialNumbers: ['DDR-01', 'DDR-02'] }],
    },
  });
}, 120_000);

afterAll(async () => {
  await api?.close();
});

const as = (url: string) => ({ url, token, tenantId: tenant.tenantId });

/** A real 1x1 PNG — a stand-in for a camera shot and for a signature pad. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Evidence, as the counter and the bench actually post it. */
const attach = (job: string, kind: 'PHOTO' | 'SIGNATURE', stage: string, caption?: string) =>
  call(api, {
    method: 'POST',
    ...as(`/v1/repairs/${job}/photos`),
    body: {
      kind,
      stage,
      contentType: 'image/png',
      imageBase64: PNG_1PX,
      ...(caption !== undefined ? { caption } : {}),
    },
  });

describe('the workshop over HTTP', () => {
  it('runs intake → quote → approve → fitted → collect, and the money is right', async () => {
    const intake = await call(api, {
      method: 'POST',
      ...as('/v1/repairs'),
      body: {
        contactId: tenant.customerId,
        deviceDescription: 'Lenovo IdeaPad, blue',
        reportedFault: 'Very slow; freezes with many tabs',
        receivedOn: '2026-08-04',
        accessories: ['Charger', 'Sleeve'],
      },
    });
    expect(intake.status).toBe(201);
    expect(intake.body['jobNo']).toMatch(/^JOB-/);
    jobId = intake.body['id'] as string;

    // Naming a price is the first commercial act, and the app refuses it until
    // the device has been photographed. See migration 0048.
    const unphotographed = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/quote`),
      body: {
        diagnosis: 'Needs more memory',
        lines: [{ description: 'RAM upgrade', quantity: '1', unitPrice: '280.00' }],
      },
    });
    expect(unphotographed.status).toBe(422);
    expect(unphotographed.body['message']).toMatch(/Photograph the device/);

    expect((await attach(jobId, 'PHOTO', 'RECEIVED', 'As received')).status).toBe(201);
    expect((await attach(jobId, 'SIGNATURE', 'RECEIVED')).status).toBe(201);

    const quote = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/quote`),
      body: {
        diagnosis: '8GB is not enough for the workload. Upgrade to 16GB.',
        lines: [
          { itemId, description: 'RAM upgrade to 16GB', quantity: '1', unitPrice: '280.00' },
          { description: 'Fitting and memtest', quantity: '1', unitPrice: '40.00', accountId: tenant.accounts['4000'], taxCodeId: tenant.taxCodes['NONE'] },
        ],
      },
    });
    expect(quote.status).toBe(201);
    expect(quote.body['status']).toBe('QUOTED');

    const approve = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/status`),
      body: { to: 'APPROVED', approvalNote: 'Customer agreed at the counter' },
    });
    expect(approve.status).toBe(201);

    const fitted = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/lines/1/serials`),
      body: { serialNumbers: ['DDR-02'] },
    });
    expect(fitted.status).toBe(201);

    await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/status`),
      body: { to: 'READY' },
    });

    // And it will not leave the shop until the customer signs for it leaving.
    const unsigned = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/collect`),
      body: { collectDate: '2026-08-05' },
    });
    expect(unsigned.status).toBe(422);
    expect(unsigned.body['message']).toMatch(/sign for the device/);

    expect((await attach(jobId, 'SIGNATURE', 'COLLECTED')).status).toBe(201);

    const collect = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${jobId}/collect`),
      body: {
        collectDate: '2026-08-05',
        payment: {
          method: 'CASH',
          depositAccountId: tenant.accounts['1000'],
          tenderedAmount: '350.00',
        },
      },
    });

    expect(collect.status).toBe(201);
    expect(collect.body['total']).toBe('320.0000'); // 280 + 40, as agreed
    expect(collect.body['changeDue']).toBe('30.0000');
    expect(collect.body['paid']).toBe(true);

    // The fitted stick is bound to the collection invoice.
    const lookup = await call(api, { method: 'GET', ...as('/v1/stock/serials/DDR-02') });
    const match = (lookup.body['matches'] as Record<string, unknown>[])[0]!;
    expect(match['status']).toBe('SOLD');
    expect((match['issuedTo'] as Record<string, unknown>)['documentId']).toBe(
      collect.body['invoiceId'],
    );
  });

  it('refuses collecting a job that is not READY, with the state named', async () => {
    const intake = await call(api, {
      method: 'POST',
      ...as('/v1/repairs'),
      body: {
        contactId: tenant.customerId,
        deviceDescription: 'HP Pavilion',
        reportedFault: 'No power',
        receivedOn: '2026-08-05',
      },
    });

    const collect = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${intake.body['id']}/collect`),
      body: { collectDate: '2026-08-05' },
    });

    expect(collect.status).toBe(422);
    expect(collect.body['message']).toMatch(/RECEIVED/);
  });

  it('filters the queue by status', async () => {
    const queue = await call(api, { method: 'GET', ...as('/v1/repairs?status=COLLECTED') });
    expect(queue.status).toBe(200);
    expect((queue.body['jobs'] as Record<string, unknown>[]).some((j) => j['id'] === jobId)).toBe(
      true,
    );
  });
});

/**
 * Photographs over HTTP.
 *
 * Its own job, so it does not depend on where the journey above left the
 * shared one — and because the interesting cases here are about a job that is
 * still open.
 */
describe('photographs on a job', () => {
  let photoJobId: string;
  let photoId: string;

  beforeAll(async () => {
    const intake = await call(api, {
      method: 'POST',
      ...as('/v1/repairs'),
      body: {
        contactId: tenant.customerId,
        deviceDescription: 'Acer Nitro, scratched lid',
        reportedFault: 'Will not power on',
        receivedOn: '2026-08-04',
      },
    });
    photoJobId = intake.body['id'] as string;
  });

  it('accepts a photograph and lists it back', async () => {
    const added = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${photoJobId}/photos`),
      body: {
        stage: 'RECEIVED',
        caption: 'Scratch on the lid, as received',
        contentType: 'image/png',
        imageBase64: PNG_1PX,
      },
    });
    expect(added.status).toBe(201);
    expect(added.body['stage']).toBe('RECEIVED');
    expect(added.body['digest']).toMatch(/^[0-9a-f]{64}$/);
    photoId = added.body['id'] as string;

    const listed = await call(api, { method: 'GET', ...as(`/v1/repairs/${photoJobId}/photos`) });
    expect(listed.status).toBe(200);
    expect((listed.body['photos'] as unknown[])).toHaveLength(1);
  });

  it('serves the bytes back with the right content type, and never caches them', async () => {
    const raw = await callRaw(api, {
      method: 'GET',
      ...as(`/v1/repairs/${photoJobId}/photos/${photoId}`),
    });
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toContain('image/png');
    // A picture of a customer's property must not sit in a shared cache.
    expect(raw.headers['cache-control']).toContain('no-store');
    expect(raw.headers['etag']).toBeTruthy();
    // Asserted on Content-Length rather than on the body: `callRaw` hands back a
    // string, and pushing image bytes through a string round-trip mangles them.
    // The header is what the client actually reads to size the download.
    expect(Number(raw.headers['content-length'])).toBe(Buffer.from(PNG_1PX, 'base64').length);
  });

  it('will not serve a photograph through another job’s URL', async () => {
    const other = await call(api, {
      method: 'POST',
      ...as('/v1/repairs'),
      body: {
        contactId: tenant.customerId,
        deviceDescription: 'Unrelated machine',
        reportedFault: 'Fan noise',
        receivedOn: '2026-08-04',
      },
    });
    const wrong = await call(api, {
      method: 'GET',
      ...as(`/v1/repairs/${other.body['id'] as string}/photos/${photoId}`),
    });
    expect(wrong.status).toBe(404);
  });

  it('refuses a payload that is not an image the schema allows', async () => {
    const bad = await call(api, {
      method: 'POST',
      ...as(`/v1/repairs/${photoJobId}/photos`),
      body: {
        stage: 'RECEIVED',
        contentType: 'application/pdf',
        imageBase64: PNG_1PX,
      },
    });
    expect(bad.status).toBe(422);
  });

  it('a technician may photograph the bench but still cannot see money', async () => {
    // The role that matters most here: workshop staff need to record evidence,
    // and must not gain sight of the shop's figures by doing so.
    const tech = await makeUser(api, { tenantId: tenant.tenantId, role: 'TECHNICIAN' });
    const { accessToken: techToken } = await accessTokenFor(
      api, tech.refreshToken, tenant.tenantId,
    );
    const asTech = (url: string) => ({ url, token: techToken, tenantId: tenant.tenantId });

    const added = await call(api, {
      method: 'POST',
      ...asTech(`/v1/repairs/${photoJobId}/photos`),
      body: { stage: 'IN_PROGRESS', contentType: 'image/png', imageBase64: PNG_1PX },
    });
    expect(added.status).toBe(201);

    expect((await call(api, { method: 'GET', ...asTech('/v1/reports/daily-takings') })).status)
      .toBe(403);
  });

  it('removes a photograph, and the second removal is a 404', async () => {
    const removed = await call(api, {
      method: 'DELETE',
      ...as(`/v1/repairs/${photoJobId}/photos/${photoId}`),
    });
    expect(removed.status).toBe(200);

    const again = await call(api, {
      method: 'DELETE',
      ...as(`/v1/repairs/${photoJobId}/photos/${photoId}`),
    });
    expect(again.status).toBe(404);
  });
});

/**
 * The two documents the workshop prints.
 *
 * Asserted on the TEXT INSIDE the PDF, not merely on the content type. The
 * renderer runs with `compress: false` precisely so a test can read what a
 * customer will read — a 200 with a valid-but-blank PDF is the failure this
 * catches, and it is the failure that would otherwise reach the counter.
 */
describe('the printed repair documents', () => {
  it('prints the intake slip with the device, the accessories and the photograph', async () => {
    const raw = await callRaw(api, { method: 'GET', ...as(`/v1/repairs/${jobId}/slip.pdf`) });

    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toContain('application/pdf');
    expect(raw.headers['content-disposition']).toMatch(/JOB-\d+-received\.pdf/);
    expect(raw.body.startsWith('%PDF-')).toBe(true);

    const text = pdfText(raw.body);
    expect(text).toContain('DEVICE RECEIVED');
    expect(text).toContain('Lenovo IdeaPad');
    // The accessories ticked at the counter — the answer to "I gave you the
    // charger", printed on the copy the customer walks out holding.
    expect(text).toContain('Charger');
    expect(text).toContain('Sleeve');
    expect(text).toContain('Fault as reported by the customer');
  });

  it('prints the job report with the work, the total and the photographic record', async () => {
    const raw = await callRaw(api, { method: 'GET', ...as(`/v1/repairs/${jobId}/report.pdf`) });

    expect(raw.status).toBe(200);
    const text = pdfText(raw.body);
    expect(text).toContain('REPAIR JOB REPORT');
    expect(text).toContain('What we found');
    expect(text).toContain('Work carried out');
    // The agreed figures, not the catalogue's.
    expect(text).toContain('320.00');
    expect(text).toContain('Photographic record');
    // The serial actually fitted sits beside the part it belongs to.
    expect(text).toContain('DDR-02');
  });

  it('carries a fingerprint that the public verify route recognises', async () => {
    const raw = await callRaw(api, { method: 'GET', ...as(`/v1/repairs/${jobId}/report.pdf`) });
    // Printed in four groups of sixteen so a person can read it aloud without
    // losing their place; whitespace between them is presentation, not data.
    const digest = /([0-9a-f]{16})\s*([0-9a-f]{16})\s*([0-9a-f]{16})\s*([0-9a-f]{16})/
      .exec(pdfText(raw.body));
    expect(digest).not.toBeNull();

    // No token, no tenant header: this is the route a customer holding the
    // paper uses, and it must work for somebody with no account at all.
    const verified = await call(api, {
      method: 'POST',
      url: '/public/verify',
      body: { digest: digest!.slice(1, 5).join('') },
    });
    expect(verified.status).toBe(201);
    expect(verified.body['verdict']).toBe('GENUINE');
    expect(verified.body['documentType']).toBe('REPAIR_JOB');
  });

  it('answers 404 for another tenant’s job rather than confirming it exists', async () => {
    const other = await seedTenant(api.admin, 'Rival Workshop Sdn Bhd');
    const rival = await makeUser(api, { tenantId: other.tenantId, role: 'OWNER' });
    const { accessToken: rivalToken } = await accessTokenFor(
      api, rival.refreshToken, other.tenantId,
    );
    const theirs = await call(api, {
      method: 'POST',
      url: '/v1/repairs',
      token: rivalToken,
      tenantId: other.tenantId,
      body: {
        contactId: other.customerId,
        deviceDescription: 'Their machine',
        reportedFault: 'Their problem',
        receivedOn: '2026-08-05',
      },
    });

    const peek = await call(api, {
      method: 'GET',
      ...as(`/v1/repairs/${theirs.body['id'] as string}/report.pdf`),
    });
    expect(peek.status).toBe(404);
  });
});
