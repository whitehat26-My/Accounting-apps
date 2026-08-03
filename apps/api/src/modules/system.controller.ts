import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { queueHealth, scheduledJobs, withTenant, type Sql } from '@emil/db';
import { SQL } from '../tokens.js';
import { Requires } from '../guards/decorators.js';
import { tenantContextOf } from '../context/request-context.js';

/**
 * Background work, made visible.
 *
 * ---------------------------------------------------------------------------
 * A QUEUE NOBODY CAN SEE IS A QUEUE NOBODY FIXES.
 *
 * The outbox was written to by eight modules and read by nothing for the whole
 * of M1 through M9, and the reason that survived so long is that there was
 * nowhere to look. No count, no route, no dashboard — just a table quietly
 * filling with PENDING rows while every other part of the system reported
 * healthy.
 *
 * So the relay ships with the thing that would have caught it. The answer a
 * user actually needs is small and specific: did my invoice reach the
 * e-Invoice queue, and if not, why not.
 * ---------------------------------------------------------------------------
 */
@Controller('v1/system')
export class SystemController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  /**
   * Outbox health for THIS tenant, plus the global job schedule.
   *
   * The two halves have different scopes on purpose. Outbox counts and dead
   * letters are tenant data, read through RLS like anything else — a user is
   * entitled to know their own invoice never got queued, and to no more than
   * that. The job schedule is names and timings with no tenant data in it, and
   * is the same for everybody.
   */
  @Requires('system.read')
  @Get('queues')
  async queues(@Req() request: FastifyRequest) {
    const ctx = tenantContextOf(request);

    const [health, jobs] = await withTenant(this.sql, ctx, async (tx) => [
      await queueHealth(tx, ctx),
      await scheduledJobs(tx),
    ]);

    return {
      outbox: health.outbox,
      deadLettered: health.deadLettered,
      scheduledJobs: jobs,
      /*
       * The judgement, computed here rather than left to the reader.
       *
       * "Is this healthy" is the actual question, and a response that returns
       * six numbers and no verdict gets glanced at and forgotten — which is
       * how a queue accumulates failures for a month. Stalled work and dead
       * letters are the two signals worth waking somebody for; a large
       * `pending` on its own is a busy afternoon.
       */
      healthy:
        health.outbox.failed === 0 &&
        health.outbox.stalledOverAnHour === 0 &&
        jobs.every((j) => !j.isEnabled || j.lastStatus !== 'ERROR'),
    };
  }
}
