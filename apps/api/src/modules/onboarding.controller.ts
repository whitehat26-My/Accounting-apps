import { Body, Controller, Inject, Post } from '@nestjs/common';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { DEFAULT_SESSION_POLICY } from '@emil/domain';
import {
  newTenantId,
  principalFor,
  provisionOrganisation,
  refreshSession,
  withTenant,
  withUser,
  type Sql,
} from '@emil/db';
import { CONFIG, SQL } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { Public } from '../guards/decorators.js';
import { Doc } from '../openapi/doc.decorator.js';
import { UnauthenticatedError } from '../errors.js';
import { parse } from '../validation.js';

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
}

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
