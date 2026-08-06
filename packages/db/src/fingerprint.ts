import type { Sql, TenantContext, Tx } from './client.js';
import { invoiceDocumentData, receiptDocumentData } from './document-data.js';
import { repairDocumentData, warrantyCardForUnit } from './repair-document.js';
import { hashDocument } from './proof.js';

/**
 * A document that can prove it is genuine, to somebody with no account.
 *
 * ---------------------------------------------------------------------------
 * THE CLAIM ON THE PAPER, AND EXACTLY WHAT BACKS IT.
 *
 * The QR on an invoice encodes a verification URL carrying the SHA-256 of that
 * invoice's canonical figures. Anyone can scan it and be told "yes, this shop
 * issued a document with exactly these figures, on this date". Change one
 * amount in a photocopier or a PDF editor and the digest no longer matches
 * anything: the check fails.
 *
 * What it does NOT claim, and the UI says so: it is not a signature. It proves
 * the document matches a record in THIS system. A shop that never issued the
 * document cannot be framed by it, and a document altered after issue is
 * caught — but the system attesting is the same one that issued, so the honest
 * description is "the shop's own records agree", which is what an audit trail
 * is for and what §5.22 says.
 * ---------------------------------------------------------------------------
 */

export type DocumentType = 'INVOICE' | 'RECEIPT' | 'REPAIR_JOB' | 'WARRANTY';

/**
 * What `verify_document_digest` can answer for.
 *
 * Wider than `DocumentType` because migration 0048 also matches a repair
 * PHOTOGRAPH's digest — the photo is not a document and is never fingerprinted
 * here, but the digest printed beside it on a report is checkable, which is
 * the whole reason for photographing the device.
 */
export type VerifiableType = DocumentType | 'REPAIR_PHOTO';

export interface Fingerprint {
  readonly documentType: DocumentType;
  readonly documentId: string;
  readonly digest: string;
  readonly issuedOn: string;
}

/**
 * Compute and store the fingerprint for a document, idempotently.
 *
 * Called lazily when a PDF is rendered rather than at issue, which means
 * every document already in the system gains its QR the next time it is
 * printed — no backfill migration, and nothing to run before this is useful.
 * The digest is a pure function of the frozen figures, so computing it late
 * gives the same answer as computing it early.
 */
export async function fingerprintDocument(
  tx: Tx,
  ctx: TenantContext,
  documentType: DocumentType,
  documentId: string,
): Promise<Fingerprint> {
  const { digest, issuedOn } =
    documentType === 'INVOICE'
      ? await invoiceFingerprint(tx, ctx, documentId)
      : documentType === 'RECEIPT'
        ? await receiptFingerprint(tx, ctx, documentId)
        : documentType === 'REPAIR_JOB'
          ? await repairFingerprint(tx, ctx, documentId)
          : await warrantyFingerprint(tx, ctx, documentId);

  /*
   * ON CONFLICT DO NOTHING, then read back. Re-rendering the same invoice
   * must not write a second row, and two concurrent renders must not race —
   * the unique key on (tenant, type, id) settles it in the database rather
   * than in a check-then-insert here.
   */
  await tx`
      INSERT INTO document_fingerprint (tenant_id, document_type, document_id, digest, issued_on)
      VALUES (${ctx.tenantId}, ${documentType}, ${documentId}, decode(${digest}, 'hex'), ${issuedOn})
      ON CONFLICT (tenant_id, document_type, document_id) DO NOTHING
  `;

  return { documentType, documentId, digest, issuedOn };
}

async function invoiceFingerprint(tx: Tx, ctx: TenantContext, id: string) {
  const document = await invoiceDocumentData(tx, ctx, id);
  /*
   * `status` and `amountDue` are deliberately EXCLUDED from the hash: both
   * move as the invoice is paid, and a receipt handed over at issue must
   * still verify after the customer settles it. Everything hashed here is
   * frozen at issue — a change to any of it requires a credit note, which is
   * its own document with its own fingerprint.
   */
  const { status, amountDue, ...frozen } = document;
  void status;
  void amountDue;
  return { digest: hashDocument(frozen), issuedOn: document.issueDate };
}

async function receiptFingerprint(tx: Tx, ctx: TenantContext, id: string) {
  const document = await receiptDocumentData(tx, ctx, id);
  return { digest: hashDocument(document), issuedOn: document.paymentDate };
}

/**
 * A repair job report, hashed over the account of the work — not the images.
 *
 * ---------------------------------------------------------------------------
 * THE PHOTOGRAPHS ARE IN THE DIGEST, BUT ONLY BY THEIR OWN DIGESTS.
 *
 * Hashing megabytes of JPEG on every render would be slow and pointless: each
 * photograph already carries a SHA-256 computed when it was stored, so listing
 * those hashes binds the report to exactly those images. Substituting a
 * picture changes its digest, which changes the report's digest, which fails
 * verification — the same guarantee, at the cost of a few hundred bytes.
 *
 * `status` is excluded, as it is for an invoice: a report printed at handover
 * must still verify when the job is later re-opened as a warranty return.
 * ---------------------------------------------------------------------------
 */
async function repairFingerprint(tx: Tx, ctx: TenantContext, id: string) {
  const document = await repairDocumentData(tx, ctx, id);
  const { status, seller, photos, signatures, ...rest } = document;
  void status;
  return {
    digest: hashDocument({
      ...rest,
      seller: seller.name,
      evidence: [...photos, ...signatures].map((p) => ({
        kind: p.kind,
        stage: p.stage,
        digest: p.digest,
        takenOn: p.takenOn,
      })),
    }),
    issuedOn: document.collectedOn ?? document.receivedOn,
  };
}

/**
 * A warranty card, hashed over the promise it states.
 *
 * ---------------------------------------------------------------------------
 * `status` AND `claims` ARE EXCLUDED, AND THAT MATTERS MORE HERE THAN ELSEWHERE.
 *
 * Both move with time and use: a card printed on the day of sale reads ACTIVE
 * and shows no claims, and eleven months later the same card reads
 * EXPIRING_SOON with two repairs against it. If either were in the digest, a
 * genuine card would stop verifying the moment the customer most needs it —
 * near the end of the cover, which is exactly when somebody checks.
 *
 * What IS hashed is the promise: this unit, this item, sold on this date,
 * covered until this one. Those cannot change without the sale itself being
 * undone, and a card for a unit that has since been returned should stop
 * verifying — the promise it states no longer exists.
 * ---------------------------------------------------------------------------
 */
async function warrantyFingerprint(tx: Tx, ctx: TenantContext, unitId: string) {
  const card = await warrantyCardForUnit(tx, ctx, unitId);
  const { status, claims, seller, ...promise } = card;
  void status;
  void claims;
  return {
    digest: hashDocument({ ...promise, seller: seller.name }),
    issuedOn: card.soldOn,
  };
}

export interface VerificationResult {
  readonly verdict: 'GENUINE' | 'UNKNOWN';
  readonly documentType: VerifiableType | null;
  readonly issuedOn: string | null;
}

/**
 * Verify a digest presented by a member of the public.
 *
 * Takes the raw `Sql`, not a tenant transaction: the caller has no tenant, and
 * that is the point. `verify_document_digest` is SECURITY DEFINER and returns
 * only the document kind and its date — never the tenant, the customer, the
 * amount or the document number. Somebody holding the paper can already read
 * all of that off it; somebody who is not holding it learns nothing they did
 * not already have to know to ask the question.
 */
export async function verifyDocumentDigest(sql: Sql, digest: string): Promise<VerificationResult> {
  // A malformed digest is UNKNOWN, not an error: the answer to "is this
  // genuine" for a string that cannot be a digest is no.
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    return { verdict: 'UNKNOWN', documentType: null, issuedOn: null };
  }

  const rows = await sql<{ document_type: VerifiableType; issued_on: Date }[]>`
      SELECT document_type, issued_on FROM verify_document_digest(decode(${digest}, 'hex'))
  `;
  const row = rows[0];
  if (!row) return { verdict: 'UNKNOWN', documentType: null, issuedOn: null };

  return {
    verdict: 'GENUINE',
    documentType: row.document_type,
    issuedOn: row.issued_on.toISOString().slice(0, 10),
  };
}
