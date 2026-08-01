import { z } from 'zod';

/**
 * Runtime configuration.
 *
 * Parsed once at boot and validated, so a missing secret fails the process
 * immediately rather than the first request that needs it — a service that
 * starts healthy and 500s on login is worse than one that refuses to start.
 */
const schema = z.object({
  databaseUrl: z.string().min(1),
  /**
   * Signs access tokens. No default, deliberately: a development fallback is
   * exactly the value that reaches production, and a predictable signing key
   * is a total authentication bypass.
   */
  jwtSecret: z.string().min(32),
  port: z.number().int().positive(),
  /** Requests per window, per principal. */
  rateLimit: z.number().int().positive(),
  rateLimitWindowMs: z.number().int().positive(),
});

export type ApiConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse({
    databaseUrl: env['DATABASE_URL'],
    jwtSecret: env['JWT_SECRET'],
    port: Number(env['PORT'] ?? 3000),
    rateLimit: Number(env['RATE_LIMIT'] ?? 600),
    rateLimitWindowMs: Number(env['RATE_LIMIT_WINDOW_MS'] ?? 60_000),
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `The API cannot start — its configuration is invalid:\n${problems}\n\n` +
        'JWT_SECRET must be at least 32 characters and has no default: a ' +
        'development fallback is the value that reaches production.',
    );
  }

  return parsed.data;
}
