/**
 * Bill approval — threshold routing and separation of duties (M3).
 *
 * Deferred out of M3 deliberately and built now, because it could not be built
 * before: threshold routing without users points at bare UUIDs, and separation
 * of duties cannot be enforced by a system with no concept of two people.
 *
 * ---------------------------------------------------------------------------
 * APPROVAL GATES PAYMENT, NOT RECOGNITION. THIS IS THE DECISION THAT MATTERS.
 *
 * The tempting design is to hold a bill out of the ledger until it is approved.
 * It is wrong, and wrong in a way that produces a misstatement rather than an
 * inconvenience.
 *
 * If the goods arrived and the supplier has invoiced, the obligation EXISTS.
 * Accrual accounting recognises it when it is incurred, not when someone
 * internal gets round to authorising the payment. A bill held out of the ledger
 * pending approval understates payables and understates expenses — and it does
 * so at exactly the moment it matters most, because bills pile up unapproved at
 * period end when everyone is busy.
 *
 * So a bill posts on entry. What approval controls is whether money may LEAVE:
 * `paySupplier()` refuses a bill whose approval is outstanding. Internal control
 * over cash, not a lever over the general ledger.
 * ---------------------------------------------------------------------------
 *
 * Pure. The rules, the decisions and the clock are supplied, so every awkward
 * case below — a self-approval, one person filling both steps, a role that
 * changed after the decision — is testable without a database.
 */

import { Money } from './money.js';
import type { RoleCode } from './rbac.js';

/**
 * A routing rule: bills in this amount band need this role's approval at this
 * step.
 */
export interface ApprovalRule {
  readonly id: string;
  /** Inclusive. */
  readonly minAmount: Money;
  /** Inclusive; absent means unbounded. */
  readonly maxAmount?: Money;
  readonly requiredRole: RoleCode;
  /** 1-based. Two rules at the same band with sequences 1 and 2 mean two approvers. */
  readonly sequence: number;
}

/** One approval a bill actually needs, resolved from the rules. */
export interface ApprovalStep {
  readonly sequence: number;
  readonly requiredRole: RoleCode;
  readonly ruleId: string;
}

export type ApprovalDecisionKind = 'APPROVE' | 'REJECT';

export interface ApprovalDecision {
  readonly sequence: number;
  readonly decision: ApprovalDecisionKind;
  readonly decidedBy: string;
  /**
   * The approver's role AT THE MOMENT THEY DECIDED, recorded rather than looked
   * up later. A role change afterwards must not retroactively invalidate — or
   * validate — a decision that was correct when it was made.
   */
  readonly roleAtDecision: RoleCode;
  readonly decidedAt: string;
}

/**
 * Which approvals a bill of this size needs.
 *
 * Every rule whose band contains the amount applies, ordered by sequence. Bands
 * are allowed to overlap on purpose: "anything over RM 1,000 needs an
 * Accountant" and "anything over RM 10,000 also needs an Owner" is two rules,
 * and a RM 50,000 bill picks up both.
 *
 * Compared on the ABSOLUTE amount. A credit-natured total would otherwise slip
 * under every threshold and route to nobody.
 */
export function requiredApprovals(
  amount: Money,
  rules: readonly ApprovalRule[],
): ApprovalStep[] {
  const magnitude = amount.abs();

  return rules
    .filter(
      (rule) =>
        magnitude.compare(rule.minAmount) >= 0 &&
        (rule.maxAmount === undefined || magnitude.compare(rule.maxAmount) <= 0),
    )
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
    .map((rule) => ({
      sequence: rule.sequence,
      requiredRole: rule.requiredRole,
      ruleId: rule.id,
    }));
}

export type ApprovalStatus = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export type ApprovalViolation =
  /** The person who entered the bill tried to approve it. */
  | { readonly code: 'SELF_APPROVAL'; readonly userId: string }
  /** One person tried to fill two steps that exist to be filled by two people. */
  | { readonly code: 'DUPLICATE_APPROVER'; readonly userId: string; readonly sequence: number }
  | {
      readonly code: 'WRONG_ROLE';
      readonly sequence: number;
      readonly required: RoleCode;
      readonly actual: RoleCode;
    }
  | { readonly code: 'UNKNOWN_STEP'; readonly sequence: number }
  | { readonly code: 'DUPLICATE_DECISION'; readonly sequence: number };

export interface ApprovalState {
  readonly status: ApprovalStatus;
  /** Steps still waiting on someone. */
  readonly outstanding: readonly ApprovalStep[];
  readonly violations: readonly ApprovalViolation[];
}

/**
 * Where a bill's approval stands, given its steps and the decisions so far.
 *
 * ---------------------------------------------------------------------------
 * THE TWO RULES THAT MAKE THIS A CONTROL RATHER THAN PAPERWORK.
 *
 *   1. THE REQUESTER MAY NEVER APPROVE. An approval workflow where the person
 *      who raised the bill can authorise it records a click and controls
 *      nothing. This is the single most common way approval features are built
 *      useless.
 *
 *   2. ONE PERSON MAY NOT FILL TWO STEPS. "Over RM 10,000 needs a second
 *      approver" means a second PERSON. Letting one user satisfy both sequences
 *      because they happen to hold both roles defeats the threshold entirely —
 *      and it is exactly what happens at a small company where one person is
 *      both Accountant and Owner.
 *
 * A rejection at ANY step is final. Requiring every step to reject before the
 * bill is refused would mean one approver's objection could be overridden by
 * the others simply not deciding.
 * ---------------------------------------------------------------------------
 */
export function evaluateApproval(
  steps: readonly ApprovalStep[],
  decisions: readonly ApprovalDecision[],
  requestedBy: string,
): ApprovalState {
  if (steps.length === 0) {
    return { status: 'NOT_REQUIRED', outstanding: [], violations: [] };
  }

  const violations: ApprovalViolation[] = [];
  const bySequence = new Map(steps.map((s) => [s.sequence, s]));
  const seenSequences = new Set<number>();
  const approvers = new Map<string, number>();

  for (const decision of decisions) {
    const step = bySequence.get(decision.sequence);

    if (step === undefined) {
      violations.push({ code: 'UNKNOWN_STEP', sequence: decision.sequence });
      continue;
    }

    if (seenSequences.has(decision.sequence)) {
      violations.push({ code: 'DUPLICATE_DECISION', sequence: decision.sequence });
      continue;
    }
    seenSequences.add(decision.sequence);

    if (decision.decidedBy === requestedBy) {
      violations.push({ code: 'SELF_APPROVAL', userId: decision.decidedBy });
    }

    const already = approvers.get(decision.decidedBy);
    if (already !== undefined) {
      violations.push({
        code: 'DUPLICATE_APPROVER',
        userId: decision.decidedBy,
        sequence: decision.sequence,
      });
    }
    approvers.set(decision.decidedBy, decision.sequence);

    if (decision.roleAtDecision !== step.requiredRole) {
      violations.push({
        code: 'WRONG_ROLE',
        sequence: decision.sequence,
        required: step.requiredRole,
        actual: decision.roleAtDecision,
      });
    }
  }

  // A rejection anywhere is final, and is reported even alongside violations:
  // the bill is refused either way, and hiding the rejection behind a
  // procedural complaint would be misleading.
  if (decisions.some((d) => d.decision === 'REJECT')) {
    return { status: 'REJECTED', outstanding: [], violations };
  }

  const outstanding = steps.filter((s) => !seenSequences.has(s.sequence));

  // Violations mean the decisions on record do not constitute valid approval.
  // The bill stays PENDING rather than being marked approved with a warning —
  // an approval that is "approved, but" is an approval in every report that
  // matters.
  if (violations.length > 0) {
    return { status: 'PENDING', outstanding, violations };
  }

  return {
    status: outstanding.length === 0 ? 'APPROVED' : 'PENDING',
    outstanding,
    violations,
  };
}

/**
 * Whether one person may record a decision on a step right now.
 *
 * Checked BEFORE the decision is written, so an invalid one never reaches the
 * table — `evaluateApproval` then describes a history that is valid by
 * construction, rather than a mixture of good and bad rows that every reader
 * has to re-filter.
 */
export function canDecide(
  step: ApprovalStep,
  actor: { userId: string; role: RoleCode },
  requestedBy: string,
  decisions: readonly ApprovalDecision[],
): { allowed: true } | { allowed: false; violation: ApprovalViolation } {
  if (actor.userId === requestedBy) {
    return { allowed: false, violation: { code: 'SELF_APPROVAL', userId: actor.userId } };
  }

  if (decisions.some((d) => d.sequence === step.sequence)) {
    return {
      allowed: false,
      violation: { code: 'DUPLICATE_DECISION', sequence: step.sequence },
    };
  }

  if (decisions.some((d) => d.decidedBy === actor.userId)) {
    return {
      allowed: false,
      violation: {
        code: 'DUPLICATE_APPROVER',
        userId: actor.userId,
        sequence: step.sequence,
      },
    };
  }

  if (actor.role !== step.requiredRole) {
    return {
      allowed: false,
      violation: {
        code: 'WRONG_ROLE',
        sequence: step.sequence,
        required: step.requiredRole,
        actual: actor.role,
      },
    };
  }

  return { allowed: true };
}

/**
 * Whether a bill may be paid.
 *
 * The one question the rest of the system asks this module. `NOT_REQUIRED` and
 * `APPROVED` both permit payment; anything else does not.
 */
export function mayPay(status: ApprovalStatus): boolean {
  return status === 'NOT_REQUIRED' || status === 'APPROVED';
}

/**
 * A human explanation of why a bill cannot be paid yet.
 *
 * Written here rather than at the call site so the wording is the same
 * wherever it surfaces — and because "approval required" with no indication of
 * WHOSE approval is the most common complaint about workflow software.
 */
export function explainBlockedPayment(state: ApprovalState): string {
  if (state.status === 'REJECTED') {
    return 'This bill was rejected in approval and cannot be paid. Raise a debit note or a new bill.';
  }

  const waiting = state.outstanding
    .map((s) => `step ${s.sequence} (${s.requiredRole})`)
    .join(', ');

  return waiting.length > 0
    ? `This bill is awaiting approval: ${waiting}.`
    : 'This bill is awaiting approval.';
}
