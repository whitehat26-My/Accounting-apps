-- =============================================================================
-- 0035 — Photographs on a repair job
--
-- The evidence that settles "that crack was already there when I brought it
-- in". A workshop takes a customer's machine apart and gives it back days
-- later; without a record of its condition on arrival, every dispute is one
-- person's word against another's.
--
-- -----------------------------------------------------------------------------
-- THE BYTES LIVE IN POSTGRESQL, NOT ON DISK, AND THAT IS DELIBERATE.
--
-- The received wisdom is that binary belongs in object storage. That advice is
-- about scale this shop will not reach for a decade, and it is wrong HERE for
-- one decisive reason: the nightly backup is a `pg_dump`. A folder of files
-- beside the database is a folder that no backup covers — and it would be
-- discovered the day a disk fails, which is the worst possible day to discover
-- it. In the database the photographs are backed up by the same command, on the
-- same schedule, restored by the same procedure, and isolated by the same RLS
-- policy as every other tenant row. Nothing new has to be remembered.
--
-- The volume this trades against is small: a shop taking in ten jobs a week
-- with four photographs each, downscaled in the browser to roughly 250 KB,
-- accumulates about half a gigabyte a year. When that stops being true, the
-- data column moves to object storage and the metadata table below does not
-- change — which is the reason for splitting them.
-- -----------------------------------------------------------------------------
-- =============================================================================

-- -----------------------------------------------------------------------------
-- What the photograph IS. Audited.
-- -----------------------------------------------------------------------------
CREATE TABLE repair_job_photo (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    repair_job_id UUID NOT NULL,

    /* WHEN in the job's life this was taken. The intake photographs are the
       ones that matter in a dispute, so the stage is recorded rather than
       inferred from a timestamp — a photograph added late but labelled
       RECEIVED is visible as exactly that in the audit trail. */
    stage         TEXT NOT NULL
                  CHECK (stage IN ('RECEIVED','DIAGNOSIS','IN_PROGRESS','READY','COLLECTED')),

    /* "Dent on lid, top left" — what a photograph cannot say for itself. */
    caption       TEXT,

    content_type  TEXT NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),

    /* Two megabytes is the ceiling AFTER the browser has downscaled. A modern
       phone photograph is four to six megabytes straight off the sensor; the
       web app resizes before upload, so anything arriving near this limit did
       not come from that path and is worth rejecting. */
    byte_size     INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
    width         INTEGER CHECK (width  > 0),
    height        INTEGER CHECK (height > 0),

    /* SHA-256 of the bytes, hex. This is what makes splitting the table safe:
       the audit log records the digest, so replacing the image in the un-audited
       data table below is DETECTABLE — the stored bytes would no longer hash to
       the digest the audit trail recorded when the photograph was added. */
    digest        TEXT NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),

    taken_by      UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, repair_job_id)
        REFERENCES repair_job (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX repair_job_photo_job_idx
    ON repair_job_photo (tenant_id, repair_job_id, created_at);

-- -----------------------------------------------------------------------------
-- The bytes themselves. NOT audited — see the exemption in audit.test.ts.
--
-- Separate from the metadata because `audit_row_change` serialises the whole
-- row with `to_jsonb(NEW)`, and a bytea rendered into JSONB is a hex string
-- twice the size of the image. Attaching the audit trigger here would store
-- every photograph twice, the second copy in the append-only log that can never
-- be pruned. The metadata row carries the digest instead, which is the part
-- worth an immutable record.
-- -----------------------------------------------------------------------------
CREATE TABLE repair_job_photo_data (
    tenant_id UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    photo_id  UUID NOT NULL,
    image     BYTEA NOT NULL,

    PRIMARY KEY (tenant_id, photo_id),
    FOREIGN KEY (tenant_id, photo_id)
        REFERENCES repair_job_photo (tenant_id, id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- RLS + audit (rule 3, 0016)
--
-- Both tables get RLS; only the metadata gets the audit trigger, for the reason
-- above. `repair_job_photo_data` is listed in AUDIT_EXEMPT with that reason.
-- -----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['repair_job_photo', 'repair_job_photo_data'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                 USING      (tenant_id = current_tenant_id())
                 WITH CHECK (tenant_id = current_tenant_id())', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO emil_app', t);
    END LOOP;

    EXECUTE format(
        'CREATE TRIGGER trg_audit_%1$s
             AFTER INSERT OR UPDATE OR DELETE ON %1$I
             FOR EACH ROW EXECUTE FUNCTION audit_row_change(%2$L)',
        'repair_job_photo', 'tenant_id');
END $$;
