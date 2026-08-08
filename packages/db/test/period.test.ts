import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unwrap } from '@emil/domain';
import { Money, validateJournalEntry } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { changePeriodStatus, listPeriods } from '../src/period.js';
import {
  changeAccountType,
  createAccount,
  getAccount,
  listAccounts,
  updateAccount,
} from '../src/account.js';
import { postJournalEntry } from '../src/ledger.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;
let ctx: { tenantId: string; userId: string };

beforeAll(async () => {
  const db = await createTestDatabase('period');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(admin, 'Closing Sdn Bhd');
  ctx = { tenantId: tenant.tenantId, userId: tenant.userId };
}, 60_000);

afterAll(async () => {
  await drop?.();
});

/** A balanced two-line entry on a given date. */
function entry(date: string) {
  return {
    entryDate: date,
    description: 'period probe',
    sourceModule: 'MANUAL' as const,
    lines: [
      {
        accountId: tenant.accounts['1000']!,
        side: 'DEBIT' as const,
        amount: Money.fromDecimal('100.00', 'MYR'),
        baseAmount: Money.fromDecimal('100.00', 'MYR'),
      },
      {
        accountId: tenant.accounts['4000']!,
        side: 'CREDIT' as const,
        amount: Money.fromDecimal('100.00', 'MYR'),
        baseAmount: Money.fromDecimal('100.00', 'MYR'),
      },
    ],
  };
}

async function post(date: string, override = false) {
  const valid = unwrap(validateJournalEntry(entry(date), 'MYR'));
  return withTenant(sql, { ...ctx, ...(override ? { allowLockedPeriod: true } : {}) }, (tx) =>
    postJournalEntry(tx, ctx, valid, { idempotencyKey: randomUUID() }),
  );
}

async function periodFor(month: number) {
  const periods = await withTenant(sql, ctx, (tx) => listPeriods(tx, ctx));
  return periods.find((p) => p.sequence === month)!;
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

describe('closing a period', () => {
  it('refuses postings once CLOSED — the state that used to do nothing', async () => {
    /*
     * `fiscal_period.status` has allowed CLOSED since migration 0001 and
     * `assert_period_open()` checked only for LOCKED, so a period marked CLOSED
     * accepted postings exactly as if it were OPEN.
     *
     * That is the worst behaviour available to a state called "closed": a
     * bookkeeper closes January, reports on it, sends the figures to a client —
     * and later entries keep landing in it, silently, after the numbers have
     * gone out.
     */
    // February must be closed before March; close the earlier ones in order.
    for (const month of [2, 3]) {
      const period = await periodFor(month);
      await withTenant(sql, ctx, (tx) =>
        changePeriodStatus(tx, ctx, { periodId: period.id, status: 'CLOSED' }),
      );
    }

    await expect(post('2026-03-15')).rejects.toThrow(/CLOSED/);
  });

  it('has no override path out of CLOSED, unlike LOCKED', async () => {
    // The distinction between the two states. `period.override` lets a posting
    // through a LOCKED period and leaves a financial event; there is
    // deliberately no equivalent for CLOSED, because an override that quietly
    // writes into a closed period is how a reported figure changes after it was
    // reported. Reopening is the visible alternative.
    await expect(post('2026-03-15', true)).rejects.toThrow(/CLOSED/);
  });

  it('still lets an override through a LOCKED period, and records it', async () => {
    const period = await periodFor(4);
    await withTenant(sql, ctx, (tx) =>
      changePeriodStatus(tx, ctx, { periodId: period.id, status: 'LOCKED' }),
    );

    await expect(post('2026-04-15')).rejects.toThrow(/LOCKED/);

    const posted = await post('2026-04-15', true);
    expect(posted.id).toBeTruthy();

    const [override] = await admin<{ event_type: string }[]>`
        SELECT event_type FROM financial_event_log
         WHERE tenant_id = ${ctx.tenantId} AND event_type = 'LOCKED_PERIOD_OVERRIDE'
    `;
    expect(override!.event_type).toBe('LOCKED_PERIOD_OVERRIDE');
  });

  it('refuses to close a period while an earlier one is still open', async () => {
    // A February closed while January is open is not a close: the comparatives
    // underneath it can still move, so the figures it makes final are not.
    const june = await periodFor(6);

    await expect(
      withTenant(sql, ctx, (tx) =>
        changePeriodStatus(tx, ctx, { periodId: june.id, status: 'CLOSED' }),
      ),
    ).rejects.toThrow(/still open/);
  });

  it('records who closed it and when', async () => {
    const period = await periodFor(5);
    const closed = await withTenant(sql, ctx, (tx) =>
      changePeriodStatus(tx, ctx, { periodId: period.id, status: 'CLOSED' }),
    );

    expect(closed.status).toBe('CLOSED');
    expect(closed.lockedBy).toBe(ctx.userId);
    expect(closed.lockedAt).not.toBeNull();
    // And says what was made final, which is the number anyone asks about.
    expect(closed.entryCount).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Reopening
// ---------------------------------------------------------------------------

describe('reopening a period', () => {
  it('demands a reason, because the figures may already have been reported', async () => {
    const period = await periodFor(2);

    await expect(
      withTenant(sql, ctx, (tx) =>
        changePeriodStatus(tx, ctx, { periodId: period.id, status: 'OPEN' }),
      ),
    ).rejects.toThrow(/needs a reason/);
  });

  it('reopens with a reason and writes PERIOD_UNLOCKED carrying it', async () => {
    const period = await periodFor(3);

    const reopened = await withTenant(sql, ctx, (tx) =>
      changePeriodStatus(tx, ctx, {
        periodId: period.id,
        status: 'OPEN',
        reason: 'Supplier invoice arrived after close; agreed with the client',
      }),
    );

    expect(reopened.status).toBe('OPEN');
    // Cleared, so "locked by" never describes a period that is open.
    expect(reopened.lockedBy).toBeNull();
    expect(reopened.lockedAt).toBeNull();

    const [event] = await admin<{ event_type: string; detail: { reason: string; from: string } }[]>`
        SELECT event_type, detail FROM financial_event_log
         WHERE tenant_id = ${ctx.tenantId} AND event_type = 'PERIOD_UNLOCKED'
         ORDER BY id DESC LIMIT 1
    `;

    expect(event!.event_type).toBe('PERIOD_UNLOCKED');
    expect(event!.detail.from).toBe('CLOSED');
    expect(event!.detail.reason).toMatch(/arrived after close/);

    // And postings work again.
    await expect(post('2026-03-16')).resolves.toBeTruthy();
  });

  it('writes PERIOD_LOCKED on the way in — two event types nothing used to write', async () => {
    const [locked] = await admin<{ count: string }[]>`
        SELECT count(*)::text FROM financial_event_log
         WHERE tenant_id = ${ctx.tenantId} AND event_type = 'PERIOD_LOCKED'
    `;
    expect(Number(locked!.count)).toBeGreaterThan(0);
  });

  it('refuses a transition to the state it is already in', async () => {
    const period = await periodFor(4);
    await expect(
      withTenant(sql, ctx, (tx) =>
        changePeriodStatus(tx, ctx, { periodId: period.id, status: 'LOCKED' }),
      ),
    ).rejects.toThrow(/already LOCKED/);
  });
});

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

describe('the chart of accounts', () => {
  it('creates an account and derives its normal balance rather than storing it', async () => {
    const account = await withTenant(sql, ctx, (tx) =>
      createAccount(tx, ctx, { code: '6700', name: 'Travel', type: 'EXPENSE' }),
    );

    expect(account.normalBalance).toBe('DEBIT');
    expect(account.postings).toBe(0);

    const listed = await withTenant(sql, ctx, (tx) => listAccounts(tx, ctx, { type: 'EXPENSE' }));
    expect(listed.map((a) => a.code)).toContain('6700');
  });

  it('refuses a duplicate code', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        createAccount(tx, ctx, { code: '6700', name: 'Travel again', type: 'EXPENSE' }),
      ),
    ).rejects.toThrow(/already in use/);
  });

  it('refuses a child of a different type from its parent', async () => {
    const parent = await withTenant(sql, ctx, (tx) =>
      createAccount(tx, ctx, { code: '6300', name: 'Premises', type: 'EXPENSE' }),
    );

    // A liability under an expense makes every rolled-up subtotal wrong, and it
    // surfaces as a balance sheet that does not balance.
    await expect(
      withTenant(sql, ctx, (tx) =>
        createAccount(tx, ctx, {
          code: '6301',
          name: 'Wrong side',
          type: 'LIABILITY',
          parentId: parent.id,
        }),
      ),
    ).rejects.toThrow(/mix the two sides/);
  });

  it('lets an unused account be reclassified', async () => {
    const account = await withTenant(sql, ctx, (tx) =>
      createAccount(tx, ctx, { code: '6400', name: 'Miscoded', type: 'EXPENSE' }),
    );

    const fixed = await withTenant(sql, ctx, (tx) =>
      changeAccountType(tx, ctx, account.id, 'ASSET'),
    );
    expect(fixed.type).toBe('ASSET');
    expect(fixed.normalBalance).toBe('DEBIT');
  });

  it('REFUSES to reclassify an account that already carries posted history', async () => {
    /*
     * The assertion this module exists for. Changing an account's type does not
     * move a number — it moves that number from the profit and loss to the
     * balance sheet, or back, for every period ever reported, because statements
     * are rendered from the current chart rather than from a snapshot.
     *
     * A signed-off year-end would show different figures the next time it was
     * opened, with nothing in the ledger changed to explain it.
     */
    const revenue = await withTenant(sql, ctx, (tx) =>
      getAccount(tx, ctx, tenant.accounts['4000']!),
    );
    expect(revenue.postings).toBeGreaterThan(0);

    await expect(
      withTenant(sql, ctx, (tx) => changeAccountType(tx, ctx, revenue.id, 'LIABILITY')),
    ).rejects.toThrow(/posted journal lines/);
  });

  it('refuses to archive an account still holding a balance', async () => {
    await expect(
      withTenant(sql, ctx, (tx) =>
        updateAccount(tx, ctx, tenant.accounts['4000']!, { isActive: false }),
      ),
    ).rejects.toThrow(/still holds a balance/);
  });

  it('writes CHART_OF_ACCOUNTS_CHANGED when an account with history is renamed', async () => {
    // 04-security-compliance.md lists this among the events an auditor asks
    // about by name. The event type existed nowhere until this slice.
    await withTenant(sql, ctx, (tx) =>
      updateAccount(tx, ctx, tenant.accounts['4000']!, { name: 'Sales Revenue (renamed)' }),
    );

    const [event] = await admin<{ event_type: string; detail: { code: string } }[]>`
        SELECT event_type, detail FROM financial_event_log
         WHERE tenant_id = ${ctx.tenantId} AND event_type = 'CHART_OF_ACCOUNTS_CHANGED'
         ORDER BY id DESC LIMIT 1
    `;

    expect(event!.event_type).toBe('CHART_OF_ACCOUNTS_CHANGED');
    expect(event!.detail.code).toBe('4000');
  });

  it('does not raise an event for an account nobody has posted to', async () => {
    // Renaming an account during setup is not a compliance event, and treating
    // it as one is how the high-signal log stops being high-signal.
    const before = await admin<{ count: string }[]>`
        SELECT count(*)::text FROM financial_event_log
         WHERE tenant_id = ${ctx.tenantId} AND event_type = 'CHART_OF_ACCOUNTS_CHANGED'
    `;

    const fresh = await withTenant(sql, ctx, (tx) =>
      createAccount(tx, ctx, { code: '6500', name: 'Typo', type: 'EXPENSE' }),
    );
    await withTenant(sql, ctx, (tx) => updateAccount(tx, ctx, fresh.id, { name: 'Fixed' }));

    const after = await admin<{ count: string }[]>`
        SELECT count(*)::text FROM financial_event_log
         WHERE tenant_id = ${ctx.tenantId} AND event_type = 'CHART_OF_ACCOUNTS_CHANGED'
    `;
    expect(after[0]!.count).toBe(before[0]!.count);
  });
});
