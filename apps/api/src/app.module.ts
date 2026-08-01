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
import { CollectionsController } from './modules/collections.controller.js';
import { ContactsController } from './modules/contacts.controller.js';
import { AuditController } from './modules/audit.controller.js';
import { LedgerController } from './modules/ledger.controller.js';
import { BankingController } from './modules/banking.controller.js';
import { PublicPayController } from './modules/public-pay.controller.js';
import { GatewayRegistry } from './gateways/registry.js';
import { FakeGateway } from '@emil/db';
import { GATEWAYS } from './tokens.js';
import { DatabaseLifecycle } from './database.lifecycle.js';

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
  controllers: [
    AuthController,
    AccountingController,
    ContactsController,
    CollectionsController,
    AuditController,
    LedgerController,
    BankingController,
    PublicPayController,
  ],
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
    {
      // A separate budget for /public/*, so a flood of pay-token guesses
      // cannot exhaust an authenticated tenant's allowance or vice versa.
      provide: Symbol.for('PUBLIC_RATE_LIMITER'),
      useFactory: (config: ApiConfig) =>
        new FixedWindowRateLimiter(config.publicRateLimit, config.rateLimitWindowMs),
      inject: [CONFIG],
    },
    {
      provide: GATEWAYS,
      useFactory: (config: ApiConfig): GatewayRegistry => {
        const registry = new GatewayRegistry();
        // Empty in production, and that is correct: no concrete adapter exists
        // yet, so the routes that need one answer 503 rather than pretending.
        // `loadConfig` refuses this flag when NODE_ENV is production, because
        // the fake gateway accepts any signature.
        if (config.enableFakeGateway) registry.register(new FakeGateway());
        return registry;
      },
      inject: [CONFIG],
    },
    // Ends the pool on shutdown. A `useFactory` value gets no lifecycle hooks,
    // so the closing has to live on a class Nest can call.
    DatabaseLifecycle,
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
