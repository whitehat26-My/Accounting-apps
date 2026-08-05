/**
 * The compliance calendar — expanding deadline RULES into dated INSTANCES.
 *
 * Pure, because the arithmetic is exactly the kind that goes quietly wrong:
 * bi-monthly period boundaries, "last day of the month" across a leap
 * February, an annual return that covers the PREVIOUS year. Every branch is
 * unit-tested without a database.
 */

export type DeadlineFrequency = 'MONTHLY' | 'BIMONTHLY' | 'ANNUAL';
export type DeadlineAppliesWhen = 'PAYROLL' | 'SST' | 'ALWAYS';

export interface DeadlineRule {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly frequency: DeadlineFrequency;
  /** Day of the due month; null = the last day of that month. */
  readonly dueDay: number | null;
  /** ANNUAL only: which month of the year the deadline falls in. */
  readonly dueMonth: number | null;
  readonly appliesWhen: DeadlineAppliesWhen;
  readonly legislationRef: string;
  readonly verification: 'PRIMARY' | 'SECONDARY';
}

export interface DeadlineInstance {
  readonly ruleCode: string;
  /** Stable key a tick attaches to: '2026-08', '2026-P4', '2025'. */
  readonly periodKey: string;
  /** "August 2026", "SST period Jul–Aug 2026", "Year 2025". */
  readonly periodLabel: string;
  /** ISO date the obligation falls due. */
  readonly dueDate: string;
  /**
   * For payroll monthlies: the pay month this instance settles (ISO first of
   * month) — what the status check looks up a confirmed run against.
   */
  readonly payMonth: string | null;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function lastDayOfMonth(year: number, month: number): number {
  // Day 0 of the NEXT month. Handles leap February without an opinion.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Every instance of one rule that falls DUE in the given calendar year.
 *
 * "Due in", not "covers": January's EPF payment for December wages belongs to
 * the January it must be paid in — the calendar answers "what must I do this
 * year", not "what did this year owe".
 */
export function expandRule(rule: DeadlineRule, year: number): DeadlineInstance[] {
  switch (rule.frequency) {
    case 'MONTHLY': {
      // Due in month M for wages of month M-1 (December's lands in January).
      return Array.from({ length: 12 }, (_, i) => {
        const dueMonth = i + 1;
        const covered = dueMonth === 1 ? { year: year - 1, month: 12 } : { year, month: dueMonth - 1 };
        const day = rule.dueDay ?? lastDayOfMonth(year, dueMonth);
        return {
          ruleCode: rule.code,
          periodKey: `${covered.year}-${String(covered.month).padStart(2, '0')}`,
          periodLabel: `${MONTHS[covered.month - 1]} ${covered.year}`,
          dueDate: iso(year, dueMonth, day),
          payMonth: iso(covered.year, covered.month, 1),
        };
      });
    }

    case 'BIMONTHLY': {
      /*
       * SST taxable periods: Jan–Feb, Mar–Apr, May–Jun, Jul–Aug, Sep–Oct,
       * Nov–Dec, due by the last day of the month AFTER the period ends —
       * so the period ending in December falls due the FOLLOWING January,
       * and the previous year's Nov–Dec period falls due in THIS year's
       * January. Six instances fall due per calendar year.
       */
      const instances: DeadlineInstance[] = [];
      for (let period = 0; period < 6; period++) {
        // The period whose due date lands in `year`: due month = period end + 1.
        const dueMonth = period * 2 + 1; // Jan, Mar, May, Jul, Sep, Nov
        const covered =
          period === 0
            ? { year: year - 1, startMonth: 11, endMonth: 12, index: 6 }
            : { year, startMonth: dueMonth - 2, endMonth: dueMonth - 1, index: period };
        const day = rule.dueDay ?? lastDayOfMonth(year, dueMonth);
        instances.push({
          ruleCode: rule.code,
          periodKey: `${covered.year}-P${covered.index}`,
          periodLabel: `SST period ${MONTHS[covered.startMonth - 1]!.slice(0, 3)}–${MONTHS[covered.endMonth - 1]!.slice(0, 3)} ${covered.year}`,
          dueDate: iso(year, dueMonth, day),
          payMonth: null,
        });
      }
      return instances;
    }

    case 'ANNUAL': {
      const dueMonth = rule.dueMonth!;
      const day = rule.dueDay ?? lastDayOfMonth(year, dueMonth);
      return [
        {
          ruleCode: rule.code,
          periodKey: String(year - 1),
          periodLabel: `Year ${year - 1}`,
          dueDate: iso(year, dueMonth, day),
          payMonth: null,
        },
      ];
    }
  }
}

/** All rules, expanded and date-ordered — the year as one list. */
export function expandCalendar(
  rules: readonly DeadlineRule[],
  year: number,
): DeadlineInstance[] {
  return rules
    .flatMap((rule) => expandRule(rule, year))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.ruleCode.localeCompare(b.ruleCode));
}

export type DeadlineStatus = 'DONE' | 'OVERDUE' | 'READY' | 'ATTENTION' | 'UPCOMING';

/**
 * One instance's status, from facts the caller looked up.
 *
 * The precedence is what a person scanning the screen needs first:
 * ticked beats everything; a blown deadline beats a nice-to-have; "the
 * artifact you need exists, go file" beats "month ended and nothing is
 * confirmed"; everything else is simply not yet.
 */
export function deadlineStatus(input: {
  readonly dueDate: string;
  readonly today: string;
  readonly ticked: boolean;
  /** Payroll rules: is there a CONFIRMED run for the covered month? */
  readonly artifactReady?: boolean;
  /** Payroll rules: has the covered month ENDED with no confirmed run? */
  readonly artifactMissing?: boolean;
}): DeadlineStatus {
  if (input.ticked) return 'DONE';
  if (input.today > input.dueDate) return 'OVERDUE';
  if (input.artifactReady === true) return 'READY';
  if (input.artifactMissing === true) return 'ATTENTION';
  return 'UPCOMING';
}
