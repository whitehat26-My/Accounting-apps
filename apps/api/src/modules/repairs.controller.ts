import {
  Body, Controller, Delete, Get, Headers, Inject, Param, Post, Query, Req, Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isoDate, positiveDecimal, uuid } from '@emil/contracts';
import {
  addRepairPhoto,
  collectRepairJob,
  createRepairJob,
  deleteRepairPhoto,
  getRepairJob,
  getRepairPhoto,
  listRepairJobs,
  listRepairPhotos,
  quoteRepairJob,
  setFittedSerials,
  transitionRepairJob,
  withTenant,
  REPAIR_PHOTO_MAX_BYTES,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Doc } from '../openapi/doc.decorator.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * The workshop.
 *
 * Intake, quote, status transitions, and the one route that touches money:
 * collection, which converts the job to an invoice through the same paths the
 * till uses. A job cannot be marked COLLECTED by a status change — the invoice
 * IS the collection, or the work walks out unbilled.
 */
@Controller('v1/repairs')
export class RepairsController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Requires('repair.read')
  @Get()
  async list(@Query('status') status: string | undefined, @Req() request: FastifyRequest) {
    const parsed = status === undefined ? undefined : parse(statusSchema, status);
    const ctx = tenantContextOf(request);
    return {
      jobs: await withTenant(this.sql, ctx, (tx) =>
        listRepairJobs(tx, ctx, parsed !== undefined ? { status: parsed } : {}),
      ),
    };
  }

  @Requires('repair.read')
  @Get(':id')
  async get(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => getRepairJob(tx, ctx, parse(uuid, id)));
  }

  // -------------------------------------------------------------------------
  // Photographs — the evidence on a job. See migration 0035.
  // -------------------------------------------------------------------------

  /** Metadata only. The bytes come one at a time from the route below. */
  @Requires('repair.read')
  @Get(':id/photos')
  async photos(@Param('id') id: string, @Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return {
      photos: await withTenant(this.sql, ctx, (tx) =>
        listRepairPhotos(tx, ctx, parse(uuid, id)),
      ),
    };
  }

  /**
   * One photograph's bytes.
   *
   * `Cache-Control: private` and no `max-age`: this is a picture of a
   * customer's property behind an authenticated route, and a shared cache
   * holding it would serve it to whoever asked next. `immutable` is safe on top
   * of that — the row is never updated in place, so a URL always means the same
   * image or 404s.
   */
  @Requires('repair.read')
  @Get(':id/photos/:photoId')
  async photo(
    @Param('id') id: string,
    @Param('photoId') photoId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const ctx = tenantContextOf(request);
    const found = await withTenant(this.sql, ctx, (tx) =>
      getRepairPhoto(tx, ctx, parse(uuid, id), parse(uuid, photoId)),
    );
    void reply
      .header('Content-Type', found.contentType)
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', 'inline')
      // The digest doubles as the entity tag — same bytes, same ETag, and it is
      // already computed and stored.
      .header('ETag', `"${found.digest}"`)
      .send(found.image);
  }

  /**
   * Attach a photograph.
   *
   * The image arrives base64-encoded in JSON rather than as a multipart upload.
   * That is a deliberate trade: multipart would need another Fastify plugin and
   * would bypass the Zod validation and idempotency handling every other write
   * on this API goes through, to save a third in transfer size on a file the
   * browser has already downscaled to a couple of hundred kilobytes.
   */
  @Requires('repair.write')
  @Doc({ request: () => addPhotoSchema })
  @Post(':id/photos')
  async addPhoto(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') _idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(addPhotoSchema, body);
    const ctx = tenantContextOf(request);
    const image = Buffer.from(input.imageBase64, 'base64');

    return withTenant(this.sql, ctx, (tx) =>
      addRepairPhoto(tx, ctx, {
        repairJobId: parse(uuid, id),
        stage: input.stage,
        contentType: input.contentType,
        image,
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
      }),
    );
  }

  @Requires('repair.write')
  @Delete(':id/photos/:photoId')
  async removePhoto(
    @Param('id') id: string,
    @Param('photoId') photoId: string,
    @Headers('idempotency-key') _idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    await withTenant(this.sql, ctx, (tx) =>
      deleteRepairPhoto(tx, ctx, parse(uuid, id), parse(uuid, photoId)),
    );
    return { removed: true };
  }

  @Requires('repair.write')
  @Doc({ request: () => intakeSchema })
  @Post()
  async intake(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(intakeSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      createRepairJob(tx, ctx, { ...input, idempotencyKey }),
    );
  }

  @Requires('repair.write')
  @Doc({ request: () => quoteSchema })
  @Post(':id/quote')
  async quote(@Param('id') id: string, @Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(quoteSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => quoteRepairJob(tx, ctx, parse(uuid, id), input));
  }

  @Requires('repair.write')
  @Doc({ request: () => transitionSchema })
  @Post(':id/status')
  async transition(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(transitionSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      transitionRepairJob(tx, ctx, parse(uuid, id), input),
    );
  }

  /**
   * Name the units the bench fitted. Serials only — the agreed price cannot
   * drift in through this door, which is why it is not a quote revision.
   */
  @Requires('repair.write')
  @Doc({ request: () => fittedSchema })
  @Post(':id/lines/:lineNo/serials')
  async fitted(
    @Param('id') id: string,
    @Param('lineNo') lineNo: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(fittedSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      setFittedSerials(tx, ctx, parse(uuid, id), Number(lineNo), input.serialNumbers),
    );
  }

  /** Collect: invoice the quote, optionally taking payment at the counter. */
  @Requires('repair.write')
  @Doc({ request: () => collectSchema })
  @Post(':id/collect')
  async collect(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: FastifyRequest,
  ) {
    const input = parse(collectSchema, body);
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) =>
      collectRepairJob(tx, ctx, parse(uuid, id), { ...input, idempotencyKey }),
    );
  }
}

const statusSchema = z.enum([
  'RECEIVED', 'QUOTED', 'APPROVED', 'DECLINED', 'IN_PROGRESS', 'READY', 'COLLECTED', 'CANCELLED',
]);

const intakeSchema = z.object({
  contactId: uuid,
  deviceDescription: z.string().min(1).max(500),
  deviceSerial: z.string().min(1).max(120).optional(),
  reportedFault: z.string().min(1).max(2000),
  receivedOn: isoDate,
});

const quoteSchema = z.object({
  diagnosis: z.string().min(1).max(2000),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        quantity: positiveDecimal,
        /** The AGREED price — what collection will invoice, verbatim. */
        unitPrice: z.string().regex(/^\d+(\.\d{1,4})?$/),
        itemId: uuid.optional(),
        taxCodeId: uuid.optional(),
        accountId: uuid.optional(),
        serialNumbers: z.array(z.string().min(1).max(120)).max(100).optional(),
      }),
    )
    .min(1),
});

const transitionSchema = z.object({
  to: statusSchema,
  reason: z.string().min(1).max(1000).optional(),
  approvalNote: z.string().min(1).max(500).optional(),
});

const fittedSchema = z.object({
  serialNumbers: z.array(z.string().min(1).max(120)).min(1).max(100),
});

/**
 * A photograph, base64 in JSON.
 *
 * The length bound is on the ENCODED string and is deliberately generous
 * against the 2 MB byte ceiling the service enforces: base64 inflates by four
 * thirds, so this rejects the obviously-abusive payload cheaply at the edge
 * while the service — which sees the decoded length — owns the real limit. Two
 * checks, and the authoritative one is the one nearest the data.
 */
const addPhotoSchema = z.object({
  stage: z.enum(['RECEIVED', 'DIAGNOSIS', 'IN_PROGRESS', 'READY', 'COLLECTED']),
  caption: z.string().min(1).max(300).optional(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  imageBase64: z
    .string()
    .min(1)
    .max(Math.ceil((REPAIR_PHOTO_MAX_BYTES * 4) / 3) + 8)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Not valid base64'),
});

const collectSchema = z.object({
  collectDate: isoDate,
  payment: z
    .object({
      method: z.enum(['CASH', 'CARD', 'DUITNOW', 'TRANSFER', 'CHEQUE', 'OTHER']),
      depositAccountId: uuid,
      tenderedAmount: positiveDecimal.optional(),
    })
    .optional(),
});
