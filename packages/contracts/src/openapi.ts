import { z } from 'zod';
import { errorResponse } from './primitives.js';

/**
 * The OpenAPI document, built from routes the server actually serves.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY DESIGN DECISION HERE THAT MATTERS: THE SPEC IS NOT A SECOND SOURCE
 * OF TRUTH.
 *
 * A hand-maintained spec, or one assembled from a parallel registry of route
 * definitions, drifts. It drifts quietly, because nothing fails when it does —
 * the server keeps working and only the document is wrong. And a WRONG spec is
 * worse than no spec: a client generates a typed SDK from it, the types compile,
 * and the failures arrive at runtime in production against endpoints the
 * developer believed they had verified.
 *
 * So `apps/api` does not describe its routes to this module. It ENUMERATES them
 * — by reflecting over the same Nest metadata the router itself dispatches on,
 * and the same `@Requires` metadata the auth guard enforces. The path in the
 * document is the path Nest registered. The permission in the document is the
 * permission the guard will check. They cannot disagree, because they are not
 * two things.
 *
 * What this module cannot derive, it declares MISSING rather than inventing:
 * a route with no request schema is documented as accepting an unspecified
 * object, and `coverage()` reports how many there are.
 * ---------------------------------------------------------------------------
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * One route, as reflected off the running application.
 *
 * Every field here is READ from the server, not asserted about it.
 */
export interface RouteDescriptor {
  readonly method: HttpMethod;
  /** The full path Nest registered, e.g. `/v1/invoices/:id`. */
  readonly path: string;
  readonly controller: string;
  readonly handler: string;
  /** From `@Requires`. Absent means authenticated but unrestricted. */
  readonly permission?: string;
  /** From `@Public`. */
  readonly isPublic: boolean;
  /** From `@NoIdempotencyKey`. */
  readonly exemptFromIdempotency: boolean;
  /**
   * Whether the handler declares a `@Body()` parameter.
   *
   * Reflected rather than inferred from the method. `POST` usually means a
   * body and does not always: `POST /v1/sandbox/statutory-values` takes none,
   * and documenting one would make a generated client send a payload the
   * server ignores.
   */
  readonly expectsBody: boolean;
  /** From `@Doc`, when the route carries one. */
  readonly summary?: string;
  readonly description?: string;
  readonly request?: z.ZodType;
  readonly response?: z.ZodType;
  readonly deprecated?: boolean;
  /**
   * Set when the body is defined by a third party rather than by this API — the
   * payment-gateway webhook, whose shape belongs to the provider. Documented as
   * such, and counted as specified: "not ours to describe" is a complete
   * answer, where "nobody has described it" is not.
   */
  readonly externalBody?: string;
}

export interface OpenApiOptions {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly servers?: readonly { url: string; description?: string }[];
}

/** A minimal typing of the parts of the document this module produces. */
export interface OpenApiDocument {
  readonly openapi: '3.1.0';
  readonly info: Record<string, unknown>;
  readonly servers?: readonly unknown[];
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: Record<string, unknown>;
  readonly tags: readonly { name: string; description?: string }[];
}

const MUTATING: ReadonlySet<HttpMethod> = new Set(['post', 'put', 'patch', 'delete']);

export function buildOpenApiDocument(
  routes: readonly RouteDescriptor[],
  options: OpenApiOptions,
): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Map<string, { name: string; description?: string }>();

  for (const route of [...routes].sort(compareRoutes)) {
    const path = toOpenApiPath(route.path);
    const tag = tagFor(route);
    tags.set(tag, { name: tag });

    const operation: Record<string, unknown> = {
      operationId: `${route.controller.replace(/Controller$/, '')}_${route.handler}`,
      tags: [tag],
      summary: route.summary ?? humanise(route.handler),
      ...(route.description !== undefined ? { description: route.description } : {}),
      ...(route.deprecated ? { deprecated: true } : {}),
      parameters: parametersFor(route),
      responses: responsesFor(route),
    };

    /*
     * SECURITY IS DERIVED FROM THE GUARD'S OWN METADATA.
     *
     * `@Public` is opt-IN in this codebase — the auth guard is global and a
     * route is protected unless it says otherwise. Reflecting that flag rather
     * than restating it means a route that silently becomes public shows up
     * here as `security: []`, which is exactly the thing a reviewer scanning a
     * spec would notice and a reviewer scanning 100 controller methods would
     * not.
     */
    operation['security'] = route.isPublic
      ? []
      : [{ bearerAuth: [] }, { apiKey: [] }];

    if (route.permission) {
      operation['x-required-permission'] = route.permission;
      operation['description'] =
        `${route.description ? `${route.description}\n\n` : ''}` +
        `Requires the \`${route.permission}\` permission.`;
    }

    if (route.expectsBody) {
      operation['requestBody'] = requestBodyFor(route);
    }

    paths[path] ??= {};
    paths[path]![route.method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: options.title,
      version: options.version,
      ...(options.description !== undefined ? { description: options.description } : {}),
    },
    ...(options.servers ? { servers: options.servers } : {}),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'An access token from `POST /v1/auth/switch`. Scoped to one organisation; ' +
            'the `X-Tenant-Id` header must name the same one.',
        },
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Api-Key',
          description: 'A per-organisation API key. Carries its own permission scopes.',
        },
      },
      schemas: { Error: toJsonSchema(errorResponse) },
    },
    tags: [...tags.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * How much of the surface is actually specified.
 *
 * Reported rather than hidden. A spec that documents 100 paths and describes
 * the body of 12 of them is genuinely useful for discovery and genuinely
 * insufficient for code generation, and a caller deserves to know which one
 * they are holding.
 */
export function coverage(routes: readonly RouteDescriptor[]): {
  readonly total: number;
  readonly withRequestSchema: number;
  readonly needingRequestSchema: number;
  readonly withResponseSchema: number;
  readonly undocumented: readonly string[];
} {
  const needing = routes.filter((r) => r.expectsBody);

  return {
    total: routes.length,
    withRequestSchema: needing.filter(
      (r) => r.request !== undefined || r.externalBody !== undefined,
    ).length,
    needingRequestSchema: needing.length,
    withResponseSchema: routes.filter((r) => r.response !== undefined).length,
    undocumented: needing
      .filter((r) => r.request === undefined && r.externalBody === undefined)
      .map((r) => `${r.method.toUpperCase()} ${r.path}`)
      .sort(),
  };
}

// ------------------------------------------------------------------ internals

function compareRoutes(a: RouteDescriptor, b: RouteDescriptor): number {
  return a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path);
}

/** `/v1/invoices/:id` → `/v1/invoices/{id}`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

function tagFor(route: RouteDescriptor): string {
  return route.controller.replace(/Controller$/, '');
}

/** `listCashFlowClassifications` → `List cash flow classifications`. */
function humanise(handler: string): string {
  const words = handler.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function parametersFor(route: RouteDescriptor): unknown[] {
  const parameters: unknown[] = pathParameterNames(route.path).map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));

  if (!route.isPublic) {
    parameters.push({
      name: 'X-Tenant-Id',
      in: 'header',
      required: true,
      schema: { type: 'string', format: 'uuid' },
      description:
        'The organisation this request acts for. Asserted against the token — a token ' +
        'minted for one organisation is refused for another.',
    });
  }

  if (MUTATING.has(route.method) && !route.exemptFromIdempotency) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string' },
      description:
        'Required on every write. Replaying a key returns the stored response rather ' +
        'than performing the write again.',
    });
  }

  return parameters;
}

function requestBodyFor(route: RouteDescriptor): unknown {
  if (route.request) {
    return { required: true, content: { 'application/json': { schema: toJsonSchema(route.request) } } };
  }

  if (route.externalBody !== undefined) {
    return {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: true,
            description: route.externalBody,
          },
        },
      },
    };
  }

  // Stated, not invented. `additionalProperties: true` with no properties is
  // the honest JSON Schema for "this takes a body and nobody has described it".
  return {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          additionalProperties: true,
          description:
            'NOT YET SPECIFIED. This route accepts a body whose shape is not described ' +
            'in this document; consult the controller. Do not generate a client from it.',
        },
      },
    },
  };
}

function responsesFor(route: RouteDescriptor): Record<string, unknown> {
  const success = route.method === 'post' ? '201' : '200';

  const responses: Record<string, unknown> = {
    [success]: {
      description: 'Success',
      ...(route.response
        ? { content: { 'application/json': { schema: toJsonSchema(route.response) } } }
        : {}),
    },
    '422': errorRef('The request was well-formed and its content was not acceptable.'),
    '500': errorRef('An unexpected failure. Quote `requestId` when reporting it.'),
  };

  if (!route.isPublic) {
    responses['401'] = errorRef('No credential, or an invalid one.');
    if (route.permission) {
      responses['403'] = errorRef(
        `The caller is inside the organisation but lacks \`${route.permission}\`.`,
      );
    }
  }

  /*
   * 404 on any route that takes an id, INCLUDING a cross-tenant one.
   *
   * CLAUDE.md §9: a record belonging to another organisation answers 404, never
   * 403. Documenting it is not a formality — a client author who sees only 403
   * on this list will write "if 403, the record exists but I lack access",
   * which is precisely the inference the rule exists to deny.
   */
  if (pathParameterNames(route.path).length > 0) {
    responses['404'] = errorRef(
      'Not found. Returned identically for a record that does not exist and one ' +
        'belonging to another organisation — the two are never distinguishable.',
    );
  }

  if (MUTATING.has(route.method)) {
    responses['409'] = errorRef('A conflict, such as posting into a locked period.');
  }

  responses['429'] = errorRef('Rate limited. Retry after the interval in the body.');

  return responses;
}

function errorRef(description: string): unknown {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
}

/**
 * Zod → JSON Schema.
 *
 * Zod 4 emits this natively, so there is no third-party converter to keep in
 * step with the schema library. `io: 'input'` matters: a schema with a default
 * or a transform has a different shape going in than coming out, and a REQUEST
 * body is described by what the client may send.
 */
function toJsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
}
