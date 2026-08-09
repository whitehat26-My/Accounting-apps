import { describe, expect, it } from 'vitest';

import { fromBase64Url, unpackAttestation } from '@emil/domain';

import { attestationFragment, importSigningKey, publicKeyOf } from '../src/documents/attest.js';

/**
 * THE TEST THAT DECIDES WHETHER ANY OF THIS IS WORTH PRINTING.
 *
 * The whole point of a signed QR is that a stranger's phone, with no access to
 * this system, can tell a genuine receipt from an altered one. That claim is
 * only true if two things hold, and both are easy to get subtly wrong in ways
 * that still look like they work:
 *
 *   1. A signature this API produces VERIFIES against the public key the verify
 *      page will hold. If the key derivation is wrong, every genuine document
 *      is called a forgery — and the failure appears only in a customer's hand.
 *   2. A signature over ALTERED figures FAILS. A verifier that accepts a
 *      changed amount is worse than no verifier at all: it launders the
 *      forgery. Faking the amount is precisely what somebody would try.
 *
 * These run the real WebCrypto both ways round — signing here exactly as the
 * PDF path does, verifying exactly as the browser will.
 */

/** A fresh keypair, in the same PKCS#8 form `.env.prod` carries. */
async function freshKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
}

/** Exactly what `apps/web/src/app/verify/page.tsx` will do, in Node. */
async function verifyAsBrowserWould(publicKeyB64Url: string, fragment: string): Promise<boolean> {
  const [payload, signature] = fragment.replace(/^v=/, '').split('.');
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(publicKeyB64Url),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    fromBase64Url(signature!),
    fromBase64Url(payload!),
  );
}

const INVOICE = {
  documentType: 'INVOICE',
  documentNo: 'INV-2026-0142',
  issuedOn: '2026-08-08',
  total: '1250.00',
  currency: 'MYR',
  tenantId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
} as const;

describe('a printed document proves itself without this server', () => {
  it('verifies against the public key derived from the signing key', async () => {
    const pkcs8 = await freshKey();
    const key = await importSigningKey(pkcs8);

    const fragment = await attestationFragment(key, INVOICE);
    const publicKey = await publicKeyOf(key);

    expect(await verifyAsBrowserWould(publicKey, fragment)).toBe(true);
  });

  it('carries back the same figures that were signed', async () => {
    const key = await importSigningKey(await freshKey());
    const fragment = await attestationFragment(key, INVOICE);

    const payload = fragment.replace(/^v=/, '').split('.')[0]!;
    const decoded = unpackAttestation(fromBase64Url(payload), 'MYR');

    expect(decoded.documentType).toBe('INVOICE');
    expect(decoded.documentNo).toBe('INV-2026-0142');
    expect(decoded.issuedOn).toBe('2026-08-08');
    expect(decoded.total.toString()).toBe('1250.0000 MYR');
    // The units are the real assertion: a formatted string can match while the
    // underlying minor units are wrong by a factor of the scale.
    expect(decoded.total.units).toBe(12_500_000n);
  });

  it('REFUSES a payload whose amount was altered', async () => {
    const key = await importSigningKey(await freshKey());
    const publicKey = await publicKeyOf(key);
    const fragment = await attestationFragment(key, INVOICE);

    const [payload, signature] = fragment.replace(/^v=/, '').split('.');
    const bytes = fromBase64Url(payload!);

    // Byte 8 is the last byte of the six-byte total. Change the amount and
    // keep the signature: the forger's most obvious move.
    bytes[8] = bytes[8]! ^ 0xff;
    const forged = `${Buffer.from(bytes).toString('base64url')}.${signature}`;

    expect(await verifyAsBrowserWould(publicKey, forged)).toBe(false);
  });

  it('REFUSES a document signed by somebody else', async () => {
    const mine = await importSigningKey(await freshKey());
    const theirs = await importSigningKey(await freshKey());

    // Another shop signs a document claiming to be from this one.
    const fragment = await attestationFragment(theirs, INVOICE);

    expect(await verifyAsBrowserWould(await publicKeyOf(mine), fragment)).toBe(false);
  });

  it('produces a raw public key of the 65 bytes a browser imports', async () => {
    const key = await importSigningKey(await freshKey());
    expect(fromBase64Url(await publicKeyOf(key))).toHaveLength(65);
  });

  it('signs each document differently even for identical figures', async () => {
    // ECDSA is randomised; two signatures over the same bytes must differ, or
    // the nonce is being reused and the private key is recoverable.
    const key = await importSigningKey(await freshKey());
    const a = await attestationFragment(key, INVOICE);
    const b = await attestationFragment(key, INVOICE);

    expect(a.split('.')[0]).toBe(b.split('.')[0]); // same payload
    expect(a.split('.')[1]).not.toBe(b.split('.')[1]); // different signature
  });
});
