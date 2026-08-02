import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildOpenApiDocument, coverage, type RouteDescriptor } from '../src/openapi.js';
import { decimal, isoDate, positiveDecimal } from '../src/primitives.js';

const route = (over: Partial<RouteDescriptor> = {}): RouteDescriptor => ({
  method: 'get',
  path: '/v1/things',
  controller: 'ThingsController',
  handler: 'list',
  isPublic: false,
  exemptFromIdempotency: false,
  expectsBody: false,
  ...over,
});

const build = (routes: RouteDescriptor[]) =>
  buildOpenApiDocument(routes, { title: 'Test', version: '1' });

const operation = (routes: RouteDescriptor[], path: string, method: string) =>
  build(routes).paths[path]![method] as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe('primitives', () => {
  it('accepts a decimal string and refuses a number', () => {
    // A JSON number is an IEEE-754 double. An accounting API that accepts one
    // has already lost, and it loses silently.
    expect(decimal.safeParse('1234.56').success).toBe(true);
    expect(decimal.safeParse(1234.56).success).toBe(false);
    expect(decimal.safeParse('1234.567890').success).toBe(false);
  });

  it('distinguishes signed from unsigned rather than calling both `decimal`', () => {
    /*
     * Five controllers each declared a `decimal`. Four allowed a leading minus
     * and `items` did not — correctly, because an item price cannot be
     * negative. Both were called the same thing, so a reader could not tell a
     * deliberate narrowing from a typo and neither could a generated client.
     */
    expect(decimal.safeParse('-100.00').success).toBe(true);
    expect(positiveDecimal.safeParse('-100.00').success).toBe(false);
  });

  it('takes dates in ISO, not in the display format', () => {
    // `01/02/2026` is the first of February in Kuala Lumpur and the second of
    // January in New York. A wire format inheriting that ambiguity produces
    // invoices dated a month out with nothing to detect it.
    expect(isoDate.safeParse('2026-02-01').success).toBe(true);
    expect(isoDate.safeParse('01/02/2026').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What the document says about security
// ---------------------------------------------------------------------------

describe('security', () => {
  it('leaves `security` empty for a public route and populated otherwise', () => {
    const routes = [
      route({ path: '/v1/private' }),
      route({ path: '/public/thing', isPublic: true }),
    ];

    expect(operation(routes, '/v1/private', 'get')['security']).toHaveLength(2);
    // A route that silently becomes public shows up here as `security: []`,
    // which a reviewer scanning a spec notices and a reviewer scanning a
    // hundred controller methods does not.
    expect(operation(routes, '/public/thing', 'get')['security']).toEqual([]);
  });

  it('names the permission the guard will enforce', () => {
    const op = operation([route({ permission: 'invoice.create' })], '/v1/things', 'get');

    expect(op['x-required-permission']).toBe('invoice.create');
    expect(op['description']).toMatch(/`invoice.create`/);
  });

  it('requires X-Tenant-Id on protected routes and not on public ones', () => {
    const headers = (r: RouteDescriptor) =>
      ((operation([r], r.path, r.method)['parameters'] as { name: string }[]) ?? []).map(
        (p) => p.name,
      );

    expect(headers(route())).toContain('X-Tenant-Id');
    expect(headers(route({ isPublic: true }))).not.toContain('X-Tenant-Id');
  });
});

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

describe('request bodies', () => {
  const schema = z.object({ amount: decimal, issueDate: isoDate });

  it('emits a JSON Schema from the validator the handler actually uses', () => {
    const op = operation(
      [route({ method: 'post', expectsBody: true, request: schema })],
      '/v1/things',
      'post',
    );

    const body = JSON.stringify(op['requestBody']);
    expect(body).toMatch(/"amount"/);
    // The constraint a generated client needs: a string, not a number.
    expect(body).toMatch(/"type":"string"/);
    expect(body).not.toMatch(/"amount":\{"type":"number"/);
  });

  it('says NOT YET SPECIFIED rather than emitting an empty object', () => {
    /*
     * An empty object would tell a code generator the route takes no fields —
     * a lie a compiler accepts happily, and one that surfaces as a runtime
     * failure against an endpoint the developer believed they had verified.
     */
    const op = operation([route({ method: 'post', expectsBody: true })], '/v1/things', 'post');
    expect(JSON.stringify(op['requestBody'])).toMatch(/NOT YET SPECIFIED/);
  });

  it('omits the body entirely when the handler declares none', () => {
    // POST usually means a body and does not always. Documenting one that does
    // not exist makes a generated client send a payload the server ignores.
    const op = operation([route({ method: 'post', expectsBody: false })], '/v1/things', 'post');
    expect(op['requestBody']).toBeUndefined();
  });

  it('treats a third-party body as documented, not as a gap', () => {
    /*
     * The distinction `externalBody` exists for. "Nobody has written this down"
     * should fail a coverage check; "this is not ours to write down" — a
     * payment provider's webhook payload — is a complete answer. Collapsing the
     * two would either leave a permanent false gap or excuse real ones.
     */
    const webhook = route({
      method: 'post',
      path: '/public/webhook',
      expectsBody: true,
      externalBody: "The provider's own payload.",
    });

    expect(coverage([webhook]).undocumented).toEqual([]);
    expect(JSON.stringify(operation([webhook], '/public/webhook', 'post')['requestBody'])).toMatch(
      /provider's own payload/,
    );
  });
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

describe('responses', () => {
  it('documents 404 wherever a record is addressed by id, and says why', () => {
    /*
     * CLAUDE.md §9. A client author who sees only 403 will write "403 means the
     * record exists but I lack access", which is exactly the inference the rule
     * exists to deny.
     */
    const op = operation([route({ path: '/v1/things/:id' })], '/v1/things/{id}', 'get');
    const responses = op['responses'] as Record<string, { description: string }>;

    expect(responses['404']!.description).toMatch(/another organisation/);
  });

  it('does not invent a 404 for a collection route', () => {
    const op = operation([route()], '/v1/things', 'get');
    expect((op['responses'] as Record<string, unknown>)['404']).toBeUndefined();
  });

  it('documents 403 only where a permission is enforced', () => {
    const withPermission = operation([route({ permission: 'a.b' })], '/v1/things', 'get');
    const without = operation([route()], '/v1/things', 'get');

    expect((withPermission['responses'] as Record<string, unknown>)['403']).toBeTruthy();
    expect((without['responses'] as Record<string, unknown>)['403']).toBeUndefined();
  });

  it('uses 201 for a POST and 200 for everything else', () => {
    const post = operation([route({ method: 'post' })], '/v1/things', 'post');
    const get = operation([route()], '/v1/things', 'get');

    expect((post['responses'] as Record<string, unknown>)['201']).toBeTruthy();
    expect((get['responses'] as Record<string, unknown>)['200']).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Paths and idempotency
// ---------------------------------------------------------------------------

describe('paths', () => {
  it('converts Nest path parameters to OpenAPI braces and declares them', () => {
    const document = build([route({ path: '/v1/things/:id/lines/:lineNo' })]);
    const op = document.paths['/v1/things/{id}/lines/{lineNo}']!['get'] as {
      parameters: { name: string; in: string }[];
    };

    expect(op.parameters.filter((p) => p.in === 'path').map((p) => p.name)).toEqual([
      'id',
      'lineNo',
    ]);
  });

  it('requires Idempotency-Key on writes and honours the exemption', () => {
    const names = (r: RouteDescriptor) =>
      ((operation([r], '/v1/things', r.method)['parameters'] as { name: string }[]) ?? []).map(
        (p) => p.name,
      );

    expect(names(route({ method: 'post' }))).toContain('Idempotency-Key');
    // Exempt only where a database-level guarantee replaces it — the gateway
    // webhook, keyed on the provider's own event id.
    expect(names(route({ method: 'post', exemptFromIdempotency: true }))).not.toContain(
      'Idempotency-Key',
    );
    expect(names(route({ method: 'get' }))).not.toContain('Idempotency-Key');
  });
});

describe('coverage', () => {
  it('counts only routes that actually take a body', () => {
    const report = coverage([
      route({ method: 'post', expectsBody: true, request: z.object({}) }),
      route({ method: 'post', path: '/v1/other', expectsBody: true }),
      route({ method: 'post', path: '/v1/nobody', expectsBody: false }),
      route(),
    ]);

    expect(report.total).toBe(4);
    expect(report.needingRequestSchema).toBe(2);
    expect(report.withRequestSchema).toBe(1);
    expect(report.undocumented).toEqual(['POST /v1/other']);
  });
});
