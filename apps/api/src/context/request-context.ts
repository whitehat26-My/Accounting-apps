import type { FastifyRequest } from 'fastify';
import type { Principal } from '@emil/domain';
import type { ActorContext, TenantContext } from '@emil/db';

/**
 * What the middleware chain has established about a request.
 *
 * Attached to the Fastify request rather than held in async-local storage: it
 * makes the dependency visible in every signature that needs it, and there is
 * exactly one place it is set.
 */
export interface RequestContext {
  readonly requestId: string;
  /** Set once authentication succeeds. */
  principal?: Principal;
  /** The tenant the request asked for, before it was authorised. */
  requestedTenantId?: string;
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
  /** Required on every write. See the idempotency interceptor. */
  readonly idempotencyKey: string | undefined;
}

const CONTEXT = Symbol('emil.requestContext');

export function attachContext(request: FastifyRequest, context: RequestContext): void {
  (request as unknown as Record<symbol, RequestContext>)[CONTEXT] = context;
}

export function contextOf(request: FastifyRequest): RequestContext {
  const context = (request as unknown as Record<symbol, RequestContext | undefined>)[CONTEXT];
  if (context === undefined) {
    // Unreachable if the middleware is wired correctly, which is exactly why
    // it throws rather than fabricating an empty context — an anonymous
    // context that silently works is how an unauthenticated request ends up
    // reaching a handler.
    throw new Error('Request context missing: the context middleware did not run');
  }
  return context;
}

/**
 * The principal, or a failure.
 *
 * Never returns a "default" principal. There is no such thing as a request with
 * no identity that is still allowed to do something.
 */
export function principalOf(request: FastifyRequest): Principal {
  const { principal } = contextOf(request);
  if (principal === undefined) {
    throw new Error('No principal on this request: the auth guard did not run');
  }
  return principal;
}

/**
 * The database context for an authenticated request — assembled in ONE place.
 *
 * ---------------------------------------------------------------------------
 * EVERY CONTROLLER USED TO BUILD THIS BY HAND, AND THAT IS WHY THE AUDIT LOG
 * WAS BLIND.
 *
 * Each controller had a private `ctx()` returning `{ tenantId, userId }` and,
 * in some, the locked-period flag. None of them carried the request id, the IP
 * or the user agent — not because anyone decided not to, but because
 * `TenantContext` had nowhere to put them and five copies of a helper drift
 * quietly. The audit log's `actor_ip`, `user_agent` and `request_id` columns
 * were NULL on every row as a direct result.
 *
 * One function now, so a field added here reaches every route at once.
 * ---------------------------------------------------------------------------
 */
export function tenantContextOf(request: FastifyRequest): TenantContext {
  const principal = principalOf(request);
  return { ...actorContextOf(request), ...tenantFor(principal) };
}

/**
 * The actor half alone, for the routes with no principal.
 *
 * The public pay page and the gateway webhook are unauthenticated by necessity,
 * so they have no user — but they do have a request, an origin and a request
 * id, and a webhook that silently settles an invoice with no record of where it
 * came from is precisely the write worth being able to trace. An unattributed
 * USER is correct there; an unattributed REQUEST is not.
 */
export function actorContextOf(request: FastifyRequest): ActorContext {
  const context = contextOf(request);
  return {
    requestId: context.requestId,
    ...(context.ip !== undefined ? { actorIp: context.ip } : {}),
    ...(context.userAgent !== undefined ? { userAgent: context.userAgent } : {}),
  };
}

function tenantFor(principal: Principal): { tenantId: string; userId: string; allowLockedPeriod?: true } {
  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    // Only set when the role actually carries it. `withTenant` turns this into
    // `app.allow_locked_period`, which is what the database checks.
    ...(principal.permissions.has('period.override') ? { allowLockedPeriod: true as const } : {}),
  };
}
