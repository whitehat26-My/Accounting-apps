/*
 * Evidence on a repair job: what came in with the device, and who signed.
 *
 * ---------------------------------------------------------------------------
 * A SIGNATURE IS STORED AS A PHOTOGRAPH, DELIBERATELY.
 *
 * `repair_job_photo` already solves every problem a signature has: a SHA-256
 * digest recorded in the audit log, the bytes in a separate un-audited table
 * so replacing them is DETECTABLE, a size ceiling, and a `stage` saying when
 * in the job's life it was captured. Building a second pair of tables for an
 * image that needs exactly those properties would be duplication with a worse
 * integrity story.
 *
 * So a signature is a row with `kind = 'SIGNATURE'`, and `stage` says which
 * signature it is: RECEIVED is the customer accepting the condition recorded
 * at intake, COLLECTED is them accepting the device back.
 * ---------------------------------------------------------------------------
 */

ALTER TABLE repair_job_photo
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'PHOTO'
    CONSTRAINT repair_job_photo_kind CHECK (kind IN ('PHOTO', 'SIGNATURE'));

COMMENT ON COLUMN repair_job_photo.kind IS
    'PHOTO is the device; SIGNATURE is the customer signing. Same integrity '
    'machinery for both — see 0048.';

/*
 * What came in WITH the device.
 *
 * "I gave you the charger" is the second most common repair dispute after
 * "that scratch was not there", and unlike the scratch a photograph of the
 * laptop does not answer it. A list ticked at the counter and printed on the
 * slip the customer takes away does.
 *
 * A TEXT[] rather than its own table: this is a checklist on one document, it
 * is never queried across jobs, and it never needs a foreign key. A table
 * here would be normalisation for its own sake.
 */
ALTER TABLE repair_job
    ADD COLUMN accessories TEXT[] NOT NULL DEFAULT '{}'
    CONSTRAINT repair_job_accessories_sane CHECK (
        array_length(accessories, 1) IS NULL OR array_length(accessories, 1) <= 20
    );

COMMENT ON COLUMN repair_job.accessories IS
    'Charger, bag, SIM, SD card … ticked at intake and printed on the customer''s slip.';

-- The finished repair report joins the documents a customer can verify.
ALTER TABLE document_fingerprint
    DROP CONSTRAINT document_fingerprint_document_type_check;

ALTER TABLE document_fingerprint
    ADD CONSTRAINT document_fingerprint_document_type_check
    CHECK (document_type IN ('INVOICE', 'RECEIPT', 'REPAIR_JOB'));

/*
 * Verification now answers for a repair PHOTOGRAPH as well as a document.
 *
 * The photo's digest is already computed and stored — this simply lets the
 * public verify route match it. Scanning or typing the digest printed beside
 * a picture on a repair report answers "yes, that photograph was taken on
 * 28/07/2026 and has not been substituted since", which is the whole point of
 * photographing the device in the first place.
 *
 * `repair_job_photo.digest` is hex TEXT while `document_fingerprint.digest` is
 * BYTEA, so the photo side is decoded rather than the document side encoded:
 * comparing on the BYTEA keeps the document lookup on its unique index.
 */
CREATE OR REPLACE FUNCTION verify_document_digest(p_digest BYTEA)
RETURNS TABLE (document_type TEXT, issued_on DATE)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT f.document_type, f.issued_on
      FROM document_fingerprint f
     WHERE f.digest = p_digest
    UNION ALL
    SELECT 'REPAIR_PHOTO', p.created_at::date
      FROM repair_job_photo p
     WHERE decode(p.digest, 'hex') = p_digest
$$;

REVOKE ALL ON FUNCTION verify_document_digest(BYTEA) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_document_digest(BYTEA) TO emil_app;
