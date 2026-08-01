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
