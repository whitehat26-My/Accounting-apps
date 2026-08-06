import { Money } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';
import { sellerBlock, type SellerBlock } from './document-data.js';

/**
 * Everything the two printed repair documents need, in one read.
 *
 * ---------------------------------------------------------------------------
 * TWO DOCUMENTS, ONE SHAPE.
 *
 * The intake slip and the finished job report are the same job at two moments,
 * so they are the same query. The slip prints the RECEIVED half — device,
 * accessories, the photographs taken at the counter, the customer's signature
 * accepting that record. The report prints all of it. Fetching twice, once per
 * document, would let the two drift: a slip that lists four accessories and a
 * report that lists three is the argument the accessories list exists to end.
 *
 * The image BYTES come back with the metadata, because a PDF cannot embed a
 * URL. That makes this read genuinely heavy — twelve photographs at 2 MB is
 * 24 MB — so it is not the read a list screen uses. `listRepairPhotos` stays
 * the metadata-only path, and this one is reached only when a document is
 * actually being printed.
 * ---------------------------------------------------------------------------
 */

export class RepairDocumentError extends Error {
  constructor(readonly code: 'REPAIR_JOB_NOT_FOUND', message: string) {
    super(message);
    this.name = 'RepairDocumentError';
  }
}

export interface RepairEvidencePhoto {
  readonly id: string;
  readonly kind: 'PHOTO' | 'SIGNATURE';
  readonly stage: string;
  readonly caption: string | null;
  readonly contentType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly digest: string;
  /** The date the shot was taken — printed under it, so a photo is dated. */
  readonly takenOn: string;
  readonly takenByName: string | null;
  readonly image: Buffer;
}

export interface RepairDocument {
  readonly seller: SellerBlock;
  readonly jobId: string;
  readonly jobNo: string;
  readonly status: string;
  readonly receivedOn: string;
  readonly collectedOn: string | null;
  readonly customer: { readonly name: string; readonly phone: string | null };
  readonly deviceDescription: string;
  readonly deviceSerial: string | null;
  readonly reportedFault: string;
  readonly diagnosis: string | null;
  readonly approvalNote: string | null;
  readonly closedReason: string | null;
  readonly accessories: readonly string[];
  readonly currency: string;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly description: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly lineTotal: string;
    readonly serialNumbers: readonly string[] | null;
  }[];
  readonly total: string;
  readonly invoiceNo: string | null;
  readonly photos: readonly RepairEvidencePhoto[];
  readonly signatures: readonly RepairEvidencePhoto[];
}

export async function repairDocumentData(
  tx: Tx,
  ctx: TenantContext,
  jobId: string,
): Promise<RepairDocument> {
  const [job] = await tx<
    {
      job_no: string; status: string; received_on: Date; collected_on: Date | null;
      device_description: string; device_serial: string | null; reported_fault: string;
      diagnosis: string | null; approval_note: string | null; closed_reason: string | null;
      accessories: string[]; customer_name: string; customer_phone: string | null;
      invoice_no: string | null;
    }[]
  >`
      SELECT j.job_no, j.status, j.received_on, j.collected_on, j.device_description,
             j.device_serial, j.reported_fault, j.diagnosis, j.approval_note,
             j.closed_reason, j.accessories,
             c.name AS customer_name, c.phone AS customer_phone,
             i.invoice_no
        FROM repair_job j
        JOIN contact c      ON c.tenant_id = j.tenant_id AND c.id = j.contact_id
        LEFT JOIN invoice i ON i.tenant_id = j.tenant_id AND i.id = j.invoice_id
       WHERE j.tenant_id = ${ctx.tenantId} AND j.id = ${jobId}
  `;
  if (!job) {
    // Another tenant's job is indistinguishable from none — rule 9.
    throw new RepairDocumentError('REPAIR_JOB_NOT_FOUND', `Repair job ${jobId} not found`);
  }

  const lines = await tx<
    {
      line_no: number; description: string; quantity: string; unit_price: string;
      line_total: string; serial_numbers: string[] | null;
    }[]
  >`
      SELECT line_no, description, quantity, unit_price,
             (quantity::numeric * unit_price::numeric)::numeric(19,4) AS line_total,
             serial_numbers
        FROM repair_job_line
       WHERE tenant_id = ${ctx.tenantId} AND repair_job_id = ${jobId}
       ORDER BY line_no
  `;

  /*
   * `audit_actor` resolves a user id to a name only for members of this
   * tenant, so naming the technician on the report cannot leak a name across
   * tenants. A photograph taken before the column existed simply has no name.
   */
  const evidence = await tx<
    {
      id: string; kind: 'PHOTO' | 'SIGNATURE'; stage: string; caption: string | null;
      content_type: string; width: number | null; height: number | null;
      digest: string; created_at: Date; taken_by_name: string | null; image: Buffer;
    }[]
  >`
      SELECT p.id, p.kind, p.stage, p.caption, p.content_type, p.width, p.height,
             p.digest, p.created_at,
             audit_actor(p.taken_by) AS taken_by_name,
             d.image
        FROM repair_job_photo p
        JOIN repair_job_photo_data d
          ON d.tenant_id = p.tenant_id AND d.photo_id = p.id
       WHERE p.tenant_id = ${ctx.tenantId} AND p.repair_job_id = ${jobId}
       ORDER BY p.created_at
  `;

  const toEvidence = (r: (typeof evidence)[number]): RepairEvidencePhoto => ({
    id: r.id,
    kind: r.kind,
    stage: r.stage,
    caption: r.caption,
    contentType: r.content_type,
    width: r.width,
    height: r.height,
    digest: r.digest,
    takenOn: toIsoDate(r.created_at),
    takenByName: r.taken_by_name,
    image: r.image,
  });

  // Money, never a JS number — rule 2. The quote total on the report has to
  // agree to the sen with the invoice raised from the same lines.
  const total = lines.reduce(
    (sum, l) => sum.add(Money.fromDecimal(l.line_total, 'MYR')),
    Money.zero('MYR'),
  );

  return {
    seller: await sellerBlock(tx, ctx),
    jobId,
    jobNo: job.job_no,
    status: job.status,
    receivedOn: toIsoDate(job.received_on),
    collectedOn: job.collected_on ? toIsoDate(job.collected_on) : null,
    customer: { name: job.customer_name, phone: job.customer_phone },
    deviceDescription: job.device_description,
    deviceSerial: job.device_serial,
    reportedFault: job.reported_fault,
    diagnosis: job.diagnosis,
    approvalNote: job.approval_note,
    closedReason: job.closed_reason,
    accessories: job.accessories,
    currency: 'MYR',
    lines: lines.map((l) => ({
      lineNo: l.line_no,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      lineTotal: l.line_total,
      serialNumbers: l.serial_numbers,
    })),
    total: total.toDecimalString(),
    invoiceNo: job.invoice_no,
    photos: evidence.filter((r) => r.kind === 'PHOTO').map(toEvidence),
    signatures: evidence.filter((r) => r.kind === 'SIGNATURE').map(toEvidence),
  };
}
