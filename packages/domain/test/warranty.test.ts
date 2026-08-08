import { describe, expect, it } from 'vitest';
import { promiseStatus, warrantyWindow, EXPIRING_SOON_DAYS } from '../src/warranty.js';

describe('warrantyWindow', () => {
  it('adds plain months', () => {
    expect(warrantyWindow('2026-03-15', 12).expiresOn).toBe('2027-03-15');
    expect(warrantyWindow('2026-03-15', 6).expiresOn).toBe('2026-09-15');
  });

  it('clamps to the last day of a shorter month', () => {
    // The argument at the counter this prevents: a laptop sold on 31 January
    // with a one-month promise expires in February, not in March.
    expect(warrantyWindow('2026-01-31', 1).expiresOn).toBe('2026-02-28');
    expect(warrantyWindow('2026-05-31', 1).expiresOn).toBe('2026-06-30');
  });

  it('knows February has 29 days in a leap year', () => {
    expect(warrantyWindow('2028-01-31', 1).expiresOn).toBe('2028-02-29');
  });

  it('rolls the year over, once and many times', () => {
    expect(warrantyWindow('2026-11-10', 3).expiresOn).toBe('2027-02-10');
    expect(warrantyWindow('2026-06-01', 24).expiresOn).toBe('2028-06-01');
    // The CHECK ceiling: ten years is the longest promise the schema accepts.
    expect(warrantyWindow('2026-06-01', 120).expiresOn).toBe('2036-06-01');
  });

  it('treats a December sale correctly rather than landing on month 13', () => {
    expect(warrantyWindow('2026-12-20', 1).expiresOn).toBe('2027-01-20');
    expect(warrantyWindow('2026-12-31', 12).expiresOn).toBe('2027-12-31');
  });
});

describe('promiseStatus', () => {
  const window = warrantyWindow('2026-01-15', 12); // expires 2027-01-15

  it('is ACTIVE with time to spare', () => {
    expect(promiseStatus('2026-06-01', window)).toBe('ACTIVE');
  });

  it('turns EXPIRING_SOON inside the last 30 days, and not a day earlier', () => {
    expect(promiseStatus('2026-12-15', window)).toBe('ACTIVE'); // 31 days left
    expect(promiseStatus('2026-12-16', window)).toBe('EXPIRING_SOON'); // exactly 30
    expect(EXPIRING_SOON_DAYS).toBe(30);
  });

  it('covers the last day itself — a promise is kept to the end of it', () => {
    expect(promiseStatus('2027-01-15', window)).toBe('EXPIRING_SOON');
    expect(promiseStatus('2027-01-16', window)).toBe('EXPIRED');
  });
});
