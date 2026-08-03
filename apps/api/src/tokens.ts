/**
 * Dependency-injection tokens.
 *
 * ---------------------------------------------------------------------------
 * WHY EXPLICIT TOKENS RATHER THAN NEST'S USUAL TYPE-BASED INJECTION.
 *
 * Nest normally resolves a constructor parameter from its TYPE, which needs
 * `emitDecoratorMetadata` — and that is emitted only by `tsc`, not by esbuild.
 * The rest of this repository runs TypeScript directly through tsx and vitest,
 * both of which use esbuild.
 *
 * The choice was between adding a compile step for one package and injecting by
 * token in one package. Tokens won: a build step would mean the API's tests run
 * against compiled output while every other package's run against source, which
 * is exactly the kind of asymmetry that lets "works in tests, breaks in prod"
 * through. This is verified — type-based injection fails at runtime here with a
 * 500 from the DI container, and token-based injection works.
 *
 * The cost is a little ceremony at each injection site. That is all.
 * ---------------------------------------------------------------------------
 */

export const SQL = Symbol('SQL');
export const CONFIG = Symbol('CONFIG');
export const CLOCK = Symbol('CLOCK');
export const RATE_LIMITER = Symbol('RATE_LIMITER');
export const GATEWAYS = Symbol('GATEWAYS');
export const ASSISTANT = Symbol('ASSISTANT');
