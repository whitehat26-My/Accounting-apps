import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { createClient, type Sql } from '@emil/db';
import { CONFIG, SQL } from './tokens.js';
import { loadConfig, type ApiConfig } from './config.js';
import { AuthGuard } from './guards/auth.guard.js';
import { RateLimitGuard, FixedWindowRateLimiter } from './interceptors/rate-limit.guard.js';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor.js';
import { DomainExceptionFilter } from './filters/domain-exception.filter.js';
import { AuthController } from './modules/auth.controller.js';
import { AccountingController } from './modules/accounting.controller.js';

/**
 * The middleware chain from docs/architecture/01-system-architecture.md §1.3.
 *
 * ---------------------------------------------------------------------------
 * ORDER MATTERS, AND THE ORDER IS:
 *
 *   1. request context   — a request id exists before anything can fail
 *   2. rate limit        — cheapest rejection first; runs before any database work
 *   3. authentication    — verify the credential
 *   4. tenant resolution — assert the token's tenant against the header
 *   5. RBAC              — does this member hold the permission
 *   6. idempotency       — a write must carry a key
 *   7. handler           — opens the transaction via withTenant()
 *
 * Steps 3 to 5 are one guard because they share a database round trip and are
 * meaningless apart: a principal is a (user, tenant) pair, so resolving the
 * tenant IS resolving the principal.
 *
 * Rate limiting deliberately precedes authentication. Putting it after would
 * mean an unauthenticated flood still costs a JWT verification and a query per
 * request, which is the cheapest possible denial of service.
 * ---------------------------------------------------------------------------
 */
@Module({
  controllers: [AuthController, AccountingController],
  providers: [
    {
      provide: CONFIG,
      useFactory: (): ApiConfig => loadConfig(),
    },
    {
      provide: SQL,
      // ONE pool for the process. Every tenant-scoped query goes through
      // `withTenant`, which sets `app.tenant_id` with SET LOCAL — transaction
      // scoped, so it cannot leak to the next request served by the same
      // pooled connection. That is the whole isolation contract.
      useFactory: (config: ApiConfig): Sql => createClient(config.databaseUrl),
      inject: [CONFIG],
    },
    {
      provide: Symbol.for('RATE_LIMITER'),
      useFactory: (config: ApiConfig) =>
        new FixedWindowRateLimiter(config.rateLimit, config.rateLimitWindowMs),
      inject: [CONFIG],
    },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
