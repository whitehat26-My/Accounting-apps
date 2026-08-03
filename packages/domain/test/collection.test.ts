import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import { isErr, isOk } from '../src/result.js';
import {
  advanceCollection,
  buildGatewayFeeJournal,
  buildSettlementToBankJournal,
  checkSettlement,
  isCollectionTerminal,
  isReplay,
  MAX_REFERENCE_LENGTH,
  paymentReference,
  REPLAY_WINDOW_SECONDS,
  withinReplayWindow,
  type CollectionEvent,
  type CollectionPostingAccounts,
  type CollectionPostingContext,
  type CollectionStatus,
} from '../src/collection.js';
import { referenceMatch } from '../src/text.js';

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

const ACCOUNTS: CollectionPostingAccounts = {
  clearingAccountId: 'acct-undeposited',
  bankAccountId: 'acct-bank',
  feeAccountId: 'acct-gateway-fees',
};

const CTX: CollectionPostingContext = {
  entryDate: '2026-08-05',
  documentType: 'GATEWAY_SETTLEMENT',
  documentId: 'settlement-1',
};

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('advanceCollection', () => {
  const expectTo = (from: CollectionStatus, event: CollectionEvent, to: CollectionStatus) => {
    const result = advanceCollection(from, event);
    expect(isOk(result), `${from} --${event.type}--> expected ${to}`).toBe(true);
    if (isOk(result)) expect(result.value).toBe(to);
  };

  const expectRefused = (from: CollectionStatus, event: CollectionEvent) => {
    const result = advanceCollection(from, event);
    expect(isErr(result), `${from} --${event.type}--> should be refused`).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('ILLEGAL_TRANSITION');
      expect(result.error.from).toBe(from);
    }
  };

  const handedOff: CollectionEvent = { type: 'HANDED_OFF', providerRef: 'fpx-1' };
  const paid: CollectionEvent = { type: 'PAID', providerRef: 'fpx-1', paidAt: '2026-08-03T14:32:00.000Z' };
  const failed: CollectionEvent = { type: 'FAILED', reason: 'Bank declined' };

  it('walks the happy path', () => {
    expectTo('CREATED', { type: 'VIEWED' }, 'VIEWED');
    expectTo('VIEWED', handedOff, 'PENDING');
    expectTo('PENDING', paid, 'PAID');
  });

  it('lets a failed attempt be retried', () => {
    // The payer picks the wrong bank, the FPX page errors, they come back and
    // try again. Refusing the retry would strand a live invoice behind a dead
    // link for no reason.
    expectTo('PENDING', failed, 'FAILED');
    expectTo('FAILED', handedOff, 'PENDING');
  });

  it('accepts payment that arrives after the link expired', () => {
    // The scenario this exists for: the payer opens the link at 23:58, the link
    // expires at midnight, and their bank confirms at 00:04. The money is real
    // and in our account. Refusing it here would take the customer's payment
    // and leave the invoice showing as outstanding.
    expectTo('EXPIRED', paid, 'PAID');
  });

  it('never moves out of PAID', () => {
    for (const event of [
      { type: 'VIEWED' } as const,
      handedOff,
      paid,
      failed,
      { type: 'EXPIRED' } as const,
      { type: 'CANCELLED', reason: 'changed mind' } as const,
    ]) {
      expectRefused('PAID', event);
    }
  });

  it('refuses payment on a cancelled collection', () => {
    // Unlike expiry, cancellation is a deliberate act by the merchant — the
    // invoice may have been credited or paid another way. A payment arriving
    // afterwards is an exception a human has to look at, not something to book
    // automatically.
    expectRefused('CANCELLED', paid);
  });

  it('does not expire a collection that already succeeded or was cancelled', () => {
    expectRefused('PAID', { type: 'EXPIRED' });
    expectRefused('CANCELLED', { type: 'EXPIRED' });
  });

  it('treats only PAID and CANCELLED as terminal', () => {
    // EXPIRED is deliberately not terminal — see the late-payment case above.
    expect(isCollectionTerminal('PAID')).toBe(true);
    expect(isCollectionTerminal('CANCELLED')).toBe(true);
    for (const status of ['CREATED', 'VIEWED', 'PENDING', 'FAILED', 'EXPIRED'] as const) {
      expect(isCollectionTerminal(status)).toBe(false);
    }
  });

  it('never leaves a terminal state, whatever the sequence of events', () => {
    const statuses: CollectionStatus[] = ['CREATED', 'VIEWED', 'PENDING', 'FAILED', 'EXPIRED'];
    const events: CollectionEvent[] = [
      { type: 'VIEWED' },
      handedOff,
      paid,
      failed,
      { type: 'EXPIRED' },
      { type: 'CANCELLED', reason: 'r' },
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...statuses),
        fc.array(fc.constantFrom(...events), { minLength: 1, maxLength: 12 }),
        (start, sequence) => {
          let current = start;
          let reachedTerminal = false;

          for (const event of sequence) {
            const result = advanceCollection(current, event);
            if (!isOk(result)) continue;

            // Once terminal, no accepted transition may move us anywhere.
            expect(reachedTerminal).toBe(false);
            current = result.value;
            reachedTerminal = isCollectionTerminal(current);
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// The join with reconciliation — the highest-value test in the slice
// ---------------------------------------------------------------------------

describe('paymentReference — must be findable by the M4 matcher', () => {
  /**
   * How a DuitNow Transfer actually turns up on a Malaysian bank statement.
   * The reference the payer typed is buried in rail noise, an ALL-CAPS payer
   * name and a timestamp.
   */
  const narratives = (reference: string): string[] => [
    `IBG TRANSFER FR ACME SDN BHD ${reference}`,
    `DUITNOW TRF FROM TAN AH KOW ${reference} 03/08/2026`,
    `FPX PAYMENT ${reference}`,
    `MEPS IBFT ${reference} REF 900123`,
    `INSTANT TRANSFER ${reference.toLowerCase()}`,
  ];

  it('produces an EXACT match for a real invoice number', () => {
    // What `allocate_document_number` actually emits: prefix plus a
    // zero-padded counter.
    const invoiceNo = 'INV-00042';
    const reference = paymentReference(invoiceNo);

    expect(reference).toBe('INV00042');
    for (const narrative of narratives(reference)) {
      expect(referenceMatch(invoiceNo, narrative), narrative).toBe('EXACT');
    }
  });

  it('keeps leading zeros, because dropping them costs an EXACT match', () => {
    // The regression this file exists to prevent. `INV42` scores only NUMERIC
    // on the bare token `42`, which collides with dates, amounts and every
    // other invoice ending in 42 — and `matching.ts` weights it far lower.
    expect(referenceMatch('INV-00042', 'IBG TRANSFER FR X INV42')).toBe('NUMERIC');
    expect(referenceMatch('INV-00042', `IBG TRANSFER FR X ${paymentReference('INV-00042')}`)).toBe(
      'EXACT',
    );
  });

  it('prefixes a bare document number so the payer sees what it is for', () => {
    expect(paymentReference('00042')).toBe('INV00042');
    expect(referenceMatch('00042', 'DUITNOW TRF INV00042')).toBe('EXACT');
  });

  it('does not double up a prefix the document number already has', () => {
    expect(paymentReference('INV-00042')).not.toMatch(/^INVINV/);
    expect(paymentReference('BILL-00007')).toBe('BILL00007');
  });

  it('refuses a document number too long to carry, rather than truncating it', () => {
    // A tenant with a verbose prefix. There is genuinely no salvage: a
    // truncated compact form fails the substring test, and the digits overflow
    // what `extractReferences` will pull out of a narrative, so both score
    // NONE. Proven below rather than asserted — an unmatchable reference would
    // surface weeks later as a reconciliation that will not close.
    const invoiceNo = 'INVOICE-KUALA-LUMPUR-2026-000000042';

    expect(() => paymentReference(invoiceNo)).toThrow(/shorten the document number/);

    const truncated = invoiceNo.replace(/[^A-Z0-9]/g, '').slice(0, MAX_REFERENCE_LENGTH);
    const digitsOnly = `INV${invoiceNo.replace(/\D/g, '').replace(/^0+/, '')}`;
    for (const salvage of [truncated, digitsOnly]) {
      expect(referenceMatch(invoiceNo, `IBG TRANSFER FR X ${salvage}`), salvage).toBe('NONE');
    }
  });

  it('refuses a document number with nothing to reference', () => {
    expect(() => paymentReference('---')).toThrow(/no alphanumeric content/);
  });

  it('is idempotent — re-referencing a reference changes nothing', () => {
    // A support agent copying the reference back into the invoice field must
    // not produce a second, different reference for the same money.
    fc.assert(
      fc.property(realisticDocumentNumber(), (documentNo) => {
        const once = paymentReference(documentNo);
        expect(paymentReference(once)).toBe(once);
      }),
    );
  });

  it('PROPERTY: any generated reference is recoverable from a bank narrative', () => {
    // The contract between M2 collections and the M4 matching engine. If either
    // side changes its notion of what a reference looks like, this fails here
    // rather than as unmatched payments in production.
    fc.assert(
      fc.property(realisticDocumentNumber(), (documentNo) => {
        const reference = paymentReference(documentNo);

        for (const narrative of narratives(reference)) {
          expect(referenceMatch(documentNo, narrative), `${documentNo} in "${narrative}"`).toBe(
            'EXACT',
          );
        }
      }),
      { numRuns: 500 },
    );
  });
});

/**
 * Document numbers as this system generates them: a tenant-configured prefix
 * plus a zero-padded counter, which is what `allocate_document_number` builds
 * from `number_sequence.prefix` and `.padding`.
 */
function realisticDocumentNumber(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom('INV-', 'INV', 'IV/', 'INVOICE-', 'SI-', 'TAX-INV-', ''),
      fc.integer({ min: 1, max: 999_999 }),
      fc.integer({ min: 3, max: 8 }),
    )
    .map(([prefix, counter, padding]) => `${prefix}${String(counter).padStart(padding, '0')}`);
}

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

describe('buildGatewayFeeJournal', () => {
  it('books the fee to expense and never nets it into revenue', () => {
    const entry = buildGatewayFeeJournal(rm('1.00'), ACCOUNTS, CTX);

    expect(entry).not.toBeNull();
    expect(entry!.lines).toHaveLength(2);

    const debit = entry!.lines.find((l) => l.side === 'DEBIT')!;
    const credit = entry!.lines.find((l) => l.side === 'CREDIT')!;

    expect(debit.accountId).toBe(ACCOUNTS.feeAccountId);
    expect(credit.accountId).toBe(ACCOUNTS.clearingAccountId);
    expect(debit.amount.equals(rm('1.00'))).toBe(true);
    expect(credit.amount.equals(rm('1.00'))).toBe(true);
  });

  it('posts nothing for a zero fee', () => {
    expect(buildGatewayFeeJournal(rm('0.00'), ACCOUNTS, CTX)).toBeNull();
  });

  it('refuses to guess where a fee belongs', () => {
    // Falling back to "some expense account" would put the gateway's cut
    // somewhere arbitrary and it would never be found again.
    const { feeAccountId: _omitted, ...withoutFeeAccount } = ACCOUNTS;
    expect(() => buildGatewayFeeJournal(rm('1.00'), withoutFeeAccount, CTX)).toThrow(
      /GATEWAY_FEE/,
    );
  });

  it('normalises a fee expressed as a negative deduction', () => {
    // Providers report fees both ways in their settlement files. Either sign
    // has to produce a debit to expense, not a contra.
    const entry = buildGatewayFeeJournal(rm('-1.00'), ACCOUNTS, CTX)!;
    const debit = entry.lines.find((l) => l.side === 'DEBIT')!;
    expect(debit.accountId).toBe(ACCOUNTS.feeAccountId);
    expect(debit.amount.equals(rm('1.00'))).toBe(true);
  });
});

describe('buildSettlementToBankJournal', () => {
  it('moves only the net that actually arrived', () => {
    // Gross 1,080 less a 1.00 fee. The gross and the fee were booked when the
    // payment confirmed; posting the gross again here would double-count.
    const entry = buildSettlementToBankJournal(rm('1079.00'), ACCOUNTS, CTX)!;

    const debit = entry.lines.find((l) => l.side === 'DEBIT')!;
    const credit = entry.lines.find((l) => l.side === 'CREDIT')!;

    expect(debit.accountId).toBe(ACCOUNTS.bankAccountId);
    expect(credit.accountId).toBe(ACCOUNTS.clearingAccountId);
    expect(debit.amount.equals(rm('1079.00'))).toBe(true);
  });

  it('needs to know which bank account was paid', () => {
    const { bankAccountId: _omitted, ...withoutBank } = ACCOUNTS;
    expect(() => buildSettlementToBankJournal(rm('1079.00'), withoutBank, CTX)).toThrow(/bank/i);
  });

  it('posts nothing for a zero settlement', () => {
    expect(buildSettlementToBankJournal(rm('0.00'), ACCOUNTS, CTX)).toBeNull();
  });

  it('PROPERTY: every generated entry balances', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), (cents) => {
        const net = Money.fromDecimal((cents / 100).toFixed(2), 'MYR');
        const entry = buildSettlementToBankJournal(net, ACCOUNTS, CTX)!;

        const debits = entry.lines
          .filter((l) => l.side === 'DEBIT')
          .reduce((sum, l) => sum.add(l.amount), Money.zero('MYR'));
        const credits = entry.lines
          .filter((l) => l.side === 'CREDIT')
          .reduce((sum, l) => sum.add(l.amount), Money.zero('MYR'));

        expect(debits.equals(credits)).toBe(true);
      }),
    );
  });
});

describe('checkSettlement', () => {
  it('confirms a batch whose parts add up', () => {
    // Twelve FPX payments totalling 12,960 gross, 12.00 of fees, 12,948 net.
    const check = checkSettlement(rm('12960.00'), rm('12.00'), rm('12948.00'));

    expect(check.balances).toBe(true);
    expect(check.expectedNet.equals(rm('12948.00'))).toBe(true);
    expect(check.difference.isZero()).toBe(true);
  });

  it('surfaces a batch that does not, with the signed difference', () => {
    // The provider reports 10 more than gross-less-fees explains. Accepting it
    // silently would leave 10.00 stuck in the clearing account forever, and
    // nobody would ever work out where it came from.
    const check = checkSettlement(rm('12960.00'), rm('12.00'), rm('12958.00'));

    expect(check.balances).toBe(false);
    expect(check.difference.equals(rm('10.00'))).toBe(true);
  });

  it('PROPERTY: gross less fees always equals the net it reports as balanced', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (grossCents, feeCents) => {
          const gross = Money.fromDecimal((grossCents / 100).toFixed(2), 'MYR');
          const fees = Money.fromDecimal((feeCents / 100).toFixed(2), 'MYR');
          const check = checkSettlement(gross, fees, gross.subtract(fees));

          expect(check.balances).toBe(true);
          expect(check.expectedNet.add(check.fees).equals(check.gross)).toBe(true);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Webhook safety
// ---------------------------------------------------------------------------

describe('isReplay', () => {
  it('recognises an event id already processed', () => {
    // A double-processed PAID settles the invoice twice. The database's UNIQUE
    // (tenant_id, provider, provider_event_id) is the real guarantee; this is
    // the in-memory counterpart.
    const seen = new Set(['evt_1', 'evt_2']);
    expect(isReplay('evt_1', seen)).toBe(true);
    expect(isReplay('evt_3', seen)).toBe(false);
  });
});

describe('withinReplayWindow', () => {
  const now = '2026-08-03T14:32:00.000Z';

  it('accepts a fresh webhook', () => {
    expect(withinReplayWindow('2026-08-03T14:31:55.000Z', now)).toBe(true);
  });

  it('accepts a provider retrying with backoff inside the window', () => {
    expect(withinReplayWindow('2026-08-03T13:47:00.000Z', now)).toBe(true);
  });

  it('refuses a captured payload replayed later', () => {
    // A valid signature does not expire on its own, so age is the only thing
    // standing between a captured webhook and it being replayed next month.
    expect(withinReplayWindow('2026-07-03T14:32:00.000Z', now)).toBe(false);
  });

  it('tolerates a modestly fast provider clock but not a wild one', () => {
    expect(withinReplayWindow('2026-08-03T14:34:00.000Z', now)).toBe(true);
    expect(withinReplayWindow('2026-08-04T14:32:00.000Z', now)).toBe(false);
  });

  it('refuses an unparseable timestamp instead of treating it as now', () => {
    expect(withinReplayWindow('yesterday afternoon', now)).toBe(false);
    expect(withinReplayWindow(now, 'not-a-date')).toBe(false);
  });

  it('honours a caller-supplied window', () => {
    expect(withinReplayWindow('2026-08-03T14:22:00.000Z', now, 60)).toBe(false);
    expect(REPLAY_WINDOW_SECONDS).toBe(3600);
  });
});
