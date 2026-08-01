import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  auditTrail,
  entityHistory,
  verifyAuditChain,
  withTenant,
  type Sql,
} from '@emil/db';
import { SQL } from '../tokens.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';
import { parse } from '../validation.js';

/**
 * Reading the audit trail.
 *
 * ---------------------------------------------------------------------------
 * A LOG NOBODY CAN READ IS NOT AN AUDIT LOG.
 *
 * `audit_log` has existed since migration 0001 with no permission, no service
 * function and no route — so the one thing it is for, someone asking "who
 * changed this, and when", was impossible to do. That is the other half of the
 * gap this milestone closes; writing rows nobody can see would have been the
 * same feature in a more expensive form.
 * ---------------------------------------------------------------------------
 */
@Controller('v1')
export class AuditController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Requires('audit.read')
  @Get('audit')
  async trail(@Query() query: unknown, @Req() request: FastifyRequest) {
    const filter = parse(auditQuerySchema, query ?? {});
    const ctx = tenantContextOf(request);

    const entries = await withTenant(this.sql, ctx, (tx) => auditTrail(tx, ctx, filter));

    return {
      entries,
      // Keyset cursor. The caller passes it back as `before` — no OFFSET, so
      // page 900 of a seven-year log costs what page 1 costs.
      nextCursor: entries.length > 0 ? entries[entries.length - 1]!.id : null,
    };
  }

  /** Everything ever recorded about one record, oldest first. */
  @Requires('audit.read')
  @Get('audit/:entityType/:entityId')
  async history(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Req() request: FastifyRequest,
  ) {
    const ctx = tenantContextOf(request);
    parse(z.object({ entityId: z.string().uuid() }), { entityId });

    return {
      entityType,
      entityId,
      history: await withTenant(this.sql, ctx, (tx) =>
        entityHistory(tx, ctx, entityType, entityId),
      ),
    };
  }

  /**
   * Verify the tenant's hash chain.
   *
   * Answers 200 with `intact: false` rather than an error status when the chain
   * is broken. A broken chain is a successful answer to the question asked —
   * and an HTTP error would be indistinguishable from the endpoint being down,
   * which is the one thing a monitor must not confuse it with.
   */
  @Requires('audit.read')
  @Get('audit-chain/verify')
  async verify(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);
    return withTenant(this.sql, ctx, (tx) => verifyAuditChain(tx, ctx));
  }
}

const auditQuerySchema = z.object({
  entityType: z.string().min(1).max(63).optional(),
  entityId: z.string().uuid().optional(),
  actorUserId: z.string().uuid().optional(),
  action: z.enum(['CREATE', 'UPDATE', 'DELETE']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD').optional(),
  before: z.string().regex(/^\d+$/, 'Cursor must be an audit row id').optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
