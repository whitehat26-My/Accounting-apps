import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  counterpartyFromNarrative,
  extractReferences,
  jaroWinkler,
  nameSimilarity,
  normaliseName,
  referenceMatch,
} from '../src/text.js';

describe('jaroWinkler', () => {
  it('is 1 for identical strings and 0 for nothing in common', () => {
    expect(jaroWinkler('NUSANTARA', 'NUSANTARA')).toBe(1);
    expect(jaroWinkler('ABC', 'XYZ')).toBe(0);
  });

  it('rewards a shared prefix, which is how bank fields truncate', () => {
    // The reason this metric was chosen over Levenshtein: a name cut off at
    // the field width should still score highly, while a difference at the
    // START of the string should not.
    const truncated = jaroWinkler('NUSANTARA RETAIL SDN BHD', 'NUSANTARA RETAIL SDN B');
    const differentStart = jaroWinkler('NUSANTARA RETAIL SDN BHD', 'XUSANTARA RETAIL SDN BHD');
    expect(truncated).toBeGreaterThan(differentStart);
    expect(truncated).toBeGreaterThan(0.95);
  });

  it('is symmetric and bounded (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (a, b) => {
        const score = jaroWinkler(a, b);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
        expect(jaroWinkler(b, a)).toBeCloseTo(score, 10);
      }),
    );
  });

  it('handles the empty string without dividing by zero', () => {
    expect(jaroWinkler('', '')).toBe(1);
    expect(jaroWinkler('', 'ABC')).toBe(0);
  });
});

describe('normaliseName — Malaysian entity suffixes', () => {
  it('treats SDN BHD, SDN. BHD. and S/B as the same thing', () => {
    const forms = [
      'Nusantara Retail Sdn Bhd',
      'NUSANTARA RETAIL SDN. BHD.',
      'Nusantara Retail S/B',
      'NUSANTARA RETAIL SENDIRIAN BERHAD',
    ].map(normaliseName);

    expect(new Set(forms).size).toBe(1);
  });

  it('treats BHD and BERHAD as the same', () => {
    expect(normaliseName('Malayan Banking Berhad')).toBe(normaliseName('MALAYAN BANKING BHD'));
  });

  it('does not let a shared suffix make two companies look alike', () => {
    // The failure this guards: with a suffix-heavy corpus and a
    // prefix-weighted metric, every "... SDN BHD" scores alike against every
    // other. Different names must still be clearly different.
    expect(nameSimilarity('Alpha Trading Sdn Bhd', 'Zulkifli Motors Sdn Bhd')).toBeLessThan(0.85);
  });

  it('collapses runs of whitespace', () => {
    expect(normaliseName('  Alpha   Trading  ')).toBe(normaliseName('Alpha Trading'));
  });

  it('turns punctuation into a separator rather than deleting it', () => {
    // Deliberate: deleting punctuation would join 'ABC,XYZ' into one token and
    // make two unrelated parties look like a single name. The cost is that
    // 'A.B.C' does not normalise to exactly 'ABC' — which is fine, because the
    // engine compares by SIMILARITY, not by normalised equality, and the two
    // are still comfortably above the matching threshold.
    expect(normaliseName('A.B.C Enterprise')).toBe('A B C ENT');
    expect(nameSimilarity('A.B.C Enterprise', 'ABC Enterprises')).toBeGreaterThan(0.85);
  });
});

describe('counterpartyFromNarrative', () => {
  const cases: [string, string][] = [
    ['IBG TRANSFER FR NUSANTARA RETAIL SDN BHD', 'NUSANTARA RETAIL SDNBHD'],
    ['DUITNOW QR PYMT SELANGOR SUPPLIES SDN BHD', 'SELANGOR SUPPLIES SDNBHD'],
    // The document reference goes too: it is not part of a name, and leaving
    // it in front of one is enough to push a genuine match below the
    // similarity threshold, because a prefix-weighted metric reads the leading
    // mismatch as strong evidence of a different party.
    ['FPX PAYMENT INV1042 ALPHA TRADING', 'ALPHA TRDG'],
    ['CHQ 123456 PENANG HARDWARE', 'PENANG HARDWARE'],
    ['MEPS IBFT JOHOR PLASTICS S/B', 'JOHOR PLASTICS SDNBHD'],
    ['INSTANT TRANSFER TENAGA NASIONAL BHD', 'TENAGA NASIONAL BHD'],
  ];

  for (const [narrative, expected] of cases) {
    it(`strips the rail prefix from "${narrative}"`, () => {
      expect(counterpartyFromNarrative(narrative)).toBe(expected);
    });
  }

  it('returns empty for a narrative that is nothing but rail noise', () => {
    // Critical: an empty remainder must NOT be scored as a name match, or
    // every DuitNow line matches every contact.
    expect(counterpartyFromNarrative('DUITNOW QR PYMT')).toBe('');
    expect(counterpartyFromNarrative('ATM')).toBe('');
  });

  it('drops long digit runs, which are account numbers not names', () => {
    expect(counterpartyFromNarrative('IBG TRANSFER FR 514122334455 ALPHA')).toBe('ALPHA');
  });
});

describe('extractReferences', () => {
  it('finds a prefixed invoice number in any of its written forms', () => {
    for (const narrative of ['INV-1042', 'INV1042', 'INV 1042', '#1042', 'FPX PAYMENT INV/1042']) {
      expect(extractReferences(narrative)).toContain('1042');
    }
  });

  it('strips leading zeros so INV-01042 and 1042 agree', () => {
    expect(extractReferences('PYMT INV-01042')).toContain('1042');
  });

  it('ignores single digits and long account numbers', () => {
    const refs = extractReferences('TRANSFER 5 FR ACCT 514122334455');
    expect(refs).not.toContain('5');
    expect(refs).not.toContain('514122334455');
  });
});

describe('referenceMatch', () => {
  it('reports an EXACT match when the full document number is present', () => {
    expect(referenceMatch('INV-01042', 'FPX PAYMENT INV01042')).toBe('EXACT');
    expect(referenceMatch('INV-01042', 'FPX PAYMENT INV-01042 THANKS')).toBe('EXACT');
  });

  it('reports a NUMERIC match when only the digits are present', () => {
    // Weaker evidence, and scored lower: a bare number collides with dates and
    // amounts that happen to sit in the narrative.
    expect(referenceMatch('INV-01042', 'DUITNOW TRANSFER 1042')).toBe('NUMERIC');
  });

  it('reports NONE when the number is absent', () => {
    expect(referenceMatch('INV-01042', 'DUITNOW TRANSFER 9999')).toBe('NONE');
  });

  it('does not match on a document number with no digits at all', () => {
    expect(referenceMatch('--', 'PAYMENT 1042')).toBe('NONE');
  });
});
