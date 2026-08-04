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
 * Every ringgit shown comes back from `/v1/payroll/employment-cost`, which
 * looks it up in the published EPF, SOCSO and EIS schedules. That is not
 * ceremony about where code lives — the employer's EPF share is 13% up to
 * RM 5,000 and 12% above it, so a field that multiplied by 0.12 in the browser
 * would under-deduct RM 25 a month on a RM 2,500 wage, quietly, and the
 * liability for that is the shop's.
 * ---------------------------------------------------------------------------
 */

interface Breakdown {
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
}

interface CostResult {
  breakdown: Breakdown;
  totalCost: string;
}

/** What each EPF Part means in plain terms, for the line under the result. */
const EPF_PART_MEANING: Record<Breakdown['epfPart'], string> = {
  A: 'Under 60, Malaysian or PR — the full schedule.',
  C: 'Aged 60 or over, permanent resident — reduced, but both sides still pay.',
  E: 'Aged 60 or over, Malaysian citizen — the employer pays, the staff member does not.',
  F: 'Not a citizen or PR — a flat 2% each, with no wage bands at all.',
};

export default function PayrollPage() {
  const [wage, setWage] = useState('2500.00');
  const [age, setAge] = useState('24');
  const [citizenship, setCitizenship] =
    useState<'CITIZEN' | 'PERMANENT_RESIDENT' | 'NON_CITIZEN'>('CITIZEN');
  const [asOf, setAsOf] = useState(todayIso());

  const calculate = useMutation({
    mutationFn: () =>
      api<CostResult>('/v1/payroll/employment-cost', {
        method: 'POST',
        body: {
          wage,
          asOf,
          // The only number this screen sends as a number. An age is a count of
          // years, not money — and the wage beside it stays a string precisely
          // because it is.
          age: Number(age),
          citizenship,
        },
      }),
  });

  const result = calculate.data;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Payroll</h1>

      <Card title="What does this wage cost?">
        <form
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            calculate.mutate();
          }}
        >
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

          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit" disabled={calculate.isPending}>
              {calculate.isPending ? 'Working it out…' : 'Calculate'}
            </Button>
          </div>
        </form>

        <ErrorNote error={calculate.error} />
      </Card>

      {result ? (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="The staff member takes home">
              <p className="text-2xl font-semibold text-slate-900">
                {rm(result.breakdown.wageAfterContributions)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {rm(result.breakdown.wage)} less {rm(result.breakdown.totalEmployee)} in
                statutory deductions.{' '}
                {/*
                  Said outright rather than buried, because a figure labelled
                  "take home" that quietly omits income tax is worse than no
                  figure — it looks finished.
                */}
                <strong className="font-medium text-slate-700">
                  Income tax (PCB) is not included.
                </strong>
              </p>
            </Card>

            <Card title="The shop pays on top">
              <p className="text-2xl font-semibold text-slate-900">
                {rm(result.breakdown.totalEmployer)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Employer EPF, SOCSO and EIS. This never appears on the payslip and is
                the figure most easily forgotten when quoting a salary.
              </p>
            </Card>

            <Card title="Total cost to the shop">
              <p className="text-2xl font-semibold text-slate-900">{rm(result.totalCost)}</p>
              <p className="mt-1 text-xs text-slate-500">
                Wage plus every employer contribution — what actually leaves the bank
                each month for this person.
              </p>
            </Card>
          </div>

          <Card title="Line by line">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2">Contribution</th>
                  <th className="pb-2 text-right">Staff pays</th>
                  <th className="pb-2 text-right">Shop pays</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-slate-100">
                  <td className="py-2">
                    <span className="font-medium">EPF</span>{' '}
                    <span className="text-xs text-slate-500">
                      Third Schedule, Part {result.breakdown.epfPart}
                    </span>
                  </td>
                  <td className="py-2 text-right">{rm(result.breakdown.epf.employee)}</td>
                  <td className="py-2 text-right">{rm(result.breakdown.epf.employer)}</td>
                </tr>
                <tr className="border-t border-slate-100">
                  <td className="py-2">
                    <span className="font-medium">SOCSO</span>{' '}
                    <span className="text-xs text-slate-500">
                      Category {result.breakdown.socsoCategory}
                    </span>
                  </td>
                  <td className="py-2 text-right">{rm(result.breakdown.socso.employee)}</td>
                  <td className="py-2 text-right">{rm(result.breakdown.socso.employer)}</td>
                </tr>
                {/*
                  The SOCSO employee side is two statutory deductions collected
                  together, and PERKESO's own statement splits them. A payslip
                  showing one figure cannot be reconciled against it.
                */}
                <tr className="border-t border-slate-50 text-xs text-slate-500">
                  <td className="py-1 pl-4">— Invalidity</td>
                  <td className="py-1 text-right">
                    {rm(result.breakdown.socso.employeeInvalidity)}
                  </td>
                  <td className="py-1 text-right">—</td>
                </tr>
                <tr className="border-t border-slate-50 text-xs text-slate-500">
                  <td className="py-1 pl-4">— SKBBK (24-hour accident cover)</td>
                  <td className="py-1 text-right">{rm(result.breakdown.socso.employeeSkbbk)}</td>
                  <td className="py-1 text-right">—</td>
                </tr>
                <tr className="border-t border-slate-100">
                  <td className="py-2">
                    <span className="font-medium">EIS</span>{' '}
                    <span className="text-xs text-slate-500">
                      {result.breakdown.eisApplies ? 'Act 800' : 'not covered'}
                    </span>
                  </td>
                  <td className="py-2 text-right">{rm(result.breakdown.eis.employee)}</td>
                  <td className="py-2 text-right">{rm(result.breakdown.eis.employer)}</td>
                </tr>
                <tr className="border-t-2 border-slate-200 font-semibold">
                  <td className="py-2">Total</td>
                  <td className="py-2 text-right">{rm(result.breakdown.totalEmployee)}</td>
                  <td className="py-2 text-right">{rm(result.breakdown.totalEmployer)}</td>
                </tr>
              </tbody>
            </table>

            <p className="mt-3 text-xs text-slate-500">
              {EPF_PART_MEANING[result.breakdown.epfPart]}
            </p>
          </Card>
        </>
      ) : null}

      <Card title="Where these figures come from">
        <ul className="space-y-1.5 text-xs text-slate-500">
          <li>
            <strong className="font-medium text-slate-700">
              Looked up, never calculated.
            </strong>{' '}
            All three schemes are tables in law. The employer&rsquo;s EPF share is 13% up to
            RM 5,000 and 12% above it — so the widely quoted &ldquo;12%&rdquo; is wrong for
            most shop wages, by RM 25 a month on RM 2,500. Under-deducting a statutory
            contribution is the employer&rsquo;s liability, not the staff member&rsquo;s.
          </li>
          <li>
            EPF Third Schedule (1,203 bands), SOCSO under Act 4 including SKBBK from
            1 June 2026, and EIS under Act 800. Every figure traces to the published
            instrument, committed in the repository alongside the code.
          </li>
          <li>
            <strong className="font-medium text-slate-700">PCB is not here yet.</strong>{' '}
            Monthly income tax needs LHDN&rsquo;s calculation specification, which this
            system has not transcribed. Until it does, these are contributions only —
            not net pay.
          </li>
        </ul>
      </Card>
    </div>
  );
}
