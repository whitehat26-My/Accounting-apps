import { createHash } from 'node:crypto';
import type { TenantContext, Tx } from './client.js';
import { businessToday } from './internal.js';
import { trialBalanceReport } from './report.js';
import { verifyAuditChain } from './audit.js';

/**
 * The proof pack — books a third party can check without touching this system.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROVES, PRECISELY.
 *
 * The pack contains a trial balance, the tenant's whole ANCHOR CHAIN, and the
 * live chain head. Anchors are hashed into each other, and each anchor pins
 * the audit log's head hash at a moment in time.
 *
 * Give a pack to your accountant in March. In September, hand March's pack
 * back to `verifyProofPack`. Every anchor in it must still match the live
 * chain. If somebody edited an audit row in between and re-chained everything
 * forward — the one attack the hash chain alone cannot survive — the recomputed
 * hashes no longer match the March anchors, and the verification names the
 * exact anchor where history diverged.
 *
 * THE PACK MUST LEAVE THE BUILDING. A pack that only ever existed inside this
 * database proves nothing extra: whoever can rewrite the log can rewrite the
 * anchors beside it. Email it, print it, attach it to the loan application.
 * The copy in someone else's hands is the evidence; this file just makes one.
 *
 * The algorithm is printed INSIDE the pack, so a bank with two packs and no
 * access to anything can compare them with thirty lines of code — see
 * `scripts/verify-proof-pack.mjs`.
 * ---------------------------------------------------------------------------
 */

export class ProofError extends Error {
  constructor(
    readonly code: 'PACK_MALFORMED' | 'PACK_WRONG_TENANT',
    message: string,
  ) {
    super(message);
    this.name = 'ProofError';
  }
}

export interface AnchorView {
  readonly seq: number;
  readonly entryCount: number;
  readonly headId: number | null;
  readonly headHash: string | null;
  readonly prevAnchorHash: string | null;
  readonly anchorHash: string;
  readonly anchoredAt: string;
  readonly reason: string;
}

export interface ProofPack {
  readonly format: 'emil-proof-pack/1';
  readonly algorithm: string;
  readonly organisation: { readonly id: string; readonly name: string };
  readonly issuedAt: string;
  readonly period: { readonly from: string | null; readonly to: string };
  readonly trialBalance: {
    readonly rows: readonly { code: string; name: string; debit: string; credit: string }[];
    readonly totalDebit: string;
    readonly totalCredit: string;
    readonly balanced: boolean;
  };
  readonly chain: {
    readonly intact: boolean;
    readonly entries: number;
    readonly anchors: readonly AnchorView[];
  };
  /** SHA-256 over everything above, canonicalised. Identifies THIS pack. */
  readonly packHash: string;
}

const ALGORITHM =
  'Each anchor hash is SHA-256 over the UTF-8 JSON text ' +
  '{"v":1,"prev":<previous anchor hash hex or "">,"tenant":<uuid>,"seq":<int>,' +
  '"count":<int>,"head":<int>,"hash":<audit head row hash hex or "">,' +
  '"at":<ISO8601 UTC to microseconds>} with keys in that order. ' +
  'packHash is SHA-256 over this document with packHash removed, keys sorted. ' +
  'To compare two packs: every anchor present in both must be identical. ' +
  'Any difference means the history behind them was rewritten.';

/** Take an anchor now. The nightly job and the button both land here. */
export async function takeAnchor(
  tx: Tx,
  ctx: TenantContext,
  reason: 'SCHEDULED' | 'MANUAL' = 'MANUAL',
): Promise<{ seq: number; entryCount: number; anchorHash: string; anchoredAt: string }> {
  const [row] = await tx<
    { seq: number; entry_count: string; anchor_hash: Buffer; anchored_at: Date }[]
  >`
      SELECT * FROM take_audit_anchor(${ctx.tenantId}, ${reason}, ${ctx.userId ?? null})
  `;
  return {
    seq: row!.seq,
    entryCount: Number(row!.entry_count),
    anchorHash: row!.anchor_hash.toString('hex'),
    anchoredAt: row!.anchored_at.toISOString(),
  };
}

export async function listAnchors(tx: Tx, ctx: TenantContext): Promise<AnchorView[]> {
  const rows = await tx<
    {
      seq: number;
      entry_count: string;
      head_id: string | null;
      head_hash: Buffer | null;
      prev_anchor_hash: Buffer | null;
      anchor_hash: Buffer;
      anchored_at: Date;
      reason: string;
    }[]
  >`
      SELECT seq, entry_count, head_id, head_hash, prev_anchor_hash,
             anchor_hash, anchored_at, reason
        FROM audit_anchor
       WHERE tenant_id = ${ctx.tenantId}
       ORDER BY seq
  `;
  return rows.map((r) => ({
    seq: r.seq,
    entryCount: Number(r.entry_count),
    headId: r.head_id === null ? null : Number(r.head_id),
    headHash: r.head_hash === null ? null : r.head_hash.toString('hex'),
    prevAnchorHash: r.prev_anchor_hash === null ? null : r.prev_anchor_hash.toString('hex'),
    anchorHash: r.anchor_hash.toString('hex'),
    anchoredAt: r.anchored_at.toISOString(),
    reason: r.reason,
  }));
}

export async function proofPack(
  tx: Tx,
  ctx: TenantContext,
  window: { from: string | null; to: string },
): Promise<ProofPack> {
  const [org] = await tx<{ name: string }[]>`
      SELECT name FROM organisation WHERE id = ${ctx.tenantId}
  `;
  const balance = await trialBalanceReport(tx, ctx, window);
  const chain = await verifyAuditChain(tx, ctx);
  const anchors = await listAnchors(tx, ctx);

  const body = {
    format: 'emil-proof-pack/1' as const,
    algorithm: ALGORITHM,
    organisation: { id: ctx.tenantId, name: org!.name },
    issuedAt: `${businessToday()}T00:00:00Z`,
    period: window,
    trialBalance: {
      rows: balance.rows.map((r) => ({
        code: r.code,
        name: r.name,
        debit: r.debit,
        credit: r.credit,
      })),
      totalDebit: balance.totalDebit,
      totalCredit: balance.totalCredit,
      balanced: balance.balanced,
    },
    chain: { intact: chain.intact, entries: chain.entries, anchors },
  };

  return { ...body, packHash: hashDocument(body) };
}

export interface PackVerification {
  readonly packHash: { readonly presented: string; readonly recomputed: string; readonly matches: boolean };
  readonly organisationMatches: boolean;
  readonly anchorsChecked: number;
  /** The first anchor in the pack that the live chain no longer agrees with. */
  readonly divergedAt: { readonly seq: number; readonly reason: string } | null;
  readonly liveChainIntact: boolean;
  readonly verdict: 'CONFIRMED' | 'TAMPERED' | 'PACK_ALTERED';
}

/**
 * Check a previously-issued pack against the live chain.
 *
 * Two independent questions, answered separately because they fail
 * differently: was the PACK altered since it was issued (its own hash no
 * longer fits its contents), and has the SYSTEM's history changed under it
 * (an anchor the pack recorded is no longer what the database holds).
 */
export async function verifyProofPack(
  tx: Tx,
  ctx: TenantContext,
  presented: unknown,
): Promise<PackVerification> {
  if (
    presented === null ||
    typeof presented !== 'object' ||
    (presented as { format?: unknown }).format !== 'emil-proof-pack/1'
  ) {
    throw new ProofError('PACK_MALFORMED', 'This is not an Emil proof pack (format/1).');
  }
  const pack = presented as ProofPack;
  if (!Array.isArray(pack.chain?.anchors)) {
    throw new ProofError('PACK_MALFORMED', 'The pack carries no anchor chain.');
  }

  const { packHash: presentedHash, ...body } = pack;
  const recomputed = hashDocument(body);
  const organisationMatches = pack.organisation?.id === ctx.tenantId;

  const live = await listAnchors(tx, ctx);
  const liveBySeq = new Map(live.map((a) => [a.seq, a]));

  /*
   * Each anchor is checked against the LIVE AUDIT LOG, not merely against the
   * stored anchor row.
   *
   * Comparing pack-anchor to stored-anchor would prove nothing: an attacker
   * who rewrites the log does not need to touch the anchors, and both copies
   * would agree while the history beneath them had changed. What pins the
   * history is that an anchor recorded the log's head hash AT A ROW NUMBER —
   * so the question worth asking is whether the log still hashes to that at
   * that row. It cannot, if anything before it was edited and re-chained.
   */
  let divergedAt: PackVerification['divergedAt'] = null;
  for (const anchor of pack.chain.anchors) {
    const stored = liveBySeq.get(anchor.seq);
    if (stored === undefined) {
      divergedAt = {
        seq: anchor.seq,
        reason: `Anchor ${anchor.seq} is in the pack but no longer in the system — anchors are append-only, so it was removed at the database level.`,
      };
      break;
    }
    if (stored.anchorHash !== anchor.anchorHash) {
      divergedAt = {
        seq: anchor.seq,
        reason: `Anchor ${anchor.seq} does not match the one the system holds. The anchor record itself was rewritten.`,
      };
      break;
    }

    if (anchor.headId === null) continue; // an anchor taken on an empty log

    const [row] = await tx<{ row_hash: Buffer }[]>`
        SELECT row_hash FROM audit_log
         WHERE tenant_id = ${ctx.tenantId} AND id = ${anchor.headId}
    `;
    if (row === undefined) {
      divergedAt = {
        seq: anchor.seq,
        reason: `The audit entry anchor ${anchor.seq} pinned (row ${anchor.headId}) is gone. Records were deleted from the log.`,
      };
      break;
    }
    if (row.row_hash.toString('hex') !== anchor.headHash) {
      divergedAt = {
        seq: anchor.seq,
        reason: `The audit log no longer hashes to what anchor ${anchor.seq} recorded at row ${anchor.headId}. History up to that point was rewritten after ${anchor.anchoredAt}.`,
      };
      break;
    }

    const [counted] = await tx<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM audit_log
         WHERE tenant_id = ${ctx.tenantId} AND id <= ${anchor.headId}
    `;
    if (Number(counted!.n) !== anchor.entryCount) {
      divergedAt = {
        seq: anchor.seq,
        reason: `Anchor ${anchor.seq} recorded ${anchor.entryCount} entries up to row ${anchor.headId}; the log now holds ${counted!.n}. Records were added or removed behind it.`,
      };
      break;
    }
  }

  const chain = await verifyAuditChain(tx, ctx);

  const verdict: PackVerification['verdict'] =
    recomputed !== presentedHash || !organisationMatches
      ? 'PACK_ALTERED'
      : divergedAt !== null || !chain.intact
        ? 'TAMPERED'
        : 'CONFIRMED';

  return {
    packHash: { presented: presentedHash, recomputed, matches: recomputed === presentedHash },
    organisationMatches,
    anchorsChecked: pack.chain.anchors.length,
    divergedAt,
    liveChainIntact: chain.intact,
    verdict,
  };
}

/**
 * SHA-256 over the document with keys sorted at every level.
 *
 * Sorted because a third party reimplementing this must get the same bytes
 * without having to know the order this codebase happened to write them in.
 */
function hashDocument(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
