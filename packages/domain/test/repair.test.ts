import { describe, expect, it } from 'vitest';
import { checkRepairTransition, isErr, isOk, type RepairStatus } from '../src/index.js';

/**
 * A job whose evidence is complete: photographed at intake, signed for on the
 * way in and on the way out. The evidence gates are exercised deliberately in
 * their own block below; everywhere else they are simply satisfied, so that a
 * test about the state machine fails for a state-machine reason.
 */
const ok = (from: RepairStatus, to: RepairStatus, ctx = {}) =>
  checkRepairTransition(from, to, {
    quoteLineCount: 1,
    intakePhotoCount: 1,
    intakeSignatureCount: 1,
    collectionSignatureCount: 1,
    ...ctx,
  });

describe('the repair state machine', () => {
  it('walks the happy path end to end', () => {
    expect(isOk(ok('RECEIVED', 'QUOTED'))).toBe(true);
    expect(isOk(ok('QUOTED', 'APPROVED'))).toBe(true);
    expect(isOk(ok('APPROVED', 'IN_PROGRESS'))).toBe(true);
    expect(isOk(ok('IN_PROGRESS', 'READY'))).toBe(true);
    expect(isOk(ok('READY', 'COLLECTED', { viaCollection: true }))).toBe(true);
  });

  it('allows skipping the bench for a while-you-wait repair', () => {
    expect(isOk(ok('APPROVED', 'READY'))).toBe(true);
  });

  it('allows re-quoting after a decline — "what about just the screen?"', () => {
    const declined = ok('QUOTED', 'DECLINED', { reason: 'too expensive' });
    expect(isOk(declined)).toBe(true);
    expect(isOk(ok('DECLINED', 'QUOTED'))).toBe(true);
  });

  it('refuses to reopen a finished job', () => {
    for (const from of ['COLLECTED', 'CANCELLED'] as const) {
      for (const to of ['QUOTED', 'APPROVED', 'READY'] as const) {
        const result = ok(from, to);
        expect(isErr(result)).toBe(true);
      }
    }
  });

  it('refuses a quote with no lines — a price of nothing is not a quote', () => {
    const result = checkRepairTransition('RECEIVED', 'QUOTED', { quoteLineCount: 0 });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('QUOTE_NEEDS_LINES');
  });

  it('requires a reason to decline or cancel', () => {
    const declined = checkRepairTransition('QUOTED', 'DECLINED', { quoteLineCount: 1 });
    expect(isErr(declined)).toBe(true);

    const cancelled = checkRepairTransition('RECEIVED', 'CANCELLED', {
      quoteLineCount: 0,
      reason: '   ',
    });
    expect(isErr(cancelled)).toBe(true);
  });

  it('refuses COLLECTED as a bare status change — the invoice IS the collection', () => {
    // Marking a job collected without invoicing hands the device back with the
    // work unbilled: the leak a workshop notices at year-end, if ever.
    const result = checkRepairTransition('READY', 'COLLECTED', { quoteLineCount: 1 });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('COLLECT_IS_NOT_A_STATUS_CHANGE');
  });

  it('refuses approving a job that was never quoted', () => {
    const result = ok('RECEIVED', 'APPROVED');
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('the evidence gates', () => {
  const codeOf = (r: ReturnType<typeof checkRepairTransition>) =>
    isErr(r) ? r.error.code : null;

  it('takes a device in with no photograph — the courier is already gone', () => {
    // Intake itself is never gated. A shop that cannot record a job it has
    // physically accepted keeps no record at all, which is strictly worse.
    expect(isOk(checkRepairTransition('RECEIVED', 'CANCELLED', {
      quoteLineCount: 0,
      reason: 'customer collected it unrepaired',
    }))).toBe(true);
  });

  it('refuses to quote a device nobody photographed', () => {
    expect(codeOf(checkRepairTransition('RECEIVED', 'QUOTED', { quoteLineCount: 1 })))
      .toBe('NO_INTAKE_PHOTO');
  });

  it('quotes once there is a photograph', () => {
    expect(isOk(checkRepairTransition('RECEIVED', 'QUOTED', {
      quoteLineCount: 1,
      intakePhotoCount: 1,
    }))).toBe(true);
  });

  it('gates the re-quote after a decline too — the picture is still missing', () => {
    expect(codeOf(checkRepairTransition('DECLINED', 'QUOTED', { quoteLineCount: 1 })))
      .toBe('NO_INTAKE_PHOTO');
  });

  it('refuses to hand the device back without the intake signature', () => {
    expect(codeOf(checkRepairTransition('READY', 'COLLECTED', {
      quoteLineCount: 1,
      viaCollection: true,
      collectionSignatureCount: 1,
    }))).toBe('NO_INTAKE_SIGNATURE');
  });

  it('refuses to hand the device back without a signature for the device leaving', () => {
    expect(codeOf(checkRepairTransition('READY', 'COLLECTED', {
      quoteLineCount: 1,
      viaCollection: true,
      intakeSignatureCount: 1,
    }))).toBe('NO_COLLECTION_SIGNATURE');
  });

  it('still says "wrong route" before it says "no signature"', () => {
    // A bare status change is refused for the reason that actually helps —
    // telling someone to fetch a signature for a route that will reject them
    // anyway wastes the customer's time at the counter.
    expect(codeOf(checkRepairTransition('READY', 'COLLECTED', { quoteLineCount: 1 })))
      .toBe('COLLECT_IS_NOT_A_STATUS_CHANGE');
  });

  it('does not gate cancellation — an unrepaired device must be returnable', () => {
    // CANCELLED is the escape hatch for "we could not fix it, take it back".
    // Gating it on signatures would strand devices in the workshop forever.
    for (const from of ['RECEIVED', 'QUOTED', 'APPROVED', 'IN_PROGRESS', 'READY'] as const) {
      expect(isOk(checkRepairTransition(from, 'CANCELLED', {
        quoteLineCount: 1,
        reason: 'beyond economical repair',
      }))).toBe(true);
    }
  });
});
