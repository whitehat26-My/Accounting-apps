import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import { isErr, unwrap } from '../src/result.js';
import { validateJournalEntry } from '../src/journal-entry.js';
import {
  buildWithholdingPaymentJournal,
  computeWithholding,
  resolveWithholdingRate,
  type WithholdingRate,
} from '../src/withholding.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);

const rate = (over: Partial<WithholdingRate> = {}): WithholdingRate => ({
  id: 'wht-1',
  paymentType: 'ROYALTY',
  countryCode: null,
  // Fictional. There are no statutory rates in the tests either — the point is
  // that the arithmetic is right for whatever rate is supplied.
  rateBasisPoints: 1000n,
  validFrom: '2026-01-01',
  validTo: null,
  ...over,
});

const ACCOUNTS = {
  accountsPayableId: 'acc-ap',
  bankAccountId: 'acc-bank',
  withholdingPayableId: 'acc-wht',
};

const CTX = {
  entryDate: '2026-08-20',
  documentType: 'PAYMENT',
  documentId: 'pay-1',
  contactId: 'sup-1',
};

describe('resolveWithholdingRate', () => {
  const rates = [
    rate({ id: 'general', countryCode: null, rateBasisPoints: 1000n }),
    rate({ id: 'treaty-sg', countryCode: 'SG', rateBasisPoints: 800n }),
    rate({ id: 'expired', countryCode: null, validFrom: '2020-01-01', validTo: '2020-12-31' }),
  ];

  it('prefers a treaty rate for the recipient country', () => {
    expect(resolveWithholdingRate(rates, 'ROYALTY', 'SG', '2026-08-20')?.id).toBe('treaty-sg');
  });

  it('falls back to the general rate when no treaty rate exists', () => {
    expect(resolveWithholdingRate(rates, 'ROYALTY', 'JP', '2026-08-20')?.id).toBe('general');
  });

  it('uses the general rate when the recipient country is unknown', () => {
    expect(resolveWithholdingRate(rates, 'ROYALTY', null, '2026-08-20')?.id).toBe('general');
  });

  it('ignores a rate whose validity window has closed', () => {
    expect(resolveWithholdingRate([rates[2]!], 'ROYALTY', null, '2026-08-20')).toBeUndefined();
  });

  it('returns undefined for a payment type with no rate at all', () => {
    // This is the shipped state: `wht_rate` is seeded empty on purpose, so
    // every payment type resolves to nothing until a verified rate is loaded.
    expect(resolveWithholdingRate([], 'TECHNICAL_FEE', null, '2026-08-20')).toBeUndefined();
  });

  it('does not leak a rate across payment types', () => {
    expect(resolveWithholdingRate(rates, 'INTEREST', 'SG', '2026-08-20')).toBeUndefined();
  });
});

describe('computeWithholding', () => {
  it('splits the gross into net and withheld', () => {
    const c = unwrap(computeWithholding(rm('10000.00'), rate()));
    expect(c.withheldAmount.toDecimalString()).toBe('1000.0000');
    expect(c.netPayable.toDecimalString()).toBe('9000.0000');
  });

  it('rejects a non-positive gross', () => {
    expect(isErr(computeWithholding(rm('0'), rate()))).toBe(true);
    expect(isErr(computeWithholding(rm('-1'), rate()))).toBe(true);
  });

  it('rejects a rate above 100%', () => {
    const result = computeWithholding(rm('100.00'), rate({ rateBasisPoints: 10_001n }));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]).toMatchObject({ code: 'WITHHOLDING_EXCEEDS_GROSS' });
  });

  it('a zero rate withholds nothing and pays the whole gross', () => {
    const c = unwrap(computeWithholding(rm('500.00'), rate({ rateBasisPoints: 0n })));
    expect(c.withheldAmount.isZero()).toBe(true);
    expect(c.netPayable.toDecimalString()).toBe('500.0000');
  });

  it('net + withheld always equals gross exactly (property)', () => {
    // The reason net is computed by subtraction rather than by a second
    // multiplication: gross×(1-r) and gross-gross×r round apart, and the
    // entry then fails to balance by a sen.
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100_000_000_000n }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        (units, bp) => {
          const gross = Money.fromUnits(units, MYR);
          const c = unwrap(computeWithholding(gross, rate({ rateBasisPoints: bp })));
          expect(c.netPayable.add(c.withheldAmount).equals(gross)).toBe(true);
        },
      ),
    );
  });
});

describe('withholding journal', () => {
  it('debits AP with the GROSS, not the net', () => {
    // The supplier's claim is discharged in full. Debiting only the net would
    // leave the bill permanently part-paid and break invariant #7.
    const c = unwrap(computeWithholding(rm('10000.00'), rate()));
    const entry = buildWithholdingPaymentJournal(c, ACCOUNTS, CTX)!;

    const ap = entry.lines.find((l) => l.accountId === 'acc-ap')!;
    expect(ap.side).toBe('DEBIT');
    expect(ap.amount.toDecimalString()).toBe('10000.0000');

    expect(entry.lines.find((l) => l.accountId === 'acc-bank')!.amount.toDecimalString()).toBe(
      '9000.0000',
    );
    expect(entry.lines.find((l) => l.accountId === 'acc-wht')!.amount.toDecimalString()).toBe(
      '1000.0000',
    );
  });

  it('posts nothing when nothing is withheld', () => {
    const c = unwrap(computeWithholding(rm('500.00'), rate({ rateBasisPoints: 0n })));
    expect(buildWithholdingPaymentJournal(c, ACCOUNTS, CTX)).toBeNull();
  });

  it('always balances (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 100_000_000_000n }),
        fc.bigInt({ min: 1n, max: 10_000n }),
        (units, bp) => {
          const c = unwrap(
            computeWithholding(Money.fromUnits(units, MYR), rate({ rateBasisPoints: bp })),
          );
          const entry = buildWithholdingPaymentJournal(c, ACCOUNTS, CTX);
          if (entry === null) return;
          expect(validateJournalEntry(entry, MYR).ok).toBe(true);
        },
      ),
    );
  });

  it('withholding the entire gross drops the bank line rather than posting zero', () => {
    const c = unwrap(computeWithholding(rm('100.00'), rate({ rateBasisPoints: 10_000n })));
    const entry = buildWithholdingPaymentJournal(c, ACCOUNTS, CTX)!;
    expect(entry.lines.find((l) => l.accountId === 'acc-bank')).toBeUndefined();
    expect(validateJournalEntry(entry, MYR).ok).toBe(true);
  });
});
