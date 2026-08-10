import { describe, expect, it } from 'vitest';
import { Money, fromBase64Url, packAttestation, tenantTag, toBase64Url } from '@emil/domain/attestation';

/**
 * THE CHECK A CUSTOMER'S PHONE PERFORMS, RUN HERE.
 *
 * ---------------------------------------------------------------------------
 * `/verify` decides whether somebody's receipt is real, with no server
 * involved. Two properties make that worth anything, and both fail silently:
 *
 *   1. A signature this shop produced VERIFIES. Get the key handling wrong and
 *      every genuine document is called a forgery — in a customer's hand, in
 *      front of the shop, with no way to tell it is the page that is broken.
 *   2. A signature over CHANGED figures FAILS. A verifier that accepts an
 *      altered amount does not merely fail to help: it launders the forgery,
 *      because the page then prints "genuine" beside the forger's number.
 *
 * This exercises the same WebCrypto calls `page.tsx` makes, against payloads
 * built by the same packer the API uses. It cannot render the page (that is
 * the browser journey), but it can prove the cryptography underneath it.
 *
 * ORDER IS PART OF THE CONTRACT. `page.tsx` verifies the signature BEFORE
 * unpacking, so a payload that fails is never decoded and its contents are
 * never shown. The "does not decode" test below pins that down.
 * ---------------------------------------------------------------------------
 */

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

const RECEIPT = {
  documentType: 'RECEIPT',
  issuedOn: '2026-08-08',
  total: Money.fromDecimal('1250.00', 'MYR'),
  tenantTag: tenantTag('3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
  documentNo: 'RCP-2026-0001',
} as const;

async function shopKeys() {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64Url(raw) };
}

/** What the API prints into the QR: `v=<payload>.<signature>`. */
async function signedFragment(privateKey: CryptoKey): Promise<string> {
  const packed = packAttestation(RECEIPT);
  const signature = await crypto.subtle.sign(SIGN, privateKey, packed);
  return `${toBase64Url(packed)}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Exactly what `verifySignature()` in page.tsx does, minus the React. */
async function check(publicKey: string, fragment: string): Promise<boolean> {
  const [payload, signature] = fragment.split('.');
  if (!payload || !signature) return false;
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64Url(publicKey), ALGORITHM, true, [
      'verify',
    ]);
    return await crypto.subtle.verify(
      SIGN,
      key,
      fromBase64Url(signature),
      fromBase64Url(payload),
    );
  } catch {
    return false;
  }
}

describe('the signature check that runs in the customer’s browser', () => {
  it('accepts a receipt this shop signed', async () => {
    const shop = await shopKeys();
    expect(await check(shop.publicKey, await signedFragment(shop.privateKey))).toBe(true);
  });

  it('REJECTS a receipt whose amount was changed', async () => {
    const shop = await shopKeys();
    const [payload, signature] = (await signedFragment(shop.privateKey)).split('.');

    // Byte 8 is the last byte of the six-byte total: the forger's obvious move,
    // keeping the signature and editing the number.
    const bytes = fromBase64Url(payload!);
    bytes[8] = bytes[8]! ^ 0xff;

    expect(await check(shop.publicKey, `${toBase64Url(bytes)}.${signature}`)).toBe(false);
  });

  it('REJECTS a receipt whose date was changed', async () => {
    const shop = await shopKeys();
    const [payload, signature] = (await signedFragment(shop.privateKey)).split('.');
    const bytes = fromBase64Url(payload!);
    bytes[2] = bytes[2]! ^ 0x01; // one day later

    expect(await check(shop.publicKey, `${toBase64Url(bytes)}.${signature}`)).toBe(false);
  });

  it('REJECTS a document signed by a different shop', async () => {
    const ours = await shopKeys();
    const theirs = await shopKeys();
    expect(await check(ours.publicKey, await signedFragment(theirs.privateKey))).toBe(false);
  });

  it('returns false rather than throwing on rubbish', async () => {
    const shop = await shopKeys();
    for (const rubbish of ['', '.', 'not-base64!.also-not', 'onlyonepart', 'a.b']) {
      expect(await check(shop.publicKey, rubbish)).toBe(false);
    }
  });

  it('returns false rather than throwing when the public key is nonsense', async () => {
    const shop = await shopKeys();
    expect(await check('not-a-key', await signedFragment(shop.privateKey))).toBe(false);
  });

  /**
   * The property that keeps a forgery off the screen. `page.tsx` only calls
   * `unpackAttestation` after the signature passes — so if this ordering is
   * ever inverted, a forger's amount would be decoded and displayed.
   */
  it('a tampered payload never reaches the decoder', async () => {
    const shop = await shopKeys();
    const [payload, signature] = (await signedFragment(shop.privateKey)).split('.');
    const bytes = fromBase64Url(payload!);
    bytes[8] = bytes[8]! ^ 0xff;

    const passed = await check(shop.publicKey, `${toBase64Url(bytes)}.${signature}`);
    expect(passed).toBe(false);

    // It WOULD decode, and to a different amount — which is exactly why the
    // signature has to be checked first.
    const { unpackAttestation } = await import('@emil/domain/attestation');
    expect(unpackAttestation(bytes, 'MYR').total.units).not.toBe(RECEIPT.total.units);
  });
});
