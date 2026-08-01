import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ValidationError } from '../errors.js';

/**
 * Require an `Idempotency-Key` on every write.
 *
 * ---------------------------------------------------------------------------
 * THIS DOES NOT CACHE RESPONSES, AND THAT IS THE DESIGN, NOT A GAP.
 *
 * The architecture sketch (§1.3) shows an idempotency lookup in Redis that
 * replays a stored response. Building that here would be the wrong layer, and
 * actively worse than what already exists:
 *
 * Every financial write path in `packages/db` is ALREADY idempotent, in the
 * database, on the same key — `invoice`, `bill`, `payment`, `credit_note`,
 * `bank_statement` and `revaluation_run` each carry a
 * `UNIQUE (tenant_id, idempotency_key)`, and each service returns
 * `replayed: true` when it finds one. The guarantee is a constraint inside the
 * same transaction as the write.
 *
 * A response cache in front of that adds a second, weaker source of truth. When
 * the cache and the database disagree — Redis restarted, an entry expired, a
 * write committed after the cache write failed — the cache wins and returns a
 * stale answer for a financial operation. A cache is only load-bearing when the
 * write underneath it is NOT idempotent, and here it is.
 *
 * So this interceptor does the part the database cannot: insists the header is
 * present, so a client that would otherwise retry blindly is forced to supply
 * the key that makes the retry safe. The replay itself is answered by the
 * constraint, and `replayed` is surfaced in the response body.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private static readonly MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  intercept(execution: ExecutionContext, next: CallHandler) {
    const request = execution.switchToHttp().getRequest<FastifyRequest>();

    if (!IdempotencyInterceptor.MUTATING.has(request.method)) {
      return next.handle();
    }

    const raw = request.headers['idempotency-key'];
    const key = Array.isArray(raw) ? raw[0] : raw;

    if (key === undefined || key.trim().length === 0) {
      throw new ValidationError(
        'An Idempotency-Key header is required on every write. Generate one per ' +
          'logical operation and reuse it when retrying, so a retry cannot post twice.',
      );
    }

    if (key.length > 255) {
      throw new ValidationError('Idempotency-Key must be at most 255 characters');
    }

    return next.handle();
  }
}
