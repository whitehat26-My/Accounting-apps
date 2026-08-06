import { Body, Controller, Get, Inject, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { DEFAULT_SESSION_POLICY } from '@emil/domain';
import {
  newTenantId,
  principalFor,
  provisionOrganisation,
  refreshSession,
  sellerBlock,
  setOrganisationBrand,
  withTenant,
  withUser,
  type Sql,
} from '@emil/db';
import { CONFIG, SQL } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { Public, Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { Doc } from '../openapi/doc.decorator.js';
import { UnauthenticatedError, ValidationError } from '../errors.js';
import { parse } from '../validation.js';
import { isPrintableImage } from '../pdf/render.js';

/**
 * First run: create an organisation.
 *
 * ---------------------------------------------------------------------------
 * THE ONE ROUTE THAT IS AUTHENTICATED BUT TENANT-LESS.
 *
 * Every guarded route resolves a principal FOR a tenant, and a brand-new user
 * belongs to none — so this follows `/auth/switch`'s shape instead: prove the
 * session with a refresh token (which rotates, as always), provision, and walk
 * away holding an access token for the organisation that now exists. One round
 * trip from "just registered" to "can issue an invoice".
 *
 * `@Public()` here means "the global guard does not run", not "anonymous":
 * the refresh token IS the authentication, checked in the handler.
 * ---------------------------------------------------------------------------
 */
@Controller('v1')
export class OnboardingController {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Public()
  @Doc({ request: () => createOrganisationSchema })
  @Post('organisations')
  async create(@Body() body: unknown) {
    const input = parse(createOrganisationSchema, body);

    const session = await withUser(this.sql, null, (tx) =>
      refreshSession(tx, input.refreshToken),
    );
    if (!session.ok) throw new UnauthenticatedError(session.message);

    // The id is generated FIRST so the transaction can claim it as its tenant
    // context — which is what lets RLS's WITH CHECK admit the insert, and the
    // only tenant id this connection can write under. See 0030.
    const tenantId = newTenantId();
    const ctx = { tenantId, userId: session.userId };

    const provisioned = await withTenant(this.sql, ctx, (tx) =>
      provisionOrganisation(tx, ctx, session.userId, input.organisation),
    );

    const principal = await withTenant(this.sql, ctx, (tx) =>
      principalFor(tx, session.userId, tenantId),
    );

    const accessToken = await new SignJWT({
      tenantId,
      role: 'OWNER',
      sessionId: session.session.sessionId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(session.userId)
      .setIssuedAt()
      .setExpirationTime(`${DEFAULT_SESSION_POLICY.accessTokenSeconds}s`)
      .sign(new TextEncoder().encode(this.config.jwtSecret));

    return {
      organisation: provisioned,
      accessToken,
      expiresInSeconds: DEFAULT_SESSION_POLICY.accessTokenSeconds,
      refreshToken: session.session.refreshToken,
      permissions: principal ? [...principal.permissions].sort() : [],
    };
  }

  // -------------------------------------------------------------------------
  // The tenant's own letterhead — migration 0050.
  //
  // Until this existed the logo on every printed document was a file compiled
  // into the API image, so a second organisation on the same server issued its
  // invoices under the first one's mark. An invoice is precisely the document
  // that must carry the name and mark of the party owed the money.
  // -------------------------------------------------------------------------

  /**
   * The mark, as bytes.
   *
   * `tax.read` rather than `org.manage`: this is the picture on documents every
   * member can already print, so gating it behind the permission to CHANGE the
   * organisation would hide it from everyone who only needs to look at it.
   */
  @Requires('tax.read')
  @Get('organisations/logo')
  async logo(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const ctx = tenantContextOf(request);
    const seller = await withTenant(this.sql, ctx, (tx) => sellerBlock(tx, ctx));

    if (!seller.logo || !seller.logoContentType) {
      // Not an error. Most organisations have no mark, and the screen wants to
      // know that rather than to catch something.
      void reply.status(204).send();
      return;
    }

    void reply
      .header('content-type', seller.logoContentType)
      // A tenant's mark behind an authenticated route: private, never shared.
      .header('cache-control', 'private, no-store')
      .send(seller.logo);
  }

  /**
   * Set or clear it.
   *
   * Base64 in JSON for the same reason repair photographs are
   * (`repairs.controller.ts`): multipart would need another Fastify plugin and
   * would bypass the Zod validation every other write goes through, to save a
   * third in transfer on a file the browser has already downscaled.
   *
   * `logoBase64: null` clears the mark. A tenant that decides its logo prints
   * badly needs a way back to the name-only letterhead, and "upload a white
   * square" is not that way.
   */
  @Requires('org.manage')
  @Doc({ request: () => brandSchema })
  @Put('organisations/brand')
  async setBrand(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(brandSchema, body);
    const ctx = tenantContextOf(request);

    const logo = input.logoBase64 === null ? null : Buffer.from(input.logoBase64, 'base64');
    if (logo !== null && !isPrintableImage(logo)) {
      /*
       * Refused HERE rather than at the moment somebody prints an invoice.
       * A logo is accepted once and embedded in every document afterwards, so
       * bytes that cannot be decoded break the tenant's printing weeks later,
       * with nobody near a file picker. A corrupt PNG passes every header check
       * — see `isPrintableImage`.
       */
      throw new ValidationError(
        'That file could not be read as an image. It may be corrupt, or it may be a ' +
          'format that cannot be embedded in a PDF — save it as PNG or JPEG and try again.',
      );
    }
    if (logo !== null && (logo.byteLength === 0 || logo.byteLength > LOGO_MAX_BYTES)) {
      throw new ValidationError(
        `A logo must be between 1 byte and ${LOGO_MAX_BYTES} bytes; this one is ` +
          `${logo.byteLength}. It is embedded in every document this organisation ` +
          'prints, so the ceiling is what stops one invoice outweighing a year of ledger.',
      );
    }

    await withTenant(this.sql, ctx, (tx) =>
      setOrganisationBrand(tx, ctx, {
        logo,
        logoContentType: logo === null ? null : input.logoContentType,
        brandColour: input.brandColour,
      }),
    );
    return { updated: true };
  }
}

/** 256 KB, matching the CHECK in 0050. A letterhead, not a photograph. */
const LOGO_MAX_BYTES = 256 * 1024;

const brandSchema = z.object({
  /** Null clears the mark; omitted is not allowed, so clearing is deliberate. */
  logoBase64: z
    .string()
    .min(1)
    .max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 8)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Not valid base64')
    .nullable(),
  logoContentType: z.enum(['image/png', 'image/jpeg']),
  /** Lowercase hex, matching the CHECK in 0050. Null is the product default. */
  brandColour: z.string().regex(/^#[0-9a-f]{6}$/).nullable(),
});

const createOrganisationSchema = z.object({
  refreshToken: z.string().min(1),
  organisation: z.object({
    name: z.string().min(1).max(200),
    ssmRegistrationNo: z.string().min(1).max(50).optional(),
    tin: z.string().min(1).max(30).optional(),
    sstRegistered: z.boolean().optional(),
    sstNo: z.string().min(1).max(30).optional(),
    /** First day of the first fiscal year. Must be the first of a month. */
    fiscalYearStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reportingFramework: z.enum(['MPERS', 'MFRS']).optional(),
  }),
});
