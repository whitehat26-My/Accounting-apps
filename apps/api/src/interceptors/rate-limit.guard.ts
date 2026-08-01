import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CONFIG } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { RateLimitedError } from '../errors.js';

/**
 * A fixed-window rate limit, keyed on the principal where there is one and the
 * client address otherwise.
 *
 * ---------------------------------------------------------------------------
 * IN-MEMORY, AND HONEST ABOUT WHAT THAT MEANS.
 *
 * §1.3 of the architecture specifies Redis, and Redis is the right answer for
 * more than one instance: an in-memory counter allows N times the intended rate
 * across N instances, and resets on every deploy.
 *
 * It is implemented in memory here because the alternative — a Redis client
 * written against a Redis nobody has stood up — would be untested code that
 * looks finished. This version is small, correct for a single instance, and
 * behind an interface that a Redis implementation drops into. The limitation is
 * stated in the README rather than discovered in production.
 *
 * It is deliberately NOT the login protection: that is the per-account lockout
 * in `record_login_outcome`, which survives a restart and cannot be evaded by
 * changing source address.
 * ---------------------------------------------------------------------------
 */
export interface RateLimiter {
  check(key: string, now: number): { allowed: boolean; retryAfterSeconds: number };
}

export class FixedWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, now: number): { allowed: boolean; retryAfterSeconds: number } {
    const existing = this.windows.get(key);

    if (existing === undefined || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    existing.count += 1;
    if (existing.count > this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Drop expired windows so the map does not grow without bound.
   *
   * Amortised into the miss path rather than run on a timer: a timer keeps the
   * process alive and has to be torn down in tests, and this is cheap.
   */
  private sweep(now: number): void {
    if (this.windows.size < 1024) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(Symbol.for('RATE_LIMITER')) private readonly limiter: RateLimiter,
  ) {}

  canActivate(execution: ExecutionContext): boolean {
    const request = execution.switchToHttp().getRequest<FastifyRequest>();

    // Keyed on the tenant AND the caller. Keying on the source address alone
    // would let one busy tenant behind a corporate NAT throttle another.
    const tenant = request.headers['x-tenant-id'];
    const key = `${Array.isArray(tenant) ? tenant[0] : (tenant ?? 'anon')}:${request.ip}`;

    const { allowed, retryAfterSeconds } = this.limiter.check(key, Date.now());
    if (!allowed) throw new RateLimitedError(retryAfterSeconds);

    return true;
  }
}
