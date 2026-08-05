-- =============================================================================
-- 0045 — Anchoring the audit chain, and the proof pack that leaves the building
--
-- `audit.ts` has carried this admission since 0016:
--
--   "It does NOT defend against an attacker with owner rights who recomputes
--    the whole chain forward from the row they edited. Nothing stored in the
--    same database can... The defence is shipping the daily chain head
--    somewhere append-only and outside this database.
--    ⚠️ That anchor is NOT implemented."
--
-- This is the anchor. And the honest part first, because it governs the whole
-- design:
--
--   AN ANCHOR STORED ONLY IN THIS DATABASE PROVES NOTHING EXTRA.
--
-- An attacker with owner rights who re-chains `audit_log` can re-chain
-- `audit_anchor` in the same afternoon. The anchor becomes proof at the moment
-- a COPY EXISTS SOMEWHERE THEY CANNOT REACH — emailed to the accountant,
-- printed and filed, attached to a loan application, or sitting in the bank's
-- inbox. So the table is only half the feature; the other half is the proof
-- pack (`packages/db/src/proof.ts`), which exports the anchor chain in a form
-- a third party can hold and later hand back for checking.
--
-- The check that gives it teeth: a pack issued in March, fed back in
-- September, must still agree with the live chain. Any retro-edit in between
-- changes the hashes and names the exact anchor where history diverged. That
-- comparison needs no access to this system — two packs and the algorithm
-- printed inside them are enough.
-- =============================================================================

CREATE TABLE audit_anchor (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    /* 1, 2, 3… per tenant. The pack presents them in this order. */
    seq           INTEGER NOT NULL,

    /* Where the chain stood when this anchor was taken. */
    entry_count   BIGINT NOT NULL CHECK (entry_count >= 0),
    head_id       BIGINT,
    head_hash     BYTEA,

    /* The anchors form their OWN chain, so a pack can be checked internally. */
    prev_anchor_hash BYTEA,
    anchor_hash      BYTEA NOT NULL,

    anchored_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* SCHEDULED (the worker, nightly) or MANUAL (someone pressed the button). */
    reason        TEXT NOT NULL DEFAULT 'SCHEDULED'
                  CHECK (reason IN ('SCHEDULED', 'MANUAL')),
    created_by    UUID,

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, seq),
    UNIQUE      (anchor_hash)
);

CREATE INDEX audit_anchor_by_seq ON audit_anchor (tenant_id, seq DESC);

-- ---------------------------------------------------------------------------
-- Append-only, like the log it anchors. An anchor that can be edited is a
-- promise that can be withdrawn.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_audit_anchor_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'Audit anchors are append-only. % on anchor % is refused.', TG_OP, OLD.id
        USING ERRCODE = 'check_violation';
END $$;

CREATE TRIGGER trg_audit_anchor_immutable
    BEFORE UPDATE OR DELETE ON audit_anchor
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_anchor_mutation();

-- ---------------------------------------------------------------------------
-- The anchor's own hash. Same shape as `audit_row_hash` (0016): SHA-256 over a
-- canonical JSON text with the previous hash hex-encoded inside it, so the
-- algorithm a third party must reimplement is one they can read in one sitting.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_anchor_hash(
    p_prev        BYTEA,
    p_tenant      UUID,
    p_seq         INTEGER,
    p_entry_count BIGINT,
    p_head_id     BIGINT,
    p_head_hash   BYTEA,
    p_anchored    TIMESTAMPTZ
) RETURNS BYTEA
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT digest(
        convert_to(
            jsonb_build_object(
                'v',      1,
                'prev',   COALESCE(encode(p_prev, 'hex'), ''),
                'tenant', p_tenant,
                'seq',    p_seq,
                'count',  p_entry_count,
                'head',   p_head_id,
                'hash',   COALESCE(encode(p_head_hash, 'hex'), ''),
                'at',     to_char(p_anchored AT TIME ZONE 'UTC',
                                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            )::text,
            'UTF8'
        ),
        'sha256'
    )
$$;

-- ---------------------------------------------------------------------------
-- Take an anchor. SECURITY DEFINER for the same reason `verify_audit_chain`
-- is: the nightly sweep runs as `emil_worker` with no tenant context set, and
-- an anchor that silently skipped a tenant would be worse than none.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION take_audit_anchor(p_tenant UUID, p_reason TEXT, p_actor UUID)
RETURNS TABLE (seq INTEGER, entry_count BIGINT, anchor_hash BYTEA, anchored_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_prev_hash  BYTEA;
    v_seq        INTEGER;
    v_count      BIGINT;
    v_head_id    BIGINT;
    v_head_hash  BYTEA;
    v_at         TIMESTAMPTZ := now();
    v_hash       BYTEA;
BEGIN
    IF current_tenant_id() IS NOT NULL AND p_tenant <> current_tenant_id() THEN
        RAISE EXCEPTION 'take_audit_anchor: cannot anchor another tenant''s chain'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT a.anchor_hash, a.seq INTO v_prev_hash, v_seq
      FROM audit_anchor a
     WHERE a.tenant_id = p_tenant
     ORDER BY a.seq DESC
     LIMIT 1;

    v_seq := COALESCE(v_seq, 0) + 1;

    SELECT COUNT(*), MAX(l.id) INTO v_count, v_head_id
      FROM audit_log l WHERE l.tenant_id = p_tenant;

    SELECT l.row_hash INTO v_head_hash
      FROM audit_log l WHERE l.tenant_id = p_tenant AND l.id = v_head_id;

    v_hash := audit_anchor_hash(
        v_prev_hash, p_tenant, v_seq, v_count, v_head_id, v_head_hash, v_at
    );

    INSERT INTO audit_anchor (
        tenant_id, seq, entry_count, head_id, head_hash,
        prev_anchor_hash, anchor_hash, anchored_at, reason, created_by
    ) VALUES (
        p_tenant, v_seq, v_count, v_head_id, v_head_hash,
        v_prev_hash, v_hash, v_at, COALESCE(p_reason, 'SCHEDULED'), p_actor
    );

    RETURN QUERY SELECT v_seq, v_count, v_hash, v_at;
END $$;

-- ---------------------------------------------------------------------------
-- RLS: read-your-own. No policy for UPDATE/DELETE is needed — the trigger
-- refuses both regardless of who asks.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_anchor ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_anchor FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_anchor
    USING      (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT ON audit_anchor TO emil_app;

REVOKE ALL ON FUNCTION take_audit_anchor(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION take_audit_anchor(UUID, TEXT, UUID) TO emil_app;
GRANT EXECUTE ON FUNCTION take_audit_anchor(UUID, TEXT, UUID) TO emil_worker;
GRANT EXECUTE ON FUNCTION audit_anchor_hash(BYTEA, UUID, INTEGER, BIGINT, BIGINT, BYTEA, TIMESTAMPTZ)
    TO emil_app, emil_worker;

-- ---------------------------------------------------------------------------
-- The nightly schedule. Daily, so the window in which a rewrite could hide
-- unwitnessed is one day rather than however long since somebody last thought
-- about it.
-- ---------------------------------------------------------------------------
INSERT INTO scheduled_job (name, description, interval_seconds) VALUES
    ('audit-anchor',
     'Pin every tenant''s audit chain: record the entry count and head hash, '
     || 'chained into the previous anchor. Exported in the proof pack, which '
     || 'is what makes a later rewrite detectable by someone outside.',
     86400);

-- Deliberately NOT audit-triggered: an append-only table whose rows are
-- themselves the audit evidence would recurse, and every insert here is
-- already visible as an anchor.
