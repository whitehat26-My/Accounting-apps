import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@emil/domain';
import { withTenant, type Sql } from '../src/client.js';
import { detectRollupDrift } from '../src/ledger.js';
import { computePayslip } from '../src/payroll.js';
import {
  confirmPayRun,
  createEmployee,
  getPayRun,
  listEmployees,
  payRunCp39,
  payRunPayslip,
  payRunPayslips,
  preparePayRun,
  reversePayRun,
  setPayrollSettings,
  updateEmployee,
  type EmployeeInput,
} from '../src/pay-run.js';
import { createTestDatabase, seedTenant, type Tenant } from './helpers.js';

/**
 * Pay runs, against the real schema.
 *
 * The test that matters most is YTD CONTINUITY: confirm August, prepare
 * September, and September's tax must equal a hand-fed calculator told
 * explicitly what August paid. That is the property that replaces the firm —
 * the system keeps the running totals a bookkeeper was paid to keep — and it
 * is asserted against `computePayslip` itself so the run can never drift from
 * the calculator it is built on.
 */

let sql: Sql;
let admin: Sql;
let drop: () => Promise<void>;
let tenant: Tenant;

beforeAll(async () => {
  const db = await createTestDatabase('payrun');
  sql = db.sql;
  admin = db.admin;
  drop = db.drop;
  tenant = await seedTenant(db.admin, 'Pay Runs Sdn Bhd');
}, 60_000);

afterAll(async () => {
  await drop?.();
});

const ctx = () => ({ tenantId: tenant.tenantId, userId: tenant.userId });

/**
 * The technician from the payroll tests: RM6,000, single, resident, and — via
 * TP3 opening figures — seven months of 2026 already behind her at a previous
 * employer. August's PCB for exactly this history is RM207.50, a figure this
 * suite has already pinned three ways.
 */
const NURUL: EmployeeInput = {
  fullName: 'Nurul Huda binti Ahmad',
  employeeNo: 'SGT-004',
  idType: 'NRIC',
  idValue: '900101145566',
  tin: '531367080',
  dateOfBirth: '1991-04-12',
  citizenship: 'CITIZEN',
  taxResident: true,
  taxCategory: 1,
  qualifyingChildren: 0,
  monthlyWage: '6000.00',
  jobTitle: 'Senior Technician',
  hiredOn: '2026-08-01',
  paymentMethod: 'BANK_TRANSFER',
  bankName: 'Maybank',
  bankAccountLast4: '4471',
  ytdYear: 2026,
  ytdGrossBefore: '42000.00',
  ytdEpfBefore: '4620.00',
  ytdMtdBefore: '1452.50',
};

const AZLAN: EmployeeInput = {
  fullName: 'Azlan bin Musa',
  employeeNo: 'SGT-001',
  tin: '445566778',
  dateOfBirth: '2002-02-02',
  citizenship: 'CITIZEN',
  taxResident: true,
  taxCategory: 1,
  qualifyingChildren: 0,
  monthlyWage: '2500.00',
  hiredOn: '2026-08-01',
  paymentMethod: 'CASH',
};

// ---------------------------------------------------------------------------

describe('the staff register', () => {
  it('records an employee and lists them as active', async () => {
    const created = await withTenant(sql, ctx(), (tx) => createEmployee(tx, ctx(), NURUL));
    expect(created.active).toBe(true);
    expect(created.monthlyWage).toBe('6000.0000');

    await withTenant(sql, ctx(), (tx) => createEmployee(tx, ctx(), AZLAN));

    const listed = await withTenant(sql, ctx(), (tx) => listEmployees(tx, ctx()));
    expect(listed.map((e) => e.fullName)).toContain('Nurul Huda binti Ahmad');
    expect(listed).toHaveLength(2);
  });
});

describe('a month, prepared and confirmed', () => {
  let augustId: string;

  it('computes everyone from the register — nobody types a figure', async () => {
    const august = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), { payMonth: '2026-08-01', idempotencyKey: 'aug-1' }),
    );
    augustId = august.id;

    expect(august.status).toBe('DRAFT');
    expect(august.lines).toHaveLength(2);

    const nurul = august.lines.find((l) => l.fullName === NURUL.fullName)!;
    // The pinned figures: RM207.50 of PCB against her TP3 history, RM5,046.20
    // take-home. If these move, the engines moved — this file computes nothing.
    expect(nurul.pcb).toBe('207.5000');
    expect(nurul.netPay).toBe('5046.2000');
    expect(nurul.epfEmployee).toBe('660.0000');

    const azlan = august.lines.find((l) => l.fullName === AZLAN.fullName)!;
    // RM2,500: EPF employer 13%, no PCB — the band the whole payroll slice
    // was built to get right.
    expect(azlan.epfEmployer).toBe('325.0000');
    expect(azlan.pcb).toBe('0.0000');

    // Draft posts NOTHING.
    const [entries] = await admin<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM journal_entry
         WHERE tenant_id = ${tenant.tenantId} AND source_document_type = 'PAY_RUN'
    `;
    expect(entries!.n).toBe('0');
  });

  it('replays the same prepare key instead of duplicating the draft', async () => {
    const replay = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), { payMonth: '2026-08-01', idempotencyKey: 'aug-1' }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(augustId);
  });

  it('re-preparing with a NEW key replaces the draft — a draft is a proposal', async () => {
    const again = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), {
        payMonth: '2026-08-01',
        idempotencyKey: 'aug-2',
        overrides: {},
      }),
    );
    expect(again.id).not.toBe(augustId);
    augustId = again.id;

    const [drafts] = await admin<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM pay_run
         WHERE tenant_id = ${tenant.tenantId} AND pay_month = '2026-08-01'
    `;
    expect(drafts!.n).toBe('1');
  });

  it('confirms: one balanced journal, each authority its own payable', async () => {
    const confirmed = await withTenant(sql, ctx(), (tx) =>
      confirmPayRun(tx, ctx(), augustId, 'aug-confirm-1'),
    );
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.journalEntryId).not.toBeNull();

    const lines = await admin<{ code: string; debit: string; credit: string }[]>`
        SELECT a.code, l.debit::text AS debit, l.credit::text AS credit
          FROM journal_line l
          JOIN account a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
         WHERE l.tenant_id = ${tenant.tenantId}
           AND l.journal_entry_id = ${confirmed.journalEntryId}
         ORDER BY a.code
    `;

    const by = (code: string) => lines.find((l) => l.code === code);
    // Gross wages 8,500 Dr; every deduction and employer share in its own
    // payable, both sides of each scheme together.
    expect(by('6200')?.debit).toBe('8500.0000');
    expect(by('2300')?.credit).toBe('1980.0000'); // EPF, employee + employer
    expect(by('2330')?.credit).toBe('207.5000'); // PCB
    expect(Number(by('2340')?.credit)).toBeGreaterThan(0); // net wages owed to staff

    const total = (pick: (l: { debit: string; credit: string }) => string) =>
      lines.reduce((t, l) => t.add(Money.fromDecimal(pick(l), 'MYR')), Money.zero('MYR'));
    expect(total((l) => l.debit).toDecimalString()).toBe(
      total((l) => l.credit).toDecimalString(),
    );

    // The derived balance cache still agrees with the journal.
    const drift = await withTenant(sql, ctx(), (tx) => detectRollupDrift(tx, ctx()));
    expect(drift).toHaveLength(0);

    // And the act is on the high-signal record.
    const [event] = await admin<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM financial_event_log
         WHERE tenant_id = ${tenant.tenantId} AND event_type = 'PAY_RUN_CONFIRMED'
    `;
    expect(event!.n).toBe('1');
  });

  it('replays the same confirm key; refuses a different one', async () => {
    const replay = await withTenant(sql, ctx(), (tx) =>
      confirmPayRun(tx, ctx(), augustId, 'aug-confirm-1'),
    );
    expect(replay.replayed).toBe(true);

    await expect(
      withTenant(sql, ctx(), (tx) => confirmPayRun(tx, ctx(), augustId, 'other-key')),
    ).rejects.toMatchObject({ code: 'NOT_DRAFT' });
  });

  it('refuses a second run for a confirmed month, naming the fix', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) =>
        preparePayRun(tx, ctx(), { payMonth: '2026-08-01', idempotencyKey: 'aug-3' }),
      ),
    ).rejects.toMatchObject({ code: 'MONTH_ALREADY_CONFIRMED' });
  });
});

// ---------------------------------------------------------------------------
// The property this slice exists for
// ---------------------------------------------------------------------------

describe('year-to-date continuity', () => {
  it('September uses what August actually paid — kept, not typed', async () => {
    const september = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), { payMonth: '2026-09-01', idempotencyKey: 'sep-1' }),
    );
    const nurul = september.lines.find((l) => l.fullName === NURUL.fullName)!;

    /*
     * The same month, hand-fed: TP3 opening plus August's confirmed line.
     * Gross 42,000 + 6,000; EPF 4,620 + 660; MTD 1,452.50 + 207.50. If the run
     * and the calculator ever disagree, one of them is lying about August.
     */
    const handFed = await withTenant(sql, ctx(), (tx) =>
      computePayslip(tx, {
        wage: '6000.00',
        subject: { age: 35, citizenship: 'CITIZEN' },
        asOf: '2026-09-01',
        tax: { resident: true, category: 1, qualifyingChildren: 0 },
        taxYearToDate: {
          accumulatedGross: '48000.00',
          accumulatedEpf: '5280.00',
          accumulatedMtd: '1660.00',
        },
      }),
    );

    expect(nurul.pcb).toBe(handFed.pcb!.deduction);
    expect(nurul.netPay).toBe(handFed.netPay!);
    expect(nurul.pcb).not.toBe('0.0000');
  });

  it('a bonus flows through the five-step formula, not a flat rate', async () => {
    const withBonus = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), {
        payMonth: '2026-09-01',
        idempotencyKey: 'sep-bonus',
        overrides: {},
      }),
    );
    // Re-prepare with a bonus for Nurul.
    const employees = await withTenant(sql, ctx(), (tx) => listEmployees(tx, ctx()));
    const nurulId = employees.find((e) => e.fullName === NURUL.fullName)!.id;

    const run = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), {
        payMonth: '2026-09-01',
        idempotencyKey: 'sep-bonus-2',
        overrides: { [nurulId]: { bonus: '3000.00' } },
      }),
    );
    const line = run.lines.find((l) => l.fullName === NURUL.fullName)!;

    expect(line.bonus).toBe('3000.0000');
    expect(line.gross).toBe('9000.0000');
    // EPF follows the higher wage band; PCB exceeds the no-bonus month.
    expect(Number(line.pcb)).toBeGreaterThan(Number(withBonus.lines[0]!.pcb));
  });

  it('a REVERSED month vanishes from the accumulation', async () => {
    // Reverse August entirely, then re-prepare September: Nurul's history is
    // back to the TP3 opening alone, so her PCB matches a hand-fed calculator
    // that never heard of August. Backed-out money must not haunt the tax.
    const [august] = await admin<{ id: string }[]>`
        SELECT id FROM pay_run
         WHERE tenant_id = ${tenant.tenantId} AND pay_month = '2026-08-01'
           AND status = 'CONFIRMED'
    `;
    await withTenant(sql, ctx(), (tx) =>
      reversePayRun(tx, ctx(), august!.id, 'wrong wages keyed', 'aug-reverse-1'),
    );

    const september = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), { payMonth: '2026-09-01', idempotencyKey: 'sep-after-rev' }),
    );
    const nurul = september.lines.find((l) => l.fullName === NURUL.fullName)!;

    const handFed = await withTenant(sql, ctx(), (tx) =>
      computePayslip(tx, {
        wage: '6000.00',
        subject: { age: 35, citizenship: 'CITIZEN' },
        asOf: '2026-09-01',
        tax: { resident: true, category: 1, qualifyingChildren: 0 },
        taxYearToDate: {
          accumulatedGross: '42000.00',
          accumulatedEpf: '4620.00',
          accumulatedMtd: '1452.50',
        },
      }),
    );
    expect(nurul.pcb).toBe(handFed.pcb!.deduction);

    // The ledger backed August out with a reversing entry, not an edit.
    const [entries] = await admin<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM journal_entry
         WHERE tenant_id = ${tenant.tenantId} AND reversal_of_id IS NOT NULL
    `;
    expect(Number(entries!.n)).toBeGreaterThan(0);

    const drift = await withTenant(sql, ctx(), (tx) => detectRollupDrift(tx, ctx()));
    expect(drift).toHaveLength(0);
  });

  it('the month can be run again after the reversal', async () => {
    const again = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), { payMonth: '2026-08-01', idempotencyKey: 'aug-4' }),
    );
    const confirmed = await withTenant(sql, ctx(), (tx) =>
      confirmPayRun(tx, ctx(), again.id, 'aug-confirm-2'),
    );
    expect(confirmed.status).toBe('CONFIRMED');
  });
});

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

describe('the snapshot', () => {
  it('a confirmed line ignores later edits to the employee', async () => {
    const employees = await withTenant(sql, ctx(), (tx) => listEmployees(tx, ctx()));
    const nurul = employees.find((e) => e.fullName === NURUL.fullName)!;

    await withTenant(sql, ctx(), (tx) =>
      updateEmployee(tx, ctx(), nurul.id, {
        ...NURUL,
        fullName: 'Nurul Huda binti Ahmad (married name)',
        monthlyWage: '6500.00',
      }),
    );

    const runs = await admin<{ id: string }[]>`
        SELECT id FROM pay_run
         WHERE tenant_id = ${tenant.tenantId} AND pay_month = '2026-08-01'
           AND status = 'CONFIRMED'
    `;
    const view = await withTenant(sql, ctx(), (tx) => getPayRun(tx, ctx(), runs[0]!.id));
    const line = view.lines.find((l) => l.employeeNo === 'SGT-004')!;

    // What was paid, as it was paid. The register moved on; the record did not.
    expect(line.fullName).toBe('Nurul Huda binti Ahmad');
    expect(line.wage).toBe('6000.0000');
  });

  it('serves the payslip from the stored line, never recomputed', async () => {
    const runs = await admin<{ id: string }[]>`
        SELECT id FROM pay_run
         WHERE tenant_id = ${tenant.tenantId} AND pay_month = '2026-08-01'
           AND status = 'CONFIRMED'
    `;
    const view = await withTenant(sql, ctx(), (tx) => getPayRun(tx, ctx(), runs[0]!.id));
    const line = view.lines.find((l) => l.employeeNo === 'SGT-004')!;

    const doc = await withTenant(sql, ctx(), (tx) =>
      payRunPayslip(tx, ctx(), runs[0]!.id, line.id),
    );
    expect(doc.employee.name).toBe('Nurul Huda binti Ahmad');
    expect(doc.period).toBe('August 2026');
    expect(doc.netPay).toBe('5046.2000');
    expect(doc.deductions.map((d) => d.label)).toContain('SOCSO — SKBBK');

    /*
     * How she was paid is snapshotted too, and the previous test has ALREADY
     * renamed her and raised her wage on the register. If the payslip read the
     * employee row rather than the line, this block would follow those edits.
     */
    expect(doc.payment).toEqual({
      method: 'BANK_TRANSFER',
      bankName: 'Maybank',
      accountLast4: '4471',
    });
  });

  it('changing bank later does not rewrite a payslip already handed out', async () => {
    const employees = await withTenant(sql, ctx(), (tx) => listEmployees(tx, ctx()));
    const nurul = employees.find((e) => e.employeeNo === 'SGT-004')!;

    await withTenant(sql, ctx(), (tx) =>
      updateEmployee(tx, ctx(), nurul.id, {
        ...NURUL,
        bankName: 'CIMB',
        bankAccountLast4: '9902',
      }),
    );

    const runs = await admin<{ id: string }[]>`
        SELECT id FROM pay_run
         WHERE tenant_id = ${tenant.tenantId} AND pay_month = '2026-08-01'
           AND status = 'CONFIRMED'
    `;
    const view = await withTenant(sql, ctx(), (tx) => getPayRun(tx, ctx(), runs[0]!.id));
    const line = view.lines.find((l) => l.employeeNo === 'SGT-004')!;
    const doc = await withTenant(sql, ctx(), (tx) =>
      payRunPayslip(tx, ctx(), runs[0]!.id, line.id),
    );

    // August's payslip still says where August's money went.
    expect(doc.payment?.bankName).toBe('Maybank');
    expect(doc.payment?.accountLast4).toBe('4471');
  });

  it('hands over every payslip for the month, name-ordered, in one call', async () => {
    const runs = await admin<{ id: string }[]>`
        SELECT id FROM pay_run
         WHERE tenant_id = ${tenant.tenantId} AND pay_month = '2026-08-01'
           AND status = 'CONFIRMED'
    `;
    const book = await withTenant(sql, ctx(), (tx) =>
      payRunPayslips(tx, ctx(), runs[0]!.id),
    );

    expect(book.payMonth).toBe('2026-08-01');
    // Both people, sorted — the printed stack has to be predictable.
    expect(book.documents.map((d) => d.employee.name)).toEqual([
      'Azlan bin Musa',
      'Nurul Huda binti Ahmad',
    ]);
    // Cash and transfer are different sentences on the page.
    expect(book.documents[0]!.payment?.method).toBe('CASH');
    expect(book.documents[0]!.payment?.bankName).toBeUndefined();
    expect(book.documents[1]!.payment?.method).toBe('BANK_TRANSFER');
    // One employer block, read once, identical on every page.
    expect(book.documents[0]!.employer).toEqual(book.documents[1]!.employer);
  });

  it('refuses to print a book for a month that is not confirmed', async () => {
    const draft = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), { payMonth: '2026-10-01', idempotencyKey: 'book-draft' }),
    );
    await expect(
      withTenant(sql, ctx(), (tx) => payRunPayslips(tx, ctx(), draft.id)),
    ).rejects.toMatchObject({ code: 'NOT_CONFIRMED' });
  });
});

// ---------------------------------------------------------------------------
// CP39
// ---------------------------------------------------------------------------

describe('the CP39 export', () => {
  const confirmedAugust = async () => {
    const runs = await admin<{ id: string }[]>`
        SELECT id FROM pay_run
         WHERE tenant_id = ${tenant.tenantId} AND pay_month = '2026-08-01'
           AND status = 'CONFIRMED'
    `;
    return runs[0]!.id;
  };

  it('refuses without the employer number, naming where to set it', async () => {
    await expect(
      withTenant(sql, ctx(), async (tx) => payRunCp39(tx, ctx(), await confirmedAugust())),
    ).rejects.toMatchObject({ code: 'NO_EMPLOYER_NO' });
  });

  it('exports the confirmed month at the exhibit’s exact widths', async () => {
    await withTenant(sql, ctx(), (tx) =>
      setPayrollSettings(tx, ctx(), { lhdnEmployerNo: '9012345678' }),
    );

    const file = await withTenant(sql, ctx(), async (tx) =>
      payRunCp39(tx, ctx(), await confirmedAugust()),
    );

    expect(file.filename).toBe('901234567808_2026.txt');
    const records = file.content.split('\r\n').filter((l) => l.length > 0);
    expect(records[0]).toHaveLength(57);
    for (const detail of records.slice(1)) expect(detail).toHaveLength(136);

    // Azlan pays no PCB, so only Nurul is filed — and the header agrees.
    expect(records).toHaveLength(2);
    expect(records[1]).toContain('NURUL HUDA BINTI AHMAD');
    expect(records[0]!.slice(37, 42)).toBe('00001');
  });

  it('will not file a draft', async () => {
    const draft = await withTenant(sql, ctx(), (tx) =>
      preparePayRun(tx, ctx(), { payMonth: '2026-10-01', idempotencyKey: 'oct-1' }),
    );
    await expect(
      withTenant(sql, ctx(), (tx) => payRunCp39(tx, ctx(), draft.id)),
    ).rejects.toMatchObject({ code: 'NOT_CONFIRMED' });
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('what it refuses', () => {
  it('rejects a pay month that is not the first of a month', async () => {
    await expect(
      withTenant(sql, ctx(), (tx) =>
        preparePayRun(tx, ctx(), { payMonth: '2026-11-15', idempotencyKey: 'bad-day' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FIRST_OF_MONTH' });
  });

  it('names every missing posting account rather than posting half a payroll', async () => {
    await admin`
        DELETE FROM posting_account_map
         WHERE tenant_id = ${tenant.tenantId}
           AND role IN ('EPF_PAYABLE', 'PCB_PAYABLE')
    `;
    try {
      const draft = await withTenant(sql, ctx(), (tx) =>
        preparePayRun(tx, ctx(), { payMonth: '2026-11-01', idempotencyKey: 'nov-1' }),
      );
      await expect(
        withTenant(sql, ctx(), (tx) => confirmPayRun(tx, ctx(), draft.id, 'nov-c')),
      ).rejects.toMatchObject({
        code: 'NO_PAYROLL_ACCOUNTS',
        detail: { missing: ['EPF_PAYABLE', 'PCB_PAYABLE'] },
      });
    } finally {
      // Restore for any test that follows.
      const accounts = await admin<{ id: string; code: string }[]>`
          SELECT id, code FROM account
           WHERE tenant_id = ${tenant.tenantId} AND code IN ('2300', '2330')
      `;
      for (const account of accounts) {
        await admin`
            INSERT INTO posting_account_map (tenant_id, role, account_id)
            VALUES (${tenant.tenantId},
                    ${account.code === '2300' ? 'EPF_PAYABLE' : 'PCB_PAYABLE'},
                    ${account.id})
        `;
      }
    }
  });

  it('refuses to reverse a draft — a draft is simply prepared again', async () => {
    const [draft] = await admin<{ id: string }[]>`
        SELECT id FROM pay_run
         WHERE tenant_id = ${tenant.tenantId} AND status = 'DRAFT'
         LIMIT 1
    `;
    await expect(
      withTenant(sql, ctx(), (tx) =>
        reversePayRun(tx, ctx(), draft!.id, 'no reason', 'rev-draft'),
      ),
    ).rejects.toMatchObject({ code: 'NOT_CONFIRMED' });
  });
});
