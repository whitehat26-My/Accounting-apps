import {
  Money,
  packAttestation,
  tenantTag,
  toBase64Url,
  type AttestedType,
  type Currency,
} from '@emil/domain';

/**
 * Sign a document so its QR code can be checked without asking this server.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SIGNATURE BUYS, AND WHAT IT DOES NOT.
 *
 * It proves the holder of this deployment's private key issued a document with
 * exactly these figures on this date. A customer's phone checks that offline,
 * against a public key baked into the verify page, and compares what it decodes
 * to the paper in their hand.
 *
 * It CANNOT say the document was not later cancelled or credited — a signature
 * is a statement about a moment, and the moment has passed. `/verify` therefore
 * still asks the live system when it can reach it, and says which answer it
 * used. Offline gives certainty about the paper; online adds current status.
 *
 * ---------------------------------------------------------------------------
 * ECDSA P-256, AND WHY NOT SOMETHING NEWER.
 *
 * Ed25519 is the better primitive and its WebCrypto support is too recent to
 * rely on in whatever browser a customer happens to be holding — which for a
 * warranty card scanned in 2031 could be almost anything. P-256 has been in
 * every browser's WebCrypto for a decade. The signature is the same 64 bytes
 * either way, so the QR does not pay for the compatibility.
 *
 * WebCrypto's ECDSA output is raw `r||s`, not DER — 64 bytes flat, no length
 * prefixes, nothing to parse. That is what keeps it inside the QR budget, and
 * it is why this signs through WebCrypto rather than node:crypto's `sign()`,
 * which would hand back DER and cost another ~7 bytes plus a parser in the
 * browser.
 * ---------------------------------------------------------------------------
 */

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;

/**
 * The imported key, once.
 *
 * `importKey` is not free and a busy till prints a receipt per sale; importing
 * per document would put an avoidable few milliseconds in front of the one
 * screen where waiting is felt. Cached as the PROMISE so two concurrent renders
 * on a cold start share one import instead of racing to do it twice.
 *
 * `undefined` means "not looked at yet"; `null` means "looked, and there is no
 * key configured" — a distinction worth keeping, because the second is a normal
 * state that must not re-read the environment on every receipt.
 */
let cachedKey: Promise<CryptoKey> | null | undefined;

/** Test seam: forget the cached key so a test can change the environment. */
export function resetSigningKey(): void {
  cachedKey = undefined;
}

export function signingKey(env: NodeJS.ProcessEnv = process.env): Promise<CryptoKey> | null {
  if (cachedKey === undefined) {
    const configured = env['DOCUMENT_SIGNING_KEY']?.trim();
    cachedKey = configured ? importSigningKey(configured) : null;
  }
  return cachedKey;
}

export interface AttestableDocument {
  readonly documentType: AttestedType;
  readonly documentNo: string;
  /** Accounting date, `YYYY-MM-DD`. */
  readonly issuedOn: string;
  /** Decimal string as stored — parsed to Money here, never to a number. */
  readonly total: string;
  readonly currency: string;
  readonly tenantId: string;
}

/**
 * Decode the configured private key.
 *
 * PKCS#8 base64 because it is the one format WebCrypto imports directly and
 * OpenSSL emits without argument, so the value in `.env.prod` can be produced
 * by `scripts/new-signing-key.mjs` OR by hand and mean the same thing.
 */
export async function importSigningKey(pkcs8Base64: string): Promise<CryptoKey> {
  const der = Uint8Array.from(Buffer.from(pkcs8Base64, 'base64'));
  return globalThis.crypto.subtle.importKey('pkcs8', der, ALGORITHM, true, ['sign']);
}

/**
 * The matching public key, as the 65 raw bytes a browser can import directly.
 *
 * Derived from the private key rather than configured separately: two settings
 * that must agree are two settings that can disagree, and a verify page holding
 * the wrong public key would call every genuine document a forgery.
 */
export async function publicKeyOf(privateKey: CryptoKey): Promise<string> {
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', privateKey);

  /*
   * Checked rather than spread. A JWK's members are all optional to the type
   * system, and dropping `d` to get the public half means the remaining
   * coordinates are the ENTIRE key — a missing `y` would either throw somewhere
   * less obvious or, worse, produce a key that verifies nothing. Name them.
   */
  const { kty, crv, x, y } = jwk;
  if (!kty || !crv || !x || !y) {
    throw new Error('DOCUMENT_SIGNING_KEY did not export a complete P-256 public point');
  }

  const pub = await globalThis.crypto.subtle.importKey(
    'jwk',
    { kty, crv, x, y, ext: true },
    ALGORITHM,
    true,
    ['verify'],
  );
  const raw = await globalThis.crypto.subtle.exportKey('raw', pub);
  return toBase64Url(new Uint8Array(raw));
}

/**
 * Build the URL fragment a document's QR should carry: `v=<payload>.<signature>`.
 *
 * The fragment, not the query string — a fragment is never sent to a server, so
 * scanning a receipt tells the host of the verify page nothing about the
 * customer, the shop, or the amount. That property is why the verify page can
 * live on somebody else's free static hosting without leaking the books.
 */
export async function attestationFragment(
  privateKey: CryptoKey,
  document: AttestableDocument,
): Promise<string> {
  const packed = packAttestation({
    documentType: document.documentType,
    issuedOn: document.issuedOn,
    total: Money.fromDecimal(document.total, document.currency as Currency),
    tenantTag: tenantTag(document.tenantId),
    documentNo: document.documentNo,
  });

  const signature = await globalThis.crypto.subtle.sign(SIGN_PARAMS, privateKey, packed);
  return `v=${toBase64Url(packed)}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Everything the PDF renderer needs to print a verification block.
 *
 * The digest is always present, because it is what a reader types into
 * `/verify` when they cannot scan; the signed fragment is added when a key is
 * configured. Signing failure is NOT fatal — a receipt that prints with the
 * older QR is worth incomparably more than a 500 at the till, and the operator
 * finds out from the log rather than from a queue of customers.
 */
export async function verificationFor(
  digest: string,
  verifyUrl: string,
  document: AttestableDocument,
  onError: (error: unknown) => void = () => {},
): Promise<{ digest: string; verifyUrl: string; attestation?: string }> {
  const key = signingKey();
  if (!key) return { digest, verifyUrl };

  try {
    return { digest, verifyUrl, attestation: await attestationFragment(await key, document) };
  } catch (error) {
    onError(error);
    return { digest, verifyUrl };
  }
}
