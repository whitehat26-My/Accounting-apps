import {
  Money,
  ageAt,
  buildCp39File,
  buildPayRunJournal,
  isErr,
  validateJournalEntry,
  type ContributionSubject,
  type Cp39Detail,
  type Cp39File,
  type Currency,
  type MtdEmployee,
  type PayRunAccounts,
  type PayRunJournalLine,
} from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';
import { loadBaseCurrency } from './invoice.js';
import { postJournalEntry, reversePostedEntry } from './ledger.js';
import { computePayslip } from './payroll.js';
import { sellerBlock } from './document-data.js';
import type { PayslipDocument } from './payroll.js';

/**
 * Pay runs — the firm's monthly job, kept in the books.
 *
 * ---------------------------------------------------------------------------
 * THE RUN IS WHERE THE YEAR-TO-DATE LIVES.
 *
 * The MTD formula needs what has already been paid and deducted this year (its
 * X, Y and K), and until now the user typed those in by hand — the exact
 * bookkeeping a shop pays a firm to keep. Here they are ACCUMULATED: a
 * prepared month sums the confirmed months before it, plus whatever a previous
 * employer's Form TP3 said on the employee record. Nobody types a running
 * total again, and September cannot disagree with August about what August
 * paid.
 *
 * Everything statutory is computed by `computePayslip` — this module never
 * touches a schedule. Its own job is bookkeeping: who works here, what a month
 * looked like when it was confirmed, and what the ledger says about it.
 * ---------------------------------------------------------------------------
 */

export class PayRunError extends Error {
  constructor(
    readonly code:
      | 'EMPLOYEE_NOT_FOUND'
      | 'RUN_NOT_FOUND'
      | 'NOT_DRAFT'
      | 'NOT_CONFIRMED'
      | 'MONTH_ALREADY_CONFIRMED'
      | 'NOT_FIRST_OF_MONTH'
      | 'NO_EMPLOYEES'
      | 'NO_PAYROLL_ACCOUNTS'
      | 'NO_EMPLOYER_NO',
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'PayRunError';
  }
}

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export interface EmployeeInput {
  readonly fullName: string;
  readonly employeeNo?: string;
  readonly idType?: 'NRIC' | 'PASSPORT';
  readonly idValue?: string;
  readonly tin?: string;
  readonly countryCode?: string;
  readonly dateOfBirth: string;
  readonly citizenship: 'CITIZEN' | 'PERMANENT_RESIDENT' | 'NON_CITIZEN';
  readonly taxResident: boolean;
  readonly taxCategory: 1 | 2 | 3;
  readonly qualifyingChildren: number;
  readonly disabled?: boolean;
  readonly disabledSpouse?: boolean;
  readonly epfElectedBefore1998?: boolean;
  readonly onInvalidityPension?: boolean;
  readonly hadEisContributionBefore57?: boolean;
  readonly monthlyWage: string;
  readonly jobTitle?: string;
  readonly hiredOn: string;
  readonly leftOn?: string | null;
  /** Form TP3: what a previous employer already paid and deducted this year. */
  readonly ytdYear?: number;
  readonly ytdGrossBefore?: string;
  readonly ytdEpfBefore?: string;
  readonly ytdMtdBefore?: string;
}

export interface EmployeeView {
  readonly id: string;
  readonly fullName: string;
  readonly employeeNo: string | null;
  readonly idType: string | null;
  readonly idValue: string | null;
  readonly tin: string | null;
  readonly countryCode: string;
  readonly dateOfBirth: string;
  readonly citizenship: string;
  readonly taxResident: boolean;
  readonly taxCategory: number;
  readonly qualifyingChildren: number;
  readonly disabled: boolean;
  readonly disabledSpouse: boolean;
  readonly epfElectedBefore1998: boolean;
  readonly onInvalidityPension: boolean;
  readonly hadEisContributionBefore57: boolean;
  readonly monthlyWage: string;
  readonly jobTitle: string | null;
  readonly hiredOn: string;
  readonly leftOn: string | null;
  readonly active: boolean;
  readonly ytdYear: number | null;
  readonly ytdGrossBefore: string;
  readonly ytdEpfBefore: string;
  readonly ytdMtdBefore: string;
}

interface EmployeeRow {
  id: string;
  full_name: string;
  employee_no: string | null;
  id_type: string | null;
  id_value: string | null;
  tin: string | null;
  country_code: string;
  date_of_birth: Date;
  citizenship: string;
  tax_resident: boolean;
  tax_category: number;
  qualifying_children: number;
  disabled: boolean;
  disabled_spouse: boolean;
  epf_elected_before_1998: boolean;
  on_invalidity_pension: boolean;
  had_eis_contribution_before_57: boolean;
  monthly_wage: string;
  job_title: string | null;
  hired_on: Date;
  left_on: Date | null;
  ytd_year: number | null;
  ytd_gross_before: string;
  ytd_epf_before: string;
  ytd_mtd_before: string;
}

const EMPLOYEE_COLUMNS = `id, full_name, employee_no, id_type, id_value, tin, country_code,
  date_of_birth, citizenship, tax_resident, tax_category, qualifying_children,
  disabled, disabled_spouse, epf_elected_before_1998, on_invalidity_pension,
  had_eis_contribution_before_57, monthly_wage, job_title, hired_on, left_on,
  ytd_year, ytd_gross_before, ytd_epf_before, ytd_mtd_before`;

function toEmployeeView(row: EmployeeRow): EmployeeView {
  return {
    id: row.id,
    fullName: row.full_name,
    employeeNo: row.employee_no,
    idType: row.id_type,
    idValue: row.id_value,
    tin: row.tin,
    countryCode: row.country_code,
    dateOfBirth: toIsoDate(row.date_of_birth),
    citizenship: row.citizenship,
    taxResident: row.tax_resident,
    taxCategory: row.tax_category,
    qualifyingChildren: row.qualifying_children,
    disabled: row.disabled,
    disabledSpouse: row.disabled_spouse,
    epfElectedBefore1998: row.epf_elected_before_1998,
    onInvalidityPension: row.on_invalidity_pension,
    hadEisContributionBefore57: row.had_eis_contribution_before_57,
    monthlyWage: row.monthly_wage,
    jobTitle: row.job_title,
    hiredOn: toIsoDate(row.hired_on),
    leftOn: row.left_on === null ? null : toIsoDate(row.left_on),
    active: row.left_on === null,
    ytdYear: row.ytd_year,
    ytdGrossBefore: row.ytd_gross_before,
    ytdEpfBefore: row.ytd_epf_before,
    ytdMtdBefore: row.ytd_mtd_before,
  };
}

export async function createEmployee(
  tx: Tx,
  ctx: TenantContext,
  input: EmployeeInput,
): Promise<EmployeeView> {
  const [row] = await tx<EmployeeRow[]>`
      INSERT INTO employee (
          tenant_id, full_name, employee_no, id_type, id_value, tin, country_code,
          date_of_birth, citizenship, tax_resident, tax_category, qualifying_children,
          disabled, disabled_spouse, epf_elected_before_1998, on_invalidity_pension,
          had_eis_contribution_before_57, monthly_wage, job_title, hired_on, left_on,
          ytd_year, ytd_gross_before, ytd_epf_before, ytd_mtd_before
      ) VALUES (
          ${ctx.tenantId}, ${input.fullName}, ${input.employeeNo ?? null},
          ${input.idType ?? null}, ${input.idValue ?? null}, ${input.tin ?? null},
          ${input.countryCode ?? 'MY'},
          ${input.dateOfBirth}, ${input.citizenship}, ${input.taxResident},
          ${input.taxCategory}, ${input.qualifyingChildren},
          ${input.disabled ?? false}, ${input.disabledSpouse ?? false},
          ${input.epfElectedBefore1998 ?? false}, ${input.onInvalidityPension ?? false},
          ${input.hadEisContributionBefore57 ?? false},
          ${input.monthlyWage}, ${input.jobTitle ?? null}, ${input.hiredOn},
          ${input.leftOn ?? null},
          ${input.ytdYear ?? null}, ${input.ytdGrossBefore ?? '0'},
          ${input.ytdEpfBefore ?? '0'}, ${input.ytdMtdBefore ?? '0'}
      )
      RETURNING ${tx.unsafe(EMPLOYEE_COLUMNS)}
  `;
  return toEmployeeView(row as EmployeeRow);
}

/**
 * Full-row update, not a patch.
 *
 * The row is small and the caller (the edit form) holds every field anyway. A
 * COALESCE-per-column patch cannot express "clear the leaving date", and a
 * form that sends everything makes the audit row a complete before/after.
 */
export async function updateEmployee(
  tx: Tx,
  ctx: TenantContext,
  employeeId: string,
  input: EmployeeInput,
): Promise<EmployeeView> {
  const [row] = await tx<EmployeeRow[]>`
      UPDATE employee SET
          full_name = ${input.fullName},
          employee_no = ${input.employeeNo ?? null},
          id_type = ${input.idType ?? null},
          id_value = ${input.idValue ?? null},
          tin = ${input.tin ?? null},
          country_code = ${input.countryCode ?? 'MY'},
          date_of_birth = ${input.dateOfBirth},
          citizenship = ${input.citizenship},
          tax_resident = ${input.taxResident},
          tax_category = ${input.taxCategory},
          qualifying_children = ${input.qualifyingChildren},
          disabled = ${input.disabled ?? false},
          disabled_spouse = ${input.disabledSpouse ?? false},
          epf_elected_before_1998 = ${input.epfElectedBefore1998 ?? false},
          on_invalidity_pension = ${input.onInvalidityPension ?? false},
          had_eis_contribution_before_57 = ${input.hadEisContributionBefore57 ?? false},
          monthly_wage = ${input.monthlyWage},
          job_title = ${input.jobTitle ?? null},
          hired_on = ${input.hiredOn},
          left_on = ${input.leftOn ?? null},
          ytd_year = ${input.ytdYear ?? null},
          ytd_gross_before = ${input.ytdGrossBefore ?? '0'},
          ytd_epf_before = ${input.ytdEpfBefore ?? '0'},
          ytd_mtd_before = ${input.ytdMtdBefore ?? '0'}
       WHERE tenant_id = ${ctx.tenantId} AND id = ${employeeId}
      RETURNING ${tx.unsafe(EMPLOYEE_COLUMNS)}
  `;
  if (row === undefined) {
    throw new PayRunError('EMPLOYEE_NOT_FOUND', `No employee ${employeeId}.`);
  }
  return toEmployeeView(row as EmployeeRow);
}

export async function listEmployees(tx: Tx, ctx: TenantContext): Promise<EmployeeView[]> {
  const rows = await tx<EmployeeRow[]>`
      SELECT ${tx.unsafe(EMPLOYEE_COLUMNS)}
        FROM employee
       WHERE tenant_id = ${ctx.tenantId}
       ORDER BY (left_on IS NOT NULL), full_name
  `;
  return rows.map(toEmployeeView);
}

// ---------------------------------------------------------------------------
// Preparing a month
// ---------------------------------------------------------------------------

export interface PreparePayRunInput {
  /** First of the month, YYYY-MM-01. The day carries no information. */
  readonly payMonth: string;
  /** Per-employee adjustments for THIS month only. */
  readonly overrides?: Readonly<
    Record<string, { readonly bonus?: string; readonly wageOverride?: string }>
  >;
  readonly idempotencyKey: string;
}

export interface PayRunLineView {
  readonly id: string;
  readonly employeeId: string;
  readonly fullName: string;
  readonly employeeNo: string | null;
  readonly wage: string;
  readonly bonus: string;
  readonly gross: string;
  readonly epfPart: string;
  readonly socsoCategory: number;
  readonly eisApplies: boolean;
  readonly nonResident: boolean;
  readonly epfEmployee: string;
  readonly epfEmployer: string;
  readonly socsoEmployeeInvalidity: string;
  readonly socsoEmployeeSkbbk: string;
  readonly socsoEmployer: string;
  readonly eisEmployee: string;
  readonly eisEmployer: string;
  readonly pcb: string;
  readonly totalDeducted: string;
  readonly netPay: string;
}

export interface PayRunTotals {
  readonly gross: string;
  readonly epf: string;
  readonly socso: string;
  readonly eis: string;
  readonly pcb: string;
  readonly netPay: string;
  readonly employerCost: string;
}

export interface PayRunView {
  readonly id: string;
  readonly runNo: string;
  readonly payMonth: string;
  readonly status: string;
  readonly journalEntryId: string | null;
  readonly confirmedAt: string | null;
  readonly lines: readonly PayRunLineView[];
  /**
   * What to remit to whom. Each figure is BOTH sides of its scheme — the
   * amount that actually leaves the bank for that authority.
   */
  readonly totals: PayRunTotals;
  readonly replayed: boolean;
}

interface RunRow {
  id: string;
  run_no: string;
  pay_month: Date;
  status: string;
  journal_entry_id: string | null;
  confirmed_at: Date | null;
}

interface LineRow {
  id: string;
  employee_id: string;
  full_name: string;
  employee_no: string | null;
  tin: string | null;
  id_type: string | null;
  id_value: string | null;
  wage: string;
  bonus: string;
  gross: string;
  epf_part: string;
  socso_category: number;
  eis_applies: boolean;
  non_resident: boolean;
  epf_employee: string;
  epf_employer: string;
  socso_employee_invalidity: string;
  socso_employee_skbbk: string;
  socso_employer: string;
  eis_employee: string;
  eis_employer: string;
  pcb: string;
  pcb_on_bonus: string;
  chargeable_income: string;
  total_deducted: string;
  net_pay: string;
}

function toLineView(row: LineRow): PayRunLineView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    fullName: row.full_name,
    employeeNo: row.employee_no,
    wage: row.wage,
    bonus: row.bonus,
    gross: row.gross,
    epfPart: row.epf_part,
    socsoCategory: row.socso_category,
    eisApplies: row.eis_applies,
    nonResident: row.non_resident,
    epfEmployee: row.epf_employee,
    epfEmployer: row.epf_employer,
    socsoEmployeeInvalidity: row.socso_employee_invalidity,
    socsoEmployeeSkbbk: row.socso_employee_skbbk,
    socsoEmployer: row.socso_employer,
    eisEmployee: row.eis_employee,
    eisEmployer: row.eis_employer,
    pcb: row.pcb,
    totalDeducted: row.total_deducted,
    netPay: row.net_pay,
  };
}

function totalsOf(lines: readonly LineRow[], currency: Currency): PayRunTotals {
  const zero = Money.zero(currency);
  const sum = (pick: (l: LineRow) => string): Money =>
    lines.reduce((t, l) => t.add(Money.fromDecimal(pick(l), currency)), zero);

  const employeeSocso = (l: LineRow): Money =>
    Money.fromDecimal(l.socso_employee_invalidity, currency).add(
      Money.fromDecimal(l.socso_employee_skbbk, currency),
    );

  const gross = sum((l) => l.gross);
  const epf = sum((l) => l.epf_employee).add(sum((l) => l.epf_employer));
  const socso = lines
    .reduce((t, l) => t.add(employeeSocso(l)), zero)
    .add(sum((l) => l.socso_employer));
  const eis = sum((l) => l.eis_employee).add(sum((l) => l.eis_employer));
  const pcb = sum((l) => l.pcb);
  const net = sum((l) => l.net_pay);
  const employerShare = sum((l) => l.epf_employer)
    .add(sum((l) => l.socso_employer))
    .add(sum((l) => l.eis_employer));

  return {
    gross: gross.toDecimalString(),
    epf: epf.toDecimalString(),
    socso: socso.toDecimalString(),
    eis: eis.toDecimalString(),
    pcb: pcb.toDecimalString(),
    netPay: net.toDecimalString(),
    employerCost: gross.add(employerShare).toDecimalString(),
  };
}

async function runView(
  tx: Tx,
  ctx: TenantContext,
  run: RunRow,
  replayed: boolean,
): Promise<PayRunView> {
  const lines = await tx<LineRow[]>`
      SELECT * FROM pay_run_line
       WHERE tenant_id = ${ctx.tenantId} AND pay_run_id = ${run.id}
       ORDER BY full_name
  `;
  const currency = (await loadBaseCurrency(tx, ctx)) as Currency;
  return {
    id: run.id,
    runNo: run.run_no,
    payMonth: toIsoDate(run.pay_month),
    status: run.status,
    journalEntryId: run.journal_entry_id,
    confirmedAt: run.confirmed_at === null ? null : run.confirmed_at.toISOString(),
    lines: lines.map(toLineView),
    totals: totalsOf(lines, currency),
    replayed,
  };
}

/**
 * Compute a month for everyone on the books, as a DRAFT.
 *
 * ---------------------------------------------------------------------------
 * THE YEAR-TO-DATE IS READ, NOT TYPED.
 *
 * For each employee: what confirmed runs earlier this calendar year already
 * paid (gross), sheltered (employee EPF) and deducted (MTD), plus the opening
 * figures a previous employer's TP3 put on the record. That is X, Y and K in
 * the tax formula, kept by the system — the point of this whole slice.
 *
 * A DRAFT is a proposal: preparing again for the same month replaces it.
 * Nothing posts until confirm.
 * ---------------------------------------------------------------------------
 */
export async function preparePayRun(
  tx: Tx,
  ctx: TenantContext,
  input: PreparePayRunInput,
): Promise<PayRunView> {
  if (!/^\d{4}-\d{2}-01$/.test(input.payMonth)) {
    throw new PayRunError(
      'NOT_FIRST_OF_MONTH',
      `A pay month is its first day — got ${input.payMonth}. The day carries no ` +
        'information, and letting it vary would make "one run per month" unenforceable.',
    );
  }

  // Idempotent replay: same key, same run back.
  const [existing] = await tx<RunRow[]>`
      SELECT id, run_no, pay_month, status, journal_entry_id, confirmed_at
        FROM pay_run
       WHERE tenant_id = ${ctx.tenantId}
         AND created_idempotency_key = ${input.idempotencyKey}
  `;
  if (existing !== undefined) return runView(tx, ctx, existing, true);

  const [confirmed] = await tx<{ run_no: string }[]>`
      SELECT run_no FROM pay_run
       WHERE tenant_id = ${ctx.tenantId} AND pay_month = ${input.payMonth}
         AND status = 'CONFIRMED'
  `;
  if (confirmed !== undefined) {
    throw new PayRunError(
      'MONTH_ALREADY_CONFIRMED',
      `${input.payMonth.slice(0, 7)} is already confirmed as ${confirmed.run_no}. ` +
        'Reverse that run first if it is wrong — the ledger is append-only, so the ' +
        'correction is a reversing entry, never an edit.',
    );
  }

  // A fresh prepare replaces any standing draft for the month. Lines cascade.
  await tx`
      DELETE FROM pay_run
       WHERE tenant_id = ${ctx.tenantId} AND pay_month = ${input.payMonth}
         AND status = 'DRAFT'
  `;

  /*
   * Everyone employed at any point in the month: hired by its end, not left
   * before it starts. A leaver's final month still pays them.
   */
  const employees = await tx<EmployeeRow[]>`
      SELECT ${tx.unsafe(EMPLOYEE_COLUMNS)}
        FROM employee
       WHERE tenant_id = ${ctx.tenantId}
         AND hired_on <= (${input.payMonth}::date + interval '1 month - 1 day')::date
         AND (left_on IS NULL OR left_on >= ${input.payMonth}::date)
       ORDER BY full_name
  `;
  if (employees.length === 0) {
    throw new PayRunError(
      'NO_EMPLOYEES',
      'Nobody is on the books for this month. Add staff before running payroll.',
    );
  }

  const [numbered] = await tx<{ allocate_document_number: string }[]>`
      SELECT allocate_document_number('PAY_RUN')
  `;
  const runNo = numbered!.allocate_document_number;

  const [run] = await tx<RunRow[]>`
      INSERT INTO pay_run (tenant_id, run_no, pay_month, created_idempotency_key)
      VALUES (${ctx.tenantId}, ${runNo}, ${input.payMonth}, ${input.idempotencyKey})
      RETURNING id, run_no, pay_month, status, journal_entry_id, confirmed_at
  `;

  const payYear = Number(input.payMonth.slice(0, 4));

  for (const employee of employees) {
    /*
     * The accumulated year, from confirmed runs only. A draft is a proposal
     * and proposals do not accumulate; a reversed month's figures were backed
     * out of the ledger and must not haunt the tax formula either — so the
     * filter is status = CONFIRMED, nothing else.
     */
    const [ytd] = await tx<{ gross: string; epf: string; mtd: string }[]>`
        SELECT COALESCE(SUM(l.gross), 0)::text        AS gross,
               COALESCE(SUM(l.epf_employee), 0)::text AS epf,
               COALESCE(SUM(l.pcb), 0)::text          AS mtd
          FROM pay_run_line l
          JOIN pay_run r ON r.tenant_id = l.tenant_id AND r.id = l.pay_run_id
         WHERE l.tenant_id = ${ctx.tenantId}
           AND l.employee_id = ${employee.id}
           AND r.status = 'CONFIRMED'
           AND EXTRACT(YEAR FROM r.pay_month) = ${payYear}
           AND r.pay_month < ${input.payMonth}::date
    `;

    const currency = 'MYR' as const;
    const opening =
      employee.ytd_year === payYear
        ? {
            gross: Money.fromDecimal(employee.ytd_gross_before, currency),
            epf: Money.fromDecimal(employee.ytd_epf_before, currency),
            mtd: Money.fromDecimal(employee.ytd_mtd_before, currency),
          }
        : {
            gross: Money.zero(currency),
            epf: Money.zero(currency),
            mtd: Money.zero(currency),
          };

    const accumulatedGross = opening.gross.add(Money.fromDecimal(ytd!.gross, currency));
    const accumulatedEpf = opening.epf.add(Money.fromDecimal(ytd!.epf, currency));
    const accumulatedMtd = opening.mtd.add(Money.fromDecimal(ytd!.mtd, currency));

    const override = input.overrides?.[employee.id];
    const wage = override?.wageOverride ?? employee.monthly_wage;
    const bonus = override?.bonus;

    const subject: ContributionSubject = {
      age: ageAt(toIsoDate(employee.date_of_birth), input.payMonth),
      citizenship: employee.citizenship as ContributionSubject['citizenship'],
      ...(employee.epf_elected_before_1998 ? { electedBefore1Aug1998: true } : {}),
      ...(employee.on_invalidity_pension ? { onInvalidityPension: true } : {}),
      ...(employee.had_eis_contribution_before_57
        ? { hadEisContributionBefore57: true }
        : {}),
    };
    const tax: MtdEmployee = {
      resident: employee.tax_resident,
      category: employee.tax_category as 1 | 2 | 3,
      qualifyingChildren: employee.qualifying_children,
      ...(employee.disabled ? { disabled: true } : {}),
      ...(employee.disabled_spouse ? { disabledSpouse: true } : {}),
    };

    const slip = await computePayslip(tx, {
      wage,
      subject,
      asOf: input.payMonth,
      tax,
      taxYearToDate: {
        accumulatedGross: accumulatedGross.toDecimalString(),
        accumulatedEpf: accumulatedEpf.toDecimalString(),
        accumulatedMtd: accumulatedMtd.toDecimalString(),
      },
      ...(bonus !== undefined ? { bonus } : {}),
    });

    // `tax` was supplied, so the payslip is complete — assert rather than trust.
    if (slip.pcb === null || slip.netPay === null || slip.totalDeducted === null) {
      throw new PayRunError('RUN_NOT_FOUND', 'computePayslip returned no tax with a tax profile — a bug, not a data problem.');
    }

    const gross = Money.fromDecimal(slip.wage, currency).add(
      Money.fromDecimal(bonus ?? '0', currency),
    );

    await tx`
        INSERT INTO pay_run_line (
            tenant_id, pay_run_id, employee_id,
            full_name, employee_no, tin, id_type, id_value,
            wage, bonus, gross,
            epf_part, socso_category, eis_applies, non_resident,
            epf_employee, epf_employer,
            socso_employee_invalidity, socso_employee_skbbk, socso_employer,
            eis_employee, eis_employer,
            pcb, pcb_on_bonus, chargeable_income,
            total_deducted, net_pay
        ) VALUES (
            ${ctx.tenantId}, ${run!.id}, ${employee.id},
            ${employee.full_name}, ${employee.employee_no}, ${employee.tin},
            ${employee.id_type}, ${employee.id_value},
            ${slip.wage}, ${bonus ?? '0'}, ${gross.toDecimalString()},
            ${slip.epfPart}, ${slip.socsoCategory}, ${slip.eisApplies},
            ${slip.pcb.nonResident},
            ${slip.epf.employee}, ${slip.epf.employer},
            ${slip.socso.employeeInvalidity}, ${slip.socso.employeeSkbbk},
            ${slip.socso.employer},
            ${slip.eis.employee}, ${slip.eis.employer},
            ${slip.pcb.deduction}, ${slip.pcb.onBonus}, ${slip.pcb.chargeableIncome},
            ${slip.totalDeducted}, ${slip.netPay}
        )
    `;
  }

  return runView(tx, ctx, run!, false);
}

// ---------------------------------------------------------------------------
// Confirming — the moment it becomes bookkeeping
// ---------------------------------------------------------------------------

async function loadPayrollAccounts(tx: Tx, ctx: TenantContext): Promise<PayRunAccounts> {
  const rows = await tx<{ role: string; account_id: string }[]>`
      SELECT role, account_id FROM posting_account_map
       WHERE tenant_id = ${ctx.tenantId}
         AND role IN ('WAGES_EXPENSE', 'EMPLOYER_STATUTORY_EXPENSE', 'EPF_PAYABLE',
                      'SOCSO_PAYABLE', 'EIS_PAYABLE', 'PCB_PAYABLE', 'NET_WAGES_PAYABLE')
  `;
  const byRole = new Map(rows.map((r) => [r.role, r.account_id]));
  const missing = [
    'WAGES_EXPENSE',
    'EMPLOYER_STATUTORY_EXPENSE',
    'EPF_PAYABLE',
    'SOCSO_PAYABLE',
    'EIS_PAYABLE',
    'PCB_PAYABLE',
    'NET_WAGES_PAYABLE',
  ].filter((role) => !byRole.has(role));

  if (missing.length > 0) {
    // All or nothing, like the stock accounts: posting half a payroll to a
    // suspense account would balance and be wrong.
    throw new PayRunError(
      'NO_PAYROLL_ACCOUNTS',
      `This organisation has no posting accounts for: ${missing.join(', ')}. ` +
        'Organisations onboarded before payroll existed need the payroll accounts ' +
        'added to the chart and mapped to these roles.',
      { missing },
    );
  }

  return {
    wagesExpense: byRole.get('WAGES_EXPENSE')!,
    employerStatutoryExpense: byRole.get('EMPLOYER_STATUTORY_EXPENSE')!,
    epfPayable: byRole.get('EPF_PAYABLE')!,
    socsoPayable: byRole.get('SOCSO_PAYABLE')!,
    eisPayable: byRole.get('EIS_PAYABLE')!,
    pcbPayable: byRole.get('PCB_PAYABLE')!,
    netWagesPayable: byRole.get('NET_WAGES_PAYABLE')!,
  };
}

export async function confirmPayRun(
  tx: Tx,
  ctx: TenantContext,
  runId: string,
  idempotencyKey: string,
): Promise<PayRunView> {
  const [run] = await tx<(RunRow & { entry_date: Date })[]>`
      SELECT id, run_no, pay_month, status, journal_entry_id, confirmed_at,
             (pay_month + interval '1 month - 1 day')::date AS entry_date
        FROM pay_run
       WHERE tenant_id = ${ctx.tenantId} AND id = ${runId}
         FOR UPDATE
  `;
  if (run === undefined) throw new PayRunError('RUN_NOT_FOUND', `No pay run ${runId}.`);

  if (run.status === 'CONFIRMED') {
    // Idempotent replay: the same key confirmed this run already.
    const [entry] = await tx<{ idempotency_key: string }[]>`
        SELECT idempotency_key FROM journal_entry
         WHERE tenant_id = ${ctx.tenantId} AND id = ${run.journal_entry_id}
    `;
    if (entry?.idempotency_key === `payrun:${idempotencyKey}`) {
      return runView(tx, ctx, run, true);
    }
    throw new PayRunError('NOT_DRAFT', `${run.run_no} is already confirmed.`);
  }
  if (run.status !== 'DRAFT') {
    throw new PayRunError(
      'NOT_DRAFT',
      `${run.run_no} is ${run.status}. A reversed run stays reversed — prepare the month again.`,
    );
  }

  const lines = await tx<LineRow[]>`
      SELECT * FROM pay_run_line
       WHERE tenant_id = ${ctx.tenantId} AND pay_run_id = ${run.id}
  `;
  if (lines.length === 0) {
    throw new PayRunError('NO_EMPLOYEES', `${run.run_no} has no lines to confirm.`);
  }

  const currency = (await loadBaseCurrency(tx, ctx)) as Currency;
  const accounts = await loadPayrollAccounts(tx, ctx);

  const journalLines: PayRunJournalLine[] = lines.map((l) => ({
    gross: Money.fromDecimal(l.gross, currency),
    epfEmployee: Money.fromDecimal(l.epf_employee, currency),
    epfEmployer: Money.fromDecimal(l.epf_employer, currency),
    socsoEmployee: Money.fromDecimal(l.socso_employee_invalidity, currency).add(
      Money.fromDecimal(l.socso_employee_skbbk, currency),
    ),
    socsoEmployer: Money.fromDecimal(l.socso_employer, currency),
    eisEmployee: Money.fromDecimal(l.eis_employee, currency),
    eisEmployer: Money.fromDecimal(l.eis_employer, currency),
    pcb: Money.fromDecimal(l.pcb, currency),
    netPay: Money.fromDecimal(l.net_pay, currency),
  }));

  const draft = buildPayRunJournal(
    journalLines,
    accounts,
    toIsoDate(run.entry_date),
    currency,
    run.run_no,
    run.id,
  );

  const validated = validateJournalEntry(draft, currency);
  if (isErr(validated)) {
    // Unreachable if the builder is right — loud precisely because of that.
    throw new PayRunError('NO_PAYROLL_ACCOUNTS', 'Generated payroll journal is invalid', validated.error);
  }

  const posted = await postJournalEntry(tx, ctx, validated.value, {
    idempotencyKey: `payrun:${idempotencyKey}`,
  });

  await tx`
      UPDATE pay_run
         SET status = 'CONFIRMED',
             journal_entry_id = ${posted.id},
             confirmed_by = ${ctx.userId ?? null},
             confirmed_at = now()
       WHERE tenant_id = ${ctx.tenantId} AND id = ${run.id}
  `;

  const totals = totalsOf(lines, currency);
  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'PAY_RUN_CONFIRMED', ${ctx.userId ?? null},
          'payroll.manage', 'pay_run', ${run.id},
          ${tx.json({
            runNo: run.run_no,
            payMonth: toIsoDate(run.pay_month),
            employees: lines.length,
            totals: { ...totals },
          })}
      )
  `;

  const [updated] = await tx<RunRow[]>`
      SELECT id, run_no, pay_month, status, journal_entry_id, confirmed_at
        FROM pay_run WHERE tenant_id = ${ctx.tenantId} AND id = ${run.id}
  `;
  return runView(tx, ctx, updated!, false);
}

/**
 * Undo a confirmed month the only way the ledger allows: a reversing entry
 * that references the original (rule 1). The run's own figures stay on record
 * — they were true when confirmed, and the reversal is a second fact, not an
 * erasure. Prepare the month again after this.
 */
export async function reversePayRun(
  tx: Tx,
  ctx: TenantContext,
  runId: string,
  reason: string,
  idempotencyKey: string,
): Promise<PayRunView> {
  const [run] = await tx<RunRow[]>`
      SELECT id, run_no, pay_month, status, journal_entry_id, confirmed_at
        FROM pay_run
       WHERE tenant_id = ${ctx.tenantId} AND id = ${runId}
         FOR UPDATE
  `;
  if (run === undefined) throw new PayRunError('RUN_NOT_FOUND', `No pay run ${runId}.`);
  if (run.status === 'REVERSED') return runView(tx, ctx, run, true);
  if (run.status !== 'CONFIRMED' || run.journal_entry_id === null) {
    throw new PayRunError('NOT_CONFIRMED', `${run.run_no} is ${run.status}; only a confirmed run reverses. A draft is simply prepared again.`);
  }

  await reversePostedEntry(tx, ctx, {
    entryId: run.journal_entry_id,
    reason,
    idempotencyKey: `payrun-reverse:${idempotencyKey}`,
  });

  await tx`
      UPDATE pay_run SET status = 'REVERSED'
       WHERE tenant_id = ${ctx.tenantId} AND id = ${run.id}
  `;

  await tx`
      INSERT INTO financial_event_log (
          tenant_id, event_type, actor_user_id, permission, entity_type, entity_id, detail
      ) VALUES (
          ${ctx.tenantId}, 'PAY_RUN_REVERSED', ${ctx.userId ?? null},
          'payroll.manage', 'pay_run', ${run.id},
          ${tx.json({ runNo: run.run_no, payMonth: toIsoDate(run.pay_month), reason })}
      )
  `;

  const [updated] = await tx<RunRow[]>`
      SELECT id, run_no, pay_month, status, journal_entry_id, confirmed_at
        FROM pay_run WHERE tenant_id = ${ctx.tenantId} AND id = ${run.id}
  `;
  return runView(tx, ctx, updated!, false);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getPayRun(tx: Tx, ctx: TenantContext, runId: string): Promise<PayRunView> {
  const [run] = await tx<RunRow[]>`
      SELECT id, run_no, pay_month, status, journal_entry_id, confirmed_at
        FROM pay_run WHERE tenant_id = ${ctx.tenantId} AND id = ${runId}
  `;
  if (run === undefined) throw new PayRunError('RUN_NOT_FOUND', `No pay run ${runId}.`);
  return runView(tx, ctx, run, false);
}

export async function listPayRuns(
  tx: Tx,
  ctx: TenantContext,
): Promise<readonly Omit<PayRunView, 'lines' | 'totals' | 'replayed'>[]> {
  const runs = await tx<RunRow[]>`
      SELECT id, run_no, pay_month, status, journal_entry_id, confirmed_at
        FROM pay_run
       WHERE tenant_id = ${ctx.tenantId}
       ORDER BY pay_month DESC, created_at DESC
  `;
  return runs.map((run) => ({
    id: run.id,
    runNo: run.run_no,
    payMonth: toIsoDate(run.pay_month),
    status: run.status,
    journalEntryId: run.journal_entry_id,
    confirmedAt: run.confirmed_at === null ? null : run.confirmed_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// The filing artifact and the payslips — from the SNAPSHOT, never recomputed
// ---------------------------------------------------------------------------

/**
 * The CP39 text file for a confirmed month.
 *
 * Confirmed only: the file goes to LHDN, and what is filed must be what the
 * books say — a draft can still change.
 */
export async function payRunCp39(tx: Tx, ctx: TenantContext, runId: string): Promise<Cp39File> {
  const [run] = await tx<(RunRow & { lhdn_employer_no: string | null })[]>`
      SELECT r.id, r.run_no, r.pay_month, r.status, r.journal_entry_id, r.confirmed_at,
             o.lhdn_employer_no
        FROM pay_run r
        JOIN organisation o ON o.id = r.tenant_id
       WHERE r.tenant_id = ${ctx.tenantId} AND r.id = ${runId}
  `;
  if (run === undefined) throw new PayRunError('RUN_NOT_FOUND', `No pay run ${runId}.`);
  if (run.status !== 'CONFIRMED') {
    throw new PayRunError(
      'NOT_CONFIRMED',
      `${run.run_no} is ${run.status}. CP39 files what the books say, so only a ` +
        'confirmed run can be exported.',
    );
  }
  if (run.lhdn_employer_no === null || run.lhdn_employer_no.trim() === '') {
    throw new PayRunError(
      'NO_EMPLOYER_NO',
      'This organisation has no LHDN employer number (E number). Set it in the ' +
        'Payroll settings before exporting a CP39.',
    );
  }

  const lines = await tx<LineRow[]>`
      SELECT * FROM pay_run_line
       WHERE tenant_id = ${ctx.tenantId} AND pay_run_id = ${run.id}
       ORDER BY full_name
  `;

  const details: Cp39Detail[] = lines.map((l) => ({
    tin: l.tin ?? '',
    name: l.full_name.toUpperCase(),
    ...(l.id_type === 'NRIC' && l.id_value !== null ? { newIc: l.id_value } : {}),
    ...(l.id_type === 'PASSPORT' && l.id_value !== null ? { passportNo: l.id_value } : {}),
    countryCode: 'MY',
    mtd: l.pcb,
    ...(l.employee_no !== null ? { employeeNo: l.employee_no } : {}),
  }));

  const month = toIsoDate(run.pay_month);
  return buildCp39File(
    run.lhdn_employer_no.trim(),
    Number(month.slice(0, 4)),
    Number(month.slice(5, 7)),
    details,
  );
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * A payslip for one line of a run, assembled from the SNAPSHOT.
 *
 * Never recomputed: the schedules may have changed since, the employee record
 * may have changed since, and the payslip's one job is to say what was
 * actually paid. The employee's job title is the only field read live — it is
 * cosmetic, and freezing it was not worth a column.
 */
export async function payRunPayslip(
  tx: Tx,
  ctx: TenantContext,
  runId: string,
  lineId: string,
): Promise<PayslipDocument> {
  const [line] = await tx<(LineRow & { pay_month: Date; job_title: string | null })[]>`
      SELECT l.*, r.pay_month, e.job_title
        FROM pay_run_line l
        JOIN pay_run r ON r.tenant_id = l.tenant_id AND r.id = l.pay_run_id
        LEFT JOIN employee e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
       WHERE l.tenant_id = ${ctx.tenantId} AND l.pay_run_id = ${runId} AND l.id = ${lineId}
  `;
  if (line === undefined) {
    throw new PayRunError('RUN_NOT_FOUND', `No payslip line ${lineId} on run ${runId}.`);
  }

  const employer = await sellerBlock(tx, ctx);
  const month = toIsoDate(line.pay_month);
  const currency = 'MYR' as const;

  const earnings: { label: string; amount: string }[] = [
    { label: 'Basic wage', amount: line.wage },
  ];
  if (!Money.fromDecimal(line.bonus, currency).isZero()) {
    earnings.push({ label: 'Bonus / additional remuneration', amount: line.bonus });
  }

  return {
    employer,
    employee: {
      name: line.full_name,
      ...(line.employee_no !== null ? { staffId: line.employee_no } : {}),
      ...(line.job_title !== null ? { jobTitle: line.job_title } : {}),
      ...(line.id_value !== null ? { idNumber: line.id_value } : {}),
    },
    period: `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`,
    payDate: toIsoDate(
      new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)),
    ),
    currency,
    earnings,
    grossPay: line.gross,
    deductions: [
      { label: 'EPF', note: `Third Schedule, Part ${line.epf_part}`, amount: line.epf_employee },
      {
        label: 'SOCSO — Invalidity',
        note: `Act 4, Category ${line.socso_category}`,
        amount: line.socso_employee_invalidity,
      },
      { label: 'SOCSO — SKBBK', amount: line.socso_employee_skbbk },
      {
        label: 'EIS',
        note: line.eis_applies ? 'Act 800' : 'not covered',
        amount: line.eis_employee,
      },
      {
        label: 'Income tax (PCB)',
        note: line.non_resident ? 'non-resident rate' : 'monthly tax deduction',
        amount: line.pcb,
      },
    ],
    totalDeductions: line.total_deducted,
    netPay: line.net_pay,
    employerContributions: [
      { label: 'EPF', amount: line.epf_employer },
      { label: 'SOCSO', amount: line.socso_employer },
      { label: 'EIS', amount: line.eis_employer },
    ],
    totalEmployerContributions: Money.fromDecimal(line.epf_employer, currency)
      .add(Money.fromDecimal(line.socso_employer, currency))
      .add(Money.fromDecimal(line.eis_employer, currency))
      .toDecimalString(),
    basis: {
      epfPart: line.epf_part as PayslipDocument['basis']['epfPart'],
      socsoCategory: line.socso_category as 1 | 2,
      eisApplies: line.eis_applies,
      nonResident: line.non_resident,
      chargeableIncome: line.chargeable_income,
    },
  };
}

/** Set the LHDN employer number — the E number every CP39 record carries. */
export async function setPayrollSettings(
  tx: Tx,
  ctx: TenantContext,
  input: { readonly lhdnEmployerNo: string },
): Promise<{ lhdnEmployerNo: string }> {
  await tx`
      UPDATE organisation SET lhdn_employer_no = ${input.lhdnEmployerNo.trim()}
       WHERE id = ${ctx.tenantId}
  `;
  return { lhdnEmployerNo: input.lhdnEmployerNo.trim() };
}
