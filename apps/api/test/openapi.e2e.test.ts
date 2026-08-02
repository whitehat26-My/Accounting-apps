import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coverage } from '@emil/contracts';
import { apiDocument, apiRoutes } from '../src/openapi/document.js';
import { call, createTestApi, type TestApi } from './helpers.js';

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi('openapi');
}, 120_000);

afterAll(async () => {
  await api?.close();
});

/**
 * Every route Fastify actually dispatches on, read from the router itself.
 *
 * This is the independent side of the comparison. `apiRoutes()` reads Nest's
 * decorator metadata; this reads what Fastify was ultimately given. If the two
 * ever disagree, the document is describing something the server does not
 * serve — which is the failure the whole design exists to prevent, and it must
 * be a test failure rather than a surprise in a client.
 */
function fastifyRoutes(): { method: string; path: string }[] {
  const printed = api.app
    .getHttpAdapter()
    .getInstance()
    .printRoutes({ commonPrefix: false, includeHooks: false });

  /*
   * `printRoutes` renders Fastify's RADIX TREE, not a flat list, so a path is
   * split wherever it shares a prefix with a sibling:
   *
   *     ├── /v1/auth/me (GET, HEAD)
   *     │   └── mbers (POST)
   *
   * That second line is `/v1/auth/members`, not a route called `mbers`. Reading
   * each line on its own — which the first version of this did — produced 32
   * imaginary routes and made the comparison meaningless. Depth comes from the
   * 4-character indent groups, and each node's segment concatenates onto its
   * parent's accumulated path.
   */
  const routes: { method: string; path: string }[] = [];
  const prefixAtDepth: string[] = [];

  for (const line of printed.split('\n')) {
    const match = /^((?:[│ ]\s{3})*)(?:├──|└──)\s(\S*)(?:\s\((.+)\))?\s*$/.exec(line);
    if (!match) continue;

    const depth = match[1]!.length / 4;
    const segment = match[2] ?? '';
    const methods = match[3];

    prefixAtDepth[depth] = (depth === 0 ? '' : (prefixAtDepth[depth - 1] ?? '')) + segment;

    // A node with no methods is a branch in the tree, not a route.
    if (!methods) continue;

    for (const method of methods.split(',')) {
      routes.push({ method: method.trim().toLowerCase(), path: prefixAtDepth[depth]! });
    }
  }

  return routes;
}

// ---------------------------------------------------------------------------
// The property the design rests on
// ---------------------------------------------------------------------------

describe('the specification describes the application, not an intention about it', () => {
  it('documents every route the server serves, and no route it does not', () => {
    /*
     * THE ASSERTION THIS WHOLE SLICE IS FOR.
     *
     * A hand-maintained spec drifts silently — nothing fails when it does,
     * because the server keeps working and only the document is wrong. And a
     * wrong spec is worse than none: a client generates a typed SDK, the types
     * compile, and the failures land at runtime against endpoints the developer
     * believed they had verified.
     */
    const documented = new Set(
      apiRoutes().map((r) => `${r.method} ${r.path.replace(/:([A-Za-z0-9_]+)/g, ':param')}`),
    );

    const served = new Set(
      fastifyRoutes()
        // Fastify registers HEAD for every GET, and OPTIONS for CORS. Neither is
        // a route anybody wrote, so neither belongs in the comparison.
        .filter((r) => !['head', 'options'].includes(r.method))
        .map((r) => `${r.method} ${normalise(r.path).replace(/:([A-Za-z0-9_]+)/g, ':param')}`),
    );

    expect(served.size).toBeGreaterThan(90);

    const undocumented = [...served].filter((r) => !documented.has(r)).sort();
    const phantom = [...documented].filter((r) => !served.has(r)).sort();

    expect(undocumented, 'served but absent from the specification').toEqual([]);
    expect(phantom, 'in the specification but not served').toEqual([]);
  });

  it('reports the permission the guard will actually enforce', () => {
    /*
     * A spec that lies about which permission an endpoint needs is worse than
     * one that says nothing, because a reviewer will believe it. The document
     * reads `REQUIRED_PERMISSION` — the exact metadata `AuthGuard` reads — so
     * the two cannot disagree.
     *
     * Spot-checked against routes whose permission was chosen deliberately and
     * argued about in review.
     */
    const byKey = new Map(apiRoutes().map((r) => [`${r.method} ${r.path}`, r]));

    expect(byKey.get('post /v1/invoices')?.permission).toBe('invoice.create');
    // Editing the catalogue is a bookkeeping decision, not a sales-desk one.
    expect(byKey.get('post /v1/items')?.permission).toBe('item.write');
    expect(byKey.get('get /v1/items')?.permission).toBe('item.read');
    // Classifying an account changes every cash flow statement retroactively.
    expect(byKey.get('post /v1/reports/cash-flow/classifications')?.permission).toBe('org.manage');
    expect(byKey.get('get /v1/system/queues')?.permission).toBe('system.read');
  });

  it('marks exactly the routes that are genuinely public', () => {
    /*
     * `@Public` is opt-IN here: the auth guard is global, so a route is
     * protected unless it says otherwise. That makes the list of public routes
     * short, deliberate, and worth pinning — a route that silently becomes
     * public appears in the document as `security: []`, which is the thing a
     * reviewer scanning a spec notices and a reviewer scanning a hundred
     * controller methods does not.
     */
    const publicRoutes = apiRoutes()
      .filter((r) => r.isPublic)
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    expect(publicRoutes).toEqual([
      'get /openapi.json',
      'get /public/pay/:token',
      'post /public/gateways/:provider/webhook',
      'post /public/pay/:token/initiate',
      'post /v1/auth/login',
      // Logout is public because it authenticates with the refresh token in its
      // body rather than with an access token — a session must be revocable
      // after the access token has already expired.
      'post /v1/auth/logout',
      'post /v1/auth/refresh',
      'post /v1/auth/register',
      'post /v1/auth/switch',
    ]);
  });

  it('documents the Idempotency-Key requirement on writes, and its one exemption', () => {
    const document = apiDocument();

    const invoiceHeaders = headerNames(document, '/v1/invoices', 'post');
    expect(invoiceHeaders).toContain('Idempotency-Key');

    // The gateway webhook is the sole exemption: a payment provider does not
    // send a header this product invented, so the guarantee is the unique
    // constraint on `gateway_event` instead. Documented as not required, or a
    // client author would conclude the API is inconsistent.
    const webhookHeaders = headerNames(document, '/public/gateways/{provider}/webhook', 'post');
    expect(webhookHeaders).not.toContain('Idempotency-Key');
  });
});

// ---------------------------------------------------------------------------
// Honesty about what is missing
// ---------------------------------------------------------------------------

describe('coverage', () => {
  it('describes the body of every route that takes one', () => {
    /*
     * A route with a body and no schema is documented as `NOT YET SPECIFIED`
     * rather than as an empty object — an empty object would tell a code
     * generator the route takes no fields, which is a lie a compiler would
     * happily accept.
     *
     * This asserts the gap is closed. If a new route with a body lands without
     * a `@Doc`, this fails and names it.
     */
    const report = coverage(apiRoutes());

    expect(report.undocumented, 'routes taking a body with no @Doc request schema').toEqual([]);
    expect(report.withRequestSchema).toBe(report.needingRequestSchema);
  });

  it('publishes the coverage figures rather than implying completeness', async () => {
    const response = await call(api, { method: 'GET', url: '/openapi.json' });

    const report = response.body['x-coverage'] as Record<string, unknown>;
    expect(report['total']).toBeGreaterThan(90);
    // Response schemas are largely absent, and the document says so instead of
    // letting a reader assume otherwise.
    expect(report).toHaveProperty('withResponseSchema');
  });
});

// ---------------------------------------------------------------------------
// The document itself
// ---------------------------------------------------------------------------

describe('GET /openapi.json', () => {
  it('is served without authentication', async () => {
    // Deliberate. The document holds paths, methods and permission NAMES — no
    // tenant data — and requiring a credential to read it is friction paid by
    // every honest integrator to inconvenience an attacker for a minute.
    const response = await call(api, { method: 'GET', url: '/openapi.json' });

    expect(response.status).toBe(200);
    expect(response.body['openapi']).toBe('3.1.0');
  });

  it('is a valid-enough OpenAPI 3.1 document to be parsed', async () => {
    const response = await call(api, { method: 'GET', url: '/openapi.json' });
    const document = response.body as unknown as {
      paths: Record<string, Record<string, { responses: unknown; security: unknown[] }>>;
      components: { securitySchemes: Record<string, unknown> };
    };

    expect(Object.keys(document.paths).length).toBeGreaterThan(80);
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
      'apiKey',
      'bearerAuth',
    ]);

    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        expect(operation.responses, `${method} ${path} has no responses`).toBeTruthy();
        expect(Array.isArray(operation.security), `${method} ${path}`).toBe(true);
      }
    }
  });

  it('gives every operation a unique operationId', async () => {
    /*
     * Not a formality. `operationId` is what a code generator names the method
     * it emits, so a duplicate silently overwrites one endpoint with another —
     * the generated client compiles, and one of the two routes is simply
     * unreachable through it.
     *
     * The id is derived from controller + handler, so a collision means two
     * controllers whose names match after the `Controller` suffix is stripped,
     * which TypeScript would not catch.
     */
    const response = await call(api, { method: 'GET', url: '/openapi.json' });
    const paths = response.body['paths'] as Record<
      string,
      Record<string, { operationId: string }>
    >;

    const ids = Object.values(paths).flatMap((methods) =>
      Object.values(methods).map((op) => op.operationId),
    );
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);

    expect(duplicates, 'duplicate operationIds').toEqual([]);
    expect(ids.length).toBeGreaterThan(90);
  });

  it('resolves every $ref it emits', async () => {
    // A dangling `$ref` fails every parser and every generator. There is only
    // one today — the shared error envelope — and that is exactly the sort of
    // thing that is correct until somebody adds a second.
    const response = await call(api, { method: 'GET', url: '/openapi.json' });
    const document = response.body;

    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);

    for (const ref of new Set(refs)) {
      expect(ref.startsWith('#/'), `external $ref: ${ref}`).toBe(true);

      const resolved = ref
        .slice(2)
        .split('/')
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown> | undefined)?.[key],
          document,
        );

      expect(resolved, `unresolvable $ref: ${ref}`).toBeTruthy();
    }
  });

  it('documents the 404-not-403 rule wherever a record is addressed by id', async () => {
    /*
     * CLAUDE.md §9. Documenting it is not a formality: a client author who sees
     * only 403 on the list will write "403 means the record exists but I lack
     * access", which is exactly the inference the rule exists to deny.
     */
    const response = await call(api, { method: 'GET', url: '/openapi.json' });
    const paths = response.body['paths'] as Record<
      string,
      Record<string, { responses: Record<string, { description: string }> }>
    >;

    const withId = Object.entries(paths).filter(([path]) => path.includes('{'));
    expect(withId.length).toBeGreaterThan(10);

    for (const [path, methods] of withId) {
      for (const [method, operation] of Object.entries(methods)) {
        const notFound = operation.responses['404'];
        expect(notFound, `${method} ${path} does not document 404`).toBeTruthy();
        expect(notFound!.description).toMatch(/another organisation/);
      }
    }
  });

  it('says money is a string, in the schema and not only in prose', async () => {
    const response = await call(api, { method: 'GET', url: '/openapi.json' });
    const invoice = response.body['paths'] as Record<string, Record<string, unknown>>;

    const body = (invoice['/v1/invoices']!['post'] as {
      requestBody: { content: { 'application/json': { schema: Record<string, unknown> } } };
    }).requestBody.content['application/json'].schema;

    // A generated client must see `type: "string"` for an amount. Prose in the
    // description is not enough — nothing generates from prose.
    expect(JSON.stringify(body)).toMatch(/"type":"string"/);
    expect(JSON.stringify(body)).not.toMatch(/"unitPrice":\{"type":"number"/);
  });
});

// ------------------------------------------------------------------ internals

function normalise(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

function headerNames(
  document: ReturnType<typeof apiDocument>,
  path: string,
  method: string,
): string[] {
  const operation = document.paths[path]?.[method] as
    | { parameters?: { name: string; in: string }[] }
    | undefined;

  return (operation?.parameters ?? []).filter((p) => p.in === 'header').map((p) => p.name);
}
