/*
 * The warranty card becomes a verifiable document.
 *
 * ---------------------------------------------------------------------------
 * KEYED ON THE UNIT, NOT ON THE INVOICE.
 *
 * A promise belongs to one physical thing. Two laptops on one invoice are two
 * promises with two expiry dates the moment one is returned and replaced, and
 * a card keyed on the invoice could not tell them apart. `stock_unit.id` is
 * the identity of the thing the shop actually owes on.
 *
 * The promise itself is still DERIVED and still stored nowhere (see
 * `warranty.ts`) — this only records the digest of a card that was printed,
 * so somebody holding the paper can check it. If the underlying facts change,
 * the digest stops matching, which is the correct outcome: a card for a unit
 * that has since been returned should NOT verify.
 * ---------------------------------------------------------------------------
 */

ALTER TABLE document_fingerprint
    DROP CONSTRAINT document_fingerprint_document_type_check;

ALTER TABLE document_fingerprint
    ADD CONSTRAINT document_fingerprint_document_type_check
    CHECK (document_type IN ('INVOICE', 'RECEIPT', 'REPAIR_JOB', 'WARRANTY'));
