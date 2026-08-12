import { describe, expect, it } from 'vitest';
import {
  pairingAccountCodes,
  standardCounterAccount,
  STANDARD_ADJUSTMENTS,
  type PairingSide,
} from '../src/journal-pairing.js';

/**
 * The table is data, so what is worth testing is the properties that stop it
 * being a liability rather than the contents of any one row.
 *
 * The dangerous failure here is not a wrong suggestion — a person sees that and
 * changes it. It is a suggestion that is right on Tuesday and different on
 * Wednesday because two rules quietly own the same key and `find` picked
 * whichever came first after somebody reordered the array.
 */

const SIDES: PairingSide[] = ['DEBIT', 'CREDIT'];

describe('the lookup is a function, not a coin toss', () => {
  it('has no two rules sharing an account and side', () => {
    const keys = STANDARD_ADJUSTMENTS.map((r) => `${r.when.code}/${r.when.side}`);
    const duplicated = keys.filter((key, i) => keys.indexOf(key) !== i);
    expect(
      duplicated,
      '\nTwo rules claim the same (code, side). The lookup returns whichever is ' +
        'first in the array, so the suggestion would change with a reorder and ' +
        'nobody would connect the two:\n  ' + duplicated.join('\n  '),
    ).toEqual([]);
  });

  it('never suggests an account back to itself', () => {
    // A line that pairs with its own account is not an entry, it is a no-op
    // that still passes the balanced-entry check and posts nothing meaningful.
    for (const rule of STANDARD_ADJUSTMENTS) {
      expect(rule.then.code, `${rule.when.code} ${rule.when.side}`).not.toBe(rule.when.code);
    }
  });

  it('answers the same way every time it is asked', () => {
    for (const rule of STANDARD_ADJUSTMENTS) {
      const first = standardCounterAccount(rule.when.code, rule.when.side);
      const second = standardCounterAccount(rule.when.code, rule.when.side);
      expect(first).toEqual(second);
      expect(first?.then.code).toBe(rule.then.code);
    }
  });
});

describe('silence is the normal answer', () => {
  it('has no opinion about an account it does not name', () => {
    for (const side of SIDES) {
      // 5000 Cost of Sales is seeded and deliberately absent from the table:
      // what it pairs with depends entirely on the transaction.
      expect(standardCounterAccount('5000', side)).toBeNull();
      expect(standardCounterAccount('4000', side)).toBeNull();
      expect(standardCounterAccount('not-a-code', side)).toBeNull();
    }
  });

  it('has no opinion about the side a rule does not cover', () => {
    // 6300 debited is depreciation being charged. 6300 credited is a reversal or
    // a correction, and what it pairs with is the entry being corrected — which
    // this table cannot know.
    expect(standardCounterAccount('6300', 'DEBIT')).not.toBeNull();
    expect(standardCounterAccount('6300', 'CREDIT')).toBeNull();
  });
});

describe('every rule can be evaluated by the person reading it', () => {
  it('explains itself in a sentence', () => {
    for (const rule of STANDARD_ADJUSTMENTS) {
      const { because } = rule;
      expect(because.length, `${rule.when.code} ${rule.when.side}`).toBeGreaterThan(25);
      // A sentence, not a label: the form prints this beside the suggestion and
      // "Depreciation pairing" tells an accountant nothing they did not know.
      expect(because.endsWith('.'), `${rule.when.code}: "${because}"`).toBe(true);
      expect(because[0]).toBe(because[0]!.toUpperCase());
    }
  });

  /*
   * The guard against this file drifting into statutory territory, which is the
   * one way a pairing table becomes genuinely harmful rather than merely wrong.
   * A rate or a threshold here would be a number nobody dated and nobody
   * verified, presented to an accountant as though the system knew it.
   */
  it('states no rate, threshold or authority', () => {
    for (const rule of STANDARD_ADJUSTMENTS) {
      expect(rule.because, rule.because).not.toMatch(/\d+\s*%|LHDN|RMCD|SST|threshold/i);
    }
  });
});

describe('the codes it depends on', () => {
  it('reports every account code it mentions, for the seed to be checked against', () => {
    const codes = pairingAccountCodes();
    expect(codes).toEqual([...new Set(codes)].sort());
    for (const rule of STANDARD_ADJUSTMENTS) {
      expect(codes).toContain(rule.when.code);
      expect(codes).toContain(rule.then.code);
    }
  });
});
