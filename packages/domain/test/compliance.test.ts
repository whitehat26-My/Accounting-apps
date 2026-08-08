import { describe, expect, it } from 'vitest';
import {
  deadlineStatus,
  expandCalendar,
  expandRule,
  type DeadlineRule,
} from '../src/compliance.js';

const monthly = (code: string, dueDay: number | null = 15): DeadlineRule => ({
  code,
  label: code,
  description: '',
  frequency: 'MONTHLY',
  dueDay,
  dueMonth: null,
  appliesWhen: 'PAYROLL',
  legislationRef: 'test',
  verification: 'PRIMARY',
});

describe('monthly deadlines', () => {
  it('lands each month in the FOLLOWING month, December in next January', () => {
    const instances = expandRule(monthly('PCB_CP39'), 2026);
    expect(instances).toHaveLength(12);

    // January 2026's dues settle DECEMBER 2025's wages.
    expect(instances[0]).toMatchObject({
      periodKey: '2025-12',
      periodLabel: 'December 2025',
      dueDate: '2026-01-15',
      payMonth: '2025-12-01',
    });
    // August wages fall due 15 September.
    expect(instances.find((i) => i.periodKey === '2026-08')!.dueDate).toBe('2026-09-15');
  });
});

describe('SST bi-monthly periods', () => {
  const sst: DeadlineRule = {
    ...monthly('SST_RETURN', null),
    frequency: 'BIMONTHLY',
    appliesWhen: 'SST',
  };

  it('six periods fall due per year, each on a month-end', () => {
    const instances = expandRule(sst, 2026);
    expect(instances).toHaveLength(6);

    // The first due date of 2026 belongs to LAST year's Nov–Dec period.
    expect(instances[0]).toMatchObject({
      periodKey: '2025-P6',
      periodLabel: 'SST period Nov–Dec 2025',
      dueDate: '2026-01-31',
    });
    // Jan–Feb 2026 ends in February; the return is due the last day of March.
    expect(instances[1]).toMatchObject({
      periodKey: '2026-P1',
      periodLabel: 'SST period Jan–Feb 2026',
      dueDate: '2026-03-31',
    });
    // Jul–Aug: due 30 September — a 30-day month-end, not a blind "31".
    expect(instances.find((i) => i.periodKey === '2026-P4')!.dueDate).toBe('2026-09-30');
  });
});

describe('annual deadlines', () => {
  it('EA lands on the LAST day of February, leap year included', () => {
    const ea: DeadlineRule = {
      ...monthly('EA_TO_STAFF', null),
      frequency: 'ANNUAL',
      dueMonth: 2,
    };
    // 2028 is a leap year: the last day of February is the 29th.
    expect(expandRule(ea, 2027)[0]!.dueDate).toBe('2027-02-28');
    expect(expandRule(ea, 2028)[0]!.dueDate).toBe('2028-02-29');
    // And it covers the PREVIOUS year.
    expect(expandRule(ea, 2027)[0]!.periodKey).toBe('2026');
  });

  it('Form E is 31 March for last year', () => {
    const formE: DeadlineRule = {
      ...monthly('FORM_E', 31),
      frequency: 'ANNUAL',
      dueMonth: 3,
    };
    expect(expandRule(formE, 2027)[0]).toMatchObject({
      periodKey: '2026',
      dueDate: '2027-03-31',
    });
  });
});

describe('the whole calendar', () => {
  it('is date-ordered with stable tiebreaks', () => {
    const rules = [monthly('B'), monthly('A')];
    const calendar = expandCalendar(rules, 2026);
    expect(calendar[0]!.ruleCode).toBe('A');
    expect(calendar[1]!.ruleCode).toBe('B');
    const dates = calendar.map((i) => i.dueDate);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('status precedence', () => {
  const base = { dueDate: '2026-09-15', today: '2026-08-05' };

  it('ticked beats everything, even overdue', () => {
    expect(deadlineStatus({ ...base, today: '2026-10-01', ticked: true })).toBe('DONE');
  });
  it('a blown deadline outranks a ready artifact', () => {
    expect(
      deadlineStatus({ ...base, today: '2026-09-16', ticked: false, artifactReady: true }),
    ).toBe('OVERDUE');
  });
  it('the artifact existing means go file', () => {
    expect(deadlineStatus({ ...base, ticked: false, artifactReady: true })).toBe('READY');
  });
  it('a month that ended with nothing confirmed needs attention', () => {
    expect(deadlineStatus({ ...base, ticked: false, artifactMissing: true })).toBe('ATTENTION');
  });
  it('otherwise it is simply not yet', () => {
    expect(deadlineStatus({ ...base, ticked: false })).toBe('UPCOMING');
  });
});
