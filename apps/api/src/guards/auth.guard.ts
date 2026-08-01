import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';
import { checkClaims, type Permission } from '@emil/domain';
import { principalFor, resolveApiKey, withTenant, withUser, type Sql } from '@emil/db';
import { CONFIG, SQL } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { contextOf } from '../context/request-context.js';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../errors.js';
import { PUBLIC_KEY, REQUIRED_PERMISSION } from './decorators.js';

/**
 * The middleware chain from docs/architecture/01-system-architecture.md §1.3,
 * steps 3 to 5: verify the credential, resolve the tenant, then authorise.
 *
 * ---------------------------------------------------------------------------
 * THE TENANT IS ASSERTED FROM TWO SOURCES THAT MUST AGREE.
 *
 * The `X-Tenant-Id` header says which organisation the request is for. The
 * access token also carries a tenant claim. Trusting the header alone would let
 * anyone holding a valid token for tenant A read tenant B by changing one
 * header value; trusting the token alone would mean an accountant could never
 * switch organisations without re-authenticating.
 *
 * So both are required and they must match, which is `checkClaims()` in the
 * domain. Switching organisations mints a new access token for the new tenant —
 * cheap, because the refresh token is organisation-agnostic.
 * ---------------------------------------------------------------------------
 *
 * The guard resolves a `Principal` and stops. It never opens a transaction for
 * the handler: `withTenant()` remains the only place `app.tenant_id` is set.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(SQL) private readonly sql: Sql,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const handler = execution.getHandler();
    const controller = execution.getClass();

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, controller]);
    if (isPublic) return true;

    const request = execution.switchToHttp().getRequest<FastifyRequest>();
    const context = contextOf(request);

    const tenantId = header(request, 'x-tenant-id');
    if (tenantId === undefined) {
      throw new UnauthenticatedError('X-Tenant-Id header is required');
    }
    context.requestedTenantId = tenantId;

    const principal = await this.resolvePrincipal(request, tenantId);

    // No membership. A 404, NOT a 403 — a 403 would confirm the organisation
    // exists, which is enough to enumerate this product's customer list one id
    // at a time. See src/errors.ts.
    if (principal === undefined) throw new NotFoundError('Organisation');

    context.principal = principal;

    const required = this.reflector.getAllAndOverride<Permission>(REQUIRED_PERMISSION, [
      handler,
      controller,
    ]);

    if (required !== undefined && !principal.permissions.has(required)) {
      throw new ForbiddenError(required);
    }

    // An API key's scopes narrow the role, never widen it. Checked separately
    // so the denial message can say which of the two refused.
    if (
      required !== undefined &&
      principal.scopes !== undefined &&
      !principal.scopes.has(required)
    ) {
      throw new ForbiddenError(required);
    }

    return true;
  }

  private async resolvePrincipal(request: FastifyRequest, tenantId: string) {
    const apiKey = header(request, 'x-api-key');
    if (apiKey !== undefined) {
      return this.fromApiKey(apiKey, tenantId);
    }

    const authorization = header(request, 'authorization');
    if (authorization === undefined || !authorization.toLowerCase().startsWith('bearer ')) {
      throw new UnauthenticatedError();
    }

    return this.fromBearer(authorization.slice(7), tenantId);
  }

  private async fromBearer(token: string, tenantId: string) {
    let claims: Record<string, unknown>;
    try {
      const secret = new TextEncoder().encode(this.config.jwtSecret);
      const verified = await jwtVerify(token, secret, { algorithms: ['HS256'] });
      claims = verified.payload as Record<string, unknown>;
    } catch {
      // Never distinguish a bad signature from an expired token: the
      // difference tells an attacker whether they have the right key.
      throw new UnauthenticatedError('Invalid or expired token');
    }

    const violations = checkClaims(
      {
        sub: claims['sub'] as string,
        tenantId: claims['tenantId'] as string,
        role: claims['role'] as string,
        sessionId: claims['sessionId'] as string,
        exp: claims['exp'] as number,
        iat: claims['iat'] as number,
      },
      tenantId,
      new Date().toISOString(),
    );

    if (violations.length > 0) {
      // Includes the tenant mismatch, which is an authentication failure and
      // not a 403: the token simply is not valid for this organisation.
      throw new UnauthenticatedError('Token is not valid for this organisation');
    }

    const userId = claims['sub'] as string;
    return withTenant(this.sql, { tenantId, userId }, (tx) =>
      principalFor(tx, userId, tenantId),
    );
  }

  private async fromApiKey(presented: string, tenantId: string) {
    const key = await withUser(this.sql, null, (tx) => resolveApiKey(tx, presented));

    // A key that names a different organisation than the header is not a
    // permission problem; the credential is simply not for this tenant.
    if (key === undefined || key.tenantId !== tenantId) {
      throw new UnauthenticatedError('Invalid API key');
    }

    // A key acts as the user who created it, further narrowed by its scopes.
    // An orphaned key — its creator removed — authenticates as nobody and is
    // refused, rather than silently inheriting the widest role available.
    if (key.createdBy === null) {
      throw new UnauthenticatedError('This API key has no owner and can no longer be used');
    }

    await withUser(this.sql, null, (tx) => tx`SELECT touch_api_key(${key.id}::uuid)`);

    return withTenant(this.sql, { tenantId, userId: key.createdBy }, (tx) =>
      principalFor(tx, key.createdBy!, tenantId, { id: key.id, scopes: key.scopes }),
    );
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.length === 0 ? undefined : value;
}
