import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The HTTP vocabulary this API uses, and the one rule that matters most.
 *
 * ---------------------------------------------------------------------------
 * A TENANT YOU DO NOT BELONG TO IS A 404, NEVER A 403.
 *
 * CLAUDE.md rule 9. A 403 confirms the organisation EXISTS. In a multi-tenant
 * accounting product that is enough to enumerate the customer list one
 * organisation id at a time, and to confirm whether a given company is a
 * customer — which is commercially sensitive on its own.
 *
 * The same applies to a record inside a tenant you do belong to: RLS has
 * already filtered another tenant's row out of the query, so the service layer
 * cannot tell "does not exist" from "not yours" either. Both surface as 404,
 * and that consistency is the point.
 *
 * A MISSING PERMISSION is different, and is a 403: you are legitimately inside
 * the tenant, so acknowledging the resource tells an attacker nothing they
 * could not already discover.
 * ---------------------------------------------------------------------------
 */

/** Not authenticated at all. */
export class UnauthenticatedError extends HttpException {
  constructor(message = 'Authentication required') {
    super({ error: 'unauthenticated', message }, HttpStatus.UNAUTHORIZED);
  }
}

/**
 * Authenticated, inside the tenant, but lacking the permission.
 *
 * Names the permission. A user who cannot do their job needs to be able to
 * tell their administrator which permission to grant, and the permission name
 * reveals nothing that the API's own documentation does not.
 */
export class ForbiddenError extends HttpException {
  constructor(permission: string) {
    super(
      {
        error: 'forbidden',
        message: `Your role does not include the '${permission}' permission`,
        permission,
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

/**
 * Used both for a genuinely absent record AND for one belonging to another
 * tenant. That ambiguity is deliberate — see the note at the top of this file.
 */
export class NotFoundError extends HttpException {
  constructor(what = 'Resource') {
    super({ error: 'not_found', message: `${what} not found` }, HttpStatus.NOT_FOUND);
  }
}

export class ValidationError extends HttpException {
  constructor(message: string, detail?: unknown) {
    super(
      { error: 'validation_failed', message, ...(detail !== undefined ? { detail } : {}) },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}

export class ConflictError extends HttpException {
  constructor(message: string, detail?: unknown) {
    super(
      { error: 'conflict', message, ...(detail !== undefined ? { detail } : {}) },
      HttpStatus.CONFLICT,
    );
  }
}

export class RateLimitedError extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      {
        error: 'rate_limited',
        message: 'Too many requests',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
