/*
 * Receipts that prove themselves.
 *
 * A fingerprint is the SHA-256 of an invoice's or receipt's canonical DATA —
 * the same figures the PDF is typeset from. Printed on the document as a QR
 * code, it lets anybody holding the paper ask this system whether the document
 * is genuine, years later, without an account and without being told anything
 * else about the shop.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATA AND NOT THE PDF BYTES.
 *
 * The PDF is regenerated on every request (documents.controller.ts) and is not
 * byte-stable: a pdfkit upgrade, a font metric change, or the compression flag
 * would all produce different bytes for the same invoice. Hashing the bytes
 * would therefore invalidate every document ever issued, on a dependency bump.
 * The FIGURES — invoice number, dates, customer, lines, totals — are frozen at
 * issue and cannot change without a credit note, which is a new document with
 * its own fingerprint. So the data is what a promise can be made about.
 * ---------------------------------------------------------------------------
 */

CREATE TABLE document_fingerprint (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    document_type TEXT NOT NULL CHECK (document_type IN ('INVOICE', 'RECEIPT')),
    document_id   UUID NOT NULL,
    /* SHA-256 of the canonical document JSON. */
    digest        BYTEA NOT NULL CHECK (octet_length(digest) = 32),
    /* The document's own date, so verification can answer "issued when"
       without reading the document row and leaking anything else. */
    issued_on     DATE NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, document_type, document_id)
);

/*
 * Globally unique, across tenants. Two shops cannot produce the same digest
 * without producing byte-identical documents, and if they somehow did, the
 * verification lookup below must not have to choose between them.
 */
CREATE UNIQUE INDEX document_fingerprint_digest_unique ON document_fingerprint (digest);

ALTER TABLE document_fingerprint ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_fingerprint FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON document_fingerprint
    USING      (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON document_fingerprint TO emil_app;

/*
 * Verification, for somebody with no account and no tenant.
 *
 * SECURITY DEFINER because every RLS policy denies without `app.tenant_id`,
 * and a member of the public has none — the same shape as
 * `find_payment_link_by_digest` (0014).
 *
 * It returns the MINIMUM: what kind of document it is and when it was issued.
 * Not the tenant, not the customer, not the amount, not the document number.
 * Somebody holding the paper can already read all of that off it; somebody
 * NOT holding it learns only that a 256-bit number they already knew exists.
 * The digest is the capability, and a 256-bit space is not enumerable.
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
$$;

REVOKE ALL ON FUNCTION verify_document_digest(BYTEA) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_document_digest(BYTEA) TO emil_app;

/*
 * Deliberately NO audit trigger on this table, and the audit-coverage sweep in
 * packages/db/test/audit.test.ts carries a matching exemption.
 *
 * A fingerprint is a hash of a document the audit log already records the
 * creation of. Auditing it would store the hash of a hash, doubling the log's
 * volume to record a value that is a pure function of a row already in it. The
 * table is also insert-only for `emil_app` — no UPDATE, no DELETE granted — so
 * there is no mutation for a trigger to catch.
 */
