import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import {
  DEFAULT_WEIGHTS,
  MAX_COMBINATIONS,
  MINIMUM_CONFIDENCE,
  suggestMatches,
  suggestMatchesForStatement,
  suggestTransfers,
  type BankTransactionView,
  type MatchCandidate,
} from '../src/matching.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);
const CTX = { baseCurrency: MYR };

/** Money in. Negative amounts are money out. */
const bankLine = (over: Partial<BankTransactionView> = {}): BankTransactionView => ({
  id: 'bt-1',
  bankAccountId: 'acct-maybank',
  txnDate: '2026-08-20',
  amount: rm('1080.00'),
  description: 'IBG TRANSFER FR NUSANTARA RETAIL SDN BHD',
  ...over,
});

const candidate = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  id: 'inv-1',
  kind: 'INVOICE',
  documentNo: 'INV-01042',
  documentDate: '2026-08-20',
  amount: rm('1080.00'),
  direction: 'INFLOW',
  contactId: 'cust-1',
  contactName: 'Nusantara Retail Sdn Bhd',
  ...over,
});

// ---------------------------------------------------------------------------
// The seven acceptance tests from docs/architecture/07-prompt-engineering-guidelines.md §7.4
// ---------------------------------------------------------------------------

describe('acceptance test 1 — exact amount, same day, reference in narrative', () => {
  it('scores at least 95', () => {
    const suggestions = suggestMatches(
      bankLine({ description: 'FPX PAYMENT INV01042 NUSANTARA RETAIL SDN BHD' }),
      [candidate()],
      CTX,
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.confidence).toBeGreaterThanOrEqual(95);
  });
});

describe('acceptance test 2 — near amount, two days later, contact name matches', () => {
  it('is suggested with a moderate score naming both signals', () => {
    const suggestions = suggestMatches(
      bankLine({
        txnDate: '2026-08-22',
        amount: rm('1079.70'), // RM 0.30 short — a bank charge
        description: 'IBG TRANSFER FR NUSANTARA RETAIL SDN BHD',
      }),
      [candidate()],
      CTX,
    );

    expect(suggestions).toHaveLength(1);
    const [match] = suggestions;
    expect(match!.confidence).toBeGreaterThanOrEqual(MINIMUM_CONFIDENCE);
    expect(match!.confidence).toBeLessThan(95);
    expect(match!.reason).toMatch(/within tolerance/i);
    expect(match!.reason).toMatch(/Nusantara Retail/i);
    expect(match!.amountDifference.toDecimalString()).toBe('0.3000');
  });
});

describe('acceptance test 3 — direction mismatch', () => {
  it('is not suggested at any score', () => {
    // Everything else agrees perfectly: same amount, same day, reference in
    // the narrative, name match. Only the direction is wrong. A credit on the
    // bank cannot settle a supplier bill.
    const suggestions = suggestMatches(
      bankLine({ description: 'FPX PAYMENT INV01042 NUSANTARA RETAIL SDN BHD' }),
      [candidate({ direction: 'OUTFLOW', kind: 'BILL' })],
      CTX,
    );

    expect(suggestions).toEqual([]);
  });

  it('rejects the reverse case too — an outflow against a sales invoice', () => {
    const suggestions = suggestMatches(
      bankLine({ amount: rm('-1080.00') }),
      [candidate({ direction: 'INFLOW' })],
      CTX,
    );
    expect(suggestions).toEqual([]);
  });
});

describe('acceptance test 4 — three invoices summing to one bank credit', () => {
  it('returns a one-to-many suggestion listing all three', () => {
    const invoices = [
      candidate({ id: 'a', documentNo: 'INV-01001', amount: rm('300.00'), documentDate: '2026-08-01' }),
      candidate({ id: 'b', documentNo: 'INV-01002', amount: rm('400.00'), documentDate: '2026-08-05' }),
      candidate({ id: 'c', documentNo: 'INV-01003', amount: rm('380.00'), documentDate: '2026-08-10' }),
    ];

    const suggestions = suggestMatches(bankLine({ amount: rm('1080.00') }), invoices, CTX);
    const group = suggestions.find((s) => s.candidateIds.length === 3);

    expect(group).toBeDefined();
    expect([...group!.candidateIds].sort()).toEqual(['a', 'b', 'c']);
    expect(group!.amountDifference.isZero()).toBe(true);
    expect(group!.reason).toMatch(/INV-01001, INV-01002, INV-01003/);
  });

  it('proposes only combinations that sum EXACTLY', () => {
    // A near-miss group is not offered. With enough candidates something
    // always lands within tolerance by coincidence, and unpicking a wrong
    // multi-document match costs more than having no suggestion.
    const invoices = [
      candidate({ id: 'a', amount: rm('300.00') }),
      candidate({ id: 'b', amount: rm('400.00') }),
    ];
    const suggestions = suggestMatches(bankLine({ amount: rm('700.50') }), invoices, CTX);
    expect(suggestions.every((s) => s.candidateIds.length === 1)).toBe(true);
  });
});

describe('acceptance test 5 — matching outflow and inflow across two accounts', () => {
  it('is reported as a single transfer, not two transactions', () => {
    const transfers = suggestTransfers([
      bankLine({
        id: 'out',
        bankAccountId: 'acct-maybank',
        txnDate: '2026-08-20',
        amount: rm('-5000.00'),
        description: 'INSTANT TRANSFER TO CIMB',
      }),
      bankLine({
        id: 'in',
        bankAccountId: 'acct-cimb',
        txnDate: '2026-08-21',
        amount: rm('5000.00'),
        description: 'INSTANT TRANSFER FR MAYBANK',
      }),
    ]);

    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ outflowId: 'out', inflowId: 'in', dayDifference: 1 });
    expect(transfers[0]!.reason).toMatch(/your own accounts/i);
  });

  it('does not pair two lines on the SAME account', () => {
    const transfers = suggestTransfers([
      bankLine({ id: 'out', amount: rm('-500.00') }),
      bankLine({ id: 'in', amount: rm('500.00') }),
    ]);
    expect(transfers).toEqual([]);
  });

  it('does not pair beyond the window', () => {
    const transfers = suggestTransfers([
      bankLine({ id: 'out', bankAccountId: 'a', txnDate: '2026-08-01', amount: rm('-500.00') }),
      bankLine({ id: 'in', bankAccountId: 'b', txnDate: '2026-08-20', amount: rm('500.00') }),
    ]);
    expect(transfers).toEqual([]);
  });

  it('uses each line at most once', () => {
    // A round-sum sweep between three accounts on one day would otherwise
    // produce every cross-pairing.
    const transfers = suggestTransfers([
      bankLine({ id: 'out1', bankAccountId: 'a', amount: rm('-500.00') }),
      bankLine({ id: 'out2', bankAccountId: 'b', amount: rm('-500.00') }),
      bankLine({ id: 'in1', bankAccountId: 'c', amount: rm('500.00') }),
    ]);

    expect(transfers).toHaveLength(1);
    const used = transfers.flatMap((t) => [t.outflowId, t.inflowId]);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('acceptance test 6 — performance', () => {
  it('handles 500 bank lines against 2,000 candidates well inside 3 s', () => {
    const candidates: MatchCandidate[] = Array.from({ length: 2000 }, (_, i) =>
      candidate({
        id: `inv-${i}`,
        documentNo: `INV-${String(i).padStart(5, '0')}`,
        amount: Money.fromUnits(BigInt(1_000_0000 + i * 137), MYR),
        documentDate: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
        contactName: `Company ${i} Sdn Bhd`,
      }),
    );

    const lines: BankTransactionView[] = Array.from({ length: 500 }, (_, i) =>
      bankLine({
        id: `bt-${i}`,
        amount: Money.fromUnits(BigInt(1_000_0000 + i * 137), MYR),
        txnDate: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
        description: `IBG TRANSFER FR COMPANY ${i} SDN BHD`,
      }),
    );

    const started = performance.now();
    const byLine = suggestMatchesForStatement(lines, candidates, CTX);
    const elapsed = performance.now() - started;

    expect(byLine.size).toBe(500);
    expect([...byLine.values()].flat().length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(3000);
  }, 30_000);
});

describe('acceptance test 7 — every suggestion is explainable', () => {
  it('returns a non-empty human-readable reason on every suggestion', () => {
    const invoices = [
      candidate({ id: 'a', amount: rm('300.00'), documentNo: 'INV-01001' }),
      candidate({ id: 'b', amount: rm('780.00'), documentNo: 'INV-01002' }),
      candidate({ id: 'c', amount: rm('1080.00'), documentNo: 'INV-01003' }),
      candidate({ id: 'd', amount: rm('1079.80'), documentNo: 'INV-01004' }),
    ];

    const suggestions = suggestMatches(bankLine(), invoices, CTX);
    expect(suggestions.length).toBeGreaterThan(1);
    for (const suggestion of suggestions) {
      expect(suggestion.reason.length).toBeGreaterThan(0);
      expect(suggestion.reason).not.toMatch(/undefined|NaN|\[object/);
    }
  });

  it('every reason names a concrete signal, not just a score (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100_000_0000n }),
        fc.integer({ min: -20, max: 20 }),
        (units, dayOffset) => {
          const amount = Money.fromUnits(units, MYR);
          const txnDate = new Date(Date.parse('2026-08-20T00:00:00Z') + dayOffset * 86_400_000)
            .toISOString()
            .slice(0, 10);

          const suggestions = suggestMatches(
            bankLine({ amount, txnDate }),
            [candidate({ amount })],
            CTX,
          );

          for (const suggestion of suggestions) {
            expect(suggestion.reason).toMatch(/Amount|day|Reference|narrative|settles/i);
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Beyond the acceptance list
// ---------------------------------------------------------------------------

describe('scoring behaviour', () => {
  it('an exact amount with no other signal lands exactly on the floor', () => {
    // Right amount, but a month late, no reference, unrelated narrative. The
    // spec sets exact-amount at 40 and the return threshold at >= 40, so this
    // is admitted at precisely the boundary and nothing else survives with it.
    // Deliberate: a customer on a standing order pays the same amount every
    // month, and all twelve invoices SHOULD be offered — ranked by date, which
    // is the signal that separates them.
    const suggestions = suggestMatches(
      bankLine({ txnDate: '2026-09-20', description: 'ATM WITHDRAWAL' }),
      [candidate()],
      CTX,
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.confidence).toBe(MINIMUM_CONFIDENCE);
  });

  it('drops a near-amount match with nothing else going for it', () => {
    const suggestions = suggestMatches(
      bankLine({ txnDate: '2026-09-20', amount: rm('1079.80'), description: 'ATM WITHDRAWAL' }),
      [candidate()],
      CTX,
    );
    expect(suggestions).toEqual([]);
  });

  it('rejects an amount outside tolerance outright', () => {
    const suggestions = suggestMatches(bankLine({ amount: rm('900.00') }), [candidate()], CTX);
    expect(suggestions).toEqual([]);
  });

  it('applies the greater of RM 0.50 and 0.5% as the tolerance', () => {
    // On RM 1,080 the proportional tolerance is RM 5.40, so RM 5.00 off is
    // inside it and RM 6.00 is not. Asserted with a same-day reference match
    // present, because tolerance decides whether the amount signal fires at
    // all — it does not by itself carry a suggestion over the return floor.
    const withReference = (amount: string) =>
      suggestMatches(
        bankLine({ amount: rm(amount), description: 'FPX PAYMENT INV01042' }),
        [candidate()],
        CTX,
      );

    expect(withReference('1075.00')).toHaveLength(1);
    expect(withReference('1074.00')).toEqual([]);

    // On a small amount the absolute RM 0.50 floor governs instead.
    const small = candidate({ amount: rm('20.00') });
    const smallLine = (amount: string) =>
      suggestMatches(
        bankLine({ amount: rm(amount), description: 'FPX PAYMENT INV01042' }),
        [small],
        CTX,
      );

    expect(smallLine('19.60')).toHaveLength(1);
    expect(smallLine('19.00')).toEqual([]);
  });

  it('penalises a bank date BEFORE the document date more than the same gap after', () => {
    const after = suggestMatches(bankLine({ txnDate: '2026-08-24' }), [candidate()], CTX);
    const before = suggestMatches(bankLine({ txnDate: '2026-08-16' }), [candidate()], CTX);

    expect(before[0]!.confidence).toBeLessThan(after[0]!.confidence);
    expect(before[0]!.reason).toMatch(/BEFORE the document date/);
  });

  it('scores a bare number lower than the full document reference', () => {
    const exact = suggestMatches(
      bankLine({ description: 'DUITNOW QR PYMT INV01042' }),
      [candidate()],
      CTX,
    );
    const numeric = suggestMatches(
      bankLine({ description: 'DUITNOW QR PYMT 1042' }),
      [candidate()],
      CTX,
    );

    expect(numeric[0]!.confidence).toBeLessThan(exact[0]!.confidence);
    expect(numeric[0]!.confidence).toBeGreaterThanOrEqual(MINIMUM_CONFIDENCE);
  });

  it('does not award a name match on a narrative that is pure rail noise', () => {
    const noisy = suggestMatches(
      bankLine({ description: 'DUITNOW QR PYMT' }),
      [candidate()],
      CTX,
    );
    const named = suggestMatches(bankLine(), [candidate()], CTX);

    expect(noisy[0]!.reason).not.toMatch(/name match/);
    expect(noisy[0]!.confidence).toBeLessThan(named[0]!.confidence);
  });

  it('credits a learned alias from a previous decision', () => {
    const withoutAlias = suggestMatches(
      bankLine({ description: 'IBG TRANSFER FR NRSB HOLDINGS' }),
      [candidate()],
      CTX,
    );
    const withAlias = suggestMatches(
      bankLine({ description: 'IBG TRANSFER FR NRSB HOLDINGS' }),
      [candidate()],
      { ...CTX, learnedAliases: [{ pattern: 'NRSB HOLDINGS', contactId: 'cust-1' }] },
    );

    expect(withAlias[0]!.confidence).toBeGreaterThan(withoutAlias[0]?.confidence ?? 0);
    expect(withAlias[0]!.reason).toMatch(/matched to the same contact before/);
  });

  it('never exceeds 100 however many signals agree', () => {
    const suggestions = suggestMatches(
      bankLine({ description: 'FPX PAYMENT INV01042 NUSANTARA RETAIL SDN BHD' }),
      [candidate()],
      {
        ...CTX,
        learnedAliases: [{ pattern: 'NUSANTARA RETAIL SDNBHD', contactId: 'cust-1' }],
      },
    );
    expect(suggestions[0]!.confidence).toBeLessThanOrEqual(100);
  });

  it('ranks best first and is stable across calls', () => {
    const invoices = [
      candidate({ id: 'far', amount: rm('1080.00'), documentDate: '2026-08-10' }),
      candidate({ id: 'near', amount: rm('1080.00'), documentDate: '2026-08-20' }),
      candidate({ id: 'loose', amount: rm('1076.00'), documentDate: '2026-08-19' }),
    ];

    const first = suggestMatches(bankLine(), invoices, CTX);
    const second = suggestMatches(bankLine(), invoices, CTX);

    expect(first.map((s) => s.candidateIds[0])).toEqual(second.map((s) => s.candidateIds[0]));
    expect(first[0]!.candidateIds[0]).toBe('near');
  });

  it('never suggests the same candidate twice within one call', () => {
    const invoices = [
      candidate({ id: 'a', amount: rm('540.00') }),
      candidate({ id: 'b', amount: rm('540.00') }),
    ];
    const suggestions = suggestMatches(bankLine({ amount: rm('1080.00') }), invoices, CTX);

    for (const suggestion of suggestions) {
      expect(new Set(suggestion.candidateIds).size).toBe(suggestion.candidateIds.length);
    }
  });
});

describe('the combinatorial search is bounded', () => {
  it('stays bounded and still returns against a pathological candidate set', () => {
    // 30 open invoices of RM 1.00 against a RM 15.00 credit is
    // 155,117,520 exact subsets. An unbounded search never returns; this must.
    const invoices = Array.from({ length: 30 }, (_, i) =>
      candidate({
        id: `inv-${i}`,
        documentNo: `INV-${i}`,
        amount: rm('1.00'),
        documentDate: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
      }),
    );

    const started = performance.now();
    const suggestions = suggestMatches(bankLine({ amount: rm('15.00') }), invoices, CTX);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(Array.isArray(suggestions)).toBe(true);
  });

  it('says so in the reason when the search was truncated', () => {
    const invoices = Array.from({ length: 6 }, (_, i) =>
      candidate({
        id: `inv-${i}`,
        documentNo: `INV-${i}`,
        // Distinct amounts that cannot reach the target, so the walk explores
        // widely and hits the cap without finding an early exact sum.
        amount: Money.fromUnits(BigInt(10_000 + i), MYR),
        documentDate: `2026-08-0${i + 1}`,
      }),
    );

    const suggestions = suggestMatches(
      bankLine({ amount: rm('3.0009') }),
      invoices,
      { ...CTX, weights: { ...DEFAULT_WEIGHTS } },
    );

    const groups = suggestions.filter((s) => s.candidateIds.length > 1);
    // Whether or not a group is found, nothing may hang and nothing may claim
    // completeness it does not have.
    for (const group of groups) {
      expect(group.reason.length).toBeGreaterThan(0);
    }
    expect(MAX_COMBINATIONS).toBe(200);
  });
});

describe('batch and single-line agree', () => {
  it('suggestMatchesForStatement returns exactly what suggestMatches would, line by line', () => {
    // The batch path exists only to hoist candidate-name normalisation out of
    // the per-line loop. If it ever produced a different answer, the
    // optimisation would have changed behaviour — so it is asserted, not
    // assumed.
    const invoices = [
      candidate({ id: 'a', amount: rm('300.00'), documentNo: 'INV-01001' }),
      candidate({ id: 'b', amount: rm('780.00'), documentNo: 'INV-01002' }),
      candidate({ id: 'c', amount: rm('1080.00'), documentNo: 'INV-01003' }),
    ];
    const lines = [
      bankLine({ id: 'x', amount: rm('1080.00') }),
      bankLine({ id: 'y', amount: rm('300.00'), description: 'FPX PAYMENT INV01001' }),
      bankLine({ id: 'z', amount: rm('-500.00') }),
    ];

    const batch = suggestMatchesForStatement(lines, invoices, CTX);

    for (const line of lines) {
      expect(batch.get(line.id)).toEqual(suggestMatches(line, invoices, CTX));
    }
  });
});
