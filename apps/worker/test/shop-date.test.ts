import { describe, expect, it } from 'vitest';
import { shopDate } from '../src/jobs/index.js';

/**
 * CLAUDE.md rule 8: the shop's clock is Asia/Kuala_Lumpur, UTC+8, no DST.
 *
 * `paymentReminders` derived its `today` from `now.toISOString()`, which is
 * the UTC date, while `weeklyDigest` twenty lines below applied the offset and
 * explained why. The nightly slot is 03:00 local — 19:00 UTC the day before —
 * so the follow-up pass ran the whole year with yesterday's date.
 *
 * That date is not decoration. `runFollowUpPass` computes
 * `(today::date - due_date)` and filters `due_date < today::date`, so an
 * invoice due on the 12th did not reach tier 1 until the 20th rather than the
 * 19th, and `payment_reminder.queued_on` recorded the day before the reminder
 * was composed.
 */
describe('shopDate', () => {
  it('is still yesterday in UTC through the small hours in Kuala Lumpur', () => {
    // 03:00 on 19 August in KL is 19:00 on the 18th in UTC — the nightly slot.
    const nightly = new Date('2026-08-18T19:00:00Z');

    expect(nightly.toISOString().slice(0, 10)).toBe('2026-08-18');
    expect(shopDate(nightly)).toBe('2026-08-19');
  });

  it('agrees with UTC for the rest of the day', () => {
    // 15:00 KL = 07:00 UTC, same calendar date either way.
    expect(shopDate(new Date('2026-08-19T07:00:00Z'))).toBe('2026-08-19');
  });

  it('rolls at 16:00 UTC exactly, which is KL midnight', () => {
    expect(shopDate(new Date('2026-08-18T15:59:59Z'))).toBe('2026-08-18');
    expect(shopDate(new Date('2026-08-18T16:00:00Z'))).toBe('2026-08-19');
  });

  it('carries a month and a year over', () => {
    expect(shopDate(new Date('2026-08-31T16:00:00Z'))).toBe('2026-09-01');
    expect(shopDate(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01');
  });
});
