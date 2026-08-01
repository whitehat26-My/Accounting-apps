import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import { isErr, unwrap } from '../src/result.js';
import {
  cancellationWindow,
  isPending,
  isSelfBilled,
  isTerminal,
  transition,
  validateForSubmission,
  type EInvoiceDocument,
  type EInvoiceLine,
  type SubmissionEvent,
  type SubmissionStatus,
  type TaxpayerParty,
} from '../src/einvoice.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);

const ADDRESS = {
  line1: 'Level 12, Menara ABC',
  city: 'Kuala Lumpur',
  postcode: '50450',
  stateCode: '14',
  countryCode: 'MY',
};

const SUPPLIER: TaxpayerParty = {
  name: 'Emil Demo Sdn Bhd',
  tin: 'C1234567890',
  idType: 'BRN',
  idValue: '202301012345',
  address: ADDRESS,
  sstRegistrationNo: 'W10-1808-32000123',
  msicCode: '62010',
  businessActivity: 'Computer programming activities',
};

const BUYER: TaxpayerParty = {
  name: 'Nusantara Retail Sdn Bhd',
  tin: 'C9876543210',
  idType: 'BRN',
  idValue: '201901054321',
  address: { ...ADDRESS, line1: 'No 8, Jalan Perdana' },
};

const LINE: EInvoiceLine = {
  lineNo: 1,
  description: 'Consulting services',
  classificationCode: '022',
  quantity: '1',
  unitPrice: rm('1000.00'),
  taxableAmount: rm('1000.00'),
  taxAmount: rm('80.00'),
  taxRateBasisPoints: 800n,
  lineTotal: rm('1080.00'),
};

function doc(over: Partial<EInvoiceDocument> = {}): EInvoiceDocument {
  return {
    documentType: 'INVOICE',
    documentNo: 'INV-00001',
    issueDate: '2026-08-05',
    issueTime: '10:30:00Z',
    currency: MYR,
    supplier: SUPPLIER,
    buyer: BUYER,
    lines: [LINE],
    subtotal: rm('1000.00'),
    taxTotal: rm('80.00'),
    total: rm('1080.00'),
    ...over,
  };
}

describe('pre-submission validation', () => {
  it('accepts a complete document', () => {
    expect(validateForSubmission(doc()).ok).toBe(true);
  });

  it('rejects a missing buyer TIN — the most common real-world gap', () => {
    const result = validateForSubmission(doc({ buyer: { ...BUYER, tin: '' } }));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'MISSING_BUYER_TIN')).toBe(true);
    }
  });

  it('rejects a missing supplier MSIC code', () => {
    const supplier = { ...SUPPLIER };
    delete (supplier as { msicCode?: string }).msicCode;
    const result = validateForSubmission(doc({ supplier }));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'MISSING_SUPPLIER_MSIC')).toBe(true);
    }
  });

  it('rejects a line with no classification code', () => {
    const result = validateForSubmission(doc({ lines: [{ ...LINE, classificationCode: '' }] }));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'MISSING_CLASSIFICATION_CODE')).toBe(true);
    }
  });

  it('rejects a classification code outside the supplied list', () => {
    const result = validateForSubmission(doc(), {
      classificationCodes: new Set(['001', '002']),
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'UNKNOWN_CLASSIFICATION_CODE')).toBe(true);
    }
  });

  it('skips the code membership check when no list is configured', () => {
    // Reference data is refreshed from LHDN; before the first refresh the app
    // must not block issuance on a list it does not have.
    expect(validateForSubmission(doc(), { classificationCodes: new Set() }).ok).toBe(true);
  });

  it('applies a configured TIN pattern', () => {
    const config = { tinPattern: /^C\d{10}$/ };
    expect(validateForSubmission(doc(), config).ok).toBe(true);

    const result = validateForSubmission(doc({ buyer: { ...BUYER, tin: 'NOPE' } }), config);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'MALFORMED_TIN')).toBe(true);
    }
  });

  it('rejects an incomplete address', () => {
    const result = validateForSubmission(
      doc({ buyer: { ...BUYER, address: { ...ADDRESS, postcode: '' } } }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'INCOMPLETE_ADDRESS')).toBe(true);
    }
  });

  it('catches totals that do not reconcile to the lines', () => {
    const result = validateForSubmission(doc({ total: rm('9999.00') }));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'TOTALS_DO_NOT_RECONCILE')).toBe(true);
    }
  });

  it('catches a tax total that disagrees with the line tax', () => {
    const result = validateForSubmission(doc({ taxTotal: rm('60.00'), total: rm('1060.00') }));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'TAX_TOTAL_MISMATCH')).toBe(true);
    }
  });

  it('requires an exchange rate for a foreign-currency document', () => {
    const usd = Money.fromDecimal('1000.00', 'USD');
    const result = validateForSubmission(
      doc({
        currency: 'USD',
        lines: [{
          ...LINE,
          unitPrice: usd,
          taxableAmount: usd,
          taxAmount: Money.fromDecimal('0', 'USD'),
          lineTotal: usd,
        }],
        subtotal: usd,
        taxTotal: Money.fromDecimal('0', 'USD'),
        total: usd,
      }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'MISSING_EXCHANGE_RATE')).toBe(true);
    }
  });

  it('requires an original reference on a credit note', () => {
    const result = validateForSubmission(doc({ documentType: 'CREDIT_NOTE' }));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((v) => v.code === 'MISSING_ORIGINAL_REFERENCE')).toBe(true);
    }
  });

  it('accepts a credit note that references the original', () => {
    const result = validateForSubmission(
      doc({
        documentType: 'CREDIT_NOTE',
        originalReference: { documentNo: 'INV-00001', lhdnUuid: 'abc-123', reason: 'RETURN' },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('reports every problem at once', () => {
    const result = validateForSubmission(
      doc({
        buyer: { ...BUYER, tin: '', idValue: '' },
        lines: [{ ...LINE, classificationCode: '' }],
        total: rm('1.00'),
      }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      const codes = new Set(result.error.map((v) => v.code));
      expect(codes.has('MISSING_BUYER_TIN')).toBe(true);
      expect(codes.has('MISSING_ID_VALUE')).toBe(true);
      expect(codes.has('MISSING_CLASSIFICATION_CODE')).toBe(true);
      expect(codes.has('TOTALS_DO_NOT_RECONCILE')).toBe(true);
    }
  });
});

describe('self-billed documents', () => {
  it('identifies the self-billed variants', () => {
    expect(isSelfBilled('SELF_BILLED_INVOICE')).toBe(true);
    expect(isSelfBilled('SELF_BILLED_CREDIT_NOTE')).toBe(true);
    expect(isSelfBilled('INVOICE')).toBe(false);
    expect(isSelfBilled('CREDIT_NOTE')).toBe(false);
  });

  it('validates a self-billed invoice like any other', () => {
    expect(validateForSubmission(doc({ documentType: 'SELF_BILLED_INVOICE' })).ok).toBe(true);
  });

  it('still requires an original reference on a self-billed credit note', () => {
    const result = validateForSubmission(doc({ documentType: 'SELF_BILLED_CREDIT_NOTE' }));
    expect(isErr(result)).toBe(true);
  });
});

describe('submission state machine', () => {
  const submit: SubmissionEvent = { type: 'SUBMIT' };
  const validated: SubmissionEvent = {
    type: 'VALIDATED',
    lhdnUuid: 'uuid-1',
    longId: 'long-1',
    validatedAt: '2026-08-05T10:35:00Z',
  };

  it('walks the happy path', () => {
    expect(unwrap(transition('QUEUED', submit))).toBe('SUBMITTED');
    expect(unwrap(transition('SUBMITTED', validated))).toBe('VALID');
  });

  it('allows correction and resubmission after a validation failure', () => {
    const invalid = unwrap(
      transition('SUBMITTED', { type: 'REJECTED_BY_VALIDATION', errorCode: 'CF321' }),
    );
    expect(invalid).toBe('INVALID');
    expect(unwrap(transition(invalid, { type: 'RETRY' }))).toBe('QUEUED');
  });

  it('models the buyer-initiated rejection round trip', () => {
    const requested = unwrap(
      transition('VALID', { type: 'BUYER_REQUESTED_REJECTION', reason: 'Wrong entity' }),
    );
    expect(requested).toBe('REJECTION_REQUESTED');

    // The supplier may accept...
    expect(unwrap(transition(requested, { type: 'CANCELLED', reason: 'Accepted' }))).toBe('CANCELLED');
    // ...or decline, returning it to VALID.
    expect(unwrap(transition(requested, { type: 'SUPPLIER_DECLINED_REJECTION' }))).toBe('VALID');
  });

  it('refuses to cancel a document that was never validated', () => {
    const result = transition('QUEUED', { type: 'CANCELLED', reason: 'oops' });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('treats CANCELLED as terminal', () => {
    expect(isTerminal('CANCELLED')).toBe(true);
    for (const event of [submit, validated, { type: 'RETRY' } as const]) {
      expect(isErr(transition('CANCELLED', event))).toBe(true);
    }
  });

  it('never lands in an unknown state, whatever the event sequence (property)', () => {
    const statuses: SubmissionStatus[] = [
      'QUEUED', 'SUBMITTED', 'VALID', 'INVALID', 'REJECTION_REQUESTED', 'CANCELLED',
    ];
    const events: SubmissionEvent[] = [
      { type: 'SUBMIT' },
      { type: 'ACCEPTED', submissionUid: 'sub-1' },
      validated,
      { type: 'REJECTED_BY_VALIDATION', errorCode: 'E1' },
      { type: 'BUYER_REQUESTED_REJECTION', reason: 'r' },
      { type: 'SUPPLIER_DECLINED_REJECTION' },
      { type: 'CANCELLED', reason: 'c' },
      { type: 'RETRY' },
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...statuses),
        fc.array(fc.constantFrom(...events), { maxLength: 20 }),
        (start, sequence) => {
          let current = start;
          for (const event of sequence) {
            const result = transition(current, event);
            if (result.ok) {
              expect(statuses).toContain(result.value);
              current = result.value;
            }
            // An illegal transition leaves the state untouched — no partial
            // application, no silent drift into an undefined status.
          }
          expect(statuses).toContain(current);
        },
      ),
    );
  });

  it('classifies pending states', () => {
    expect(isPending('QUEUED')).toBe(true);
    expect(isPending('SUBMITTED')).toBe(true);
    expect(isPending('VALID')).toBe(false);
    expect(isPending('CANCELLED')).toBe(false);
  });
});

describe('cancellation window', () => {
  const validatedAt = '2026-08-05T10:00:00Z';

  it('reports time remaining inside the window', () => {
    const w = cancellationWindow(validatedAt, '2026-08-06T10:00:00Z', 72);
    expect(w.cancellable).toBe(true);
    expect(w.hoursRemaining).toBe(48);
    expect(w.deadline).toBe('2026-08-08T10:00:00.000Z');
  });

  it('closes once the window elapses', () => {
    const w = cancellationWindow(validatedAt, '2026-08-08T10:00:01Z', 72);
    expect(w.cancellable).toBe(false);
    expect(w.hoursRemaining).toBe(0);
  });

  it('is still open one second before the deadline', () => {
    const w = cancellationWindow(validatedAt, '2026-08-08T09:59:59Z', 72);
    expect(w.cancellable).toBe(true);
  });

  it('honours a different configured window', () => {
    // The statutory window is configuration, not a constant. A change must be
    // a config update, not a release.
    const w = cancellationWindow(validatedAt, '2026-08-05T18:00:00Z', 24);
    expect(w.hoursRemaining).toBe(16);
    expect(w.deadline).toBe('2026-08-06T10:00:00.000Z');
  });

  it('rounds hours down rather than up', () => {
    // 59 minutes left must not read as "1 hour remaining".
    const w = cancellationWindow(validatedAt, '2026-08-08T09:01:00Z', 72);
    expect(w.hoursRemaining).toBe(0);
    expect(w.cancellable).toBe(true);
  });

  it('rejects an unparseable timestamp instead of guessing', () => {
    expect(() => cancellationWindow('not-a-date', '2026-08-05T10:00:00Z', 72)).toThrow(TypeError);
  });
});
