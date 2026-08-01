import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@emil/domain';

export const PUBLIC_KEY = 'emil:public';
export const REQUIRED_PERMISSION = 'emil:permission';

/**
 * Mark a route as reachable without authentication.
 *
 * Deliberately opt-IN to being public, with the guard applied globally. The
 * alternative — opt in to being protected — means a new endpoint is
 * unauthenticated until someone remembers to guard it, and forgetting produces
 * a working endpoint rather than a broken one. Nobody notices a working
 * endpoint.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * The permission a route requires.
 *
 * A route with no `@Requires` is authenticated but unrestricted within the
 * tenant — appropriate for reads any member may perform, and a deliberate
 * decision each time rather than a default.
 */
export const Requires = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

export const NO_IDEMPOTENCY_KEY = 'emil:no-idempotency-key';

/**
 * Exempt a write from the `Idempotency-Key` requirement.
 *
 * ---------------------------------------------------------------------------
 * FOR ONE CASE ONLY: A WRITE WE DO NOT CONTROL THE CLIENT OF.
 *
 * A payment gateway's webhook is delivered by the provider, and no provider
 * sends a header this product invented. Requiring one would reject every real
 * webhook, so the choice is not "with or without idempotency" — it is "this
 * route's own guarantee, or none at all".
 *
 * The guarantee is `UNIQUE (tenant_id, provider, provider_event_id)` on
 * `gateway_event`, enforced in the same transaction as the write. That is
 * strictly stronger than a header, because it is keyed on the PROVIDER's notion
 * of the event rather than on a client remembering to reuse a key.
 *
 * Applying this anywhere without an equivalent database-level guarantee is a
 * bug. It is not a convenience for endpoints whose clients are inconvenienced.
 * ---------------------------------------------------------------------------
 */
export const NoIdempotencyKey = () => SetMetadata(NO_IDEMPOTENCY_KEY, true);
