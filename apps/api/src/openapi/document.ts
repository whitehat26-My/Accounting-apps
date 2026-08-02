import { buildOpenApiDocument, coverage, type OpenApiDocument, type RouteDescriptor } from '@emil/contracts';
import { API_CONTROLLERS } from '../app.module.js';
import { scanRoutes } from './scan.js';

/**
 * The specification for this build of the API.
 *
 * `API_CONTROLLERS` is the SAME array `@Module({ controllers })` is given, so a
 * controller cannot be served without appearing here and cannot appear here
 * without being served. Exporting the array and reusing it is the cheapest
 * version of that guarantee; a second list would be one more thing to forget.
 */
export function apiRoutes(): RouteDescriptor[] {
  return scanRoutes(API_CONTROLLERS);
}

export function apiDocument(): OpenApiDocument {
  return buildOpenApiDocument(apiRoutes(), {
    title: 'Emil Accounting API',
    version: '0.1.0',
    description: [
      'Multi-tenant accounting for Malaysian SMEs. Base currency MYR.',
      '',
      '### Three things a client author must know before writing any code',
      '',
      '1. **Money is a decimal STRING, never a JSON number.** A JSON number is an',
      '   IEEE-754 double; parsing `"1234.56"` into one and sending it back loses',
      '   sen silently. Every amount in every request and response is a string.',
      '2. **Every write requires an `Idempotency-Key` header.** Replaying a key',
      '   returns the stored response instead of performing the write again. This',
      '   is not optional and a write without one is refused.',
      '3. **A record belonging to another organisation answers 404, never 403.**',
      '   Do not infer existence from a status code — the two cases are',
      '   deliberately indistinguishable.',
      '',
      '### Coverage',
      '',
      'Paths, methods, path parameters, required headers, authentication and the',
      'permission each route enforces are REFLECTED off the running application,',
      'so they cannot drift from it. Request bodies are described where the route',
      'carries its validator; the rest are marked `NOT YET SPECIFIED` rather than',
      'guessed. Check `x-coverage` in this document before generating a client.',
    ].join('\n'),
    servers: [{ url: '/', description: 'This deployment' }],
  });
}

/** The document plus an honest statement of how much of it is filled in. */
export function apiDocumentWithCoverage(): OpenApiDocument & { 'x-coverage': unknown } {
  return { ...apiDocument(), 'x-coverage': coverage(apiRoutes()) };
}
