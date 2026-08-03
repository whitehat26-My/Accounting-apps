import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@emil/domain';
import { withTenant, withUser, type Sql } from '../src/client.js';
import {
  approvalFor,
  createApprovalRule,
  decideApproval,
  pendingApprovals,
} from '../src/approval.js';
import { enterBill, outstandingPayables } from '../src/bill.js';
import { paySupplier } from '../src/supplier-payment.js';
import { addMember, registerUser } from '../src/identity.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

/** Three distinct people, because separation of duties needs at least two. */
let clerk: string;
let accountant: string;
let owner: string;

beforeAll(async () => {
  const db = await createTestDatabase('approval');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin, 'Approval Sdn Bhd');

  clerk = await member('BOOKKEEPER');
  accountant = await member('ACCOUNTANT');
  owner = await member('OWNER');

  // The shape a Malaysian SME configures: over RM 1,000 needs an Accountant,
  // over RM 10,000 ALSO needs an Owner.
  const ctx = { tenantId: tenant.tenantId, userId: owner };
  await withTenant(sql, ctx, async (tx) => {
    await createApprovalRule(tx, ctx, {
      name: 'Over RM 1,000',
      minAmount: '1000.00',
      requiredRole: 'ACCOUNTANT',
      sequence: 1,
    });
    await createApprovalRule(tx, ctx, {
      name: 'Over RM 10,000',
      minAmount: '10000.00',
      requiredRole: 'OWNER',
      sequence: 2,
    });
  });
}, 60_000);

afterAll(async () => {
  await drop?.();
});

async function member(role: 'BOOKKEEPER' | 'ACCOUNTANT' | 'OWNER'): Promise<string> {
  const { id } = await withUser(sql, null, (tx) =>
    registerUser(tx, {
      email: `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
      password: 'correct horse battery staple',
      fullName: role,
    }),
  );
  const ctx = { tenantId: tenant.tenantId, userId: id };
  await withTenant(sql, ctx, (tx) => addMember(tx, ctx, { userId: id, role }));
  return id;
}

const rm = (v: string) => Money.fromDecimal(v, 'MYR');

/** Enter a bill AS a given user, which is what makes self-approval testable. */
async function enter(unitPrice: string, enteredBy = clerk) {
  const ctx = { tenantId: tenant.tenantId, userId: enteredBy };
  return withTenant(sql, ctx, (tx) =>
    enterBill(tx, ctx, {
      supplierId: tenant.supplierId,
      billNo: `SUP-${randomUUID().slice(0, 8)}`,
      billDate: '2026-08-05',
      lines: [
        {
          description: 'Services',
          quantity: '1',
          unitPrice,
          accountId: tenant.accounts['6000']!,
          taxCodeId: tenant.taxCodes['NONE']!,
        },
      ],
      idempotencyKey: randomUUID(),
    }),
  );
}

function decide(
  billId: string,
  userId: string,
  role: 'ACCOUNTANT' | 'OWNER' | 'BOOKKEEPER',
  sequence: number,
  decision: 'APPROVE' | 'REJECT' = 'APPROVE',
) {
  const ctx = { tenantId: tenant.tenantId, userId };
  return withTenant(sql, ctx, (tx) =>
    decideApproval(tx, ctx, { billId, sequence, decision, actorRole: role }),
  );
}

function pay(billId: string, amount: string, userId = accountant) {
  const ctx = { tenantId: tenant.tenantId, userId };
  return withTenant(sql, ctx, (tx) =>
    paySupplier(tx, ctx, {
      supplierId: tenant.supplierId,
      paymentDate: '2026-08-20',
      amount,
      method: 'TRANSFER',
      depositAccountId: tenant.accounts['1000']!,
      allocations: [{ billId, amount }],
      idempotencyKey: randomUUID(),
    }),
  );
}

describe('approval gates PAYMENT, not recognition', () => {
  it('posts an unapproved bill to the ledger anyway', async () => {
    // The decision this whole feature turns on. If the goods arrived and the
    // supplier has invoiced, the obligation EXISTS — holding it out of the
    // ledger understates payables and expenses, worst at period end when
    // unapproved bills pile up.
    const before = await withTenant(sql, ctx(), (tx) => outstandingPayables(tx, ctx()));

    const bill = await enter('5000.00');
    expect(bill.approvalRequestId).toBeDefined();
    expect(bill.journalEntryId).not.toBeNull();

    const after = await withTenant(sql, ctx(), (tx) => outstandingPayables(tx, ctx()));
    expect(rm(after.total).subtract(rm(before.total)).toDecimalString()).toBe('5000.0000');
  });

  it('refuses to PAY that bill until it is approved', async () => {
    const bill = await enter('5000.00');
    await expect(pay(bill.id, '5000.00')).rejects.toThrow(/awaiting approval/i);
  });

  it('names who is being waited on', async () => {
    // "Approval required" with no indication of WHOSE approval is the most
    // common complaint about workflow software.
    const bill = await enter('50000.00');
    await expect(pay(bill.id, '50000.00')).rejects.toThrow(/ACCOUNTANT/);
  });

  it('allows payment once every step is approved', async () => {
    const bill = await enter('5000.00');
    await decide(bill.id, accountant, 'ACCOUNTANT', 1);

    const payment = await pay(bill.id, '5000.00');
    expect(payment.settledBills[0]).toMatchObject({ status: 'PAID' });
  });

  it('leaves a small bill alone entirely', async () => {
    // No rule matches, so no request exists and payment is unimpeded. This is
    // what keeps the feature invisible for tenants who never set a threshold.
    const bill = await enter('500.00');
    expect(bill.approvalRequestId).toBeUndefined();

    const payment = await pay(bill.id, '500.00');
    expect(payment.settledBills[0]).toMatchObject({ status: 'PAID' });
  });
});

describe('threshold routing', () => {
  it('requires one approver in the middle band and two above it', async () => {
    const middle = await withTenant(sql, ctx(), async (tx) =>
      approvalFor(tx, ctx(), (await enter('5000.00')).id),
    );
    expect(middle!.state.outstanding).toHaveLength(1);

    const large = await withTenant(sql, ctx(), async (tx) =>
      approvalFor(tx, ctx(), (await enter('50000.00')).id),
    );
    expect(large!.state.outstanding).toHaveLength(2);
    expect(large!.state.outstanding.map((s) => s.requiredRole)).toEqual([
      'ACCOUNTANT',
      'OWNER',
    ]);
  });

  it('snapshots the rules in force, so a later change cannot rewrite history', async () => {
    // Raising a threshold must not make a past approval look unnecessary, nor
    // lowering one make it look insufficient. An auditor needs the answer that
    // was true at the time, which a live join to approval_rule cannot give.
    const bill = await enter('5000.00');

    await withTenant(sql, ctx(), (tx) => tx`
        UPDATE approval_rule SET min_amount = 999999
         WHERE tenant_id = ${tenant.tenantId}
    `);

    const approval = await withTenant(sql, ctx(), (tx) => approvalFor(tx, ctx(), bill.id));
    expect(approval!.state.outstanding).toHaveLength(1);

    // Put it back for the remaining tests.
    await withTenant(sql, ctx(), (tx) => tx`
        UPDATE approval_rule SET min_amount = 1000
         WHERE tenant_id = ${tenant.tenantId} AND sequence = 1
    `);
    await withTenant(sql, ctx(), (tx) => tx`
        UPDATE approval_rule SET min_amount = 10000
         WHERE tenant_id = ${tenant.tenantId} AND sequence = 2
    `);
  });
});

describe('separation of duties', () => {
  it('refuses the person who entered the bill', async () => {
    // THE control. An approval workflow where the raiser can authorise records
    // a click and controls nothing.
    const bill = await enter('5000.00', accountant);
    await expect(decide(bill.id, accountant, 'ACCOUNTANT', 1)).rejects.toThrow(
      /cannot approve it/i,
    );
  });

  it('refuses it in the DATABASE too, not only the service', async () => {
    // A control that lives only in application code is one a script, a bulk
    // import or a future service walks around.
    const bill = await enter('5000.00', accountant);
    const approval = await withTenant(sql, ctx(), (tx) => approvalFor(tx, ctx(), bill.id));

    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          INSERT INTO approval_decision (
              tenant_id, request_id, sequence, decision, decided_by, role_at_decision
          ) VALUES (
              ${tenant.tenantId}, ${approval!.requestId}, 1, 'APPROVE',
              ${accountant}, 'ACCOUNTANT'
          )
      `),
    ).rejects.toThrow(/cannot be approved by the person who entered it/i);
  });

  it('refuses one person filling both steps', async () => {
    // "A second approver" means a second PERSON. At a small company one user is
    // often both Accountant and Owner.
    const bill = await enter('50000.00');
    await decide(bill.id, accountant, 'ACCOUNTANT', 1);

    await expect(decide(bill.id, accountant, 'OWNER', 2)).rejects.toThrow(
      /already decided|different person/i,
    );
  });

  it('refuses a step decided by the wrong role', async () => {
    const bill = await enter('50000.00');
    await expect(decide(bill.id, owner, 'OWNER', 1)).rejects.toThrow(/requires the ACCOUNTANT/i);
  });

  it('refuses a second decision on the same step', async () => {
    const bill = await enter('5000.00');
    await decide(bill.id, accountant, 'ACCOUNTANT', 1);
    await expect(decide(bill.id, owner, 'ACCOUNTANT', 1)).rejects.toThrow(/already been decided/i);
  });

  it('accepts two DIFFERENT people at the two steps', async () => {
    const bill = await enter('50000.00');
    await decide(bill.id, accountant, 'ACCOUNTANT', 1);
    const final = await decide(bill.id, owner, 'OWNER', 2);

    expect(final.state.status).toBe('APPROVED');
    const payment = await pay(bill.id, '50000.00');
    expect(payment.settledBills[0]).toMatchObject({ status: 'PAID' });
  });
});

describe('rejection', () => {
  it('blocks payment permanently and says what to do instead', async () => {
    const bill = await enter('50000.00');
    await decide(bill.id, accountant, 'ACCOUNTANT', 1, 'REJECT');

    await expect(pay(bill.id, '50000.00')).rejects.toThrow(/rejected/i);
    await expect(pay(bill.id, '50000.00')).rejects.toThrow(/debit note|new bill/i);
  });

  it('is final at the first step — the others need not decide', async () => {
    // Requiring every step to reject would let one approver's objection be
    // overridden by the others simply not deciding.
    const bill = await enter('50000.00');
    await decide(bill.id, accountant, 'ACCOUNTANT', 1, 'REJECT');

    const approval = await withTenant(sql, ctx(), (tx) => approvalFor(tx, ctx(), bill.id));
    expect(approval!.state.status).toBe('REJECTED');
  });
});

describe('the decision trail', () => {
  it('is append-only', async () => {
    // A decision is a person's statement about a payment. Editing one
    // afterwards makes the whole trail worthless.
    const bill = await enter('5000.00');
    await decide(bill.id, accountant, 'ACCOUNTANT', 1);

    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          UPDATE approval_decision SET decision = 'REJECT'
           WHERE tenant_id = ${tenant.tenantId}
      `),
    ).rejects.toThrow(/append-only|permission denied/i);

    await expect(
      withTenant(sql, ctx(), (tx) => tx`
          DELETE FROM approval_decision WHERE tenant_id = ${tenant.tenantId}
      `),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it('records the role held AT THE TIME, not the one held now', async () => {
    const bill = await enter('5000.00');
    await decide(bill.id, accountant, 'ACCOUNTANT', 1);

    // The approver is demoted afterwards.
    const demoteCtx = { tenantId: tenant.tenantId, userId: owner };
    await withTenant(sql, demoteCtx, (tx) =>
      addMember(tx, demoteCtx, { userId: accountant, role: 'READ_ONLY' }),
    );

    const approval = await withTenant(sql, ctx(), (tx) => approvalFor(tx, ctx(), bill.id));
    expect(approval!.decisions[0]!.roleAtDecision).toBe('ACCOUNTANT');
    // Still approved: the decision was correct when it was made.
    expect(approval!.state.status).toBe('APPROVED');

    // Restore.
    await withTenant(sql, demoteCtx, (tx) =>
      addMember(tx, demoteCtx, { userId: accountant, role: 'ACCOUNTANT' }),
    );
  });

  it('writes a financial event when a bill is approved', async () => {
    const bill = await enter('5000.00');
    await decide(bill.id, accountant, 'ACCOUNTANT', 1);

    const [event] = await withTenant(sql, ctx(), (tx) =>
      tx<{ event_type: string; entity_id: string; actor_user_id: string }[]>`
          SELECT event_type, entity_id, actor_user_id FROM financial_event_log
           WHERE tenant_id = ${tenant.tenantId} AND entity_id = ${bill.id}
           ORDER BY id DESC LIMIT 1
      `,
    );

    expect(event).toMatchObject({
      event_type: 'BILL_APPROVED',
      entity_id: bill.id,
      actor_user_id: accountant,
    });
  });
});

describe('the approvals queue', () => {
  it('lists bills waiting, with who is being waited on', async () => {
    const fresh = await seedTenant(admin, 'Queue Sdn Bhd');
    const freshCtx = { tenantId: fresh.tenantId, userId: clerk };

    await withTenant(sql, freshCtx, (tx) =>
      addMember(tx, freshCtx, { userId: clerk, role: 'BOOKKEEPER' }),
    );
    await withTenant(sql, freshCtx, (tx) =>
      createApprovalRule(tx, freshCtx, {
        name: 'All',
        minAmount: '0',
        requiredRole: 'ACCOUNTANT',
        sequence: 1,
      }),
    );

    await withTenant(sql, freshCtx, (tx) =>
      enterBill(tx, freshCtx, {
        supplierId: fresh.supplierId,
        billNo: 'Q-1',
        billDate: '2026-08-05',
        lines: [
          {
            description: 'Services',
            quantity: '1',
            unitPrice: '100.00',
            accountId: fresh.accounts['6000']!,
            taxCodeId: fresh.taxCodes['NONE']!,
          },
        ],
        idempotencyKey: randomUUID(),
      }),
    );

    const queue = await withTenant(sql, freshCtx, (tx) => pendingApprovals(tx, freshCtx));
    expect(queue).toHaveLength(1);
    expect(queue[0]!.billNo).toBe('Q-1');
    expect(queue[0]!.outstanding[0]!.requiredRole).toBe('ACCOUNTANT');
  });
});

function ctx() {
  return { tenantId: tenant.tenantId, userId: owner };
}
