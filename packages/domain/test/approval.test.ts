import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Money } from '../src/money.js';
import {
  canDecide,
  evaluateApproval,
  explainBlockedPayment,
  mayPay,
  requiredApprovals,
  type ApprovalDecision,
  type ApprovalRule,
  type ApprovalStep,
} from '../src/approval.js';

const MYR = 'MYR';
const rm = (v: string) => Money.fromDecimal(v, MYR);

/** The shape a Malaysian SME actually configures: one approver, then two. */
const RULES: ApprovalRule[] = [
  { id: 'r1', minAmount: rm('1000.00'), requiredRole: 'ACCOUNTANT', sequence: 1 },
  { id: 'r2', minAmount: rm('10000.00'), requiredRole: 'OWNER', sequence: 2 },
];

const step = (over: Partial<ApprovalStep> = {}): ApprovalStep => ({
  sequence: 1,
  requiredRole: 'ACCOUNTANT',
  ruleId: 'r1',
  ...over,
});

const decision = (over: Partial<ApprovalDecision> = {}): ApprovalDecision => ({
  sequence: 1,
  decision: 'APPROVE',
  decidedBy: 'approver-1',
  roleAtDecision: 'ACCOUNTANT',
  decidedAt: '2026-08-20T10:00:00.000Z',
  ...over,
});

describe('requiredApprovals — threshold routing', () => {
  it('needs nobody below the lowest threshold', () => {
    expect(requiredApprovals(rm('999.99'), RULES)).toEqual([]);
  });

  it('needs one approver in the middle band', () => {
    const steps = requiredApprovals(rm('5000.00'), RULES);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.requiredRole).toBe('ACCOUNTANT');
  });

  it('accumulates overlapping bands rather than picking one', () => {
    // "Over RM 1,000 needs an Accountant" and "over RM 10,000 ALSO needs an
    // Owner" is two rules, and a large bill picks up both. Picking only the
    // highest band would silently drop the first approver.
    const steps = requiredApprovals(rm('50000.00'), RULES);
    expect(steps.map((s) => s.requiredRole)).toEqual(['ACCOUNTANT', 'OWNER']);
  });

  it('treats the boundary as inclusive', () => {
    expect(requiredApprovals(rm('1000.00'), RULES)).toHaveLength(1);
    expect(requiredApprovals(rm('10000.00'), RULES)).toHaveLength(2);
  });

  it('honours an upper bound', () => {
    const banded: ApprovalRule[] = [
      { id: 'b', minAmount: rm('100.00'), maxAmount: rm('500.00'), requiredRole: 'APPROVER', sequence: 1 },
    ];
    expect(requiredApprovals(rm('500.00'), banded)).toHaveLength(1);
    expect(requiredApprovals(rm('500.01'), banded)).toHaveLength(0);
  });

  it('routes on the ABSOLUTE amount', () => {
    // A credit-natured total would otherwise slip under every threshold and
    // route to nobody at all.
    expect(requiredApprovals(rm('-50000.00'), RULES)).toHaveLength(2);
  });

  it('is deterministic and ordered by sequence (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000_0000n }), (units) => {
        const steps = requiredApprovals(Money.fromUnits(units, MYR), RULES);
        const sequences = steps.map((s) => s.sequence);
        expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
      }),
    );
  });
});

describe('evaluateApproval', () => {
  it('reports NOT_REQUIRED when no rule applies', () => {
    const state = evaluateApproval([], [], 'requester');
    expect(state.status).toBe('NOT_REQUIRED');
    expect(mayPay(state.status)).toBe(true);
  });

  it('is PENDING until every step is decided', () => {
    const steps = [step(), step({ sequence: 2, requiredRole: 'OWNER', ruleId: 'r2' })];
    const state = evaluateApproval(steps, [decision()], 'requester');

    expect(state.status).toBe('PENDING');
    expect(state.outstanding).toHaveLength(1);
    expect(state.outstanding[0]!.sequence).toBe(2);
    expect(mayPay(state.status)).toBe(false);
  });

  it('is APPROVED when every step is filled by a distinct, correctly-roled person', () => {
    const steps = [step(), step({ sequence: 2, requiredRole: 'OWNER', ruleId: 'r2' })];
    const state = evaluateApproval(
      steps,
      [
        decision(),
        decision({ sequence: 2, decidedBy: 'approver-2', roleAtDecision: 'OWNER' }),
      ],
      'requester',
    );

    expect(state.status).toBe('APPROVED');
    expect(state.violations).toEqual([]);
    expect(mayPay(state.status)).toBe(true);
  });

  it('REFUSES a self-approval — the single most important rule here', () => {
    // An approval workflow where the person who raised the bill can authorise
    // it records a click and controls nothing.
    const state = evaluateApproval([step()], [decision({ decidedBy: 'requester' })], 'requester');

    expect(state.status).toBe('PENDING');
    expect(state.violations).toContainEqual({ code: 'SELF_APPROVAL', userId: 'requester' });
    expect(mayPay(state.status)).toBe(false);
  });

  it('REFUSES one person filling both steps', () => {
    // "A second approver" means a second PERSON. At a small company one user is
    // often both Accountant and Owner, and allowing it defeats the threshold.
    const steps = [step(), step({ sequence: 2, requiredRole: 'OWNER', ruleId: 'r2' })];
    const state = evaluateApproval(
      steps,
      [
        decision({ decidedBy: 'busy-person' }),
        decision({ sequence: 2, decidedBy: 'busy-person', roleAtDecision: 'OWNER' }),
      ],
      'requester',
    );

    expect(state.status).toBe('PENDING');
    expect(state.violations).toContainEqual({
      code: 'DUPLICATE_APPROVER',
      userId: 'busy-person',
      sequence: 2,
    });
  });

  it('REFUSES a decision by the wrong role', () => {
    const state = evaluateApproval(
      [step({ requiredRole: 'OWNER' })],
      [decision({ roleAtDecision: 'BOOKKEEPER' })],
      'requester',
    );

    expect(state.violations).toContainEqual({
      code: 'WRONG_ROLE',
      sequence: 1,
      required: 'OWNER',
      actual: 'BOOKKEEPER',
    });
  });

  it('judges a decision by the role held AT THE TIME', () => {
    // A promotion or demotion afterwards must not retroactively validate or
    // invalidate a decision that was correct when it was made.
    const state = evaluateApproval(
      [step({ requiredRole: 'ACCOUNTANT' })],
      [decision({ roleAtDecision: 'ACCOUNTANT' })],
      'requester',
    );
    expect(state.status).toBe('APPROVED');
  });

  it('a rejection at ANY step is final', () => {
    // Requiring every step to reject would let one approver's objection be
    // overridden by the others simply not deciding.
    const steps = [step(), step({ sequence: 2, requiredRole: 'OWNER', ruleId: 'r2' })];
    const state = evaluateApproval(steps, [decision({ decision: 'REJECT' })], 'requester');

    expect(state.status).toBe('REJECTED');
    expect(mayPay(state.status)).toBe(false);
  });

  it('does not mark a bill APPROVED with a warning', () => {
    // "Approved, but" is approved in every report that matters.
    const state = evaluateApproval([step()], [decision({ decidedBy: 'requester' })], 'requester');
    expect(state.status).not.toBe('APPROVED');
  });

  it('never permits payment while any violation stands (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('requester', 'approver-1', 'approver-2'),
        fc.constantFrom('requester', 'approver-1', 'approver-2'),
        fc.constantFrom('ACCOUNTANT' as const, 'OWNER' as const, 'BOOKKEEPER' as const),
        fc.constantFrom('ACCOUNTANT' as const, 'OWNER' as const, 'BOOKKEEPER' as const),
        (first, second, firstRole, secondRole) => {
          const steps = [step(), step({ sequence: 2, requiredRole: 'OWNER', ruleId: 'r2' })];
          const state = evaluateApproval(
            steps,
            [
              decision({ decidedBy: first, roleAtDecision: firstRole }),
              decision({ sequence: 2, decidedBy: second, roleAtDecision: secondRole }),
            ],
            'requester',
          );

          if (state.violations.length > 0) expect(mayPay(state.status)).toBe(false);

          // And the converse: payment is only ever permitted by two DIFFERENT
          // people, neither of them the requester, each holding the right role.
          if (mayPay(state.status)) {
            expect(first).not.toBe(second);
            expect(first).not.toBe('requester');
            expect(second).not.toBe('requester');
            expect(firstRole).toBe('ACCOUNTANT');
            expect(secondRole).toBe('OWNER');
          }
        },
      ),
    );
  });
});

describe('canDecide — checked before anything is written', () => {
  it('allows a correctly-roled third party', () => {
    expect(
      canDecide(step(), { userId: 'approver-1', role: 'ACCOUNTANT' }, 'requester', []),
    ).toEqual({ allowed: true });
  });

  it('refuses the requester', () => {
    const result = canDecide(step(), { userId: 'requester', role: 'ACCOUNTANT' }, 'requester', []);
    expect(result).toMatchObject({ allowed: false, violation: { code: 'SELF_APPROVAL' } });
  });

  it('refuses a second decision on the same step', () => {
    const result = canDecide(step(), { userId: 'approver-2', role: 'ACCOUNTANT' }, 'requester', [
      decision(),
    ]);
    expect(result).toMatchObject({ allowed: false, violation: { code: 'DUPLICATE_DECISION' } });
  });

  it('refuses someone who already decided another step', () => {
    const result = canDecide(
      step({ sequence: 2, requiredRole: 'OWNER', ruleId: 'r2' }),
      { userId: 'approver-1', role: 'OWNER' },
      'requester',
      [decision()],
    );
    expect(result).toMatchObject({ allowed: false, violation: { code: 'DUPLICATE_APPROVER' } });
  });

  it('refuses the wrong role', () => {
    const result = canDecide(
      step({ requiredRole: 'OWNER' }),
      { userId: 'approver-1', role: 'BOOKKEEPER' },
      'requester',
      [],
    );
    expect(result).toMatchObject({ allowed: false, violation: { code: 'WRONG_ROLE' } });
  });

  it('agrees with evaluateApproval — nothing it allows produces a violation (property)', () => {
    // The two must not disagree: `canDecide` gates the write and
    // `evaluateApproval` reads the history, so a decision the first admits and
    // the second rejects would be a row that permanently blocks a bill.
    fc.assert(
      fc.property(
        fc.constantFrom('requester', 'approver-1', 'approver-2'),
        fc.constantFrom('ACCOUNTANT' as const, 'OWNER' as const, 'BOOKKEEPER' as const),
        (userId, role) => {
          const gate = canDecide(step(), { userId, role }, 'requester', []);
          if (!gate.allowed) return;

          const state = evaluateApproval(
            [step()],
            [decision({ decidedBy: userId, roleAtDecision: role })],
            'requester',
          );
          expect(state.violations).toEqual([]);
          expect(state.status).toBe('APPROVED');
        },
      ),
    );
  });
});

describe('explainBlockedPayment', () => {
  it('names who is being waited on', () => {
    // "Approval required" with no indication of WHOSE approval is the most
    // common complaint about workflow software.
    const state = evaluateApproval(
      [step(), step({ sequence: 2, requiredRole: 'OWNER', ruleId: 'r2' })],
      [decision()],
      'requester',
    );
    expect(explainBlockedPayment(state)).toMatch(/step 2 \(OWNER\)/);
  });

  it('says a rejected bill needs a different document, not more approvals', () => {
    const state = evaluateApproval([step()], [decision({ decision: 'REJECT' })], 'requester');
    expect(explainBlockedPayment(state)).toMatch(/rejected/i);
    expect(explainBlockedPayment(state)).toMatch(/debit note|new bill/i);
  });
});
