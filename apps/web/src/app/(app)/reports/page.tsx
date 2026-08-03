'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { rm, todayIso } from '@/lib/display';
import { Card, Field, Input } from '@/components/ui';

/**
 * The statements: profit or loss, financial position, trial balance.
 *
 * Rendered exactly as the server lays them out — label, indent level, line
 * type, amount string. No figure is computed here; the screen is typesetting.
 */

interface StatementLine {
  label: string;
  level: number;
  lineType: string;
  amount: string;
}

interface TrialBalance {
  rows: { code: string; name: string; debit: string; credit: string }[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}

function firstOfMonth(): string {
  return `${todayIso().slice(0, 8)}01`;
}

export default function ReportsPage() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(todayIso());

  const sopl = useQuery({
    queryKey: ['sopl', from, to],
    queryFn: () => api<{ lines: StatementLine[] }>(`/v1/reports/sopl?from=${from}&to=${to}`),
  });
  const sofp = useQuery({
    queryKey: ['sofp', to],
    queryFn: () => api<{ lines: StatementLine[] }>(`/v1/reports/sofp?asOf=${to}`),
  });
  const tb = useQuery({
    queryKey: ['trial-balance', from, to],
    queryFn: () => api<TrialBalance>(`/v1/reports/trial-balance?from=${from}&to=${to}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-bold">Reports</h1>
        <div className="flex gap-3">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To / as at">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Profit or loss">
          {sopl.data ? <Statement lines={sopl.data.lines} /> : <Loading />}
        </Card>
        <Card title="Financial position">
          {sofp.data ? <Statement lines={sofp.data.lines} /> : <Loading />}
        </Card>
      </div>

      <Card title="Trial balance">
        {tb.data ? (
          <div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-neutral-500">
                  <th className="pb-1">Code</th>
                  <th className="pb-1">Account</th>
                  <th className="pb-1 text-right">Debit</th>
                  <th className="pb-1 text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {tb.data.rows.map((r) => (
                  <tr key={r.code} className="border-t border-neutral-100">
                    <td className="py-1 font-mono text-xs text-neutral-500">{r.code}</td>
                    <td className="py-1">{r.name}</td>
                    <td className="py-1 text-right">{r.debit === '0.0000' ? '' : rm(r.debit)}</td>
                    <td className="py-1 text-right">{r.credit === '0.0000' ? '' : rm(r.credit)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-neutral-300 font-semibold">
                  <td className="py-1.5" colSpan={2}>Totals</td>
                  <td className="py-1.5 text-right">{rm(tb.data.totalDebit)}</td>
                  <td className="py-1.5 text-right">{rm(tb.data.totalCredit)}</td>
                </tr>
              </tbody>
            </table>
            {!tb.data.balanced ? (
              <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
                Debits and credits disagree — this should be impossible; tell your accountant.
              </p>
            ) : null}
          </div>
        ) : (
          <Loading />
        )}
      </Card>
    </div>
  );
}

function Statement({ lines }: { lines: StatementLine[] }) {
  return (
    <div className="text-sm">
      {lines.map((line, i) => (
        <div
          key={`${line.label}-${i}`}
          className={`flex justify-between border-t border-neutral-50 py-1 ${
            line.lineType === 'TOTAL' || line.lineType === 'SUBTOTAL'
              ? 'font-semibold'
              : line.lineType === 'HEADER'
                ? 'pt-3 text-xs font-semibold uppercase text-neutral-400'
                : ''
          }`}
          style={{ paddingLeft: `${line.level * 16}px` }}
        >
          <span>{line.label}</span>
          {line.lineType !== 'HEADER' ? (
            <span className={line.amount.startsWith('-') ? 'text-red-700' : ''}>
              {rm(line.amount)}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Loading() {
  return <p className="text-sm text-neutral-500">Loading…</p>;
}
