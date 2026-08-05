import { Money, type Currency } from '@emil/domain';
import type { TenantContext, Tx } from './client.js';
import { toIsoDate } from './internal.js';
import { sellerBlock, type SellerBlock } from './document-data.js';
import { PayRunError } from './pay-run.js';

/**
 * Year-end payroll — the EA data sheet and the Form E totals.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING COMES FROM CONFIRMED SNAPSHOTS, AND ONLY THIS EMPLOYER'S.
 *
 * The figures are summed from `pay_run_line` rows of CONFIRMED runs — the
 * same frozen rows the ledger was posted from and the payslips print from,
 * so the annual statement cannot disagree with twelve monthly ones.
 *
 * The TP3 opening balances an employee brought from a PREVIOUS employer are
 * deliberately EXCLUDED: an EA covers remuneration from THIS employment; the
 * previous employer issues their own for theirs. (The TP3 figures exist to
 * make the MTD arithmetic right, not to move income between employers.)
 *
 * WHAT THIS IS NOT: the official C.P.8A layout. The official form PDF could
 * not be retrieved in this environment (docs/research/sources/
 * compliance-deadlines-provenance.md records the attempt and the promotion
 * path), so the output is a DATA SHEET carrying every figure the form needs,
 * and says so on its face. Copying the numbers onto the official form is
 * transcription; inventing the form's layout would have been forgery-adjacent
 * guesswork.
 * ---------------------------------------------------------------------------
 */

export interface EmployeeYearSummary {
  readonly employeeId: string;
  readonly fullName: string;
  readonly employeeNo: string | null;
  readonly tin: string | null;
  readonly idType: string | null;
  readonly idValue: string | null;
  readonly jobTitle: string | null;
  /** Employment window CLIPPED to the year, for the statement's own period. */
  readonly employedFrom: string;
  readonly employedTo: string;
  readonly monthsPaid: number;
  readonly grossRemuneration: string;
  readonly wage: string;
  readonly bonus: string;
  readonly pcb: string;
  readonly epfEmployee: string;
  readonly socsoEmployee: string;
  readonly eisEmployee: string;
}

export interface EaDocument {
  readonly employer: SellerBlock;
  readonly lhdnEmployerNo: string | null;
  readonly year: number;
  readonly employee: EmployeeYearSummary;
}

export interface FormESummary {
  readonly employer: SellerBlock;
  readonly lhdnEmployerNo: string | null;
  readonly year: number;
  readonly employeeCount: number;
  readonly totals: {
    readonly grossRemuneration: string;
    readonly pcb: string;
  };
  readonly rows: readonly EmployeeYearSummary[];
}

interface YearRow {
  employee_id: string;
  full_name: string;
  employee_no: string | null;
  tin: string | null;
  id_type: string | null;
  id_value: string | null;
  job_title: string | null;
  hired_on: Date;
  left_on: Date | null;
  months_paid: number;
  wage: string;
  bonus: string;
  gross: string;
  pcb: string;
  epf_employee: string;
  socso_employee: string;
  eis_employee: string;
}

/**
 * One row per person paid in the year, summed over CONFIRMED runs.
 *
 * Identity (name, staff no, TIN, IC) comes from the LATEST confirmed line of
 * the year — the year-end statement should carry the name the year ended
 * with, and the line snapshots are exactly what each month actually said.
 */
async function yearRows(tx: Tx, ctx: TenantContext, year: number): Promise<YearRow[]> {
  return tx<YearRow[]>`
      SELECT l.employee_id,
             (ARRAY_AGG(l.full_name   ORDER BY r.pay_month DESC))[1] AS full_name,
             (ARRAY_AGG(l.employee_no ORDER BY r.pay_month DESC))[1] AS employee_no,
             (ARRAY_AGG(l.tin         ORDER BY r.pay_month DESC))[1] AS tin,
             (ARRAY_AGG(l.id_type     ORDER BY r.pay_month DESC))[1] AS id_type,
             (ARRAY_AGG(l.id_value    ORDER BY r.pay_month DESC))[1] AS id_value,
             e.job_title, e.hired_on, e.left_on,
             COUNT(*)::int                          AS months_paid,
             SUM(l.wage)                            AS wage,
             SUM(l.bonus)                           AS bonus,
             SUM(l.gross)                           AS gross,
             SUM(l.pcb)                             AS pcb,
             SUM(l.epf_employee)                    AS epf_employee,
             SUM(l.socso_employee_invalidity + l.socso_employee_skbbk) AS socso_employee,
             SUM(l.eis_employee)                    AS eis_employee
        FROM pay_run_line l
        JOIN pay_run r  ON r.tenant_id = l.tenant_id AND r.id = l.pay_run_id
        LEFT JOIN employee e ON e.tenant_id = l.tenant_id AND e.id = l.employee_id
       WHERE l.tenant_id = ${ctx.tenantId}
         AND r.status = 'CONFIRMED'
         AND r.pay_month >= ${`${year}-01-01`} AND r.pay_month <= ${`${year}-12-01`}
       GROUP BY l.employee_id, e.job_title, e.hired_on, e.left_on
       ORDER BY 2
  `;
}

function toSummary(row: YearRow, year: number): EmployeeYearSummary {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const hired = toIsoDate(row.hired_on);
  const left = row.left_on === null ? null : toIsoDate(row.left_on);

  return {
    employeeId: row.employee_id,
    fullName: row.full_name,
    employeeNo: row.employee_no,
    tin: row.tin,
    idType: row.id_type,
    idValue: row.id_value,
    jobTitle: row.job_title,
    employedFrom: hired > yearStart ? hired : yearStart,
    employedTo: left !== null && left < yearEnd ? left : yearEnd,
    monthsPaid: row.months_paid,
    grossRemuneration: row.gross,
    wage: row.wage,
    bonus: row.bonus,
    pcb: row.pcb,
    epfEmployee: row.epf_employee,
    socsoEmployee: row.socso_employee,
    eisEmployee: row.eis_employee,
  };
}

async function employerNo(tx: Tx, ctx: TenantContext): Promise<string | null> {
  const [org] = await tx<{ lhdn_employer_no: string | null }[]>`
      SELECT lhdn_employer_no FROM organisation WHERE id = ${ctx.tenantId}
  `;
  return org!.lhdn_employer_no;
}

/** Every EA data sheet for the year — the book the shop prints and hands out. */
export async function eaDocuments(
  tx: Tx,
  ctx: TenantContext,
  year: number,
): Promise<EaDocument[]> {
  const rows = await yearRows(tx, ctx, year);
  if (rows.length === 0) {
    throw new PayRunError(
      'RUN_NOT_FOUND',
      `No confirmed pay runs in ${year} — there is nobody to issue an EA for.`,
    );
  }
  const employer = await sellerBlock(tx, ctx);
  const lhdnNo = await employerNo(tx, ctx);
  return rows.map((row) => ({
    employer,
    lhdnEmployerNo: lhdnNo,
    year,
    employee: toSummary(row, year),
  }));
}

export async function eaDocument(
  tx: Tx,
  ctx: TenantContext,
  year: number,
  employeeId: string,
): Promise<EaDocument> {
  const documents = await eaDocuments(tx, ctx, year);
  const found = documents.find((d) => d.employee.employeeId === employeeId);
  if (!found) {
    throw new PayRunError(
      'RUN_NOT_FOUND',
      `No confirmed ${year} pay for employee ${employeeId}.`,
    );
  }
  return found;
}

/** The employer's totals: what Form E asks, next to the per-person C.P.8D rows. */
export async function formESummary(
  tx: Tx,
  ctx: TenantContext,
  year: number,
): Promise<FormESummary> {
  const rows = await yearRows(tx, ctx, year);
  const employer = await sellerBlock(tx, ctx);
  const lhdnNo = await employerNo(tx, ctx);
  const currency = 'MYR' as Currency;

  const summaries = rows.map((row) => toSummary(row, year));
  const total = (pick: (s: EmployeeYearSummary) => string) =>
    summaries
      .reduce((sum, s) => sum.add(Money.fromDecimal(pick(s), currency)), Money.zero(currency))
      .toDecimalString();

  return {
    employer,
    lhdnEmployerNo: lhdnNo,
    year,
    employeeCount: summaries.length,
    totals: {
      grossRemuneration: total((s) => s.grossRemuneration),
      pcb: total((s) => s.pcb),
    },
    rows: summaries,
  };
}
