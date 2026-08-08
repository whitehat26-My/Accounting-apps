import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type Sql } from '../src/client.js';
import { complianceCalendar, tickDeadline, untickDeadline } from '../src/compliance.js';
import { confirmPayRun, createEmployee, preparePayRun } from '../src/pay-run.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * The calendar against real tenant state. The property that matters: statuses
 * FOLLOW the books — confirming a pay run flips its month's deadlines from
 * "needs attention" to "ready to file" without anyone typing anything.
 */

let sql: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

beforeAll(async () => {
  const db = await createTestDatabase('compliance');
  sql = db.sql;
  drop = db.drop;
  tenant = await seedTenant(db.admin, 'Compliance Sdn Bhd');
}, 60_000);

afterAll(async () => {
  await drop?.();
});

describe('what applies', () => {
  it('shows only SST deadlines before any staff exist', async () => {
    // The seeded organisation already carries an SST number (it prints on the
    // PDFs), so the SST rows are live from day one; payroll rows are not.
    const calendar = await withTenant(sql, ctx(), (tx) =>
      complianceCalendar(tx, ctx(), 2026),
    );
    expect(calendar.applies).toEqual({ payroll: false, sst: true });
    expect(new Set(calendar.entries.map((e) => e.ruleCode))).toEqual(new Set(['SST_RETURN']));
    expect(calendar.entries).toHaveLength(6);
  });

  it('payroll deadlines appear the moment staff exist', async () => {
    await withTenant(sql, ctx(), (tx) =>
      createEmployee(tx, ctx(), {
        fullName: 'Azlan bin Musa',
        dateOfBirth: '2002-02-02',
        citizenship: 'CITIZEN',
        taxResident: true,
        taxCategory: 1,
        qualifyingChildren: 0,
        monthlyWage: '2500.00',
        hiredOn: '2026-07-01',
      }),
    );
    const calendar = await withTenant(sql, ctx(), (tx) =>
      complianceCalendar(tx, ctx(), 2026),
    );
    expect(calendar.applies).toEqual({ payroll: true, sst: true });

    const codes = new Set(calendar.entries.map((e) => e.ruleCode));
    expect(codes).toEqual(
      new Set([
        'EPF_CONTRIBUTION',
        'SOCSO_EIS_CONTRIBUTION',
        'PCB_CP39',
        'SST_RETURN',
        'EA_TO_STAFF',
        'FORM_E',
      ]),
    );
    // 3 monthlies × 12 + 6 SST periods + EA + Form E.
    expect(calendar.entries).toHaveLength(3 * 12 + 6 + 2);
  });
});

describe('statuses follow the books', () => {
  it('confirming July flips its three deadlines from ATTENTION to READY', async () => {
    const before = await withTenant(sql, ctx(), (tx) => complianceCalendar(tx, ctx(), 2026));
    const julyPcbBefore = before.entries.find(
      (e) => e.ruleCode === 'PCB_CP39' && e.periodKey === '2026-07',
    )!;
    // July ended (business date is August 2026) with no confirmed run.
    expect(julyPcbBefore.status).toBe('ATTENTION');

    const run = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), { payMonth: '2026-07-01', idempotencyKey: 'comp-jul' }),
    );
    await withTenant(sql, ctx(), (tx) =>
      confirmPayRun(tx, ctx(), run.id, 'comp-jul-confirm'),
    );

    const after = await withTenant(sql, ctx(), (tx) => complianceCalendar(tx, ctx(), 2026));
    for (const code of ['PCB_CP39', 'EPF_CONTRIBUTION', 'SOCSO_EIS_CONTRIBUTION']) {
      const entry = after.entries.find((e) => e.ruleCode === code && e.periodKey === '2026-07')!;
      expect(entry.status, code).toBe('READY');
      expect(entry.dueDate).toBe('2026-08-15');
    }
  });

  it('ticking marks DONE, is idempotent, audited, and undoable', async () => {
    const first = await withTenant(sql, ctx(), (tx) =>
      tickDeadline(tx, ctx(), { ruleCode: 'PCB_CP39', periodKey: '2026-07', note: 'Paid via e-PCB Plus' }),
    );
    expect(first.replayed).toBe(false);

    const again = await withTenant(sql, ctx(), (tx) =>
      tickDeadline(tx, ctx(), { ruleCode: 'PCB_CP39', periodKey: '2026-07' }),
    );
    expect(again.replayed).toBe(true);

    const calendar = await withTenant(sql, ctx(), (tx) => complianceCalendar(tx, ctx(), 2026));
    const july = calendar.entries.find(
      (e) => e.ruleCode === 'PCB_CP39' && e.periodKey === '2026-07',
    )!;
    expect(july.status).toBe('DONE');
    expect(july.ticked?.note).toBe('Paid via e-PCB Plus');

    // The tick left an audit row — who marked the books compliant is a fact.
    const audit = await withTenant(sql, ctx(), (tx) =>
      tx<{ n: string }[]>`
          SELECT COUNT(*)::text AS n FROM audit_log
           WHERE tenant_id = ${ctx().tenantId} AND entity_type = 'compliance_tick'
      `,
    );
    expect(Number(audit[0]!.n)).toBeGreaterThan(0);

    await withTenant(sql, ctx(), (tx) =>
      untickDeadline(tx, ctx(), { ruleCode: 'PCB_CP39', periodKey: '2026-07' }),
    );
    const reverted = await withTenant(sql, ctx(), (tx) => complianceCalendar(tx, ctx(), 2026));
    expect(
      reverted.entries.find((e) => e.ruleCode === 'PCB_CP39' && e.periodKey === '2026-07')!
        .status,
    ).toBe('READY');

    await expect(
      withTenant(sql, ctx(), (tx) =>
        untickDeadline(tx, ctx(), { ruleCode: 'PCB_CP39', periodKey: '2026-07' }),
      ),
    ).rejects.toMatchObject({ code: 'TICK_NOT_FOUND' });
  });

  it('a deadline whose due date has passed unticked reads OVERDUE', async () => {
    const calendar = await withTenant(sql, ctx(), (tx) => complianceCalendar(tx, ctx(), 2026));
    // June wages fell due 15 July — long past by the August business date.
    const juneEpf = calendar.entries.find(
      (e) => e.ruleCode === 'EPF_CONTRIBUTION' && e.periodKey === '2026-06',
    )!;
    expect(juneEpf.status).toBe('OVERDUE');
  });
});
