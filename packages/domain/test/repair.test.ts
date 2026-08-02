import { describe, expect, it } from 'vitest';
import { checkRepairTransition, isErr, isOk, type RepairStatus } from '../src/index.js';

const ok = (from: RepairStatus, to: RepairStatus, ctx = {}) =>
  checkRepairTransition(from, to, { quoteLineCount: 1, ...ctx });

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
