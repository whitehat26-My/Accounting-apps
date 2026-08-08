import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addMember, createClient, migrate, registerUser, withTenant, withUser } from '@emil/db';
// The tenant fixture is the SAME one the db package's own integration tests
// use, exported under `@emil/db/testing`. A second fixture would drift, and
// then the API suite would be exercising a chart of accounts that no other
// test has ever posted to.
export { seedTenant, type Tenant } from '@emil/db/testing';
import type { RoleCode } from '@emil/domain';
import { createApp } from '../src/main.js';

/**
 * The e2e harness boots the REAL application — the same guards in the same
 * order, the same exception filter, the same middleware — and drives it through
 * Fastify's `inject()`.
 *
 * `inject()` rather than a socket because it exercises everything above the
 * network without needing a port, which keeps the suite runnable in parallel
 * with the rest. Everything below `inject()` is Fastify's own, and is not this
 * project's to test.
 *
 * A harness that assembled its own subset of the middleware would prove the
 * subset works. That is the failure mode this avoids.
 */

const ADMIN_URL = process.env['DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:55432/postgres';
const APP_LOGIN_ROLE = 'emil_app_login';

export interface TestApi {
  readonly app: NestFastifyApplication;
  readonly admin: ReturnType<typeof createClient>;
  readonly appUrl: string;
  readonly close: () => Promise<void>;
}

export async function createTestApi(
  name: string,
  /**
   * Environment the app is built with, for the few suites whose subject IS a
   * configuration choice — the invite gate, which cannot be tested under the
   * `SIGNUP_MODE=open` every other suite needs.
   */
  overrides: Record<string, string> = {},
): Promise<TestApi> {
  const dbName = `emil_api_${name}_${Date.now().toString(36)}`;
  const cluster = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });

  await cluster.unsafe(`
      DO $$
      BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_LOGIN_ROLE}') THEN
              CREATE ROLE ${APP_LOGIN_ROLE} LOGIN NOBYPASSRLS;
          END IF;
      END $$;
  `);
  await cluster.unsafe(`CREATE DATABASE ${dbName}`);
  await cluster.end();

  const adminUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
  await migrate(adminUrl);

  const admin = createClient(adminUrl);
  await admin.unsafe(`
      GRANT ${'emil_app'} TO ${APP_LOGIN_ROLE};
      GRANT CONNECT ON DATABASE ${dbName} TO ${APP_LOGIN_ROLE};
      GRANT USAGE ON SCHEMA public TO ${APP_LOGIN_ROLE};
  `);

  // The API connects as the UNPRIVILEGED role, exactly as it does in
  // production. Connecting as the owner would let every RLS assertion in this
  // suite pass while the policies did nothing.
  const appUrl = adminUrl.replace('//postgres@', `//${APP_LOGIN_ROLE}@`);

  process.env['DATABASE_URL'] = appUrl;
  process.env['JWT_SECRET'] = 'test-secret-that-is-long-enough-to-pass-validation';
  process.env['RATE_LIMIT'] = '10000';
  process.env['PUBLIC_RATE_LIMIT'] = '10000';
  /*
   * The suite registers users freely, so it runs the OPEN sign-up mode
   * explicitly. Set here rather than relied on as a default: the default is
   * `invite`, deliberately, because a default that fails open costs somebody
   * their instance while one that fails closed costs a line in a harness.
   * The invite gate has its own tests, which set this to `invite`.
   */
  process.env['SIGNUP_MODE'] = 'open';
  // Registers the in-memory FakeGateway, which accepts any signature. Safe
  // only because `loadConfig` refuses this flag when NODE_ENV is production —
  // there is a test below asserting exactly that.
  process.env['EMIL_ENABLE_FAKE_GATEWAY'] = '1';
  process.env['EMIL_ENABLE_SANDBOX_VALUES'] = '1';

  // Applied LAST, so a suite whose subject is a configuration choice can
  // override any default above.
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;

  const app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    admin,
    appUrl,
    close: async () => {
      await app.close();
      await admin.end();
      const cleanup = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

export interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  token?: string;
  apiKey?: string;
  tenantId?: string;
  idempotencyKey?: string | null;
  body?: unknown;
}

export async function call(api: TestApi, options: Call) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  if (options.apiKey) headers['x-api-key'] = options.apiKey;
  if (options.tenantId) headers['x-tenant-id'] = options.tenantId;

  // `null` means "deliberately omit", so the required-header behaviour can be
  // tested. `undefined` means "supply a fresh one", which is what a
  // well-behaved client does.
  if (options.idempotencyKey !== null) {
    headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
  }

  const response = await api.app.getHttpAdapter().getInstance().inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  });

  return {
    status: response.statusCode,
    body: response.body.length > 0 ? (JSON.parse(response.body) as Record<string, unknown>) : {},
  };
}

/** A registered user with a session, and optionally a membership. */
export async function makeUser(
  api: TestApi,
  options: { tenantId?: string; role?: RoleCode } = {},
): Promise<{ userId: string; email: string; password: string; refreshToken: string }> {
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const password = 'correct horse battery staple';

  const sql = createClient(api.appUrl);
  try {
    const user = await withUser(sql, null, (tx) =>
      registerUser(tx, { email, password, fullName: 'E2E User' }),
    );

    if (options.tenantId !== undefined) {
      const ctx = { tenantId: options.tenantId, userId: user.id };
      await withTenant(sql, ctx, (tx) =>
        addMember(tx, ctx, { userId: user.id, role: options.role ?? 'ADMIN' }),
      );
    }

    const login = await call(api, {
      method: 'POST',
      url: '/v1/auth/login',
      body: { email, password },
    });

    return {
      userId: user.id,
      email,
      password,
      refreshToken: login.body['refreshToken'] as string,
    };
  } finally {
    await sql.end();
  }
}

/** Log in and obtain an access token for one organisation. */
export async function accessTokenFor(
  api: TestApi,
  refreshToken: string,
  tenantId: string,
): Promise<{ accessToken: string; refreshToken: string; status: number; body: Record<string, unknown> }> {
  const response = await call(api, {
    method: 'POST',
    url: '/v1/auth/switch',
    body: { refreshToken, tenantId },
  });

  return {
    accessToken: response.body['accessToken'] as string,
    refreshToken: response.body['refreshToken'] as string,
    status: response.status,
    body: response.body,
  };
}

/**
 * The same request, without parsing the body as JSON.
 *
 * `call` assumes JSON, which is right for every route but the CSV exports and
 * the PDFs — and a test that ran those through `JSON.parse` would fail on the
 * response rather than on the assertion, hiding what actually broke.
 *
 * It sends a request body when given one, because not every non-JSON response
 * comes from a GET: the payslip is rendered from figures that must travel in a
 * body, since a salary in a query string ends up in every proxy's access log.
 */
export async function callRaw(api: TestApi, options: Call) {
  const headers: Record<string, string> = {};
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  if (options.tenantId) headers['x-tenant-id'] = options.tenantId;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = options.idempotencyKey ?? randomUUID();
  }

  const response = await api.app.getHttpAdapter().getInstance().inject({
    method: options.method,
    url: options.url,
    headers,
    // Stringified, exactly as `call` does. Passing the object widens the
    // inject overload to a union and the whole helper stops type-checking.
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
  });

  return {
    status: response.statusCode,
    headers: response.headers as Record<string, string>,
    body: response.body,
    /*
     * The UNDECODED bytes.
     *
     * `body` is a string decoded as UTF-8, which is fine for CSV and for
     * asserting on the ASCII text inside a PDF — but it mangles every byte
     * above 127, so writing it back out produces a PDF whose embedded images
     * are corrupt while its text still reads correctly. That failure looks
     * like a rendering bug and is not one. Anything that needs the real file
     * takes this.
     */
    raw: response.rawPayload,
  };
}

/**
 * The readable text of a rendered PDF.
 *
 * The renderer sets `compress: false` precisely so this is possible — it lets a
 * test assert what is ON the page rather than only that some PDF came back,
 * which is the difference between catching a blank payslip and shipping one.
 *
 * Joined with NOTHING: pdfkit splits a single phrase into several hex runs at
 * kerning adjustments ("INV", "OICE (P", "AID)"), so any separator would break
 * substring assertions on ordinary words.
 */
export function pdfText(body: string): string {
  return [...body.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
    .join('');
}
