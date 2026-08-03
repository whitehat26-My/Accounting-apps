/**
 * Repair jobs: the workshop's state machine.
 *
 * ---------------------------------------------------------------------------
 * A JOB IS A WORKFLOW DOCUMENT. MONEY MOVES ONLY AT COLLECTION.
 *
 * Nothing in a repair job touches the ledger until the customer collects, at
 * which point the job CONVERTS to an invoice through the same path every other
 * sale takes — stock relief, COGS, tax at the rate version, receipt if paid at
 * the counter. The job itself is intake notes, a diagnosis, a quote, and an
 * approval trail.
 *
 * That is a deliberate simplification, stated rather than hidden: parts fitted
 * mid-repair stay ON THE SHELF in the system until collection. The honest
 * alternative — issuing parts to work-in-progress as they are fitted
 * (Dr WIP / Cr Inventory, then Dr COGS / Cr WIP at invoice) — is the right
 * treatment for a workshop with weeks-long jobs and is recorded in the
 * settlement register as future work. For same-week repairs the WIP balance
 * would round to noise, and the simpler model keeps ZERO new ledger paths.
 * ---------------------------------------------------------------------------
 *
 * Pure: legality of transitions and what each one requires.
 */

import { err, ok, type Result } from './result.js';

export type RepairStatus =
  | 'RECEIVED'    // device taken in, fault recorded
  | 'QUOTED'      // diagnosis done, price named
  | 'APPROVED'    // customer said yes
  | 'DECLINED'    // customer said no — device goes back unrepaired
  | 'IN_PROGRESS' // on the bench
  | 'READY'       // repaired, awaiting collection
  | 'COLLECTED'   // invoiced (and usually paid); terminal
  | 'CANCELLED';  // abandoned before collection; terminal

/**
 * Legal transitions. Everything else is refused by name.
 *
 * DECLINED → QUOTED is allowed on purpose: "RM 800? no — what about just the
 * screen?" is a re-quote of the same job, not a new device at the door.
 * COLLECTED and CANCELLED are terminal; history does not reopen.
 */
const TRANSITIONS: Readonly<Record<RepairStatus, readonly RepairStatus[]>> = {
  RECEIVED: ['QUOTED', 'CANCELLED'],
  QUOTED: ['APPROVED', 'DECLINED', 'QUOTED', 'CANCELLED'],
  DECLINED: ['QUOTED', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'READY', 'CANCELLED'],
  IN_PROGRESS: ['READY', 'CANCELLED'],
  READY: ['COLLECTED', 'CANCELLED'],
  COLLECTED: [],
  CANCELLED: [],
};

export type RepairTransitionViolation =
  | {
      readonly code: 'ILLEGAL_TRANSITION';
      readonly from: RepairStatus;
      readonly to: RepairStatus;
      readonly allowed: readonly RepairStatus[];
    }
  | {
      /** Quoting with no lines names a price of nothing. */
      readonly code: 'QUOTE_NEEDS_LINES';
    }
  | {
      /**
       * Declining and cancelling both need a reason. The declined quote is the
       * number the owner watches — too many means the quotes are wrong — and
       * an unexplained cancellation is a device that left with no story.
       */
      readonly code: 'REASON_REQUIRED';
      readonly transition: RepairStatus;
    }
  | {
      /** Collection happens through `collectRepairJob`, never by hand. */
      readonly code: 'COLLECT_IS_NOT_A_STATUS_CHANGE';
    };

export interface RepairTransitionContext {
  readonly quoteLineCount: number;
  readonly reason?: string;
  /** True only when `collectRepairJob` itself is driving the transition. */
  readonly viaCollection?: boolean;
}

export function checkRepairTransition(
  from: RepairStatus,
  to: RepairStatus,
  context: RepairTransitionContext,
): Result<true, RepairTransitionViolation> {
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return err({ code: 'ILLEGAL_TRANSITION', from, to, allowed });
  }

  if (to === 'QUOTED' && context.quoteLineCount === 0) {
    return err({ code: 'QUOTE_NEEDS_LINES' });
  }

  if ((to === 'DECLINED' || to === 'CANCELLED') && !context.reason?.trim()) {
    return err({ code: 'REASON_REQUIRED', transition: to });
  }

  if (to === 'COLLECTED' && context.viaCollection !== true) {
    // Marking a job collected without invoicing it would hand the device back
    // with the work unbilled — the leak a workshop never notices until
    // year-end. The invoice IS the collection.
    return err({ code: 'COLLECT_IS_NOT_A_STATUS_CHANGE' });
  }

  return ok(true);
}

export function describeRepairViolation(v: RepairTransitionViolation): string {
  switch (v.code) {
    case 'ILLEGAL_TRANSITION':
      return (
        `A ${v.from} job cannot become ${v.to}. From ${v.from} it can only become: ` +
        (v.allowed.length > 0 ? v.allowed.join(', ') : 'nothing — it is finished')
      );
    case 'QUOTE_NEEDS_LINES':
      return 'A quote needs at least one line; a price of nothing is not a quote';
    case 'REASON_REQUIRED':
      return `${v.transition} requires a reason`;
    case 'COLLECT_IS_NOT_A_STATUS_CHANGE':
      return 'A job is collected by invoicing it (POST /repairs/:id/collect), not by setting the status';
  }
}
