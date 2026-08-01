import type { FastifyRequest } from 'fastify';
import type { Principal } from '@emil/domain';

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
