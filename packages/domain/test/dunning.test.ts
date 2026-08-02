import { describe, expect, it } from 'vitest';
import { DEFAULT_DUNNING_TIERS, nextTier, reminderMessage } from '../src/index.js';

const facts = (daysOverdue: number, tiersAlreadyRaised: number[] = []) => ({
  invoiceNo: 'INV-00042',
  contactName: 'Nusantara Retail Sdn Bhd',
  dueDate: '2026-07-15',
  amountDue: '1080.0000',
  currency: 'MYR',
  daysOverdue,
  tiersAlreadyRaised,
});

describe('nextTier', () => {
  it('stays quiet before the first rung', () => {
    expect(nextTier(facts(2), DEFAULT_DUNNING_TIERS)).toBeNull();
  });

  it('climbs the ladder one rung per pass', () => {
    expect(nextTier(facts(3), DEFAULT_DUNNING_TIERS)?.tier).toBe(1);
    expect(nextTier(facts(8, [1]), DEFAULT_DUNNING_TIERS)?.tier).toBe(2);
    expect(nextTier(facts(15, [1, 2]), DEFAULT_DUNNING_TIERS)?.tier).toBe(3);
    expect(nextTier(facts(40, [1, 2, 3]), DEFAULT_DUNNING_TIERS)).toBeNull();
  });

  it('jumps straight to the highest applicable tier for an old invoice — one message, not a barrage', () => {
    // An invoice discovered 20 days overdue (imported history, policy just
    // turned on) gets ONE owner alert, not three reminders in a row.
    const tier = nextTier(facts(20), DEFAULT_DUNNING_TIERS);
    expect(tier?.tier).toBe(3);
    expect(tier?.tone).toBe('OWNER_ALERT');
  });

  it('never raises a lower tier than one already raised', () => {
    // FIRM was sent; days-overdue says only FRIENDLY and FIRM apply. Sending
    // FRIENDLY now would be the system forgetting itself.
    expect(nextTier(facts(8, [2]), DEFAULT_DUNNING_TIERS)).toBeNull();
  });

  it('waits between rungs', () => {
    // Tier 1 raised at day 3; at day 5 tier 2 is not yet due.
    expect(nextTier(facts(5, [1]), DEFAULT_DUNNING_TIERS)).toBeNull();
  });
});

describe('reminderMessage', () => {
  it('writes a sendable friendly nudge with the figures in display form', () => {
    const message = reminderMessage('FRIENDLY', facts(4), 'Emil Computer Centre');
    expect(message).toContain('INV-00042');
    expect(message).toContain('RM 1,080.00');
    expect(message).toContain('15/07/2026'); // rule 8: DD/MM/YYYY
    expect(message).toContain('Terima kasih');
    expect(message).not.toContain('days'); // friendly does not count days at people
  });

  it('counts the days in the firm reminder', () => {
    const message = reminderMessage('FIRM', facts(9), 'Emil Computer Centre');
    expect(message).toContain('9 days past');
  });

  it('addresses the owner alert to the OWNER, with a decision to make', () => {
    const message = reminderMessage('OWNER_ALERT', facts(15), 'Emil Computer Centre');
    expect(message).toContain('Decide');
    expect(message).toContain('payment plan');
    // It names the customer as the subject, not the recipient.
    expect(message.startsWith('⚠')).toBe(true);
  });
});
