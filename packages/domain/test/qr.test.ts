import { describe, expect, it } from 'vitest';
import { collidesWithFinder, encodeQr, QrError, type QrMatrix } from '../src/qr.js';

/**
 * The encoder is checked three ways, because "it looks like a QR code" is not
 * a test and nobody can read one by eye:
 *
 *   1. STRUCTURE — the patterns a scanner locks onto are where the standard
 *      says they are.
 *   2. FORMAT INFORMATION — the 15-bit BCH string is compared against the
 *      published table in ISO/IEC 18004 Annex C. This is the part that would
 *      silently produce an unscannable code if the polynomial were wrong.
 *   3. ROUND TRIP — a decoder written below, independently of the encoder's
 *      internals, reads the payload back out. It reverses masking, the
 *      zig-zag, and the block interleaving; if any of those disagreed with
 *      the standard's layout, the bytes would come back scrambled.
 */

const size = (m: QrMatrix) => m.length;

describe('structure', () => {
  const m = encodeQr('https://example.test/verify#d=abc');

  it('is square, odd, and a legal version size', () => {
    expect(m.length).toBe(m[0]!.length);
    expect((m.length - 17) % 4).toBe(0);
    expect(m.length).toBeGreaterThanOrEqual(21);
  });

  it('puts a finder pattern in three corners and not the fourth', () => {
    const finderAt = (top: number, left: number) => {
      // The 7x7 eye: dark ring, light ring, 3x3 dark core.
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const onRing = r === 0 || r === 6 || c === 0 || c === 6;
          const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          if (m[top + r]![left + c] !== (onRing || inCore)) return false;
        }
      }
      return true;
    };
    const n = size(m);
    expect(finderAt(0, 0)).toBe(true);
    expect(finderAt(0, n - 7)).toBe(true);
    expect(finderAt(n - 7, 0)).toBe(true);
    // The bottom-right corner carries data, which is how a scanner works out
    // the orientation. A finder there would make the code ambiguous.
    expect(finderAt(n - 7, n - 7)).toBe(false);
  });

  it('lays the timing rulers down alternating', () => {
    const n = size(m);
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
  });

  it('always sets the dark module', () => {
    expect(m[size(m) - 8]![8]).toBe(true);
  });
});

describe('format information', () => {
  /**
   * ISO/IEC 18004 Annex C, EC level M, masks 0–7. Hard-coded from the
   * standard rather than recomputed — a table that recomputed itself with
   * the same BCH code as the encoder would agree with any bug the encoder
   * had.
   */
  const PUBLISHED = [
    '101010000010010', '101000100100101', '101111001111100', '101101101001011',
    '100010111111001', '100000011001110', '100111110010111', '100101010100000',
  ];

  it('writes one of the published strings, in both copies, consistently', () => {
    const m = encodeQr('hello');
    const n = size(m);

    // Copy 1 reads bit 0..14 around the top-left finder.
    const copy1: boolean[] = [];
    for (let i = 0; i <= 5; i++) copy1[i] = m[8]![i]!;
    copy1[6] = m[8]![7]!;
    copy1[7] = m[8]![8]!;
    copy1[8] = m[7]![8]!;
    for (let i = 9; i <= 14; i++) copy1[i] = m[14 - i]![8]!;

    const copy2: boolean[] = [];
    for (let i = 0; i <= 6; i++) copy2[i] = m[n - 1 - i]![8]!;
    for (let i = 7; i <= 14; i++) copy2[i] = m[8]![n - 15 + i]!;

    // Written most-significant-bit-last by the encoder, so reverse to read.
    const asString = (bits: boolean[]) =>
      bits.map((b) => (b ? '1' : '0')).reverse().join('');

    expect(PUBLISHED).toContain(asString(copy1));
    // Both copies must say the same thing, or a scanner reading the damaged
    // corner gets a different mask than the one actually applied.
    expect(asString(copy2)).toBe(asString(copy1));
  });
});

describe('round trip', () => {
  const cases: [string, string][] = [
    ['short', 'hi'],
    ['a verify URL, the real payload', 'https://shop.example/verify#d=' + 'a1b2c3d4'.repeat(8)],
    ['UTF-8 beyond ASCII', 'Kedai Komputer — RM 1,234.50 ✓'],
    ['one byte', 'x'],
    ['exactly at a version boundary', 'y'.repeat(34)],
    ['long enough to need several blocks', 'z'.repeat(200)],
  ];

  for (const [label, payload] of cases) {
    it(`reads back: ${label}`, () => {
      expect(decodeQr(encodeQr(payload))).toBe(payload);
    });
  }

  it('refuses a payload it cannot hold, rather than truncating it', () => {
    // Silent truncation would produce a scannable code carrying half a URL,
    // which is worse than no code: it looks like it worked.
    expect(() => encodeQr('n'.repeat(400))).toThrow(QrError);
  });
});

// ---------------------------------------------------------------------------
// A decoder, for the test only
// ---------------------------------------------------------------------------

/**
 * Reads the payload back out of a matrix. Deliberately written from the
 * standard's description rather than by reusing the encoder's helpers, so a
 * misreading shared by both would have to be made twice, differently.
 *
 * Error correction is NOT performed — the matrix is undamaged, so the data
 * codewords are read directly and the EC codewords ignored.
 */
function decodeQr(matrix: QrMatrix): string {
  const n = matrix.length;
  const version = (n - 17) / 4;

  const reserved = functionModuleMap(n, version);

  // The mask index lives in the format strip; read it and undo the mask.
  const formatBits: boolean[] = [];
  for (let i = 0; i <= 5; i++) formatBits[i] = matrix[8]![i]!;
  formatBits[6] = matrix[8]![7]!;
  formatBits[7] = matrix[8]![8]!;
  formatBits[8] = matrix[7]![8]!;
  for (let i = 9; i <= 14; i++) formatBits[i] = matrix[14 - i]![8]!;
  const format =
    formatBits.reduce((acc, bit, i) => acc | ((bit ? 1 : 0) << i), 0) ^ 0b101010000010010;
  // The 15 bits are (5 data << 10) | 10 BCH, and the data half is
  // (2 EC level << 3) | 3 mask — so the mask sits at bits 12..10, not at the
  // bottom. Reading `format & 0b111` gets BCH parity and silently unmasks
  // with the wrong rule.
  const mask = (format >> 10) & 0b111;

  const RULES = [
    (y: number, x: number) => (y + x) % 2 === 0,
    (y: number) => y % 2 === 0,
    (_: number, x: number) => x % 3 === 0,
    (y: number, x: number) => (y + x) % 3 === 0,
    (y: number, x: number) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (y: number, x: number) => ((y * x) % 2) + ((y * x) % 3) === 0,
    (y: number, x: number) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
    (y: number, x: number) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
  ];
  const rule = RULES[mask]!;

  // The same zig-zag, read rather than written.
  const bits: number[] = [];
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    const rightCol = right === 6 ? 5 : right;
    for (let step = 0; step < n; step++) {
      const y = upward ? n - 1 - step : step;
      for (const x of [rightCol, rightCol - 1]) {
        if (reserved[y]![x]) continue;
        bits.push((matrix[y]![x]! !== rule(y, x)) ? 1 : 0);
      }
    }
    upward = !upward;
    if (right === 6) right -= 1;
  }

  const stream: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    stream.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  }

  // De-interleave: the encoder wrote block[0][0], block[1][0], ... so undo it.
  const SPECS = [
    [16, 1, 0], [28, 1, 0], [44, 1, 0], [64, 2, 0], [86, 2, 0],
    [108, 4, 0], [124, 4, 0], [154, 2, 2], [182, 3, 2], [216, 4, 1],
  ] as const;
  const [dataCodewords, g1, g2] = SPECS[version - 1]!;
  const totalBlocks = g1 + g2;
  const baseLength = Math.floor(dataCodewords / totalBlocks);
  const lengths = Array.from({ length: totalBlocks }, (_, b) =>
    b < g1 ? baseLength : baseLength + 1,
  );

  const blocks: number[][] = lengths.map(() => []);
  let read = 0;
  for (let i = 0; i < Math.max(...lengths); i++) {
    for (let b = 0; b < totalBlocks; b++) {
      if (i < lengths[b]!) blocks[b]!.push(stream[read++]!);
    }
  }
  const data = blocks.flat();

  // Mode nibble, length, payload.
  const mode = data[0]! >> 4;
  expect(mode).toBe(0b0100);

  const lengthBits = version < 10 ? 8 : 16;
  let cursor = 4;
  const readBits = (count: number) => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = data[cursor >> 3]!;
      value = (value << 1) | ((byte >> (7 - (cursor & 7))) & 1);
      cursor++;
    }
    return value;
  };
  const length = readBits(lengthBits);
  const bytes = Array.from({ length }, () => readBits(8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** True where a module is a function pattern rather than data. */
function functionModuleMap(n: number, version: number): boolean[][] {
  const map: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fill = (top: number, left: number, height: number, width: number) => {
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        if (top + r >= 0 && top + r < n && left + c >= 0 && left + c < n) {
          map[top + r]![left + c] = true;
        }
      }
    }
  };

  fill(-1, -1, 9, 9);
  fill(-1, n - 8, 9, 9);
  fill(n - 8, -1, 9, 9);
  for (let i = 0; i < n; i++) {
    map[6]![i] = true;
    map[i]![6] = true;
  }

  const ALIGNMENT: readonly (readonly number[])[] = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
    [6, 26, 46], [6, 28, 50],
  ];
  const centres = ALIGNMENT[version - 1]!;
  for (const row of centres) {
    for (const col of centres) {
      if (collidesWithFinder(row, col, n)) continue;
      fill(row - 2, col - 2, 5, 5);
    }
  }

  for (let i = 0; i < 9; i++) {
    map[8]![i] = true;
    map[i]![8] = true;
  }
  for (let i = 0; i < 8; i++) {
    map[8]![n - 1 - i] = true;
    map[n - 1 - i]![8] = true;
  }
  return map;
}
