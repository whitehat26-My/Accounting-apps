/**
 * String comparison for bank narratives.
 *
 * Bank statement narratives are the messiest input this system takes. They are
 * truncated to a fixed width, upper-cased, stripped of punctuation by systems
 * that predate Unicode, and prefixed with rail-specific noise that says nothing
 * about who was paid. Everything here exists to get from that to a comparison
 * that a person would agree with.
 *
 * Pure and dependency-free, so the fuzzy-matching thresholds — the numbers most
 * likely to need tuning against real statements — can be tested exhaustively
 * without a database or a fixture file.
 */

/**
 * Jaro-Winkler similarity in [0, 1].
 *
 * Chosen over Levenshtein because it rewards a shared PREFIX, which is exactly
 * the shape of the errors bank narratives produce: a name truncated to the
 * field width ("NUSANTARA RETAIL SDN B") or abbreviated at the end. Levenshtein
 * scores those as badly as a difference at the start of the string, which is
 * far more likely to mean a genuinely different party.
 */
export function jaroWinkler(a: string, b: string): number {
  const jaro = jaroSimilarity(a, b);
  if (jaro === 0) return 0;

  // Standard Winkler adjustment: bonus for up to 4 leading characters in
  // common, scaled by 0.1. Only applied above 0.7 so it cannot promote a
  // genuinely poor match on the strength of a shared first letter.
  if (jaro < 0.7) return jaro;

  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix++;

  return jaro + prefix * 0.1 * (1 - jaro);
}

function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Transpositions: matched characters that appear in a different order.
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const t = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
}

/**
 * Malaysian company-suffix equivalences.
 *
 * `SDN BHD`, `SDN. BHD.` and `S/B` are the same thing, and so are `BHD` and
 * `BERHAD`. A bank narrative truncated at 24 characters routinely keeps the
 * suffix and loses the distinguishing part of the name, so comparing suffixes
 * literally makes unrelated companies look similar and the same company look
 * different depending on which system typed it.
 *
 * The order matters: longer patterns first, so `SDN BHD` is consumed before
 * the bare `BHD` rule can fire on its tail.
 */
const ENTITY_SUFFIXES: readonly [RegExp, string][] = [
  [/\bSDN\.?\s*BHD\.?\b/g, ' SDNBHD '],
  [/\bS\s*\/\s*B\b/g, ' SDNBHD '],
  [/\bSENDIRIAN\s+BERHAD\b/g, ' SDNBHD '],
  [/\bBERHAD\b/g, ' BHD '],
  [/\bBHD\.?\b/g, ' BHD '],
  [/\bENTERPRISE[S]?\b/g, ' ENT '],
  [/\bTRADING\b/g, ' TRDG '],
];

/**
 * Rail and channel prefixes that carry no information about the counterparty.
 *
 * These are the real formats a Malaysian statement uses. Stripping them before
 * a fuzzy name comparison is what stops every IBG transfer scoring alike
 * against every other IBG transfer purely on the shared prefix — which, with a
 * prefix-weighted metric like Jaro-Winkler, would otherwise be a systematic
 * source of false positives.
 */
const NARRATIVE_NOISE: readonly RegExp[] = [
  /\bIBG\s+TRANSFER\s+(FR|TO)\b/g,
  /\bIBG\s+(TRANSFER|PAYMENT|PYMT)\b/g,
  /\bINSTANT\s+TRANSFER\b/g,
  /\bDUITNOW\s*(QR)?\s*(PYMT|PAYMENT|TRANSFER|TFR)?\b/g,
  /\bFPX\s*(PAYMENT|PYMT|TRANSFER)?\b/g,
  /\bMEPS\s*(IBFT|IBG)?\b/g,
  /\bIBFT\b/g,
  /\bCHQ\s*(NO\.?)?\s*\d*/g,
  /\bCHEQUE\s*(NO\.?)?\s*\d*/g,
  /\bTRANSFER\s+(FR|FROM|TO)\b/g,
  /\bPAYMENT\s+(FR|FROM|TO)\b/g,
  /\bGIRO\b/g,
  /\bATM\b/g,
  /\bPOS\s+PURCHASE\b/g,
  /\bDEBIT\s+CARD\b/g,
  /\bREF\s*(NO\.?)?\s*[:#]?/g,
];

/**
 * Normalise a name or narrative for comparison: upper-case, punctuation to
 * spaces, entity suffixes folded, whitespace collapsed.
 */
export function normaliseName(value: string): string {
  let out = value
    .toUpperCase()
    // Keep alphanumerics and the slash, which `S/B` needs; everything else
    // becomes a space so "SDN.BHD." and "SDN BHD" converge.
    .replace(/[^A-Z0-9/]+/g, ' ');

  for (const [pattern, replacement] of ENTITY_SUFFIXES) {
    out = out.replace(pattern, replacement);
  }

  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Strip rail noise from a narrative, leaving what is plausibly the
 * counterparty name.
 *
 * Returns the normalised remainder. When stripping removes everything — a
 * narrative that was pure rail noise, which happens — the result is an empty
 * string rather than a fallback to the original, because scoring an empty
 * remainder as a name match is exactly the false positive this guards against.
 */
export function counterpartyFromNarrative(narrative: string): string {
  let out = normaliseName(narrative);

  for (const pattern of NARRATIVE_NOISE) {
    out = out.replace(pattern, ' ');
  }

  // Document references are not part of a name. Leaving `INV01042` in front of
  // the counterparty is enough to push a genuine name below the similarity
  // threshold, because a prefix-weighted metric reads the leading mismatch as
  // strong evidence of a different party.
  out = out.replace(/\b(INV|BILL|CN|DN|PAY|PO)\s*\d{1,12}\b/g, ' ');

  // Long digit runs are account or reference numbers, not names.
  out = out.replace(/\b\d{5,}\b/g, ' ');

  return out.replace(/\s+/g, ' ').trim();
}

/** How alike two party names are, after Malaysian normalisation. */
export function nameSimilarity(a: string, b: string): number {
  return normalisedSimilarity(normaliseName(a), normaliseName(b));
}

/**
 * Similarity between two ALREADY-normalised names.
 *
 * Separate from `nameSimilarity` so a caller comparing one narrative against
 * thousands of candidates normalises the narrative once instead of once per
 * candidate — the difference between a matching run that meets its 3-second
 * budget and one that does not.
 *
 * Containment is checked first and scores full marks. A bank narrative
 * routinely carries the counterparty name plus branch codes, city names and
 * trailing junk; Jaro-Winkler over the whole string penalises all of that as
 * though it were a different party, when in fact the name is right there.
 */
export function normalisedSimilarity(left: string, right: string): number {
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;

  // Only meaningful names count as containment — a two-character fragment
  // appears inside almost anything.
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length >= 6 && longer.includes(shorter)) return 1;

  return jaroWinkler(left, right);
}

/**
 * Document references found in a narrative.
 *
 * The comparison is deliberately loose in one direction only: `INV-1042`,
 * `INV1042`, `#1042` and a bare `1042` all reduce to `1042`, so a narrative
 * carrying any of those forms matches invoice `INV-01042`. A bare number is
 * kept because Malaysian payers routinely type only the digits into the
 * reference field — but see `referenceMatches` for why a bare number alone is
 * not treated as strong evidence.
 */
export function extractReferences(narrative: string): string[] {
  const found = new Set<string>();
  const upper = narrative.toUpperCase();

  // Prefixed forms: INV-1042, INV1042, BILL 7, CN#3, PAY-9, DN 4.
  for (const match of upper.matchAll(/\b(INV|BILL|CN|DN|PAY|PO)[\s\-#/]*(\d{1,12})\b/g)) {
    found.add(stripLeadingZeros(match[2]!));
  }

  // Hash-prefixed: #1042.
  for (const match of upper.matchAll(/#\s*(\d{1,12})\b/g)) {
    found.add(stripLeadingZeros(match[1]!));
  }

  // Bare numbers of a plausible document length. Long runs are account
  // numbers; a single digit is noise.
  for (const match of upper.matchAll(/\b(\d{2,8})\b/g)) {
    found.add(stripLeadingZeros(match[1]!));
  }

  return [...found].filter((r) => r.length > 0);
}

/**
 * Whether a document number appears in a narrative.
 *
 * Both sides are reduced to their digits before comparison, so `INV-01042`
 * matches a narrative saying `FPX PAYMENT INV1042` or `PYMT 1042`.
 *
 * Returns the strength of the evidence, not just a boolean: a match on the
 * document's full alphanumeric form is stronger than a match on its digits
 * alone, because a short bare number can collide with a date or an amount that
 * happens to sit in the narrative.
 */
/**
 * A narrative pre-processed for repeated comparison.
 *
 * Everything here depends only on the narrative, never on the document being
 * compared against it. Building it once per bank line rather than once per
 * candidate is what keeps a 500-line statement against 2,000 candidates inside
 * its time budget: with a realistic tolerance band, hundreds of candidates
 * survive the amount gate on each line, and every one of them was re-running
 * the same three regex passes over the same string.
 */
export interface NarrativeIndex {
  readonly compact: string;
  readonly references: ReadonlySet<string>;
}

export function indexNarrative(narrative: string): NarrativeIndex {
  return {
    compact: narrative.toUpperCase().replace(/[^A-Z0-9]/g, ''),
    references: new Set(extractReferences(narrative)),
  };
}

export function referenceMatch(
  documentNo: string,
  narrative: string,
): 'EXACT' | 'NUMERIC' | 'NONE' {
  return referenceMatchIndexed(documentNo, indexNarrative(narrative));
}

export function referenceMatchIndexed(
  documentNo: string,
  index: NarrativeIndex,
): 'EXACT' | 'NUMERIC' | 'NONE' {
  const compactDocument = documentNo.toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (compactDocument.length >= 3 && index.compact.includes(compactDocument)) {
    return 'EXACT';
  }

  const digits = stripLeadingZeros(documentNo.replace(/\D/g, ''));
  if (digits.length === 0) return 'NONE';

  return index.references.has(digits) ? 'NUMERIC' : 'NONE';
}

function stripLeadingZeros(value: string): string {
  const stripped = value.replace(/^0+/, '');
  return stripped.length > 0 ? stripped : value.length > 0 ? '0' : '';
}
