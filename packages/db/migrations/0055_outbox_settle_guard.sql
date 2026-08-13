-- ============================================================================
-- 0055 — the outbox settle path: guard it the way the success path is guarded
--
-- `complete_outbox_event` has always ended with `AND status = 'PENDING'` and
-- returned false when it lost the race. `fail_outbox_event` never did, and the
-- asymmetry is a bug rather than a decision.
--
-- THE INTERLEAVING. Redelivery after a lease expiry is normal and documented:
--
--   1. Worker A claims event E; `attempts` becomes 8.
--   2. A's handler outlives the 300-second lease — a push against a socket
--      that never answers, and `CloudTarget.push` sets no timeout.
--   3. The lease expires. Worker B claims E, `attempts` becomes 9, B's handler
--      SUCCEEDS, and `complete_outbox_event` marks the row DISPATCHED.
--   4. A's push finally rejects. A calls `fail_outbox_event`, which reads
--      `attempts` = 9, sees 9 >= 8, and overwrites the DISPATCHED row to
--      FAILED with A's error text.
--
-- Work that completed is then recorded as a dead letter: `queueHealth` counts
-- it, the outbox-sweep job reports the queue as not draining, and an operator
-- who resets the row re-runs something that already happened. The tell is a
-- row with `status = 'FAILED'` AND `dispatched_at IS NOT NULL`, which no other
-- path can produce. The retry branch had the same hole with a milder effect —
-- stamping `last_error` and pushing `available_at` on a settled row.
--
-- Both UPDATEs now carry the status predicate, and a lost race returns
-- 'SETTLED' rather than lying about what it did.
--
-- THE BACKOFF ALSO OVERFLOWED. `least(power(2, v_attempts)::INTEGER, 3600)`
-- casts BEFORE the cap, so the cap never protected it: at `attempts` = 31 the
-- expression is 2^31 = 2,147,483,648, one past int4, and PostgreSQL raises
-- `integer out of range`. `WORKER_MAX_ATTEMPTS` is validated in `[1, 50]`, so
-- any value of 32 or more reaches it — and then the failure to record the
-- failure means the event is never dead-lettered, stays PENDING, and is
-- reclaimed forever. The exponent is clamped before it is raised.
-- ============================================================================

CREATE OR REPLACE FUNCTION fail_outbox_event(
    p_tenant_id    UUID,
    p_id           UUID,
    p_error        TEXT,
    p_max_attempts INTEGER DEFAULT 8
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_attempts SMALLINT;
    v_status   TEXT;
    v_delay    INTEGER;
    v_updated  INTEGER;
BEGIN
    SELECT attempts, status INTO v_attempts, v_status
      FROM outbox_event
     WHERE tenant_id = p_tenant_id AND id = p_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN 'UNKNOWN';
    END IF;

    -- Somebody else finished this event, or an operator dead-lettered it by
    -- hand, while this worker was still trying. Their outcome stands.
    IF v_status <> 'PENDING' THEN
        RETURN 'SETTLED';
    END IF;

    IF v_attempts >= p_max_attempts THEN
        -- Dead-lettered. Never deleted: an event that could not be dispatched
        -- is the evidence for why something downstream never happened, and
        -- `GET /v1/system/queues` is where somebody finds it.
        UPDATE outbox_event
           SET status = 'FAILED', last_error = left(p_error, 2000)
         WHERE tenant_id = p_tenant_id AND id = p_id AND status = 'PENDING';

        GET DIAGNOSTICS v_updated = ROW_COUNT;
        RETURN CASE WHEN v_updated = 1 THEN 'FAILED' ELSE 'SETTLED' END;
    END IF;

    -- 2^attempts seconds, capped at an hour. Jittered by up to 10% so a
    -- provider outage that fails a thousand events at once does not produce a
    -- thundering herd retrying in lockstep.
    --
    -- The exponent is clamped at 12 (4,096 s, already past the hour cap)
    -- because the CAST is what overflows, and it happens before `least` can
    -- help. Clamping the exponent rather than widening the type keeps the
    -- arithmetic in int4 and makes the ceiling impossible to reach by
    -- configuration.
    v_delay := least(power(2, least(v_attempts, 12))::INTEGER, 3600);

    UPDATE outbox_event
       SET available_at = now() + make_interval(
               secs => v_delay + (v_delay * 0.1 * random())
           ),
           last_error   = left(p_error, 2000)
     WHERE tenant_id = p_tenant_id AND id = p_id AND status = 'PENDING';

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN CASE WHEN v_updated = 1 THEN 'RETRY' ELSE 'SETTLED' END;
END $$;

REVOKE ALL ON FUNCTION fail_outbox_event(UUID, UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fail_outbox_event(UUID, UUID, TEXT, INTEGER) TO emil_worker;
