import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { contextOf } from '../context/request-context.js';

/**
 * Translate service errors into HTTP, and make sure nothing else leaks.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES.
 *
 * 1. A "not found" from a service is a 404 whether the record is absent or
 *    belongs to another tenant. RLS filtered the other tenant's row out before
 *    the service saw it, so the service genuinely cannot tell the difference —
 *    and neither should the response. CLAUDE.md rule 9.
 *
 * 2. An unrecognised error is a 500 with NO detail. A stack trace or a raw
 *    PostgreSQL message tells an attacker the schema, the column names, and
 *    often the query. The detail goes to the log, keyed by request id, where
 *    the person debugging can find it and the person probing cannot.
 * ---------------------------------------------------------------------------
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Api');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();

    const requestId = safeRequestId(request);

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      void reply.status(exception.getStatus()).send(
        typeof body === 'string' ? { error: 'error', message: body, requestId } : { ...body, requestId },
      );
      return;
    }

    const mapped = mapServiceError(exception);
    if (mapped !== undefined) {
      void reply.status(mapped.status).send({ ...mapped.body, requestId });
      return;
    }

    this.logger.error(
      `Unhandled error on ${request.method} ${request.url} [${requestId}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    void reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: 'internal_error',
      message: 'Something went wrong. Quote the request id if you report this.',
      requestId,
    });
  }
}

interface Mapped {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Map the service layer's error codes onto HTTP.
 *
 * Matched on the `code` property that every service error in `packages/db`
 * carries, rather than on message text — a message is a user-facing string that
 * will be reworded, and a status code that changes when someone improves the
 * wording is a bug waiting to happen.
 */
function mapServiceError(exception: unknown): Mapped | undefined {
  if (!(exception instanceof Error)) return undefined;

  const code = (exception as Error & { code?: string }).code;
  const detail = (exception as Error & { detail?: unknown }).detail;

  if (code === undefined) return undefined;

  // Anything the services report as "not found" — including a contact or
  // document belonging to another tenant, which RLS already made invisible.
  if (/_NOT_FOUND$/.test(code) || code === 'NOT_A_MEMBER') {
    return { status: HttpStatus.NOT_FOUND, body: { error: 'not_found', message: exception.message } };
  }

  if (code === 'INVALID_CREDENTIALS' || code === 'SESSION_INVALID' || code === 'SESSION_REUSED') {
    return {
      status: HttpStatus.UNAUTHORIZED,
      body: { error: 'unauthenticated', message: exception.message },
    };
  }

  if (code === 'ACCOUNT_LOCKED') {
    return {
      status: HttpStatus.TOO_MANY_REQUESTS,
      body: { error: 'account_locked', message: exception.message },
    };
  }

  if (code === 'ACCOUNT_DISABLED' || code === 'CANNOT_GRANT_ROLE') {
    return { status: HttpStatus.FORBIDDEN, body: { error: 'forbidden', message: exception.message } };
  }

  // A year that is already closed, or already open, is a state conflict rather
  // than a malformed request — the caller asked for something reasonable and
  // the world had moved on since they decided to ask.
  if (
    code === 'EMAIL_TAKEN' ||
    code === 'GL_ACCOUNT_IN_USE' ||
    code === 'ALREADY_MATCHED' ||
    code === 'ALREADY_CLOSED' ||
    code === 'NOT_CLOSED'
  ) {
    return { status: HttpStatus.CONFLICT, body: { error: 'conflict', message: exception.message } };
  }

  if (code === 'PERIOD_LOCKED') {
    return {
      status: HttpStatus.CONFLICT,
      body: { error: 'period_locked', message: exception.message },
    };
  }

  // Everything else a service raises deliberately is a client problem: an
  // unbalanced entry, a document that failed validation, a missing posting
  // account, an over-allocation. 422 rather than 400 — the request was
  // well-formed, its content was not acceptable.
  return {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    body: {
      error: 'validation_failed',
      message: exception.message,
      code,
      ...(detail !== undefined ? { detail } : {}),
    },
  };
}

function safeRequestId(request: FastifyRequest): string {
  try {
    return contextOf(request).requestId;
  } catch {
    // The context middleware may not have run — a malformed request rejected
    // before it, for instance. Never let the error handler itself throw.
    return 'unknown';
  }
}
