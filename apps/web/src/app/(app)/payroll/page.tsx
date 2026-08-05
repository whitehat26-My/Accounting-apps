'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiBlobUrl, apiDownload } from '@/lib/api';
import { Badge, Button, Card, ErrorNote, Field, Input, Skeleton } from '@/components/ui';
import { rm, todayIso } from '@/lib/display';

/**
 * Payroll: what a wage really costs, and what actually reaches the staff.
 *
 * ---------------------------------------------------------------------------
 * NOTHING ON THIS SCREEN IS CALCULATED HERE.
 *
 * Every ringgit shown comes back from the API, which looks it up in the
 * published EPF, SOCSO and EIS schedules and applies IRBM's MTD formula for
 * income tax. That is not ceremony about where code lives — the employer's EPF
 * share is 13% up to RM 5,000 and 12% above it, so a field that multiplied by
 * 0.12 in the browser would under-deduct RM 25 a month on a RM 2,500 wage,
 * quietly, and the liability for that is the shop's.
 * ---------------------------------------------------------------------------
 */

interface Contributions {
  wage: string;
  epfPart: 'A' | 'C' | 'E' | 'F';
  socsoCategory: 1 | 2;
  eisApplies: boolean;
  epf: { employer: string; employee: string };
  socso: {
    employer: string;
    employee: string;
    employeeInvalidity: string;
    employeeSkbbk: string;
  };
  eis: { employer: string; employee: string };
  totalEmployee: string;
  totalEmployer: string;
  wageAfterContributions: string;
  totalEmploymentCost: string;
}

interface Pcb {
  chargeableIncome: string;
  deduction: string;
  onBonus: string;
  nonResident: boolean;
}

/**
 * Two routes answer with two shapes, and the difference is a trap worth naming.
 *
 * `/payslip` returns `pcb: null` when it cannot compute tax. `/contributions`
 * does not return the key AT ALL, so it reads back as `undefined` — and
 * `undefined !== null` is true, which is how a check for "did we get tax
 * figures" passes and then dereferences nothing. Both are optional here and
 * both are normalised to null once, below, so the rest of the screen has one
 * thing to test.
 */
interface Payslip extends Contributions {
  pcb?: Pcb | null;
  netPay?: string | null;
  totalDeducted?: string | null;
}

/** What each EPF Part means in plain terms, for the line under the result. */
const EPF_PART_MEANING: Record<Contributions['epfPart'], string> = {
  A: 'Under 60, Malaysian or PR — the full schedule.',
  C: 'Aged 60 or over, permanent resident — reduced, but both sides still pay.',
  E: 'Aged 60 or over, Malaysian citizen — the employer pays, the staff member does not.',
  F: 'Not a citizen or PR — a flat 2% each, with no wage bands at all.',
};

/**
 * The tax categories, in the words a shop owner would use.
 *
 * There is no "not sure" option and no default beyond single, because the
 * choice changes the answer by RM4,000 of relief a year and the person filling
 * this in is the only one who knows.
 */
const TAX_CATEGORIES = [
  { value: 1, label: 'Single', hint: 'Individual relief only.' },
  { value: 2, label: 'Married, spouse not working', hint: 'Adds RM4,000 spouse relief.' },
  {
    value: 3,
    label: 'Married (spouse works), divorced or widowed',
    hint: 'Individual relief and children, no spouse relief.',
  },
] as const;

function CalculatorSection() {
  const [wage, setWage] = useState('2500.00');
  const [age, setAge] = useState('24');
  const [citizenship, setCitizenship] =
    useState<'CITIZEN' | 'PERMANENT_RESIDENT' | 'NON_CITIZEN'>('CITIZEN');
  const [asOf, setAsOf] = useState(todayIso());

  // Income tax. Off by default: it needs figures a quick "what would this hire
  // cost" question does not have, and a half-filled tax profile produces a
  // confident wrong answer rather than an obviously incomplete one.
  const [withTax, setWithTax] = useState(false);
  const [category, setCategory] = useState<1 | 2 | 3>(1);
  const [children, setChildren] = useState('0');
  const [paidSoFar, setPaidSoFar] = useState('0.00');
  const [epfSoFar, setEpfSoFar] = useState('0.00');
  const [taxSoFar, setTaxSoFar] = useState('0.00');
  // Only needed to PRINT: a payslip is addressed to someone, and the shop types
  // the name because nothing here stores employees.
  const [staffName, setStaffName] = useState('');
  const [staffId, setStaffId] = useState('');
  const [jobTitle, setJobTitle] = useState('');

  /*
   * One request body, built once and used by both buttons.
   *
   * Calculating and printing must not be able to disagree — a payslip that
   * differs from the figures on the screen above it is the kind of defect
   * nobody reports because nobody believes their own eyes.
   */
  const requestBody = () => ({
    wage,
    asOf,
    // The only numbers this screen sends as numbers. An age and a child count
    // are counts, not money — and the wage beside them stays a string precisely
    // because it is money.
    age: Number(age),
    citizenship,
    ...(withTax
      ? {
          tax: {
            // A foreign worker on a contract of 182 days or more is resident
            // for tax; a shorter posting is a flat 30%. The shop knows which, so
            // the citizenship field is not overloaded to guess it.
            resident: citizenship !== 'NON_CITIZEN',
            category,
            qualifyingChildren: Number(children),
          },
          taxYearToDate: {
            accumulatedGross: paidSoFar,
            accumulatedEpf: epfSoFar,
            accumulatedMtd: taxSoFar,
          },
        }
      : {}),
  });

  const calculate = useMutation({
    mutationFn: () =>
      api<Payslip>(withTax ? '/v1/payroll/payslip' : '/v1/payroll/contributions', {
        method: 'POST',
        body: requestBody(),
      }),
  });

  const print = useMutation({
    mutationFn: async () => {
      const url = await apiBlobUrl('/v1/payroll/payslip/pdf', {
        ...requestBody(),
        employee: {
          name: staffName.trim(),
          ...(staffId.trim() ? { staffId: staffId.trim() } : {}),
          ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
        },
      });
      window.open(url, '_blank');
    },
  });

  const result = calculate.data;
  // Normalised once — see the note on `Payslip`.
  const pcb: Pcb | null = result?.pcb ?? null;
  const netPay: string | null = result?.netPay ?? null;

  return (
    <div className="space-y-4">
      <Card title="Quick quote: what would a wage cost?">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            calculate.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Monthly wage (RM)">
              <Input
                value={wage}
                inputMode="decimal"
                onChange={(event) => setWage(event.target.value)}
                placeholder="2500.00"
              />
            </Field>
            <Field label="Age">
              <Input
                value={age}
                inputMode="numeric"
                onChange={(event) => setAge(event.target.value)}
              />
            </Field>
            <Field label="Status">
              <select
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                value={citizenship}
                onChange={(event) =>
                  setCitizenship(event.target.value as typeof citizenship)
                }
              >
                <option value="CITIZEN">Malaysian citizen</option>
                <option value="PERMANENT_RESIDENT">Permanent resident</option>
                <option value="NON_CITIZEN">Foreign worker</option>
              </select>
            </Field>
            <Field label="Contribution month">
              {/*
                Required, and not defaulted on the server. SKBBK started on
                1 June 2026, so working out an earlier month has to be told which
                month it is — otherwise a re-run of May silently gets June's rates.
              */}
              <Input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
            </Field>
          </div>

          <label className="flex items-start gap-2.5 rounded-lg bg-slate-50 p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300"
              checked={withTax}
              onChange={(event) => setWithTax(event.target.checked)}
            />
            <span>
              <span className="font-medium text-slate-900">Include income tax (PCB)</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Needed for a real take-home figure. Tax is worked out on the whole year,
                so it also needs what has been paid so far.
              </span>
            </span>
          </label>

          {withTax ? (
            <div className="grid gap-4 rounded-lg border border-slate-200 p-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Tax category">
                <select
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  value={category}
                  onChange={(event) => setCategory(Number(event.target.value) as 1 | 2 | 3)}
                >
                  {TAX_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  {TAX_CATEGORIES.find((c) => c.value === category)?.hint}
                </p>
              </Field>

              <Field label="Children claimed">
                <Input
                  value={children}
                  inputMode="numeric"
                  onChange={(event) => setChildren(event.target.value)}
                />
                {/*
                  Counted, not listed — the specification expresses the larger
                  relief for a student by inflating the COUNT rather than the
                  per-child amount, so this field has to say so.
                */}
                <p className="mt-1 text-xs text-slate-500">
                  Count a child in college or university as 4. A disabled child counts as 4,
                  and a disabled child studying as 8.
                </p>
              </Field>

              <Field label="Gross paid this year so far (RM)">
                <Input
                  value={paidSoFar}
                  inputMode="decimal"
                  onChange={(event) => setPaidSoFar(event.target.value)}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Not counting this month. Leave at 0 for someone who started this month.
                </p>
              </Field>

              <Field label="EPF deducted this year so far (RM)">
                <Input
                  value={epfSoFar}
                  inputMode="decimal"
                  onChange={(event) => setEpfSoFar(event.target.value)}
                />
              </Field>

              <Field label="PCB deducted this year so far (RM)">
                <Input
                  value={taxSoFar}
                  inputMode="decimal"
                  onChange={(event) => setTaxSoFar(event.target.value)}
                />
              </Field>

              {/*
                Only needed to print. A payslip is a statement addressed to a
                person, so it needs their name; the calculation does not, and
                asking for it before it is needed would imply this system keeps
                a staff register. It does not.
              */}
              <Field label="Staff name (to print a payslip)">
                <Input
                  value={staffName}
                  onChange={(event) => setStaffName(event.target.value)}
                  placeholder="Nurul Huda binti Ahmad"
                />
              </Field>
              <Field label="Staff number">
                <Input value={staffId} onChange={(event) => setStaffId(event.target.value)} />
              </Field>
              <Field label="Job title">
                <Input value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} />
              </Field>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={calculate.isPending}>
              {calculate.isPending ? 'Working it out…' : 'Calculate'}
            </Button>
            {withTax ? (
              <Button
                type="button"
                variant="ghost"
                disabled={print.isPending || staffName.trim() === ''}
                onClick={() => print.mutate()}
              >
                {print.isPending ? 'Preparing…' : 'Print payslip'}
              </Button>
            ) : null}
            {withTax && staffName.trim() === '' ? (
              <span className="text-xs text-slate-500">Enter a staff name to print.</span>
            ) : null}
          </div>
        </form>

        <ErrorNote error={calculate.error} />
        <ErrorNote error={print.error} />
      </Card>

      {result ? (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title={netPay !== null ? 'The staff member takes home' : 'After contributions'}>
              <p className="text-2xl font-semibold text-slate-900">
                {rm(netPay ?? result.wageAfterContributions)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {netPay !== null && pcb !== null ? (
                  <>
                    {rm(result.wage)} less {rm(result.totalEmployee)} in contributions and{' '}
                    {rm(pcb.deduction)} in income tax.
                  </>
                ) : (
                  <>
                    {rm(result.wage)} less {rm(result.totalEmployee)} in statutory
                    deductions.{' '}
                    {/*
                      Said outright rather than buried: a figure labelled "take
                      home" that quietly omits income tax is worse than no figure,
                      because it looks finished.
                    */}
                    <strong className="font-medium text-slate-700">
                      Income tax (PCB) is not included — tick the box above.
                    </strong>
                  </>
                )}
              </p>
            </Card>

            <Card title="The shop pays on top">
              <p className="text-2xl font-semibold text-slate-900">
                {rm(result.totalEmployer)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Employer EPF, SOCSO and EIS. This never appears on the payslip and is
                the figure most easily forgotten when quoting a salary. Income tax is
                not here — it comes out of the staff member&rsquo;s pay, not the shop&rsquo;s.
              </p>
            </Card>

            <Card title="Total cost to the shop">
              {/*
                Wage plus employer contributions — added on the server, not here.
                Two money strings summed in the browser would need parseFloat,
                and that is the line this app does not cross.
              */}
              <p className="text-2xl font-semibold text-slate-900">
                {rm(result.totalEmploymentCost)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                What actually leaves the bank each month for this person.
              </p>
            </Card>
          </div>

          <Card title="Line by line">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2">Deduction</th>
                  <th className="pb-2 text-right">Staff pays</th>
                  <th className="pb-2 text-right">Shop pays</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-slate-100">
                  <td className="py-2">
                    <span className="font-medium">EPF</span>{' '}
                    <span className="text-xs text-slate-500">
                      Third Schedule, Part {result.epfPart}
                    </span>
                  </td>
                  <td className="py-2 text-right">{rm(result.epf.employee)}</td>
                  <td className="py-2 text-right">{rm(result.epf.employer)}</td>
                </tr>
                <tr className="border-t border-slate-100">
                  <td className="py-2">
                    <span className="font-medium">SOCSO</span>{' '}
                    <span className="text-xs text-slate-500">
                      Category {result.socsoCategory}
                    </span>
                  </td>
                  <td className="py-2 text-right">{rm(result.socso.employee)}</td>
                  <td className="py-2 text-right">{rm(result.socso.employer)}</td>
                </tr>
                {/*
                  The SOCSO employee side is two statutory deductions collected
                  together, and PERKESO's own statement splits them. A payslip
                  showing one figure cannot be reconciled against it.
                */}
                <tr className="border-t border-slate-50 text-xs text-slate-500">
                  <td className="py-1 pl-4">— Invalidity</td>
                  <td className="py-1 text-right">{rm(result.socso.employeeInvalidity)}</td>
                  <td className="py-1 text-right">—</td>
                </tr>
                <tr className="border-t border-slate-50 text-xs text-slate-500">
                  <td className="py-1 pl-4">— SKBBK (24-hour accident cover)</td>
                  <td className="py-1 text-right">{rm(result.socso.employeeSkbbk)}</td>
                  <td className="py-1 text-right">—</td>
                </tr>
                <tr className="border-t border-slate-100">
                  <td className="py-2">
                    <span className="font-medium">EIS</span>{' '}
                    <span className="text-xs text-slate-500">
                      {result.eisApplies ? 'Act 800' : 'not covered'}
                    </span>
                  </td>
                  <td className="py-2 text-right">{rm(result.eis.employee)}</td>
                  <td className="py-2 text-right">{rm(result.eis.employer)}</td>
                </tr>
                {pcb !== null ? (
                  <tr className="border-t border-slate-100">
                    <td className="py-2">
                      <span className="font-medium">Income tax (PCB)</span>{' '}
                      <span className="text-xs text-slate-500">
                        {pcb.nonResident
                          ? 'non-resident, flat 30%'
                          : `on ${rm(pcb.chargeableIncome)} chargeable for the year`}
                      </span>
                    </td>
                    <td className="py-2 text-right">{rm(pcb.deduction)}</td>
                    <td className="py-2 text-right">—</td>
                  </tr>
                ) : null}
                <tr className="border-t-2 border-slate-200 font-semibold">
                  <td className="py-2">Total</td>
                  <td className="py-2 text-right">
                    {rm(result.totalDeducted ?? result.totalEmployee)}
                  </td>
                  <td className="py-2 text-right">{rm(result.totalEmployer)}</td>
                </tr>
              </tbody>
            </table>

            <p className="mt-3 text-xs text-slate-500">{EPF_PART_MEANING[result.epfPart]}</p>

            {pcb !== null && pcb.deduction === '0.0000' && !pcb.nonResident ? (
              <p className="mt-2 text-xs text-slate-500">
                No income tax this month. Either the year&rsquo;s chargeable income is
                below where tax starts, or the RM400 individual rebate covers it — and
                below RM10 a month the employer does not deduct at all. The tax is still
                owed and settles when the return is filed.
              </p>
            ) : null}
          </Card>
        </>
      ) : null}

      <Card title="Where these figures come from">
        <ul className="space-y-1.5 text-xs text-slate-500">
          <li>
            <strong className="font-medium text-slate-700">Looked up, never guessed.</strong>{' '}
            EPF, SOCSO and EIS are tables in law. The employer&rsquo;s EPF share is 13% up
            to RM 5,000 and 12% above it — so the widely quoted &ldquo;12%&rdquo; is wrong
            for most shop wages, by RM 25 a month on RM 2,500. Under-deducting a statutory
            contribution is the employer&rsquo;s liability, not the staff member&rsquo;s.
          </li>
          <li>
            <strong className="font-medium text-slate-700">
              Income tax is worked out on the whole year, not the month.
            </strong>{' '}
            PCB assumes this month&rsquo;s pay repeats, taxes the year, subtracts what has
            already been deducted, and spreads the rest over the months left. That is why
            someone who joins in August pays less than a colleague on the same wage since
            January — and why the year-to-date figures matter.
          </li>
          <li>
            EPF Third Schedule (1,203 bands), SOCSO under Act 4 including SKBBK from
            1 June 2026, EIS under Act 800, and PCB by IRBM&rsquo;s Computerised
            Calculation specification for 2026 — checked against the four worked months
            IRBM publishes with it. Every source document is committed in the repository
            alongside the code.
          </li>
          <li>
            This quick quote posts nothing and remembers nothing — it exists for
            &ldquo;what would hiring at RM X cost?&rdquo;. The sections above are the real
            payroll: staff on the register, months confirmed into the books, payslips kept.
          </li>
        </ul>
      </Card>
    </div>
  );
}


// ---------------------------------------------------------------------------
// The payroll itself: the register, and the month
// ---------------------------------------------------------------------------

interface Employee {
  id: string;
  fullName: string;
  employeeNo: string | null;
  idType: string | null;
  idValue: string | null;
  tin: string | null;
  dateOfBirth: string;
  citizenship: 'CITIZEN' | 'PERMANENT_RESIDENT' | 'NON_CITIZEN';
  taxResident: boolean;
  taxCategory: 1 | 2 | 3;
  qualifyingChildren: number;
  monthlyWage: string;
  jobTitle: string | null;
  hiredOn: string;
  leftOn: string | null;
  active: boolean;
  paymentMethod: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE';
  bankName: string | null;
  bankAccountLast4: string | null;
  ytdYear: number | null;
  ytdGrossBefore: string;
  ytdEpfBefore: string;
  ytdMtdBefore: string;
}

interface RunLine {
  id: string;
  employeeId: string;
  fullName: string;
  gross: string;
  epfEmployee: string;
  socsoEmployeeInvalidity: string;
  socsoEmployeeSkbbk: string;
  eisEmployee: string;
  pcb: string;
  totalDeducted: string;
  netPay: string;
}

interface Run {
  id: string;
  runNo: string;
  payMonth: string;
  status: 'DRAFT' | 'CONFIRMED' | 'REVERSED';
  lines: RunLine[];
  totals: {
    gross: string;
    epf: string;
    socso: string;
    eis: string;
    pcb: string;
    netPay: string;
    employerCost: string;
  };
}

interface RunSummary {
  id: string;
  runNo: string;
  payMonth: string;
  status: string;
}

export default function PayrollPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Payroll</h1>
      <RunCard />
      <YearEndCard />
      <StaffCard />
      <CalculatorSection />
    </div>
  );
}

// ---------------------------------------------------------------------------

const EMPTY_FORM = {
  fullName: '',
  employeeNo: '',
  jobTitle: '',
  idType: 'NRIC' as 'NRIC' | 'PASSPORT',
  idValue: '',
  tin: '',
  dateOfBirth: '',
  citizenship: 'CITIZEN' as Employee['citizenship'],
  taxResident: true,
  taxCategory: 1 as 1 | 2 | 3,
  qualifyingChildren: '0',
  monthlyWage: '',
  hiredOn: todayIso(),
  leftOn: '',
  paymentMethod: 'BANK_TRANSFER' as 'BANK_TRANSFER' | 'CASH' | 'CHEQUE',
  bankName: '',
  bankAccountLast4: '',
  midYear: false,
  ytdGrossBefore: '0.00',
  ytdEpfBefore: '0.00',
  ytdMtdBefore: '0.00',
};

function StaffCard() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const staff = useQuery({
    queryKey: ['employees'],
    queryFn: () => api<{ employees: Employee[] }>('/v1/payroll/employees'),
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        fullName: form.fullName.trim(),
        ...(form.employeeNo.trim() ? { employeeNo: form.employeeNo.trim() } : {}),
        ...(form.jobTitle.trim() ? { jobTitle: form.jobTitle.trim() } : {}),
        ...(form.idValue.trim()
          ? { idType: form.idType, idValue: form.idValue.trim().replace(/-/g, '') }
          : {}),
        ...(form.tin.trim() ? { tin: form.tin.trim() } : {}),
        dateOfBirth: form.dateOfBirth,
        citizenship: form.citizenship,
        taxResident: form.taxResident,
        taxCategory: form.taxCategory,
        qualifyingChildren: Number(form.qualifyingChildren),
        monthlyWage: form.monthlyWage,
        hiredOn: form.hiredOn,
        leftOn: form.leftOn === '' ? null : form.leftOn,
        paymentMethod: form.paymentMethod,
        ...(form.bankName.trim() ? { bankName: form.bankName.trim() } : {}),
        ...(form.bankAccountLast4.trim()
          ? { bankAccountLast4: form.bankAccountLast4.trim() }
          : {}),
        // TP3: only sent when the joiner brought a year with them. The year is
        // the hire year — figures from an earlier year are stale by law.
        ...(form.midYear
          ? {
              ytdYear: Number(form.hiredOn.slice(0, 4)),
              ytdGrossBefore: form.ytdGrossBefore,
              ytdEpfBefore: form.ytdEpfBefore,
              ytdMtdBefore: form.ytdMtdBefore,
            }
          : {}),
      };
      return editing === null
        ? api('/v1/payroll/employees', { method: 'POST', body })
        : api(`/v1/payroll/employees/${editing}`, { method: 'PATCH', body });
    },
    onSuccess: () => {
      setForm(EMPTY_FORM);
      setEditing(null);
      setShowForm(false);
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
  });

  const startEdit = (employee: Employee) => {
    setEditing(employee.id);
    setShowForm(true);
    setForm({
      fullName: employee.fullName,
      employeeNo: employee.employeeNo ?? '',
      jobTitle: employee.jobTitle ?? '',
      idType: (employee.idType as 'NRIC' | 'PASSPORT') ?? 'NRIC',
      idValue: employee.idValue ?? '',
      tin: employee.tin ?? '',
      dateOfBirth: employee.dateOfBirth,
      citizenship: employee.citizenship,
      taxResident: employee.taxResident,
      taxCategory: employee.taxCategory,
      qualifyingChildren: String(employee.qualifyingChildren),
      monthlyWage: employee.monthlyWage,
      hiredOn: employee.hiredOn,
      leftOn: employee.leftOn ?? '',
      paymentMethod: employee.paymentMethod,
      bankName: employee.bankName ?? '',
      bankAccountLast4: employee.bankAccountLast4 ?? '',
      midYear: employee.ytdYear !== null,
      ytdGrossBefore: employee.ytdGrossBefore,
      ytdEpfBefore: employee.ytdEpfBefore,
      ytdMtdBefore: employee.ytdMtdBefore,
    });
  };

  const set = (patch: Partial<typeof EMPTY_FORM>) =>
    setForm((current) => ({ ...current, ...patch }));

  const ready =
    form.fullName.trim() !== '' &&
    form.dateOfBirth !== '' &&
    form.monthlyWage.trim() !== '' &&
    form.hiredOn !== '';

  return (
    <Card title="Staff">
      {staff.data ? (
        staff.data.employees.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-2">Name</th>
                <th className="pb-2">Role</th>
                <th className="pb-2 text-right">Monthly wage</th>
                <th className="pb-2">Status</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {staff.data.employees.map((employee) => (
                <tr key={employee.id} className="border-t border-slate-100">
                  <td className="py-2 font-medium">{employee.fullName}</td>
                  <td className="py-2 text-slate-500">{employee.jobTitle ?? ''}</td>
                  <td className="py-2 text-right">{rm(employee.monthlyWage)}</td>
                  <td className="py-2">
                    <Badge status={employee.active ? 'ACTIVE' : 'LEFT'} />
                  </td>
                  <td className="py-2 text-right">
                    <Button variant="ghost" onClick={() => startEdit(employee)}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-slate-500">
            Nobody on the books yet. Add your staff once — the monthly run computes
            everyone from here.
          </p>
        )
      ) : (
        <Skeleton />
      )}

      {!showForm ? (
        <div className="mt-3">
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(null);
              setForm(EMPTY_FORM);
              setShowForm(true);
            }}
          >
            Add a staff member
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4 rounded-lg border border-slate-200 p-4">
          <p className="text-sm font-medium text-slate-900">
            {editing === null ? 'New staff member' : 'Edit staff member'}
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Full name (as on IC)">
              <Input value={form.fullName} onChange={(e) => set({ fullName: e.target.value })} />
            </Field>
            <Field label="Staff number">
              <Input value={form.employeeNo} onChange={(e) => set({ employeeNo: e.target.value })} />
            </Field>
            <Field label="Job title">
              <Input value={form.jobTitle} onChange={(e) => set({ jobTitle: e.target.value })} />
            </Field>
            <Field label="ID type">
              <select
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                value={form.idType}
                onChange={(e) => set({ idType: e.target.value as 'NRIC' | 'PASSPORT' })}
              >
                <option value="NRIC">NRIC</option>
                <option value="PASSPORT">Passport</option>
              </select>
            </Field>
            <Field label="NRIC / passport number">
              <Input value={form.idValue} onChange={(e) => set({ idValue: e.target.value })} />
            </Field>
            <Field label="Income tax number (TIN)">
              <Input
                value={form.tin}
                onChange={(e) => set({ tin: e.target.value })}
                placeholder="Needed for the CP39 filing"
              />
            </Field>
            <Field label="Date of birth">
              {/*
                Age is computed from this at every run, never stored: EPF, SOCSO
                and EIS all change at 60, and the month after a 60th birthday
                must switch schedules with nobody remembering anything.
              */}
              <Input
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => set({ dateOfBirth: e.target.value })}
              />
            </Field>
            <Field label="Status">
              <select
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                value={form.citizenship}
                onChange={(e) => set({ citizenship: e.target.value as Employee['citizenship'] })}
              >
                <option value="CITIZEN">Malaysian citizen</option>
                <option value="PERMANENT_RESIDENT">Permanent resident</option>
                <option value="NON_CITIZEN">Foreign worker</option>
              </select>
            </Field>
            <Field label="Tax category">
              <select
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                value={form.taxCategory}
                onChange={(e) => set({ taxCategory: Number(e.target.value) as 1 | 2 | 3 })}
              >
                <option value={1}>Single</option>
                <option value={2}>Married, spouse not working</option>
                <option value={3}>Married (spouse works) / divorced / widowed</option>
              </select>
            </Field>
            <Field label="Children claimed">
              <Input
                inputMode="numeric"
                value={form.qualifyingChildren}
                onChange={(e) => set({ qualifyingChildren: e.target.value })}
              />
            </Field>
            <Field label="Monthly wage (RM)">
              <Input
                inputMode="decimal"
                value={form.monthlyWage}
                onChange={(e) => set({ monthlyWage: e.target.value })}
              />
            </Field>
            <Field label="Hired on">
              <Input
                type="date"
                value={form.hiredOn}
                onChange={(e) => set({ hiredOn: e.target.value })}
              />
            </Field>
            {editing !== null ? (
              <Field label="Left on (blank = still employed)">
                <Input
                  type="date"
                  value={form.leftOn}
                  onChange={(e) => set({ leftOn: e.target.value })}
                />
              </Field>
            ) : null}
            <Field label="Paid by">
              <select
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                value={form.paymentMethod}
                onChange={(e) =>
                  set({ paymentMethod: e.target.value as typeof form.paymentMethod })
                }
              >
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="CASH">Cash</option>
                <option value="CHEQUE">Cheque</option>
              </select>
            </Field>
            {form.paymentMethod !== 'CASH' ? (
              <>
                <Field label="Bank">
                  <Input
                    value={form.bankName}
                    onChange={(e) => set({ bankName: e.target.value })}
                    placeholder="Maybank"
                  />
                </Field>
                <Field label="Account — last 4 digits only">
                  {/*
                    Four digits, and the app never asks for more. It does not
                    make payments, so the rest of an account number would be
                    stored for no reason; four is enough for someone to match
                    the payslip against their own bank statement.
                  */}
                  <Input
                    inputMode="numeric"
                    maxLength={4}
                    value={form.bankAccountLast4}
                    onChange={(e) =>
                      set({ bankAccountLast4: e.target.value.replace(/\D/g, '').slice(0, 4) })
                    }
                    placeholder="4471"
                  />
                </Field>
              </>
            ) : null}
          </div>

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300"
              checked={form.midYear}
              onChange={(e) => set({ midYear: e.target.checked })}
            />
            <span>
              <span className="font-medium text-slate-900">
                Joined mid-year from another employer
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Their Form TP3 figures — what the old employer already paid and deducted
                this year. Without them the tax formula treats the person as having no
                income before joining, which under-deducts all year.
              </span>
            </span>
          </label>

          {form.midYear ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Gross paid this year (RM)">
                <Input
                  inputMode="decimal"
                  value={form.ytdGrossBefore}
                  onChange={(e) => set({ ytdGrossBefore: e.target.value })}
                />
              </Field>
              <Field label="EPF deducted this year (RM)">
                <Input
                  inputMode="decimal"
                  value={form.ytdEpfBefore}
                  onChange={(e) => set({ ytdEpfBefore: e.target.value })}
                />
              </Field>
              <Field label="PCB deducted this year (RM)">
                <Input
                  inputMode="decimal"
                  value={form.ytdMtdBefore}
                  onChange={(e) => set({ ytdMtdBefore: e.target.value })}
                />
              </Field>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <Button disabled={!ready || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : editing === null ? 'Add to the register' : 'Save changes'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowForm(false);
                setEditing(null);
              }}
            >
              Cancel
            </Button>
          </div>
          <ErrorNote error={save.error} />
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function RunCard() {
  const queryClient = useQueryClient();
  const [payMonth, setPayMonth] = useState(`${todayIso().slice(0, 7)}-01`);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [reverseReason, setReverseReason] = useState('');
  const [employerNo, setEmployerNo] = useState('');
  const [blobError, setBlobError] = useState<unknown>(null);

  const runs = useQuery({
    queryKey: ['pay-runs'],
    queryFn: () => api<{ runs: RunSummary[] }>('/v1/payroll/runs'),
  });

  const detail = useQuery({
    queryKey: ['pay-run', selectedRunId],
    enabled: selectedRunId !== null,
    queryFn: () => api<Run>(`/v1/payroll/runs/${selectedRunId}`),
  });

  const refresh = (runId?: string) => {
    void queryClient.invalidateQueries({ queryKey: ['pay-runs'] });
    if (runId !== undefined) setSelectedRunId(runId);
    void queryClient.invalidateQueries({ queryKey: ['pay-run'] });
  };

  const prepare = useMutation({
    mutationFn: () =>
      api<Run>('/v1/payroll/runs/prepare', { method: 'POST', body: { payMonth } }),
    onSuccess: (run) => refresh(run.id),
  });

  const confirm = useMutation({
    mutationFn: () =>
      api<Run>(`/v1/payroll/runs/${selectedRunId}/confirm`, { method: 'POST', body: {} }),
    onSuccess: () => {
      setConfirming(false);
      refresh();
    },
  });

  const reverse = useMutation({
    mutationFn: () =>
      api<Run>(`/v1/payroll/runs/${selectedRunId}/reverse`, {
        method: 'POST',
        body: { reason: reverseReason.trim() },
      }),
    onSuccess: () => {
      setReversing(false);
      setReverseReason('');
      refresh();
    },
  });

  const saveEmployerNo = useMutation({
    mutationFn: () =>
      api('/v1/payroll/settings', { method: 'PATCH', body: { lhdnEmployerNo: employerNo.trim() } }),
  });

  const openBlob = async (path: string) => {
    setBlobError(null);
    try {
      const url = await apiBlobUrl(path);
      window.open(url, '_blank');
    } catch (error) {
      setBlobError(error);
    }
  };

  /** Saved under the server's own filename — see `apiDownload`. */
  const download = async (path: string, fallbackName: string) => {
    setBlobError(null);
    try {
      await apiDownload(path, fallbackName);
    } catch (error) {
      setBlobError(error);
    }
  };

  const run = detail.data ?? null;

  return (
    <Card title="Run the month">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[180px]">
          <Field label="Pay month">
            <Input
              type="date"
              value={payMonth}
              onChange={(e) => setPayMonth(`${e.target.value.slice(0, 7)}-01`)}
            />
          </Field>
        </div>
        <Button disabled={prepare.isPending} onClick={() => prepare.mutate()}>
          {prepare.isPending ? 'Computing…' : 'Compute the month'}
        </Button>
        <p className="text-xs text-slate-500">
          Computes everyone on the register with their year-to-date carried forward
          automatically. Posts nothing until you confirm.
        </p>
      </div>
      <ErrorNote error={prepare.error} />

      {runs.data && runs.data.runs.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {runs.data.runs.map((summary) => (
            <button
              key={summary.id}
              onClick={() => setSelectedRunId(summary.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${
                summary.id === selectedRunId
                  ? 'bg-slate-900 text-white ring-slate-900'
                  : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              {summary.payMonth.slice(0, 7)} · {summary.status}
            </button>
          ))}
        </div>
      ) : null}

      {run !== null ? (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-semibold text-slate-900">{run.runNo}</span>{' '}
              <span className="text-slate-500">· {run.payMonth.slice(0, 7)}</span>{' '}
              <Badge status={run.status} />
            </p>
            {run.status === 'DRAFT' ? (
              <Button onClick={() => setConfirming((open) => !open)}>Confirm the month</Button>
            ) : null}
            {run.status === 'CONFIRMED' ? (
              <div className="flex flex-wrap gap-2">
                {/*
                  One file, one per page, downloaded under its own name — print
                  it once and hand the pages out. The per-row buttons below stay
                  for reprinting a single slip someone has lost.
                */}
                <Button
                  onClick={() =>
                    void download(
                      `/v1/payroll/runs/${run.id}/payslips/pdf`,
                      `payslips-${run.payMonth.slice(0, 7)}.pdf`,
                    )
                  }
                >
                  Payslips for everyone
                </Button>
                <Button variant="ghost" onClick={() => void openBlob(`/v1/payroll/runs/${run.id}/cp39`)}>
                  CP39 file (LHDN)
                </Button>
                <Button variant="ghost" onClick={() => setReversing((open) => !open)}>
                  Reverse
                </Button>
              </div>
            ) : null}
          </div>

          {confirming && run.status === 'DRAFT' ? (
            <div className="rounded-lg bg-emerald-50 p-3">
              <p className="text-xs text-slate-600">
                This posts to the books: wages as an expense, and what is owed to KWSP,
                PERKESO, LHDN and your staff as payables. It cannot be edited afterwards —
                a mistake is corrected by reversing the whole month.
              </p>
              <div className="mt-2">
                <Button disabled={confirm.isPending} onClick={() => confirm.mutate()}>
                  {confirm.isPending ? 'Posting…' : 'Post it'}
                </Button>
              </div>
            </div>
          ) : null}
          <ErrorNote error={confirm.error} />

          {reversing && run.status === 'CONFIRMED' ? (
            <div className="flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3">
              <div className="min-w-[240px] flex-1">
                <Field label="Why? (kept on the record)">
                  <Input
                    value={reverseReason}
                    onChange={(e) => setReverseReason(e.target.value)}
                    placeholder="Wrong wages keyed for August"
                  />
                </Field>
              </div>
              <Button
                disabled={reverse.isPending || reverseReason.trim() === ''}
                onClick={() => reverse.mutate()}
              >
                Reverse the month
              </Button>
            </div>
          ) : null}
          <ErrorNote error={reverse.error} />
          <ErrorNote error={blobError} />

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2">Staff</th>
                  <th className="pb-2 text-right">Gross</th>
                  <th className="pb-2 text-right">EPF</th>
                  <th className="pb-2 text-right">SOCSO</th>
                  <th className="pb-2 text-right">EIS</th>
                  <th className="pb-2 text-right">PCB</th>
                  <th className="pb-2 text-right">Take-home</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {run.lines.map((line) => (
                  <tr key={line.id} className="border-t border-slate-100">
                    <td className="py-2 font-medium">{line.fullName}</td>
                    <td className="py-2 text-right">{rm(line.gross)}</td>
                    <td className="py-2 text-right">{rm(line.epfEmployee)}</td>
                    <td className="py-2 text-right">
                      {/* Shown combined on the review row; the payslip splits it. */}
                      {rm(line.socsoEmployeeInvalidity)}+{rm(line.socsoEmployeeSkbbk)}
                    </td>
                    <td className="py-2 text-right">{rm(line.eisEmployee)}</td>
                    <td className="py-2 text-right">{rm(line.pcb)}</td>
                    <td className="py-2 text-right font-medium">{rm(line.netPay)}</td>
                    <td className="py-2 text-right">
                      {run.status === 'CONFIRMED' ? (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void download(
                              `/v1/payroll/runs/${run.id}/payslips/${line.id}/pdf`,
                              `payslip-${line.fullName}-${run.payMonth.slice(0, 7)}.pdf`,
                            )
                          }
                        >
                          Payslip
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 rounded-lg bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-5">
            <RemitFigure label="Pay your staff" amount={run.totals.netPay} />
            <RemitFigure label="Pay KWSP (EPF)" amount={run.totals.epf} />
            <RemitFigure label="Pay PERKESO (SOCSO)" amount={run.totals.socso} />
            <RemitFigure label="Pay PERKESO (EIS)" amount={run.totals.eis} />
            <RemitFigure label="Pay LHDN (PCB)" amount={run.totals.pcb} />
          </div>
          <p className="text-xs text-slate-500">
            Statutory payments are generally due by the 15th of the following month —
            confirm the current due dates with each authority. Match the bank payments to
            the payable accounts (2300–2340) in Banking and each balance clears itself.
          </p>

          {run.status === 'CONFIRMED' ? (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[220px]">
                <Field label="LHDN employer number (E no.) — needed for the CP39 file">
                  <Input
                    value={employerNo}
                    inputMode="numeric"
                    onChange={(e) => setEmployerNo(e.target.value)}
                    placeholder="e.g. 9012345678"
                  />
                </Field>
              </div>
              <Button
                variant="ghost"
                disabled={saveEmployerNo.isPending || employerNo.trim() === ''}
                onClick={() => saveEmployerNo.mutate()}
              >
                Save number
              </Button>
              <ErrorNote error={saveEmployerNo.error} />
            </div>
          ) : null}
        </div>
      ) : selectedRunId !== null ? (
        <div className="mt-4">
          <Skeleton />
        </div>
      ) : null}
    </Card>
  );
}

function RemitFigure({ label, amount }: { label: string; amount: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-sm font-semibold text-slate-900">{rm(amount)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface FormE {
  year: number;
  employeeCount: number;
  totals: { grossRemuneration: string; pcb: string };
  rows: { employeeId: string; fullName: string; monthsPaid: number; grossRemuneration: string; pcb: string }[];
}

/**
 * Year-end: the EA sheets and the Form E figures, from the confirmed runs.
 *
 * The EA download is a PREPARATION SHEET — every figure the C.P.8A needs,
 * labelled as not the official form (the official layout is not on file; the
 * provenance note names the exact document that promotes it). Form E's asks
 * are shown on screen because the e-Filing form wants them typed in anyway.
 */
function YearEndCard() {
  const [showYear, setShowYear] = useState(new Date().getFullYear());
  const [error, setError] = useState<unknown>(null);

  const formE = useQuery({
    queryKey: ['form-e', showYear],
    queryFn: () => api<FormE>(`/v1/payroll/years/${showYear}/form-e`),
  });

  const data = formE.data;
  if (!data || data.employeeCount === 0) return null;

  const download = async (path: string, fallbackName: string) => {
    setError(null);
    try {
      await apiDownload(path, fallbackName);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Card title={`Year-end — ${showYear}`}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span>
            <span className="font-semibold">{data.employeeCount}</span> staff paid
          </span>
          <span>
            Gross <span className="font-semibold">{rm(data.totals.grossRemuneration)}</span>
          </span>
          <span>
            PCB remitted <span className="font-semibold">{rm(data.totals.pcb)}</span>
          </span>
          <Button variant="ghost" onClick={() => setShowYear((y) => y - 1)}>
            ← {showYear - 1}
          </Button>
          {showYear < new Date().getFullYear() ? (
            <Button variant="ghost" onClick={() => setShowYear((y) => y + 1)}>
              {showYear + 1} →
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              void download(`/v1/payroll/years/${showYear}/ea/pdf`, `ea-sheets-${showYear}.pdf`)
            }
          >
            EA sheets for everyone
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void download(
                `/v1/payroll/years/${showYear}/form-e/csv`,
                `cp8d-rows-${showYear}.csv`,
              )
            }
          >
            C.P.8D rows (CSV)
          </Button>
        </div>

        <p className="text-xs text-slate-500">
          The EA download is a preparation sheet for the official C.P.8A — every figure,
          summed from the confirmed runs, ready to transcribe. EA to staff by end of
          February; Form E to LHDN by 31 March (both tracked under Compliance).
        </p>
        <ErrorNote error={error} />
      </div>
    </Card>
  );
}
