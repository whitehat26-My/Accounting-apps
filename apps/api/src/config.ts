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
   * Who may open an account on this installation.
   *
   * ---------------------------------------------------------------------------
   * DEFAULTS TO `invite`, BECAUSE THE WRONG DEFAULT HAS AN OWNER.
   *
   * Registration used to be open to whoever found the URL. That is right for a
   * shop PC on a LAN or behind Tailscale, where the NETWORK is the gate, and
   * wrong for anything with a domain name — the operator would learn about the
   * strangers from the table sizes.
   *
   * A default that fails open costs somebody their instance; a default that
   * fails closed costs a developer one environment variable. So `invite` here,
   * and `SIGNUP_MODE=open` set explicitly by the dev harness, the e2e harness
   * and any deployment that genuinely wants self-serve sign-up.
   * ---------------------------------------------------------------------------
   */
  signupMode: z.enum(['open', 'invite']),
  /**
   * Requests per window for the assistant chat route, keyed PER TENANT.
   *
   * Every other route's cost is a database query; this one's is a paid LLM
   * call, so one member holding a valid login could run up real money by
   * scripting the chat endpoint. The per-IP limiter above does not bound that —
   * a tenant behind one NAT shares an IP, and an authenticated caller can vary
   * it. This is a much smaller budget, applied on the tenant, inside the route
   * where the principal is known. Independent of the general limit so a busy
   * tenant's ordinary traffic never eats into the assistant allowance.
   */
  assistantRateLimit: z.number().int().positive(),
  /**
   * What to trust `X-Forwarded-For` from.
   *
   * ---------------------------------------------------------------------------
   * DEFAULT `false`, BECAUSE THE ALTERNATIVE FORGES THE CLIENT ADDRESS.
   *
   * Fastify's `trustProxy: true` trusts EVERY hop, so `request.ip` becomes the
   * left-most `X-Forwarded-For` value — i.e. whatever the client typed. That
   * IP keys the rate limiter and is written to the audit log as `actor_ip`, so
   * trusting it blindly lets an attacker rotate the header to defeat every rate
   * limit and to forge the "from where" on the audit trail.
   *
   * `false` uses the real socket address, which a client cannot spoof. When the
   * app runs behind the bundled Caddy + web proxy, set `TRUST_PROXY` to the
   * number of proxy hops in front of the API (Caddy + web = `2`) or to the
   * proxy's CIDR — so `request.ip` is the real client without trusting a
   * client-injected header. See docs/DEPLOY.md.
   * ---------------------------------------------------------------------------
   */
  trustProxy: z.union([z.boolean(), z.number().int().nonnegative(), z.string().min(1)]),
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
  /**
   * Where a printed document tells the reader to go to verify it.
   *
   * Printed onto paper that outlives any deployment, so it is configuration
   * rather than a constant — but it has a default, unlike the secrets above:
   * a wrong URL on a receipt is a bad link, while a missing one would stop
   * invoices printing at all. The document also prints the digest as text, so
   * a reader who cannot reach this address still holds everything needed to
   * verify through any future address.
   */
  publicBaseUrl: z.string().url(),
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

/**
 * `TRUST_PROXY` → Fastify's `trustProxy`. Unset means `false` (trust nothing).
 * A bare number is a hop count; `true`/`false` are literal; anything else is
 * passed through as a CIDR / comma-separated address list.
 */
function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse({
    databaseUrl: env['DATABASE_URL'],
    jwtSecret: env['JWT_SECRET'],
    port: Number(env['PORT'] ?? 3000),
    rateLimit: Number(env['RATE_LIMIT'] ?? 600),
    rateLimitWindowMs: Number(env['RATE_LIMIT_WINDOW_MS'] ?? 60_000),
    publicRateLimit: Number(env['PUBLIC_RATE_LIMIT'] ?? 30),
    signupMode: env['SIGNUP_MODE'] ?? 'invite',
    assistantRateLimit: Number(env['ASSISTANT_RATE_LIMIT'] ?? 30),
    trustProxy: parseTrustProxy(env['TRUST_PROXY']),
    enableFakeGateway: env['EMIL_ENABLE_FAKE_GATEWAY'] === '1',
    enableSandboxValues: env['EMIL_ENABLE_SANDBOX_VALUES'] === '1',
    ...(env['ANTHROPIC_API_KEY'] ? { anthropicApiKey: env['ANTHROPIC_API_KEY'] } : {}),
    enableFakeAssistant: env['EMIL_ENABLE_FAKE_ASSISTANT'] === '1',
    publicBaseUrl: env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000',
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

/**
 * The address printed on a document's verification block.
 *
 * Read from the environment at call time rather than injected: the renderer is
 * a pure function of its arguments and the controller is the only caller, so
 * threading config through the PDF layer would buy nothing. Kept beside the
 * schema so there is one place that knows the variable's name.
 */
export function verifyUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${(env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '')}/verify`;
}
