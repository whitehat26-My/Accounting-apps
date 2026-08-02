import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { DEFAULT_SESSION_POLICY, type Permission } from '@emil/domain';
import {
  addMember,
  authenticate,
  createSession,
  issueApiKey,
  membershipsForUser,
  principalFor,
  refreshSession,
  registerUser,
  revokeSession,
  withTenant,
  withUser,
  type Sql,
} from '@emil/db';
import { CONFIG, SQL } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { Public, Requires } from '../guards/decorators.js';
import { Doc } from '../openapi/doc.decorator.js';
import { principalOf } from '../context/request-context.js';
import { NotFoundError, UnauthenticatedError, ValidationError } from '../errors.js';
import { parse } from '../validation.js';

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(12, 'Use at least 12 characters'),
});

const registration = credentials.extend({ fullName: z.string().min(1) });
const refreshBody = z.object({ refreshToken: z.string().min(1) });
const switchBody = z.object({ tenantId: z.string().uuid() });

@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Register. Public, and creates no organisation — a user exists before any
   * membership does, which is what makes one login work across N clients.
   */
  @Public()
  @Doc({ request: () => registration })
  @Post('register')
  async register(@Body() body: unknown) {
    const input = parse(registration, body);
    const user = await withUser(this.sql, null, (tx) => registerUser(tx, input));
    return { id: user.id, email: input.email };
  }

  /**
   * Sign in.
   *
   * Returns a refresh token but NO access token: an access token is scoped to
   * one organisation, and at this point we do not know which one the user
   * wants. The client lists its organisations and calls `/switch`.
   *
   * That is a deliberate shape, not an extra round trip for its own sake —
   * minting an access token for an arbitrarily-chosen organisation would be a
   * credential the user never asked for.
   */
  @Public()
  @Doc({ request: () => credentials })
  @Post('login')
  async login(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(credentials, body);

    const user = await withUser(this.sql, null, (tx) =>
      authenticate(tx, input.email, input.password),
    );

    const session = await withUser(this.sql, user.id, (tx) =>
      createSession(tx, user.id, sessionContext(request)),
    );

    const organisations = await withUser(this.sql, user.id, (tx) =>
      membershipsForUser(tx, user.id),
    );

    return {
      user: { id: user.id, email: user.email, fullName: user.fullName },
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.expiresAt,
      organisations,
    };
  }

  /**
   * Exchange a refresh token.
   *
   * The service returns a result rather than throwing, so a reuse detection
   * COMMITS its family revocation. Turning it into a 401 is this layer's job.
   */
  @Public()
  @Doc({ request: () => refreshBody })
  @Post('refresh')
  async refresh(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parse(refreshBody, body);

    const result = await withUser(this.sql, null, (tx) =>
      refreshSession(tx, input.refreshToken, sessionContext(request)),
    );

    if (!result.ok) throw new UnauthenticatedError(result.message);

    return {
      refreshToken: result.session.refreshToken,
      refreshExpiresAt: result.session.expiresAt,
    };
  }

  /**
   * Mint an access token for one organisation.
   *
   * The refresh token proves who you are; this proves which organisation you
   * are acting for. Both are needed, and the access token names the tenant so
   * the guard can assert it against the header.
   */
  @Public()
  @Doc({ request: () => switchOrganisationSchema })
  @Post('switch')
  async switchOrganisation(@Body() body: unknown) {
    const input = parse(switchOrganisationSchema, body);

    const session = await withUser(this.sql, null, (tx) =>
      refreshSession(tx, input.refreshToken),
    );
    if (!session.ok) throw new UnauthenticatedError(session.message);

    const principal = await withTenant(
      this.sql,
      { tenantId: input.tenantId, userId: session.userId },
      (tx) => principalFor(tx, session.userId, input.tenantId),
    );

    // Not a member. 404, never 403 — a 403 confirms the organisation exists.
    if (principal === undefined) throw new NotFoundError('Organisation');

    const accessToken = await new SignJWT({
      tenantId: principal.tenantId,
      role: principal.role,
      sessionId: session.session.sessionId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(principal.userId)
      .setIssuedAt()
      .setExpirationTime(`${DEFAULT_SESSION_POLICY.accessTokenSeconds}s`)
      .sign(new TextEncoder().encode(this.config.jwtSecret));

    return {
      accessToken,
      expiresInSeconds: DEFAULT_SESSION_POLICY.accessTokenSeconds,
      // Rotation applies here too: the refresh token used to switch is spent.
      refreshToken: session.session.refreshToken,
      tenantId: principal.tenantId,
      role: principal.role,
      permissions: [...principal.permissions].sort(),
    };
  }

  @Public()
  @Doc({ request: () => logoutSchema })
  @Post('logout')
  async logout(@Body() body: unknown) {
    const input = parse(logoutSchema, body);
    await withUser(this.sql, null, (tx) => revokeSession(tx, input.sessionId));
    return { revoked: true };
  }

  /** Who the caller is, in the organisation they named. */
  @Get('me')
  me(@Req() request: FastifyRequest) {
    const principal = principalOf(request);
    return {
      userId: principal.userId,
      tenantId: principal.tenantId,
      role: principal.role,
      permissions: [...principal.permissions].sort(),
      ...(principal.apiKeyId !== undefined
        ? { apiKeyId: principal.apiKeyId, scopes: [...(principal.scopes ?? [])].sort() }
        : {}),
    };
  }

  @Requires('user.manage')
  @Doc({ request: () => addMemberSchema })
  @Post('members')
  async addMember(@Body() body: unknown, @Req() request: FastifyRequest) {
    const principal = principalOf(request);
    const input = parse(addMemberSchema,
      body,
    );

    // Privilege escalation check. The domain owns the rule; this is where the
    // actor's own role is known.
    const { canGrantRole } = await import('@emil/domain');
    if (!canGrantRole(principal.role, input.role)) {
      throw new ValidationError(
        `A ${principal.role} cannot grant the ${input.role} role — it outranks your own`,
      );
    }

    const ctx = { tenantId: principal.tenantId, userId: principal.userId };
    return withTenant(this.sql, ctx, (tx) =>
      addMember(tx, ctx, {
        userId: input.userId,
        role: input.role,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      }),
    );
  }

  @Requires('apikey.manage')
  @Doc({ request: () => createApiKeySchema })
  @Post('api-keys')
  async createApiKey(@Body() body: unknown, @Req() request: FastifyRequest) {
    const principal = principalOf(request);
    const input = parse(createApiKeySchema,
      body,
    );

    const ctx = { tenantId: principal.tenantId, userId: principal.userId };
    const issued = await withTenant(this.sql, ctx, (tx) =>
      issueApiKey(tx, ctx, {
        name: input.name,
        scopes: input.scopes as Permission[],
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      }),
    );

    return {
      id: issued.id,
      prefix: issued.prefix,
      // Shown once and never again — only the digest is stored.
      key: issued.key,
      warning: 'Copy this key now. It cannot be retrieved again.',
    };
  }
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Built here rather than inline so the optional keys are genuinely absent. */
function sessionContext(request: FastifyRequest): { ip?: string; userAgent?: string } {
  const userAgent = headerValue(request, 'user-agent');
  return {
    ...(typeof request.ip === 'string' ? { ip: request.ip } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
  };
}

const switchOrganisationSchema = switchBody.extend({ refreshToken: z.string().min(1) });

const logoutSchema = z.object({ sessionId: z.string().uuid() });

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum([
    'OWNER',
    'ADMIN',
    'ACCOUNTANT',
    'APPROVER',
    'BOOKKEEPER',
    'SALES',
    'READ_ONLY',
    'EXTERNAL_AUDITOR',
  ]),
  expiresAt: z.string().datetime().optional(),
});

const createApiKeySchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string()).min(1),
  expiresAt: z.string().datetime().optional(),
});
