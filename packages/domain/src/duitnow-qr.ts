/**
 * DuitNow QR payload — EMVCo Merchant-Presented Mode.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS VERIFIABLE HERE, AND WHAT IS NOT. READ THIS BEFORE USING IT.
 *
 * The ENVELOPE is a published open standard: EMVCo's Merchant-Presented Mode
 * QR specification. Tag-length-value in fixed positions, a CRC-16/CCITT-FALSE
 * checksum in tag 63, ASCII throughout. Every part of that is deterministic
 * and is tested here against known CRC vectors, so this encoder is either
 * right or visibly wrong.
 *
 * The MERCHANT ACCOUNT TEMPLATE is not. DuitNow occupies one of the reserved
 * tags 26–51, carries a PayNet-assigned identifier, and formats the merchant
 * id in a way this codebase cannot confirm from public documentation. Those
 * values are therefore CONFIGURATION, supplied per tenant, and they ship
 * EMPTY — the same treatment `wht_rate` gets.
 *
 * The reason is concrete rather than procedural. A guessed tax rate produces a
 * wrong number on a return. A guessed merchant template produces a QR that
 * SCANS SUCCESSFULLY AND PAYS THE WRONG PARTY, with the payer holding a
 * completed transaction and the merchant holding nothing. There is no
 * plausible-looking failure worse than that, so nothing here invents one.
 *
 * ⚠️ Confirm the DuitNow merchant account template against PayNet before
 * enabling QR generation for any tenant.
 * ---------------------------------------------------------------------------
 */

import { Money } from './money.js';

/** ISO 4217 numeric. MYR is 458. */
export const MYR_NUMERIC = '458';
export const MALAYSIA = 'MY';

/** Root-level EMVCo tags used here. */
const TAG = {
  PAYLOAD_FORMAT: '00',
  POINT_OF_INITIATION: '01',
  MCC: '52',
  CURRENCY: '53',
  AMOUNT: '54',
  COUNTRY: '58',
  MERCHANT_NAME: '59',
  MERCHANT_CITY: '60',
  ADDITIONAL_DATA: '62',
  CRC: '63',
} as const;

/** Sub-tags of the additional-data field (62). */
const ADDITIONAL = {
  BILL_NUMBER: '01',
  REFERENCE_LABEL: '05',
  PURPOSE: '08',
} as const;

/**
 * `11` = static, reusable for any amount. `12` = dynamic, one transaction.
 *
 * An invoice QR is always dynamic: it carries an amount and must not be
 * re-scanned to pay again.
 */
const POINT_OF_INITIATION_DYNAMIC = '12';

/**
 * The PayNet-assigned merchant account template.
 *
 * Supplied as configuration, never inferred. `tag` is which of 26–51 DuitNow
 * occupies; `fields` are its sub-tags in the order PayNet specifies.
 */
export interface MerchantAccountTemplate {
  /** One of "26".."51". */
  readonly tag: string;
  /** Ordered sub-tag/value pairs, e.g. [["00","A000000..."],["01","<merchant id>"]]. */
  readonly fields: readonly (readonly [string, string])[];
}

export interface DuitNowQrInput {
  readonly merchantAccount: MerchantAccountTemplate;
  readonly merchantName: string;
  readonly merchantCity: string;
  /** ISO 18245 merchant category code. */
  readonly merchantCategoryCode: string;
  readonly amount: Money;
  /** The payment reference — what reconciliation later matches on. */
  readonly reference: string;
  readonly billNumber?: string;
}

export class DuitNowQrError extends Error {
  constructor(
    readonly code: 'NO_MERCHANT_TEMPLATE' | 'INVALID_FIELD' | 'UNSUPPORTED_CURRENCY',
    message: string,
  ) {
    super(message);
    this.name = 'DuitNowQrError';
  }
}

/**
 * Encode one tag-length-value element.
 *
 * The length is two ASCII digits — so no value may exceed 99 characters, and
 * one that does is an error rather than a silent truncation. A truncated
 * merchant id would produce a scannable QR pointing somewhere unintended.
 */
export function tlv(tag: string, value: string): string {
  if (!/^\d{2}$/.test(tag)) {
    throw new DuitNowQrError('INVALID_FIELD', `Tag must be two digits, got "${tag}"`);
  }
  if (value.length > 99) {
    throw new DuitNowQrError(
      'INVALID_FIELD',
      `Value for tag ${tag} is ${value.length} characters; EMVCo allows at most 99`,
    );
  }
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
}

/**
 * CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection,
 * no final XOR.
 *
 * Written out rather than taken from a dependency because it is fifteen lines,
 * the parameters matter, and the well-known check value `0x29B1` for the
 * string "123456789" pins all of them at once — which the tests assert.
 */
export function crc16(input: string): number {
  let crc = 0xffff;

  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc & 0xffff;
}

/** The CRC as EMVCo writes it: four upper-case hex digits. */
export function crcHex(input: string): string {
  return crc16(input).toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Build a dynamic DuitNow QR payload.
 *
 * Throws when no merchant template is configured, rather than emitting a QR
 * with a placeholder. See the header: a QR that scans and pays the wrong party
 * is the worst available failure, so the only safe default is refusing.
 */
export function buildDuitNowQr(input: DuitNowQrInput): string {
  if (input.merchantAccount.fields.length === 0) {
    throw new DuitNowQrError(
      'NO_MERCHANT_TEMPLATE',
      'No DuitNow merchant account template is configured. It must be obtained from ' +
        'PayNet and verified before QR generation is enabled — a guessed template ' +
        'produces a QR that scans successfully and pays the wrong party.',
    );
  }

  if (input.amount.currency !== 'MYR') {
    throw new DuitNowQrError(
      'UNSUPPORTED_CURRENCY',
      `DuitNow QR is a Malaysian rail and settles in MYR; got ${input.amount.currency}`,
    );
  }

  const merchantTemplate = input.merchantAccount.fields
    .map(([tag, value]) => tlv(tag, value))
    .join('');

  const additional = [
    ...(input.billNumber !== undefined ? [tlv(ADDITIONAL.BILL_NUMBER, input.billNumber)] : []),
    tlv(ADDITIONAL.REFERENCE_LABEL, input.reference),
  ].join('');

  const body = [
    // "01" is the only payload format indicator EMVCo defines.
    tlv(TAG.PAYLOAD_FORMAT, '01'),
    tlv(TAG.POINT_OF_INITIATION, POINT_OF_INITIATION_DYNAMIC),
    tlv(input.merchantAccount.tag, merchantTemplate),
    tlv(TAG.MCC, input.merchantCategoryCode),
    tlv(TAG.CURRENCY, MYR_NUMERIC),
    tlv(TAG.AMOUNT, amountForQr(input.amount)),
    tlv(TAG.COUNTRY, MALAYSIA),
    tlv(TAG.MERCHANT_NAME, truncate(input.merchantName, 25)),
    tlv(TAG.MERCHANT_CITY, truncate(input.merchantCity, 15)),
    tlv(TAG.ADDITIONAL_DATA, additional),
  ].join('');

  // The CRC covers everything up to and including its own tag and length —
  // "6304" — which is why those four characters are appended before hashing.
  const withCrcHeader = `${body}${TAG.CRC}04`;
  return `${withCrcHeader}${crcHex(withCrcHeader)}`;
}

/**
 * Parse a payload back into its top-level elements.
 *
 * Provided so a generated QR can be asserted field by field rather than
 * against a golden string — a golden string tells you something changed but
 * not what, and these payloads are unreadable by eye.
 */
export function parseTlv(payload: string): Map<string, string> {
  const out = new Map<string, string>();
  let index = 0;

  while (index + 4 <= payload.length) {
    const tag = payload.slice(index, index + 2);
    const length = Number(payload.slice(index + 2, index + 4));
    if (Number.isNaN(length)) break;

    const value = payload.slice(index + 4, index + 4 + length);
    out.set(tag, value);
    index += 4 + length;
  }

  return out;
}

/** Whether a payload's checksum is intact. */
export function verifyQr(payload: string): boolean {
  const marker = payload.lastIndexOf(`${TAG.CRC}04`);
  if (marker === -1 || marker + 8 !== payload.length) return false;

  const body = payload.slice(0, marker + 4);
  const supplied = payload.slice(marker + 4);
  return crcHex(body) === supplied.toUpperCase();
}

/**
 * The amount as EMVCo tag 54 wants it: plain digits and one dot, no grouping,
 * no currency symbol, two decimal places.
 *
 * `toDisplayString()` is the wrong tool despite looking right — it inserts
 * thousands separators, and `RM 1,080.00` in tag 54 is not a number any scanner
 * will read.
 *
 * Note `roundToExponent` counts DECIMAL PLACES, so this is `2` and not `-2`.
 * That distinction is not cosmetic: `-2` rounds to the nearest hundred, and an
 * invoice for RM 1,080.00 then produces a QR that charges RM 1,100.00. It
 * scans, it verifies, and it takes twenty ringgit too much — which is exactly
 * why this function is exported and tested directly rather than left inline.
 */
export function amountForQr(amount: Money): string {
  return amount
    .roundToExponent(2)
    .toDecimalString()
    .replace(/(\.\d{2})\d*$/, '$1');
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}
