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
    }
  | {
      /**
       * No photograph of the device as it arrived.
       *
       * This is the one piece of evidence that cannot be recreated later: once
       * the device is on the bench, nobody can prove what it looked like at
       * the counter. "That scratch was not there when I gave it to you" is the
       * single most common repair dispute, and a shop that photographed
       * nothing has only its word.
       */
      readonly code: 'NO_INTAKE_PHOTO';
    }
  | {
      /** The customer never signed for the condition recorded at intake. */
      readonly code: 'NO_INTAKE_SIGNATURE';
    }
  | {
      /** Nobody signed for the device on the way out. */
      readonly code: 'NO_COLLECTION_SIGNATURE';
    };

export interface RepairTransitionContext {
  readonly quoteLineCount: number;
  readonly reason?: string;
  /** True only when `collectRepairJob` itself is driving the transition. */
  readonly viaCollection?: boolean;
  /** Photographs stored at stage RECEIVED — the device as it arrived. */
  readonly intakePhotoCount?: number;
  /** Customer signatures at stage RECEIVED and at stage COLLECTED. */
  readonly intakeSignatureCount?: number;
  readonly collectionSignatureCount?: number;
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

  /*
   * EVIDENCE GATES.
   *
   * Placed on the TRANSITIONS rather than on intake itself, and the placement
   * is the whole design:
   *
   *   - A device can be taken in with nothing but a description, because the
   *     counter is sometimes a courier handing over a box. Refusing the job at
   *     that moment would mean the shop keeps no record at all.
   *   - It cannot be QUOTED until it has been photographed. Naming a price is
   *     the first commercial act, and by then somebody has had the device in
   *     their hands with a camera in their pocket.
   *   - It cannot be handed back until the customer has signed for BOTH the
   *     condition recorded at intake and the device leaving. At collection the
   *     customer is definitely present, so a signature missed at drop-off is
   *     caught here rather than lost.
   */
  if (to === 'QUOTED' && (context.intakePhotoCount ?? 0) === 0) {
    return err({ code: 'NO_INTAKE_PHOTO' });
  }

  if (to === 'COLLECTED' && context.viaCollection !== true) {
    // Marking a job collected without invoicing it would hand the device back
    // with the work unbilled — the leak a workshop never notices until
    // year-end. The invoice IS the collection.
    //
    // Checked BEFORE the signatures: "you are using the wrong route" is the
    // more useful answer, and telling someone to collect a signature on a
    // path that will refuse them anyway wastes the customer's time.
    return err({ code: 'COLLECT_IS_NOT_A_STATUS_CHANGE' });
  }

  if (to === 'COLLECTED') {
    if ((context.intakeSignatureCount ?? 0) === 0) return err({ code: 'NO_INTAKE_SIGNATURE' });
    if ((context.collectionSignatureCount ?? 0) === 0) {
      return err({ code: 'NO_COLLECTION_SIGNATURE' });
    }
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
    case 'NO_INTAKE_PHOTO':
      return (
        'Photograph the device before quoting it. The picture of how it arrived is the ' +
        'one piece of evidence nobody can recreate later, and it is what answers ' +
        '“that damage was not there when I brought it in”'
      );
    case 'NO_INTAKE_SIGNATURE':
      return (
        'The customer has not signed for the condition recorded when the device came in. ' +
        'Capture it now — they are standing in front of you'
      );
    case 'NO_COLLECTION_SIGNATURE':
      return 'The customer must sign for the device before it leaves the shop';
  }
}
