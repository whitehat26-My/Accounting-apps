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
  /**
   * Requests per window for the UNAUTHENTICATED pay routes.
   *
   * Far tighter than the authenticated limit, because a pay-link token is
   * guessable in principle and these routes are the only unauthenticated read
   * of tenant data. The limit is what makes brute-forcing a token impractical
   * rather than merely slow.
   */
  publicRateLimit: z.number().int().positive(),
  /**
   * Register the in-memory `FakeGateway`.
   *
   * It accepts any signature, so enabling it in production would let anyone
   * mark any invoice paid. Refused outright when NODE_ENV is production rather
   * than left to a deployment checklist — see the refinement below.
   */
  enableFakeGateway: z.boolean(),
  /**
   * Allow loading obviously-fake statutory values.
   *
   * The sandbox withholding rate is 99% and the DuitNow merchant template pays
   * nobody. Both exist so the flows built on them can be demonstrated at all;
   * neither may ever reach a real payment or a real payer.
   */
  enableSandboxValues: z.boolean(),
  /**
   * Connects the in-app assistant to the Claude API. Optional, deliberately:
   * the whole product works without it, the assistant's status route says
   * honestly that it is not configured, and the how-to-use content in the web
   * panel is static and needs no key at all.
   */
  anthropicApiKey: z.string().min(1).optional(),
  /**
   * Register the deterministic `FakeAssistantProvider` instead of a model.
   * Test-only, same posture as the fake gateway: its replies are canned, and
   * a canned assistant presented as real is a lie to the person reading it.
   */
  enableFakeAssistant: z.boolean(),
  nodeEnv: z.string(),
})
  .refine((c) => !(c.enableFakeGateway && c.nodeEnv === 'production'), {
    message:
      'EMIL_ENABLE_FAKE_GATEWAY must never be set in production: the fake gateway ' +
      'accepts any webhook signature, which would let anyone mark any invoice paid.',
    path: ['enableFakeGateway'],
  })
  .refine((c) => !(c.enableSandboxValues && c.nodeEnv === 'production'), {
    message:
      'EMIL_ENABLE_SANDBOX_VALUES must never be set in production: it loads a 99% ' +
      'withholding rate, which on a real supplier payment retains almost the whole ' +
      'invoice and remits it to LHDN.',
    path: ['enableSandboxValues'],
  })
  .refine((c) => !(c.enableFakeAssistant && c.nodeEnv === 'production'), {
    message:
      'EMIL_ENABLE_FAKE_ASSISTANT must never be set in production: it replaces the ' +
      'model with canned test replies while still reporting the assistant as ' +
      'configured, which misleads every person who asks it a question.',
    path: ['enableFakeAssistant'],
  });

export type ApiConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse({
    databaseUrl: env['DATABASE_URL'],
    jwtSecret: env['JWT_SECRET'],
    port: Number(env['PORT'] ?? 3000),
    rateLimit: Number(env['RATE_LIMIT'] ?? 600),
    rateLimitWindowMs: Number(env['RATE_LIMIT_WINDOW_MS'] ?? 60_000),
    publicRateLimit: Number(env['PUBLIC_RATE_LIMIT'] ?? 30),
    enableFakeGateway: env['EMIL_ENABLE_FAKE_GATEWAY'] === '1',
    enableSandboxValues: env['EMIL_ENABLE_SANDBOX_VALUES'] === '1',
    ...(env['ANTHROPIC_API_KEY'] ? { anthropicApiKey: env['ANTHROPIC_API_KEY'] } : {}),
    enableFakeAssistant: env['EMIL_ENABLE_FAKE_ASSISTANT'] === '1',
    nodeEnv: env['NODE_ENV'] ?? 'development',
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
