import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ATTESTED_TYPES,
  MAX_ATTESTABLE_DATE,
  Money,
  fromBase64Url,
  packAttestation,
  tenantTag,
  toBase64Url,
  unpackAttestation,
  type DocumentAttestation,
} from '../src/index.js';
import { encodeQr } from '../src/qr.js';

/**
 * The QR stops being a pointer and starts carrying the proof, which means the
 * bytes ARE the document as far as a customer's phone is concerned. Two things
 * therefore have to hold, and neither is obvious by reading the packer:
 *
 *   1. Everything that goes in comes back out identical. A date that shifts by
 *      a day or an amount that loses its last digit would still verify — the
 *      signature covers the BYTES — and would show the reader a figure that
 *      does not match the paper, which is the exact failure this is meant to
 *      catch.
 *   2. The result still fits a QR code. `encodeQr` stops at version 10 (213
 *      bytes) and THROWS past it, at render time, on a real receipt. A test is
 *      a cheaper place to find that than a counter.
 */

/**
 * The full packable span, to the day.
 *
 * Generating to 2179-12-31 is what caught the imprecision: the 16-bit day count
 * actually stops at 2179-06-06, and the first version of this generator failed
 * against correct code because the COMMENT had rounded the limit up to the year.
 */
const isoDate = fc
  .date({
    min: new Date('2000-01-01T00:00:00Z'),
    max: new Date(`${MAX_ATTESTABLE_DATE}T00:00:00Z`),
  })
  .map((d) => d.toISOString().slice(0, 10));

const documentNo = fc
  .stringMatching(/^[A-Z]{2,4}-[0-9]{4}-[0-9]{4,6}$/)
  .filter((s) => s.length > 0 && s.length <= 64);

const attestation: fc.Arbitrary<DocumentAttestation> = fc.record({
  documentType: fc.constantFrom(...ATTESTED_TYPES),
  issuedOn: isoDate,
  // Whole minor units at MONEY_SCALE, inside the six-byte field.
  total: fc
    .bigInt({ min: 0n, max: 0xffff_ffff_ffffn })
    .map((units) => Money.fromUnits(units, 'MYR')),
  tenantTag: fc.uuid().map(tenantTag),
  documentNo,
});

describe('the attestation carried inside the QR', () => {
  it('comes back exactly as it went in', () => {
    fc.assert(
      fc.property(attestation, (input) => {
        const output = unpackAttestation(packAttestation(input), 'MYR');

        expect(output.documentType).toBe(input.documentType);
        expect(output.issuedOn).toBe(input.issuedOn);
        expect(output.tenantTag).toBe(input.tenantTag);
        expect(output.documentNo).toBe(input.documentNo);
        // Compare units, not the formatted string: a Money that round-trips to
        // the same text but different units would still be the wrong money.
        expect(output.total.units).toBe(input.total.units);
      }),
      { numRuns: 500 },
    );
  });

  it('survives the base64url trip the URL fragment forces on it', () => {
    fc.assert(
      fc.property(attestation, (input) => {
        const packed = packAttestation(input);
        expect(fromBase64Url(toBase64Url(packed))).toEqual(packed);
      }),
      { numRuns: 300 },
    );
  });

  it('encodes arbitrary bytes through base64url without loss', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 200 }), (bytes) => {
        expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
      }),
      { numRuns: 300 },
    );
  });

  /*
   * The decoder used to answer where it should have refused, and this module's
   * whole contract is that every failure is a refusal rather than a best
   * guess — it runs in front of a person deciding whether a document is real.
   */
  it('refuses a length no encoder can produce', () => {
    // Four characters carry three bytes; a remainder of one carries six bits
    // and no whole byte. These used to decode to 0, 3 and 6 bytes.
    for (const impossible of ['A', 'AAAAA', 'AAAAAAAAA']) {
      expect(() => fromBase64Url(impossible)).toThrow(/no whole byte/);
    }
  });

  it('refuses a final character that sets bits carrying no data', () => {
    // One byte is `AQ`; the last character's low four bits are padding the
    // encoder always leaves zero. `AR` differs only in that padding, so it
    // used to decode to the identical byte — which made a typo verify.
    expect(fromBase64Url('AQ')).toEqual(new Uint8Array([0x01]));
    expect(() => fromBase64Url('AR')).toThrow(/carry no data/);

    // Two bytes: `AQI` has two padding bits, so three of the sixty-three
    // possible typos in that position used to collide with it.
    expect(fromBase64Url('AQI')).toEqual(new Uint8Array([0x01, 0x02]));
    for (const collision of ['AQJ', 'AQK', 'AQL']) {
      expect(() => fromBase64Url(collision)).toThrow(/carry no data/);
    }
  });

  it('accepts every string it produces, and no neighbour of one', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 60 }), (bytes) => {
        const encoded = toBase64Url(bytes);
        expect(fromBase64Url(encoded)).toEqual(bytes);

        // No other character in the last position decodes to the same bytes:
        // either it is refused, or it means something different.
        const stem = encoded.slice(0, -1);
        for (const character of ALPHABET) {
          if (character === encoded[encoded.length - 1]) continue;
          let decoded: Uint8Array | null = null;
          try {
            decoded = fromBase64Url(stem + character);
          } catch {
            continue; // refused, which is the honest answer
          }
          expect(decoded).not.toEqual(bytes);
        }
      }),
      { numRuns: 100 },
    );
  });
});

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

describe('the whole QR still fits a QR code', () => {
  /**
   * The realistic worst case, not the average one: the longest host anybody
   * would plausibly use, a long document number, and a 64-byte signature.
   */
  function qrText(host: string, documentNo: string): string {
    const packed = packAttestation({
      documentType: 'INVOICE',
      issuedOn: '2026-08-08',
      total: Money.fromDecimal('99999.99', 'MYR'),
      tenantTag: tenantTag('3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
      documentNo,
    });
    const signature = toBase64Url(new Uint8Array(64).fill(0xab));
    return `${host}/verify#v=${toBase64Url(packed)}.${signature}`;
  }

  it('fits with a typical document number and host', () => {
    const text = qrText('https://shahgtech.netlify.app', 'INV-2026-0142');
    const matrix = encodeQr(text);

    expect(text.length).toBeLessThan(213);
    // QrMatrix is rows of booleans, so the module count is its length.
    // Version n is 17 + 4n modules across; assert we are inside the
    // encoder's range rather than merely that it did not throw.
    const version = (matrix.length - 17) / 4;
    expect(Number.isInteger(version)).toBe(true);
    expect(version).toBeLessThanOrEqual(10);
  });

  it('fits with a long document number and a long host', () => {
    const text = qrText('https://books.shah-g-tech-sales-repairs.com', 'INVOICE-2026-000142');
    expect(() => encodeQr(text)).not.toThrow();
  });

  /**
   * The measurement that motivated the binary format. If somebody later
   * "simplifies" the payload to JSON, this is the number they will be looking
   * at when they wonder why the printer started throwing.
   */
  it('records why this is not JSON', () => {
    const asJson = toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          t: 'INVOICE',
          n: 'INV-2026-0142',
          d: '2026-08-08',
          a: '99999.99',
          o: '3f2504e0',
        }),
      ),
    );
    const jsonUrl = `https://shahgtech.netlify.app/verify#v=${asJson}.${toBase64Url(new Uint8Array(64))}`;
    const packedUrl = qrText('https://shahgtech.netlify.app', 'INV-2026-0142');

    expect(packedUrl.length).toBeLessThan(jsonUrl.length);
    expect(jsonUrl.length).toBeGreaterThan(213); // would throw at the printer
  });
});

describe('it refuses rather than guesses', () => {
  const good: DocumentAttestation = {
    documentType: 'RECEIPT',
    issuedOn: '2026-08-08',
    total: Money.fromDecimal('1250.00', 'MYR'),
    tenantTag: tenantTag('3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
    documentNo: 'RCP-2026-0001',
  };

  it('rejects a negative total instead of wrapping it round', () => {
    expect(() =>
      packAttestation({ ...good, total: Money.fromDecimal('-1.00', 'MYR') }),
    ).toThrow(/negative/i);
  });

  it('rejects a date that is not a real day', () => {
    expect(() => packAttestation({ ...good, issuedOn: '2026-02-31' })).toThrow(/calendar/i);
  });

  it('rejects a truncated payload rather than reading past the end', () => {
    const packed = packAttestation(good);
    expect(() => unpackAttestation(packed.slice(0, 10), 'MYR')).toThrow(/truncated/i);
  });

  it('rejects a payload whose declared length disagrees with its size', () => {
    const packed = packAttestation(good);
    packed[13] = 99;
    expect(() => unpackAttestation(packed, 'MYR')).toThrow(/length mismatch/i);
  });

  it('refuses a future format version instead of misreading it', () => {
    const packed = packAttestation(good);
    packed[0] = (9 << 4) | (packed[0]! & 0x0f);
    expect(() => unpackAttestation(packed, 'MYR')).toThrow(/newer than this reader/i);
  });
});
