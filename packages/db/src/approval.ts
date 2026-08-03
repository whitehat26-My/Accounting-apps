import {
  canDecide,
  evaluateApproval,
  explainBlockedPayment,
  mayPay,
  Money,
  requiredApprovals,
  type ApprovalDecision,
  type ApprovalRule,
  type ApprovalState,
  type ApprovalStep,
  type RoleCode,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { loadBaseCurrency } from './invoice.js';

/**
 * ApprovalService — threshold routing and separation of duties for bills.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO: hold a bill out of the ledger.
 *
 * A bill posts on entry, approved or not. If the goods arrived and the supplier
 * has invoiced, the obligation exists, and accrual accounting recognises it
 * when incurred rather than when someone internal gets round to authorising it.
 * Deferring the posting understates payables and expenses, worst at period end
 * when unapproved bills pile up.
 *
 * Approval gates PAYMENT. `paySupplier()` calls `assertPayable()` and refuses a
 * bill whose approval is outstanding.
 * ---------------------------------------------------------------------------
 */

export class ApprovalError extends Error {
  constructor(
    readonly code:
      | 'BILL_NOT_FOUND'
      | 'REQUEST_NOT_FOUND'
      | 'STEP_NOT_FOUND'
      | 'NOT_PERMITTED'
      | 'ALREADY_DECIDED'
      | 'APPROVAL_REQUIRED',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface CreateApprovalRuleInput {
  readonly name: string;
  readonly minAmount: string;
  readonly maxAmount?: string;
  readonly requiredRole: RoleCode;
  readonly sequence: number;
}

export async function createApprovalRule(
  tx: Tx,
  ctx: TenantContext,
  input: CreateApprovalRuleInput,
): Promise<{ id: string }> {
  const [row] = await tx<{ id: string }[]>`
      INSERT INTO approval_rule (tenant_id, name, min_amount, max_amount, required_role, sequence)
      VALUES (
          ${ctx.tenantId}, ${input.name}, ${input.minAmount}, ${input.maxAmount ?? null},
          ${input.requiredRole}, ${input.sequence}
      )
      RETURNING id
  `;
  return { id: row!.id };
}

async function loadRules(
  tx: Tx,
  ctx: TenantContext,
  currency: string,
): Promise<ApprovalRule[]> {
  const rows = await tx<
    {
      id: string;
      min_amount: string;
      max_amount: string | null;
      required_role: RoleCode;
      sequence: number;
    }[]
  >`
      SELECT id, min_amount, max_amount, required_role, sequence
        FROM approval_rule
       WHERE tenant_id = ${ctx.tenantId} AND is_active
       ORDER BY sequence, id
  `;

  return rows.map((r) => ({
    id: r.id,
    minAmount: Money.fromDecimal(r.min_amount, currency),
    ...(r.max_amount !== null ? { maxAmount: Money.fromDecimal(r.max_amount, currency) } : {}),
    requiredRole: r.required_role,
    sequence: r.sequence,
  }));
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Route a newly-entered bill, if any rule applies.
 *
 * Called from `enterBill()` inside the same transaction, so a bill and its
 * approval requirement are created together. A bill that committed without its
 * request would be payable by a caller who never saw a rule.
 *
 * The steps are SNAPSHOT into the request rather than referenced. Raising a
 * threshold later must not make a past approval look unnecessary, nor lowering
 * one make it look insufficient — an auditor needs the answer that was true at
 * the time.
 */
export async function routeBillForApproval(
  tx: Tx,
  ctx: TenantContext,
  billId: string,
  totalInBaseCurrency: Money,
): Promise<{ requestId: string; steps: ApprovalStep[] } | null> {
  const rules = await loadRules(tx, ctx, totalInBaseCurrency.currency);
  const steps = requiredApprovals(totalInBaseCurrency, rules);

  if (steps.length === 0) return null;

  const [row] = await tx<{ id: string }[]>`
      INSERT INTO approval_request (
          tenant_id, bill_id, required_steps, amount, status, requested_by
      ) VALUES (
          ${ctx.tenantId}, ${billId}, ${tx.json(snapshot(steps))},
          ${totalInBaseCurrency.toDecimalString()}, 'PENDING', ${ctx.userId ?? null}
      )
      RETURNING id
  `;

  return { requestId: row!.id, steps };
}

export interface ApprovalView {
  readonly requestId: string;
  readonly billId: string;
  readonly amount: string;
  readonly state: ApprovalState;
  readonly requestedBy: string | null;
  readonly decisions: readonly ApprovalDecision[];
}

/**
 * Where a bill's approval stands.
 *
 * The state is recomputed from the snapshot and the decisions on every read
 * rather than trusted from `approval_request.status`. The stored status is a
 * cache for querying; this is the answer, and if the two ever disagree the
 * decisions are the truth.
 */
export async function approvalFor(
  tx: Tx,
  ctx: TenantContext,
  billId: string,
): Promise<ApprovalView | null> {
  const [request] = await tx<
    {
      id: string;
      bill_id: string;
      required_steps: ApprovalStep[];
      amount: string;
      requested_by: string | null;
    }[]
  >`
      SELECT id, bill_id, required_steps, amount, requested_by
        FROM approval_request
       WHERE tenant_id = ${ctx.tenantId} AND bill_id = ${billId}
  `;

  if (!request) return null;

  const decisions = await loadDecisions(tx, ctx, request.id);

  return {
    requestId: request.id,
    billId: request.bill_id,
    amount: request.amount,
    requestedBy: request.requested_by,
    decisions,
    state: evaluateApproval(request.required_steps, decisions, request.requested_by ?? ''),
  };
}

async function loadDecisions(
  tx: Tx,
  ctx: TenantContext,
  requestId: string,
): Promise<ApprovalDecision[]> {
  const rows = await tx<
    {
      sequence: number;
      decision: 'APPROVE' | 'REJECT';
      decided_by: string;
      role_at_decision: RoleCode;
      decided_at: Date;
    }[]
  >`
      SELECT sequence, decision, decided_by, role_at_decision, decided_at
        FROM approval_decision
       WHERE tenant_id = ${ctx.tenantId} AND request_id = ${requestId}
       ORDER BY sequence
  `;

  return rows.map((r) => ({
    sequence: r.sequence,
    decision: r.decision,
    decidedBy: r.decided_by,
    roleAtDecision: r.role_at_decision,
    decidedAt: r.decided_at.toISOString(),
  }));
}

export interface DecideInput {
  readonly billId: string;
  readonly sequence: number;
  readonly decision: 'APPROVE' | 'REJECT';
  readonly comment?: string;
  /** The actor's role, resolved by the API from their membership. */
  readonly actorRole: RoleCode;
}

/**
 * Record one approval decision.
 *
 * Validity is checked BEFORE the write, so `approval_decision` never holds a
 * row that `evaluateApproval` would object to — a reader then sees a history
 * that is valid by construction rather than a mixture it has to re-filter.
 *
 * The database enforces the same rules independently: a UNIQUE on
 * `(request, decided_by)` and a trigger refusing self-approval. This is the
 * control the whole feature exists to provide, and a control that lives only in
 * application code is one a script or a bulk import walks around.
 */
export async function decideApproval(
  tx: Tx,
  ctx: TenantContext,
  input: DecideInput,
): Promise<ApprovalView> {
  const current = await approvalFor(tx, ctx, input.billId);
  if (current === null) {
    throw new ApprovalError(
      'REQUEST_NOT_FOUND',
      `Bill ${input.billId} has no approval request — it did not meet any routing rule`,
    );
  }

  const [request] = await tx<{ required_steps: ApprovalStep[] }[]>`
      SELECT required_steps FROM approval_request
       WHERE tenant_id = ${ctx.tenantId} AND id = ${current.requestId}
         FOR UPDATE
  `;

  const step = request!.required_steps.find((s) => s.sequence === input.sequence);
  if (step === undefined) {
    throw new ApprovalError(
      'STEP_NOT_FOUND',
      `This bill has no approval step ${input.sequence}`,
    );
  }

  const gate = canDecide(
    step,
    { userId: ctx.userId ?? '', role: input.actorRole },
    current.requestedBy ?? '',
    current.decisions,
  );

  if (!gate.allowed) {
    throw new ApprovalError(
      gate.violation.code === 'DUPLICATE_DECISION' ? 'ALREADY_DECIDED' : 'NOT_PERMITTED',
      explainViolation(gate.violation),
      gate.violation,
    );
  }

  await tx`
      INSERT INTO approval_decision (
          tenant_id, request_id, sequence, decision, decided_by, role_at_decision, comment
      ) VALUES (
          ${ctx.tenantId}, ${current.requestId}, ${input.sequence}, ${input.decision},
          ${ctx.userId ?? null}, ${input.actorRole}, ${input.comment ?? null}
      )
  `;

  const updated = await approvalFor(tx, ctx, input.billId);
  const state = updated!.state;

  if (state.status === 'APPROVED' || state.status === 'REJECTED') {
    await tx`
        UPDATE approval_request
           SET status = ${state.status}, decided_at = now()
         WHERE tenant_id = ${ctx.tenantId} AND id = ${current.requestId}
    `;

    await tx`
        INSERT INTO financial_event_log (
            tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
        ) VALUES (
            ${ctx.tenantId},
            ${state.status === 'APPROVED' ? 'BILL_APPROVED' : 'BILL_REJECTED'},
            ${ctx.userId ?? null}, 'bill.approve', 'BILL', ${input.billId},
            ${tx.json({ amount: current.amount, sequence: input.sequence })}
        )
    `;
  }

  return updated!;
}

/**
 * Refuse to pay a bill whose approval is outstanding.
 *
 * Called by `paySupplier()` for every allocation. A bill that needs no approval
 * — no rule matched, or none is configured — passes straight through, which is
 * what keeps this invisible for the tenants who never set a threshold.
 */
export async function assertPayable(
  tx: Tx,
  ctx: TenantContext,
  billId: string,
): Promise<void> {
  const approval = await approvalFor(tx, ctx, billId);
  if (approval === null) return; // never routed: nothing to wait for

  if (!mayPay(approval.state.status)) {
    throw new ApprovalError(
      'APPROVAL_REQUIRED',
      explainBlockedPayment(approval.state),
      { billId, status: approval.state.status, outstanding: approval.state.outstanding },
    );
  }
}

/** Bills waiting on someone, for the approvals screen. */
export async function pendingApprovals(
  tx: Tx,
  ctx: TenantContext,
): Promise<
  {
    billId: string;
    internalRef: string;
    billNo: string;
    supplierName: string;
    amount: string;
    outstanding: readonly ApprovalStep[];
  }[]
> {
  const rows = await tx<
    {
      bill_id: string;
      internal_ref: string;
      bill_no: string;
      supplier_name: string;
      amount: string;
      required_steps: ApprovalStep[];
      requested_by: string | null;
      request_id: string;
    }[]
  >`
      SELECT r.bill_id, b.internal_ref, b.bill_no, c.name AS supplier_name,
             r.amount, r.required_steps, r.requested_by, r.id AS request_id
        FROM approval_request r
        JOIN bill b    ON b.tenant_id = r.tenant_id AND b.id = r.bill_id
        JOIN contact c ON c.tenant_id = b.tenant_id AND c.id = b.supplier_id
       WHERE r.tenant_id = ${ctx.tenantId} AND r.status = 'PENDING'
       ORDER BY r.requested_at
  `;

  const out = [];
  for (const row of rows) {
    const decisions = await loadDecisions(tx, ctx, row.request_id);
    const state = evaluateApproval(row.required_steps, decisions, row.requested_by ?? '');
    out.push({
      billId: row.bill_id,
      internalRef: row.internal_ref,
      billNo: row.bill_no,
      supplierName: row.supplier_name,
      amount: row.amount,
      outstanding: state.outstanding,
    });
  }
  return out;
}

// ------------------------------------------------------------------ internals

/**
 * The steps as plain JSON.
 *
 * Written out rather than casting the domain type: `ApprovalStep` is readonly
 * and a cast would let a later field addition reach the column silently. This
 * way adding one is a deliberate edit here, which is the right friction for a
 * snapshot an auditor relies on.
 */
function snapshot(steps: readonly ApprovalStep[]) {
  return steps.map((s) => ({
    sequence: s.sequence,
    requiredRole: s.requiredRole,
    ruleId: s.ruleId,
  }));
}

function explainViolation(violation: { code: string; [k: string]: unknown }): string {
  switch (violation.code) {
    case 'SELF_APPROVAL':
      return 'You entered this bill, so you cannot approve it. Approval must come from someone else.';
    case 'DUPLICATE_APPROVER':
      return 'You have already decided on this bill. A second approval must come from a different person.';
    case 'DUPLICATE_DECISION':
      return 'That approval step has already been decided.';
    case 'WRONG_ROLE':
      return `This step requires the ${String(violation['required'])} role; yours is ${String(violation['actual'])}.`;
    default:
      return 'You cannot record that decision.';
  }
}

export { loadBaseCurrency };
