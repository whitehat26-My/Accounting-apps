import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import {
  amountForQr,
  buildDuitNowQr,
  crc16,
  crcHex,
  DuitNowQrError,
  MALAYSIA,
  MYR_NUMERIC,
  parseTlv,
  tlv,
  verifyQr,
  type DuitNowQrInput,
  type MerchantAccountTemplate,
} from '../src/duitnow-qr.js';
import { paymentReference } from '../src/collection.js';
import { referenceMatch } from '../src/text.js';

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

/**
 * A merchant template shaped like the real thing, with values that are
 * obviously not.
 *
 * This is NOT a guess at PayNet's assignment and must never be copied into a
 * seed or a default — the module header explains why a plausible-looking
 * template is the worst possible failure here. It exists only so the envelope
 * around it can be tested.
 */
const TEST_ONLY_TEMPLATE: MerchantAccountTemplate = {
  tag: '26',
  fields: [
    ['00', 'TEST.NOT.A.REAL.AID'],
    ['01', 'TEST-MERCHANT-0001'],
  ],
};

const input = (over: Partial<DuitNowQrInput> = {}): DuitNowQrInput => ({
  merchantAccount: TEST_ONLY_TEMPLATE,
  merchantName: 'ACME SDN BHD',
  merchantCity: 'KUALA LUMPUR',
  merchantCategoryCode: '5734',
  amount: rm('1080.00'),
  reference: 'INV00042',
  ...over,
});

// ---------------------------------------------------------------------------
// CRC-16/CCITT-FALSE — the part that is either right or visibly wrong
// ---------------------------------------------------------------------------

describe('crc16', () => {
  it('matches the published CCITT-FALSE check value', () => {
    // 0x29B1 over "123456789" is the standard check vector. It pins all four
    // parameters at once — polynomial 0x1021, init 0xFFFF, no input or output
    // reflection, no final XOR. Any one of them wrong moves this number, and a
    // QR with a bad CRC is rejected by every scanner.
    expect(crc16('123456789')).toBe(0x29b1);
    expect(crcHex('123456789')).toBe('29B1');
  });

  it('starts from 0xFFFF rather than zero', () => {
    // The difference between CCITT-FALSE and CRC-16/XMODEM is exactly this
    // initial value, and an empty input is where they diverge most visibly:
    // XMODEM would give 0x0000.
    expect(crc16('')).toBe(0xffff);
  });

  it('always renders as four upper-case hex digits', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(crcHex(s)).toMatch(/^[0-9A-F]{4}$/);
      }),
    );
  });

  it('changes when any character changes', () => {
    expect(crc16('INV00042')).not.toBe(crc16('INV00043'));
  });
});

// ---------------------------------------------------------------------------
// TLV encoding
// ---------------------------------------------------------------------------

describe('tlv', () => {
  it('encodes tag, two-digit length, then value', () => {
    expect(tlv('00', '01')).toBe('000201');
    expect(tlv('59', 'ACME SDN BHD')).toBe('5912ACME SDN BHD');
  });

  it('zero-pads a single-digit length', () => {
    expect(tlv('01', '12')).toBe('010212');
  });

  it('refuses a value longer than the two-digit length can express', () => {
    // Silent truncation here would produce a scannable QR carrying a cut-off
    // merchant id — money to somewhere unintended, with the payer holding a
    // completed transaction.
    expect(() => tlv('26', 'X'.repeat(100))).toThrow(DuitNowQrError);
    expect(() => tlv('26', 'X'.repeat(99))).not.toThrow();
  });

  it('refuses a malformed tag', () => {
    expect(() => tlv('1', 'x')).toThrow(/two digits/);
    expect(() => tlv('abc', 'x')).toThrow(/two digits/);
  });

  it('PROPERTY: parseTlv inverts a concatenation of tlv', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.string({ minLength: 0, maxLength: 40 }), { minLength: 8, maxLength: 8 }),
        (tags, values) => {
          const pairs = tags.map(
            (t, i) => [String(t).padStart(2, '0'), values[i]!] as const,
          );
          const parsed = parseTlv(pairs.map(([t, v]) => tlv(t, v)).join(''));

          for (const [t, v] of pairs) expect(parsed.get(t)).toBe(v);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Refusing to guess
// ---------------------------------------------------------------------------

describe('buildDuitNowQr — what it refuses to invent', () => {
  it('throws NO_MERCHANT_TEMPLATE rather than emitting a placeholder', () => {
    // The single most important assertion in this file. A guessed merchant
    // template produces a QR that SCANS SUCCESSFULLY AND PAYS THE WRONG PARTY.
    // Unlike a guessed tax rate, which shows up as a wrong number on a return,
    // there is no downstream check that catches it — the payer's transaction
    // completes, and the merchant simply never receives the money.
    const empty: MerchantAccountTemplate = { tag: '26', fields: [] };

    try {
      buildDuitNowQr(input({ merchantAccount: empty }));
      expect.unreachable('should have refused to build a QR with no merchant template');
    } catch (error) {
      expect(error).toBeInstanceOf(DuitNowQrError);
      expect((error as DuitNowQrError).code).toBe('NO_MERCHANT_TEMPLATE');
      expect((error as DuitNowQrError).message).toMatch(/PayNet/);
    }
  });

  it('refuses a non-MYR amount', () => {
    // DuitNow is a domestic rail. Encoding SGD with currency 458 would produce
    // a QR that charges the wrong number.
    try {
      buildDuitNowQr(input({ amount: Money.fromDecimal('100.00', 'SGD') }));
      expect.unreachable('should have refused a non-MYR amount');
    } catch (error) {
      expect((error as DuitNowQrError).code).toBe('UNSUPPORTED_CURRENCY');
    }
  });
});

// ---------------------------------------------------------------------------
// The envelope, asserted field by field
// ---------------------------------------------------------------------------

describe('buildDuitNowQr — EMVCo envelope', () => {
  it('emits the root fields EMVCo specifies', () => {
    // Field by field rather than against a golden string: a golden string tells
    // you something changed and not what, and these payloads are unreadable.
    const fields = parseTlv(buildDuitNowQr(input()));

    expect(fields.get('00')).toBe('01');
    // "12" = dynamic. An invoice QR carries an amount and must not be
    // re-scanned to pay a second time; "11" (static) would allow exactly that.
    expect(fields.get('01')).toBe('12');
    expect(fields.get('52')).toBe('5734');
    expect(fields.get('53')).toBe(MYR_NUMERIC);
    expect(fields.get('54')).toBe('1080.00');
    expect(fields.get('58')).toBe(MALAYSIA);
    expect(fields.get('59')).toBe('ACME SDN BHD');
    expect(fields.get('60')).toBe('KUALA LUMPUR');
  });

  it('nests the merchant template under its assigned tag', () => {
    const fields = parseTlv(buildDuitNowQr(input()));
    const template = parseTlv(fields.get('26')!);

    expect(template.get('00')).toBe('TEST.NOT.A.REAL.AID');
    expect(template.get('01')).toBe('TEST-MERCHANT-0001');
  });

  it('carries the reference in the additional-data field', () => {
    const additional = parseTlv(parseTlv(buildDuitNowQr(input())).get('62')!);
    expect(additional.get('05')).toBe('INV00042');
  });

  it('includes a bill number only when there is one', () => {
    expect(parseTlv(parseTlv(buildDuitNowQr(input())).get('62')!).has('01')).toBe(false);

    const withBill = parseTlv(
      parseTlv(buildDuitNowQr(input({ billNumber: 'INV-00042' }))).get('62')!,
    );
    expect(withBill.get('01')).toBe('INV-00042');
  });

  it('truncates over-long merchant names to the EMVCo limits', () => {
    const fields = parseTlv(
      buildDuitNowQr(
        input({
          merchantName: 'A VERY LONG MALAYSIAN COMPANY NAME SDN BHD',
          merchantCity: 'BANDAR SERI BEGAWAN NORTH',
        }),
      ),
    );

    // Cosmetic fields, unlike the merchant id — truncating a display name is
    // safe, truncating an account identifier is not.
    expect(fields.get('59')).toHaveLength(25);
    expect(fields.get('60')).toHaveLength(15);
  });
});

describe('amountForQr', () => {
  it('drops the ledger tail without grouping or a symbol', () => {
    // toDisplayString() would give "RM 1,080.00" — not a number any scanner
    // reads. The internal four-place scale is not what goes on the wire.
    expect(amountForQr(rm('1080.00'))).toBe('1080.00');
    expect(amountForQr(rm('0.50'))).toBe('0.50');
    expect(amountForQr(Money.fromDecimal('1234567.89', 'MYR'))).toBe('1234567.89');
  });

  it('rounds the sub-cent scale rather than truncating it', () => {
    expect(amountForQr(Money.fromDecimal('10.005', 'MYR'))).toBe('10.01');
    expect(amountForQr(Money.fromDecimal('10.004', 'MYR'))).toBe('10.00');
  });

  it('PROPERTY: never emits a separator a scanner would choke on', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), (cents) => {
        const formatted = amountForQr(Money.fromDecimal((cents / 100).toFixed(2), 'MYR'));
        expect(formatted).toMatch(/^\d+\.\d{2}$/);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Checksum integrity
// ---------------------------------------------------------------------------

describe('verifyQr', () => {
  it('accepts a payload this module built', () => {
    expect(verifyQr(buildDuitNowQr(input()))).toBe(true);
  });

  it('covers its own tag and length, per EMVCo', () => {
    // The CRC is computed over everything INCLUDING the literal "6304" that
    // introduces it. Getting this wrong is the classic EMVCo mistake and
    // produces a payload every scanner rejects.
    const payload = buildDuitNowQr(input());
    const body = payload.slice(0, -4);

    expect(body.endsWith('6304')).toBe(true);
    expect(payload.slice(-4)).toBe(crcHex(body));
  });

  it('rejects a payload whose amount was altered in transit', () => {
    const payload = buildDuitNowQr(input());
    const tampered = payload.replace('54071080.00', '54070180.00');

    expect(tampered).not.toBe(payload);
    expect(verifyQr(tampered)).toBe(false);
  });

  it('rejects a truncated or malformed payload', () => {
    const payload = buildDuitNowQr(input());
    expect(verifyQr(payload.slice(0, -1))).toBe(false);
    expect(verifyQr('')).toBe(false);
    expect(verifyQr('nonsense')).toBe(false);
  });

  it('PROPERTY: every payload it builds verifies', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !/[\r\n]/.test(s)),
        fc.integer({ min: 1, max: 99_999_999 }),
        (merchantName, cents) => {
          const payload = buildDuitNowQr(
            input({
              merchantName,
              amount: Money.fromDecimal((cents / 100).toFixed(2), 'MYR'),
            }),
          );
          expect(verifyQr(payload)).toBe(true);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// The junction with reconciliation
// ---------------------------------------------------------------------------

describe('a QR-driven payment stays matchable', () => {
  it('carries a reference the M4 matcher recovers from the bank narrative', () => {
    // A DuitNow QR payment lands on the statement like any other transfer, so
    // the reference embedded in tag 62 has to survive the same round trip as
    // one typed by hand. If it does not, QR payments become the one class of
    // collection that never auto-reconciles.
    const invoiceNo = 'INV-00042';
    const reference = paymentReference(invoiceNo);

    const additional = parseTlv(parseTlv(buildDuitNowQr(input({ reference }))).get('62')!);
    expect(additional.get('05')).toBe(reference);

    expect(referenceMatch(invoiceNo, `DUITNOW QR ${additional.get('05')} 03/08/2026`)).toBe(
      'EXACT',
    );
  });
});
