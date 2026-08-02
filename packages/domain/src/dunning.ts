/**
 * Payment follow-up: the three-tier escalation ladder.
 *
 * ---------------------------------------------------------------------------
 * CHASING MONEY IS A SCHEDULE, NOT A MOOD.
 *
 * The reason unpaid invoices age is not that owners are shy — it is that
 * "remind them next week" lives in nobody's calendar. This module makes the
 * ladder explicit: a friendly nudge a few days after due, a firmer note a week
 * in, and an OWNER ALERT at two weeks, because by then the question is no
 * longer wording, it is whether this customer gets credit again.
 *
 * The MESSAGE is part of the machinery, deliberately. Until an email
 * transport exists (and honestly, long after), a Malaysian SME chases payment
 * by WhatsApp — so the system's job is to put the right words on the
 * clipboard with the right figures in them, dates DD/MM/YYYY, amounts in RM.
 * ---------------------------------------------------------------------------
 *
 * Pure: invoices and history in, today's actions out.
 */

export type DunningTone = 'FRIENDLY' | 'FIRM' | 'OWNER_ALERT';

export interface DunningTier {
  readonly tier: number;
  readonly daysAfterDue: number;
  readonly tone: DunningTone;
}

/** The diagram's ladder: day 3, week 1, week 2. Tenant-overridable in the DB. */
export const DEFAULT_DUNNING_TIERS: readonly DunningTier[] = [
  { tier: 1, daysAfterDue: 3, tone: 'FRIENDLY' },
  { tier: 2, daysAfterDue: 7, tone: 'FIRM' },
  { tier: 3, daysAfterDue: 14, tone: 'OWNER_ALERT' },
];

export interface OverdueInvoiceFacts {
  readonly invoiceNo: string;
  readonly contactName: string;
  /** ISO. Display conversion happens in the message builder. */
  readonly dueDate: string;
  /** Decimal string in the invoice currency. */
  readonly amountDue: string;
  readonly currency: string;
  readonly daysOverdue: number;
  /** Tiers already recorded for this invoice, sent or still queued. */
  readonly tiersAlreadyRaised: readonly number[];
}

/**
 * Which tier this invoice earns today, or null.
 *
 * The HIGHEST applicable unraised tier, not every missed one: an invoice
 * discovered 20 days overdue (imported history, a policy just enabled) gets
 * one OWNER_ALERT, not three messages in a row — a barrage teaches the
 * customer that reminders are noise.
 */
export function nextTier(
  facts: OverdueInvoiceFacts,
  tiers: readonly DunningTier[],
): DunningTier | null {
  const applicable = tiers
    .filter((t) => facts.daysOverdue >= t.daysAfterDue)
    .filter((t) => !facts.tiersAlreadyRaised.includes(t.tier))
    .sort((a, b) => b.tier - a.tier);

  const highest = applicable[0];
  if (!highest) return null;

  // Never raise a lower tier than one already raised: after a FIRM reminder,
  // a FRIENDLY one reads as the system forgetting itself.
  const highestRaised = Math.max(0, ...facts.tiersAlreadyRaised);
  if (highest.tier <= highestRaised) return null;

  return highest;
}

/**
 * The message, ready for the clipboard.
 *
 * Written to be SENT, not templated to death: first person plural, the
 * figures the customer needs to act (invoice number, amount, due date), and
 * no threats — tier 3's escalation is to the OWNER, not at the customer.
 */
export function reminderMessage(
  tone: DunningTone,
  facts: Pick<OverdueInvoiceFacts, 'invoiceNo' | 'contactName' | 'dueDate' | 'amountDue' | 'currency' | 'daysOverdue'>,
  shopName: string,
): string {
  const amount = `${facts.currency === 'MYR' ? 'RM ' : `${facts.currency} `}${displayAmount(facts.amountDue)}`;
  const due = displayDate(facts.dueDate);

  switch (tone) {
    case 'FRIENDLY':
      return (
        `Hi ${facts.contactName}, gentle reminder from ${shopName}: ` +
        `invoice ${facts.invoiceNo} for ${amount} was due on ${due}. ` +
        `If you have already paid, thank you — please ignore this. ` +
        `Otherwise we would appreciate payment at your convenience. Terima kasih!`
      );
    case 'FIRM':
      return (
        `Hi ${facts.contactName}, this is ${shopName} following up on invoice ` +
        `${facts.invoiceNo} for ${amount}, now ${facts.daysOverdue} days past its ` +
        `due date of ${due}. Please arrange payment this week, or let us know if ` +
        `something is holding it up so we can help sort it out.`
      );
    case 'OWNER_ALERT':
      // Addressed to the OWNER, not the customer — the diagram's "flag to
      // owner". Two weeks overdue is a decision point, not a wording problem.
      return (
        `⚠ ${facts.contactName} — invoice ${facts.invoiceNo} for ${amount} is now ` +
        `${facts.daysOverdue} days overdue (due ${due}). Two reminders have been ` +
        `raised. Decide: call them, agree a payment plan, or hold further credit.`
      );
  }
}

// ------------------------------------------------------------------ display

function displayDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** '1234.5000' → '1,234.50'. String surgery, no arithmetic. */
function displayAmount(decimal: string): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  const cents = fraction.padEnd(2, '0').slice(0, 2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${cents}`;
}
