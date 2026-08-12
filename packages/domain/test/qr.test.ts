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

  /*
   * THE ORDER THE MODULES ARE READ IN IS PART OF THE CLAIM.
   *
   * This block used to end with `.reverse()`, on the note "written
   * most-significant-bit-last by the encoder". That is not a fact about the
   * standard, it is a fact about the encoder — and the encoder had it
   * backwards. Reading it back the same way it was written recovered the
   * published string and passed, while no scanner on earth could read the
   * symbol.
   *
   * ISO/IEC 18004 Figure 25 fixes the placement: bit 14 (the MSB of the
   * published string) at (8,0), running to bit 0 at (0,8), and the second copy
   * from (n-1,8) to (8,n-1). Read in that order the string comes out
   * most-significant-bit FIRST, with no reversal anywhere. The reversal is
   * gone, and `qr-golden.test.ts` compares whole symbols against a separate
   * implementation so that no shared convention can hide here again.
   */
  const readFormat = (m: QrMatrix, positions: [number, number][]) =>
    positions.map(([r, c]) => (m[r]![c] ? '1' : '0')).join('');

  it('writes one of the published strings, in both copies, consistently', () => {
    const m = encodeQr('hello');
    const n = size(m);

    const copy1: [number, number][] = [
      ...Array.from({ length: 6 }, (_, c) => [8, c] as [number, number]),
      [8, 7], [8, 8], [7, 8],
      ...Array.from({ length: 6 }, (_, i) => [5 - i, 8] as [number, number]),
    ];
    const copy2: [number, number][] = [
      ...Array.from({ length: 7 }, (_, i) => [n - 1 - i, 8] as [number, number]),
      ...Array.from({ length: 8 }, (_, i) => [8, n - 8 + i] as [number, number]),
    ];

    expect(PUBLISHED).toContain(readFormat(m, copy1));
    // Both copies must say the same thing, or a scanner reading the damaged
    // corner gets a different mask than the one actually applied.
    expect(readFormat(m, copy2)).toBe(readFormat(m, copy1));
  });
});

describe('version information', () => {
  /**
   * From version 7 a scanner is no longer allowed to infer the version by
   * counting modules — two 6x3 blocks state it, BCH(18,6)-coded. Omit them and
   * the symbol is structurally perfect and decodes as nothing at all, which is
   * exactly what happened to every DuitNow QR the till drew: around 150 bytes
   * of payload lands on version 8 or 9, on the far side of this threshold.
   *
   * The strings are ISO/IEC 18004 Annex D, hard-coded rather than recomputed
   * for the same reason as the format table above.
   */
  const PUBLISHED: Record<number, string> = {
    7: '000111110010010100',
    8: '001000010110111100',
    9: '001001101010011001',
    10: '001010010011010011',
  };

  /** The smallest payload that lands on each version, at EC level M. */
  const AT_VERSION: Record<number, string> = {
    7: 'a'.repeat(110),
    8: 'a'.repeat(130),
    9: 'a'.repeat(160),
    10: 'a'.repeat(195),
  };

  for (const version of [7, 8, 9, 10]) {
    it(`states version ${version} in both blocks`, () => {
      const m = encodeQr(AT_VERSION[version]!);
      const n = size(m);
      expect((n - 17) / 4).toBe(version);

      // Bit 0 is the LSB and sits nearest each finder; the two blocks are
      // transposes of one another.
      const upperRight: string[] = [];
      const lowerLeft: string[] = [];
      for (let i = 17; i >= 0; i--) {
        const row = Math.floor(i / 3);
        const col = n - 11 + (i % 3);
        upperRight.push(m[row]![col] ? '1' : '0');
        lowerLeft.push(m[col]![row] ? '1' : '0');
      }
      expect(upperRight.join('')).toBe(PUBLISHED[version]);
      expect(lowerLeft.join('')).toBe(PUBLISHED[version]);
    });
  }

  it('leaves the blocks alone below version 7, where they do not exist', () => {
    // Version 6 infers its size from the module count. Writing a version block
    // there would overwrite data modules.
    const m = encodeQr('a'.repeat(100));
    expect(size(m)).toBe(41); // version 6
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

  /*
   * From version 7 a real scanner takes the version from the symbol rather
   * than from the module count, so this does too — otherwise the decoder is
   * told the answer and cannot notice a missing version block. It is read and
   * checked against the size; a symbol that disagrees with itself is one no
   * scanner would accept.
   */
  if (version >= 7) {
    let stated = 0;
    for (let i = 17; i >= 0; i--) {
      stated = (stated << 1) | (matrix[Math.floor(i / 3)]![n - 11 + (i % 3)]! ? 1 : 0);
    }
    expect(stated >> 12).toBe(version);
  }

  // The mask index lives in the format strip; read it and undo the mask.
  // Bit 14 first — the standard's order, not the encoder's convenience.
  const formatBits: boolean[] = [];
  for (let i = 0; i <= 5; i++) formatBits[14 - i] = matrix[8]![i]!;
  formatBits[8] = matrix[8]![7]!;
  formatBits[7] = matrix[8]![8]!;
  formatBits[6] = matrix[7]![8]!;
  for (let i = 9; i <= 14; i++) formatBits[14 - i] = matrix[14 - i]![8]!;
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

  // The two version blocks, from version 7 up. They are function modules, so
  // the zig-zag steps over them; a decoder that did not know that would read
  // 36 modules of version string as though they were data and recover noise.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      map[Math.floor(i / 3)]![n - 11 + (i % 3)] = true;
      map[n - 11 + (i % 3)]![Math.floor(i / 3)] = true;
    }
  }
  return map;
}
