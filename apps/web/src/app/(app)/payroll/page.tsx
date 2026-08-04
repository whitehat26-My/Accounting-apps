'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button, Card, ErrorNote, Field, Input } from '@/components/ui';
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

export default function PayrollPage() {
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

  const calculate = useMutation({
    mutationFn: () =>
      api<Payslip>(withTax ? '/v1/payroll/payslip' : '/v1/payroll/contributions', {
        method: 'POST',
        body: {
          wage,
          asOf,
          // The only numbers this screen sends as numbers. An age and a child
          // count are counts, not money — and the wage beside them stays a
          // string precisely because it is money.
          age: Number(age),
          citizenship,
          ...(withTax
            ? {
                tax: {
                  // A foreign worker on a contract of 182 days or more is
                  // resident for tax; a shorter posting is a flat 30%. The shop
                  // knows which, so the citizenship field is not overloaded to
                  // guess it.
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
        },
      }),
  });

  const result = calculate.data;
  // Normalised once — see the note on `Payslip`.
  const pcb: Pcb | null = result?.pcb ?? null;
  const netPay: string | null = result?.netPay ?? null;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Payroll</h1>

      <Card title="What does this wage cost?">
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
            </div>
          ) : null}

          <Button type="submit" disabled={calculate.isPending}>
            {calculate.isPending ? 'Working it out…' : 'Calculate'}
          </Button>
        </form>

        <ErrorNote error={calculate.error} />
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
            This is a calculator, not a payroll run: it keeps no employee records, files
            nothing, and posts nothing to the accounts.
          </li>
        </ul>
      </Card>
    </div>
  );
}
