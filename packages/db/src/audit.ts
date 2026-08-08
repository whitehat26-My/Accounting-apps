/**
 * AuditService — reading the trail, and proving it has not been edited.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO WRITE FUNCTION HERE, DELIBERATELY.
 *
 * Audit rows are written by a database trigger on every audited table
 * (migration 0016), not by application code. An `writeAudit()` helper in this
 * file would be a second way to produce audit rows — one that a caller can
 * forget, and one that can claim something the row it describes did not do.
 *
 * The trigger cannot be forgotten and cannot lie about what changed, because it
 * reads `OLD` and `NEW` rather than being told. So this module reads.
 * ---------------------------------------------------------------------------
 */

import type { TenantContext, Tx } from './client.js';

export class AuditError extends Error {
  constructor(
    readonly code: 'AUDIT_CHAIN_BROKEN',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AuditError';
  }
}

export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly actorIp: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly occurredAt: string;
  /** Only the fields that actually changed, on an UPDATE. */
  readonly changed: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
}

export interface AuditQuery {
  readonly entityType?: string;
  readonly entityId?: string;
  readonly actorUserId?: string;
  readonly action?: string;
  /** Inclusive ISO date bounds on `occurred_at`. */
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  /** Keyset cursor: return rows with a lower id than this. */
  readonly before?: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Read the trail, newest first.
 *
 * Paged by keyset on `id` rather than OFFSET. The log only grows, and at the
 * far end of a seven-year retention an OFFSET scan reads and discards every
 * row it skips. Keyset paging over the primary key stays flat.
 */
export async function auditTrail(
  tx: Tx,
  ctx: TenantContext,
  query: AuditQuery = {},
): Promise<AuditEntry[]> {
  const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const rows = await tx<
    {
      id: string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      actor_user_id: string | null;
      actor_email: string | null;
      actor_ip: string | null;
      user_agent: string | null;
      request_id: string | null;
      occurred_at: Date;
      before_json: unknown;
      after_json: unknown;
    }[]
  >`
      SELECT a.id::text, a.action, a.entity_type, a.entity_id::text,
             a.actor_user_id::text, act.email AS actor_email,
             host(a.actor_ip) AS actor_ip, a.user_agent, a.request_id,
             a.occurred_at, a.before_json, a.after_json
        FROM audit_log a
        -- Through a SECURITY DEFINER function, because app_user is global and
        -- the application role has no grant on it. LEFT, and it stays LEFT: an
        -- actor who has since left the organisation must not make their own
        -- audit rows vanish from the trail — that is the opposite of the point.
        LEFT JOIN LATERAL audit_actor(a.actor_user_id) act ON TRUE
       WHERE a.tenant_id = ${ctx.tenantId}
         AND (${query.entityType ?? null}::text  IS NULL OR a.entity_type   = ${query.entityType ?? null})
         AND (${query.entityId ?? null}::uuid    IS NULL OR a.entity_id     = ${query.entityId ?? null})
         AND (${query.actorUserId ?? null}::uuid IS NULL OR a.actor_user_id = ${query.actorUserId ?? null})
         AND (${query.action ?? null}::text      IS NULL OR a.action        = ${query.action ?? null})
         AND (${query.from ?? null}::date        IS NULL OR a.occurred_at  >= ${query.from ?? null}::date)
         AND (${query.to ?? null}::date          IS NULL OR a.occurred_at   < (${query.to ?? null}::date + 1))
         AND (${query.before ?? null}::bigint    IS NULL OR a.id            < ${query.before ?? null}::bigint)
       ORDER BY a.id DESC
       LIMIT ${limit}
  `;

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    actorIp: row.actor_ip,
    userAgent: row.user_agent,
    requestId: row.request_id,
    occurredAt: row.occurred_at.toISOString(),
    changed: changedFields(row.before_json, row.after_json),
    before: row.before_json,
    after: row.after_json,
  }));
}

/**
 * Which fields an UPDATE actually changed.
 *
 * Computed on read rather than stored. A user looking at "someone edited this
 * invoice" wants the two fields that moved, not a diff of forty columns they
 * have to scan — and the row already holds both images, so storing a third
 * copy of the answer would just be a copy that can disagree with them.
 */
function changedFields(before: unknown, after: unknown): string[] {
  if (before === null || after === null) return [];
  if (typeof before !== 'object' || typeof after !== 'object') return [];

  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;

  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .sort();
}

export interface ChainBreak {
  readonly brokenAt: string;
  readonly reason: 'CONTENT_ALTERED' | 'CHAIN_BROKEN';
}

export interface ChainVerification {
  readonly intact: boolean;
  readonly entries: number;
  readonly breaks: readonly ChainBreak[];
}

/**
 * Verify the tenant's hash chain.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ACTUALLY PROVES, AND WHAT IT DOES NOT.
 *
 * It proves nobody edited, deleted or spliced a row using ordinary database
 * access — which is the realistic threat, because `audit_log` has UPDATE and
 * DELETE revoked from the application role and blocked by trigger, so reaching
 * it at all means someone had owner rights and used them deliberately.
 *
 * It does NOT defend against an attacker with owner rights who recomputes the
 * whole chain forward from the row they edited. Nothing stored in the same
 * database can: the hash function is right there. The defence against that is
 * shipping the daily chain head somewhere append-only and outside this database
 * — 04-security-compliance.md:90 specifies S3 Object Lock — so a rewritten
 * chain no longer matches an anchor the attacker cannot reach.
 *
 * THE ANCHOR NOW EXISTS — see `proof.ts` and migration 0045. A nightly job
 * pins the chain (entry count + head hash) into `audit_anchor`, and the proof
 * pack EXPORTS those anchors so a copy lives with the accountant, the bank, or
 * whoever was given one. A re-chained log no longer agrees with a pack issued
 * before the rewrite, and `verifyProofPack` names the anchor where the two
 * histories part company — `proof.test.ts` performs the full owner-rights
 * attack and watches it caught.
 *
 * ⚠️ Still true, and worth restating: an anchor that never LEAVES this
 * database adds nothing. Whoever can rewrite the log can rewrite the anchors
 * beside it. The evidence is the exported copy, not the table.
 * ---------------------------------------------------------------------------
 */
export async function verifyAuditChain(
  tx: Tx,
  ctx: TenantContext,
): Promise<ChainVerification> {
  const breaks = await tx<{ broken_at: string; reason: string }[]>`
      SELECT broken_at::text, reason FROM verify_audit_chain(${ctx.tenantId})
  `;

  const [counted] = await tx<{ entries: string }[]>`
      SELECT count(*)::text AS entries FROM audit_log WHERE tenant_id = ${ctx.tenantId}
  `;

  return {
    intact: breaks.length === 0,
    entries: Number(counted!.entries),
    breaks: breaks.map((b) => ({
      brokenAt: b.broken_at,
      reason: b.reason as ChainBreak['reason'],
    })),
  };
}

/** Everything recorded about one entity, oldest first — its life story. */
export async function entityHistory(
  tx: Tx,
  ctx: TenantContext,
  entityType: string,
  entityId: string,
): Promise<AuditEntry[]> {
  const entries = await auditTrail(tx, ctx, { entityType, entityId, limit: MAX_LIMIT });
  return [...entries].reverse();
}
