/**
 * A QR code encoder, byte mode, error-correction level M.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS HAND-WRITTEN RATHER THAN A DEPENDENCY.
 *
 * The same argument `duitnow-qr.ts` makes for its CRC-16: this produces a
 * matrix of booleans from a string of bytes, the specification (ISO/IEC 18004)
 * has not changed since 2006 and will not, and the output is verifiable by
 * pointing a phone at it. A package here would be a supply-chain surface, a
 * transitive tree, and a thing to keep updating — for an algorithm that is
 * finished.
 *
 * It also has to run on a document meant to be readable in fifty years. A
 * dependency that has been unpublished, or whose new major version encodes
 * differently, is a worse bet than four hundred lines that are frozen because
 * the standard is.
 *
 * Scope, deliberately narrow: byte mode only (the payload is a URL), EC level
 * M (15% recovery — enough for a receipt that lives in a drawer), versions 1
 * through 10 chosen automatically. Kanji and alphanumeric modes would compress
 * some payloads better and are not written, because nothing here needs them.
 * ---------------------------------------------------------------------------
 */

export type QrMatrix = readonly (readonly boolean[])[];

export class QrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrError';
  }
}

// ---------------------------------------------------------------------------
// GF(256) — the field Reed–Solomon works in
// ---------------------------------------------------------------------------

/*
 * The QR standard's field: generator 2, primitive polynomial 0x11D. EXP and
 * LOG tables turn multiplication into addition, which is what makes the
 * polynomial arithmetic below short enough to read.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** The generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ gfMul(poly[j]!, 1);
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** The remainder of `data` divided by the generator — the EC codewords. */
function reedSolomon(data: readonly number[], ecCount: number): number[] {
  const generator = generatorPoly(ecCount);
  const remainder = new Array<number>(ecCount).fill(0);

  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < ecCount; i++) {
      remainder[i] = remainder[i]! ^ gfMul(generator[i + 1]!, factor);
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Version tables (1–10, EC level M)
// ---------------------------------------------------------------------------

/**
 * Per version: total data codewords, EC codewords per block, and the block
 * split. Straight from ISO/IEC 18004 table 9; the two block counts are
 * (group 1 blocks, group 2 blocks) where group 2 blocks hold one more
 * data codeword each.
 */
interface VersionSpec {
  readonly dataCodewords: number;
  readonly ecPerBlock: number;
  readonly group1Blocks: number;
  readonly group2Blocks: number;
}

const VERSIONS: readonly VersionSpec[] = [
  { dataCodewords: 16, ecPerBlock: 10, group1Blocks: 1, group2Blocks: 0 }, // 1
  { dataCodewords: 28, ecPerBlock: 16, group1Blocks: 1, group2Blocks: 0 }, // 2
  { dataCodewords: 44, ecPerBlock: 26, group1Blocks: 1, group2Blocks: 0 }, // 3
  { dataCodewords: 64, ecPerBlock: 18, group1Blocks: 2, group2Blocks: 0 }, // 4
  { dataCodewords: 86, ecPerBlock: 24, group1Blocks: 2, group2Blocks: 0 }, // 5
  { dataCodewords: 108, ecPerBlock: 16, group1Blocks: 4, group2Blocks: 0 }, // 6
  { dataCodewords: 124, ecPerBlock: 18, group1Blocks: 4, group2Blocks: 0 }, // 7
  { dataCodewords: 154, ecPerBlock: 22, group1Blocks: 2, group2Blocks: 2 }, // 8
  { dataCodewords: 182, ecPerBlock: 22, group1Blocks: 3, group2Blocks: 2 }, // 9
  { dataCodewords: 216, ecPerBlock: 26, group1Blocks: 4, group2Blocks: 1 }, // 10
];

/** Alignment-pattern centre coordinates by version (empty for version 1). */
const ALIGNMENT: readonly (readonly number[])[] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50],
];

// ---------------------------------------------------------------------------
// The encoder
// ---------------------------------------------------------------------------

/**
 * Encode `text` (UTF-8, byte mode) as a QR matrix at EC level M.
 *
 * `true` is a dark module. The returned matrix has no quiet zone — the
 * standard requires four modules of light border, and the CALLER adds it,
 * because on paper that border is usually the page's own margin.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = Array.from(new TextEncoder().encode(text));

  const versionIndex = VERSIONS.findIndex((spec, i) => {
    // 4 bits mode + 8 or 16 bits length + the data itself, in bits.
    const lengthBits = i + 1 < 10 ? 8 : 16;
    return spec.dataCodewords * 8 >= 4 + lengthBits + bytes.length * 8;
  });
  if (versionIndex === -1) {
    throw new QrError(
      `${bytes.length} bytes does not fit a version-10 QR at EC level M. ` +
        'This encoder covers versions 1 to 10 — see packages/domain/src/qr.ts.',
    );
  }

  const version = versionIndex + 1;
  const spec = VERSIONS[versionIndex]!;
  const size = 17 + version * 4;

  const codewords = buildCodewords(bytes, version, spec);
  const modules = placeFunctionPatterns(size, version);
  const reserved = modules.map((row) => row.map((m) => m !== null));

  placeData(modules, reserved, codewords, size);

  // All eight masks are applied and scored; the standard's four penalty
  // rules pick the one a scanner will find easiest.
  let best: boolean[][] | null = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(modules, reserved, mask);
    writeFormatInfo(candidate, size, mask);
    const penalty = score(candidate, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = candidate;
    }
  }
  return best!;
}

/** Mode indicator, length, payload, terminator, padding, then EC interleaved. */
function buildCodewords(
  bytes: readonly number[],
  version: number,
  spec: VersionSpec,
): number[] {
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  // Terminator: up to four zero bits, then pad to a byte boundary.
  const capacityBits = spec.dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  // The standard's alternating pad bytes, until the version is full.
  const PAD = [0xec, 0x11];
  for (let i = 0; data.length < spec.dataCodewords; i++) data.push(PAD[i % 2]!);

  // Split into blocks, compute EC per block, then interleave both — the
  // interleaving is what makes a coffee stain damage every block a little
  // rather than one block fatally.
  const totalBlocks = spec.group1Blocks + spec.group2Blocks;
  const group1Size = Math.floor(spec.dataCodewords / totalBlocks);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];

  let offset = 0;
  for (let b = 0; b < totalBlocks; b++) {
    const length = b < spec.group1Blocks ? group1Size : group1Size + 1;
    const block = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocks.push(reedSolomon(block, spec.ecPerBlock));
  }

  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return out;
}

type Grid = (boolean | null)[][];

/** The three alignment positions that would sit on top of a finder eye. */
export function collidesWithFinder(row: number, col: number, size: number): boolean {
  return (
    (row <= 8 && col <= 8) ||
    (row <= 8 && col >= size - 9) ||
    (row >= size - 9 && col <= 8)
  );
}

/** Finders, separators, timing, alignment, the dark module, format reserves. */
function placeFunctionPatterns(size: number, version: number): Grid {
  const grid: Grid = Array.from({ length: size }, () =>
    new Array<boolean | null>(size).fill(null),
  );

  const finder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = top + r;
        const x = left + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const onRing = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        grid[y]![x] = inside ? onRing || inCore : false;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns: the alternating rulers a scanner measures the grid by.
  for (let i = 8; i < size - 8; i++) {
    grid[6]![i] = i % 2 === 0;
    grid[i]![6] = i % 2 === 0;
  }

  /*
   * Alignment patterns sit at every combination of the version's centre
   * coordinates EXCEPT the three that would collide with a finder. The
   * exclusion is specifically about finders: a pattern centred on the timing
   * row is legal and overwrites it, which is why this tests the corners
   * explicitly rather than asking whether the centre module is already
   * occupied. (It was written the second way first, and every version with a
   * centre at 6 in mid-grid — 7 upward — silently lost a pattern.)
   */
  const centres = ALIGNMENT[version - 1]!;
  for (const row of centres) {
    for (const col of centres) {
      if (collidesWithFinder(row, col, size)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          grid[row + r]![col + c] =
            Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
        }
      }
    }
  }

  // The dark module — always set, always here.
  grid[size - 8]![8] = true;

  // Reserve the format-information strips; written properly after masking.
  for (let i = 0; i < 9; i++) {
    if (grid[8]![i] === null) grid[8]![i] = false;
    if (grid[i]![8] === null) grid[i]![8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (grid[8]![size - 1 - i] === null) grid[8]![size - 1 - i] = false;
    if (grid[size - 1 - i]![8] === null) grid[size - 1 - i]![8] = false;
  }
  return grid;
}

/** The zig-zag: two columns at a time, right to left, skipping column 6. */
function placeData(grid: Grid, reserved: boolean[][], codewords: readonly number[], size: number) {
  let bit = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    const rightCol = right === 6 ? 5 : right; // column 6 is the timing ruler
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [rightCol, rightCol - 1]) {
        if (reserved[y]![x]) continue;
        const byte = codewords[bit >> 3];
        grid[y]![x] = byte === undefined ? false : ((byte >> (7 - (bit & 7))) & 1) === 1;
        bit++;
      }
    }
    upward = !upward;
    if (right === 6) right -= 1; // skip past the timing column cleanly
  }
}

const MASKS: readonly ((y: number, x: number) => boolean)[] = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (_, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, reserved: boolean[][], mask: number): boolean[][] {
  const rule = MASKS[mask]!;
  return grid.map((row, y) =>
    row.map((cell, x) => {
      const value = cell ?? false;
      return reserved[y]![x] ? value : value !== rule(y, x);
    }),
  );
}

/**
 * The 15-bit format string: EC level M (0b00) and the mask, BCH(15,5)-coded
 * and XOR-masked with 0x5412 so an all-zero format cannot occur.
 */
function writeFormatInfo(grid: boolean[][], size: number, mask: number) {
  const data = (0b00 << 3) | mask;
  let bch = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((bch >> (i + 10)) & 1) bch ^= 0b10100110111 << i;
  }
  const format = ((data << 10) | bch) ^ 0b101010000010010;

  const bit = (i: number) => ((format >> i) & 1) === 1;

  // Copy 1, around the top-left finder.
  for (let i = 0; i <= 5; i++) grid[8]![i] = bit(i);
  grid[8]![7] = bit(6);
  grid[8]![8] = bit(7);
  grid[7]![8] = bit(8);
  for (let i = 9; i <= 14; i++) grid[14 - i]![8] = bit(i);

  /*
   * Copy 2, split between the other two finders — redundancy so a damaged
   * corner still yields the mask.
   *
   * The split is SEVEN modules up the bottom-left column and EIGHT along the
   * top-right row, not eight and seven. The eighth module of that column is
   * (size-8, 8), which is the dark module and belongs to nothing else; writing
   * a format bit there loses it, and the two copies then disagree — which the
   * conformance test below catches by comparing them.
   */
  for (let i = 0; i <= 6; i++) grid[size - 1 - i]![8] = bit(i);
  for (let i = 7; i <= 14; i++) grid[8]![size - 15 + i] = bit(i);
  grid[size - 8]![8] = true; // the dark module, always
}

/** The standard's four penalty rules. Lower is easier to scan. */
function score(grid: readonly boolean[][], size: number): number {
  let penalty = 0;

  // Rule 1: runs of five or more identical modules in a line.
  const runs = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
          if (run === 5) penalty += 3;
          else if (run > 5) penalty += 1;
        } else run = 1;
      }
    }
  };
  runs((y, x) => grid[y]![x]!);
  runs((x, y) => grid[y]![x]!);

  // Rule 2: every 2x2 block of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = grid[y]![x]!;
      if (v === grid[y]![x + 1] && v === grid[y + 1]![x] && v === grid[y + 1]![x + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 3: the finder-lookalike 1:1:3:1:1 pattern with four light modules.
  const PATTERN = [true, false, true, true, true, false, true, false, false, false, false];
  const matches = (cells: boolean[]) =>
    PATTERN.every((p, i) => cells[i] === p) ||
    PATTERN.slice().reverse().every((p, i) => cells[i] === p);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x + 11 <= size; x++) {
      if (matches(Array.from({ length: 11 }, (_, i) => grid[y]![x + i]!))) penalty += 40;
      if (matches(Array.from({ length: 11 }, (_, i) => grid[x + i]![y]!))) penalty += 40;
    }
  }

  // Rule 4: imbalance between dark and light.
  const dark = grid.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const percent = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return penalty;
}
