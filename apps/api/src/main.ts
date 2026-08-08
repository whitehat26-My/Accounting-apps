import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { attachContext } from './context/request-context.js';

/**
 * Build the application without listening.
 *
 * Separated from `main` so the e2e suite gets the real thing — the same guards,
 * the same filter, the same middleware order — and exercises it through
 * Fastify's `inject()` rather than a socket. A test harness that assembles its
 * own subset of the middleware proves the subset works, not the application.
 */
export async function createApp(): Promise<NestFastifyApplication> {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // `trustProxy` is config, defaulting to `false` — see config.ts. Trusting
    // every hop (the old `true`) let a client forge `request.ip` via
    // `X-Forwarded-For`, defeating the rate limiter and the audit `actor_ip`.
    new FastifyAdapter({ trustProxy: config.trustProxy, bodyLimit: 8 * 1024 * 1024 }),
    // `bodyParser: false` so the JSON parser registered below is the only one.
    // Nest registers its own during `init()`, which would collide — and it is
    // the one that rejects an empty body. See the parser for why that matters.
    { logger: ['error', 'warn'], bodyParser: false },
  );

  // The request context is attached in a Fastify `onRequest` hook rather than
  // as Nest middleware. Two reasons, and the first is the one that matters:
  //
  //   * `onRequest` is the FIRST hook Fastify runs — earlier than any Nest
  //     guard, pipe or interceptor. The goal is that a request id exists before
  //     anything can fail, and Nest middleware runs after the guards have
  //     already been entered, so the context was missing exactly when the
  //     exception filter needed it.
  //
  //   * Nest middleware under the Fastify adapter needs `@fastify/middie`,
  //     which is a dependency bought for nothing when a native hook does the
  //     job better.
  app.getHttpAdapter().getInstance().addHook('onRequest', (request, _reply, done) => {
    const supplied = request.headers['x-request-id'];
    attachContext(request, {
      requestId: (Array.isArray(supplied) ? supplied[0] : supplied) ?? randomUUID(),
      ip: request.ip,
      userAgent: headerValue(request, 'user-agent'),
      idempotencyKey: headerValue(request, 'idempotency-key'),
    });
    done();
  });

  /*
   * BASELINE SECURITY HEADERS, ON EVERY RESPONSE THE API SENDS.
   *
   * ---------------------------------------------------------------------------
   * The web app already sets a full CSP, `frame-ancestors 'none'` and HSTS in
   * `next.config.ts`, and in the normal topology the browser only ever talks to
   * Next — `/api/*` is a rewrite, so those headers cover the proxied responses
   * too. That made it easy to conclude the API needed nothing.
   *
   * It is not true of the API's own origin. Found by asking a running server
   * for its headers: a financial JSON response carried `content-type`,
   * `content-length`, `date` and nothing else. Anything that reaches the API
   * directly — a misconfigured proxy, a debugging port left open, an operator
   * curling it, a PDF opened straight from its URL — got no protection at all.
   *
   *   - `nosniff` matters most here, because this API serves PDFs and CSVs.
   *     A response sniffed as HTML is a scripting vector on the API's origin.
   *   - The framing pair is cheap and absolute: nothing this API returns is
   *     ever meant to be displayed inside somebody else's page.
   *   - `no-store` keeps one tenant's books out of any intermediary cache.
   *     A CSP `default-src 'none'` is deliberately NOT set: it would apply to
   *     the built-in PDF viewer when a document is opened from this origin.
   *
   * Set only when ABSENT, so a route that has already made a considered choice
   * — the repair photographs and the logo both send their own `Cache-Control` —
   * keeps it.
   * ---------------------------------------------------------------------------
   */
  app.getHttpAdapter().getInstance().addHook('onSend', (_request, reply, payload, done) => {
    const setIfAbsent = (name: string, value: string) => {
      if (reply.getHeader(name) === undefined) reply.header(name, value);
    };
    setIfAbsent('x-content-type-options', 'nosniff');
    setIfAbsent('x-frame-options', 'DENY');
    setIfAbsent('content-security-policy', "frame-ancestors 'none'");
    setIfAbsent('referrer-policy', 'no-referrer');
    setIfAbsent('cross-origin-resource-policy', 'same-site');
    setIfAbsent('cache-control', 'no-store');
    done(null, payload);
  });

  /*
   * An empty body is `{}`, not a 400.
   *
   * Fastify's built-in JSON parser rejects a zero-length body outright when the
   * request declares `Content-Type: application/json`. Two routes take no body
   * at all — closing a fiscal year and submitting a tax return — and a client
   * that sets the header anyway, which every HTTP library does by default on a
   * POST, got "Body cannot be empty" with no hint that the body was never
   * wanted. Nothing on the server had to change for the route to work; the
   * request just had to say less.
   *
   * Registered here rather than worked around per route, because the next
   * bodyless POST would hit it too.
   */
  app.getHttpAdapter().getInstance().addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body: string, done) => {
      // Keep the EXACT bytes received, before JSON.parse loses them. A gateway
      // signs the raw payload, and re-serialising the parsed object (different
      // key order, whitespace, unicode escaping) yields a different string whose
      // signature never matches — the webhook verifier reads `rawBody`, not a
      // round-tripped copy. Harmless for every other route, which ignores it.
      (request as FastifyRequest & { rawBody?: string }).rawBody = body;
      if (body.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch {
        // Malformed JSON is still a 400 — a body that was MEANT to say
        // something and failed is a different case from one that says nothing.
        done(new BadRequestException('Request body is not valid JSON'), undefined);
      }
    },
  );

  // Without this Nest never calls `onApplicationShutdown`, and the database
  // pool in `DatabaseLifecycle` is never drained. `app.close()` alone tears
  // down the HTTP server and leaves the PostgreSQL connections open.
  app.enableShutdownHooks();

  // Deliberately NO `ValidationPipe`. Nest's pipe validates class-validator
  // decorators on DTO classes; this API validates with Zod in `parse()`, at the
  // single boundary where untrusted input becomes typed input. Two validation
  // systems would mean two places to look when a field is rejected, and the
  // pipe would silently do nothing for schemas it cannot see.
  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp();

  // 0.0.0.0 because the process runs in a container and the health check comes
  // from outside it.
  await app.listen({ port: config.port, host: '0.0.0.0' });
  new Logger('Bootstrap').log(`Emil API listening on ${config.port}`);
}

// Only when executed directly, so importing `createApp` in a test does not
// start a server.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}
