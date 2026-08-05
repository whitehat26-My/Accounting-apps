'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiBlobUrl } from '@/lib/api';
import { rm, todayIso } from '@/lib/display';
import { Button, Card, ErrorNote, Field, Input, Skeleton } from '@/components/ui';
import { can, useMe } from '@/lib/me';

/**
 * The statements: profit or loss, financial position, trial balance, cash
 * flow, changes in equity — with CSV exports for the accountant.
 *
 * Rendered exactly as the server lays them out — label, indent level, line
 * type, amount string. No figure is computed here; the screen is typesetting.
 * A statement that does not reconcile says so ON ITS FACE, in red, because
 * the number and the doubt must travel together.
 */

interface StatementLine {
  label: string;
  level: number;
  lineType: string;
  amount: string;
}

interface MarginRow {
  itemId: string | null;
  code: string;
  name: string;
  quantitySold: string;
  revenue: string;
  cost: string;
  margin: string;
  marginBp: number | null;
}

interface TrialBalance {
  rows: { code: string; name: string; debit: string; credit: string }[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}

interface CashFlow {
  sections: {
    activity: string;
    subtotal: string;
    lines: { accountId: string; code: string; name: string; amount: string }[];
  }[];
  netCashFlow: string;
  openingCash: string;
  closingCash: string;
  reconciles: boolean;
  difference: string;
  unclassifiedAccounts: { id: string; code: string; name: string }[];
}

interface Equity {
  components: { kind: string; key: string; label: string; opening: string; movement: string; closing: string }[];
  openingEquity: string;
  closingEquity: string;
  consistent: boolean;
}

function firstOfMonth(): string {
  return `${todayIso().slice(0, 8)}01`;
}

export default function ReportsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(todayIso());
  const [exportError, setExportError] = useState<unknown>(null);

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
  const cashFlow = useQuery({
    queryKey: ['cash-flow', from, to],
    queryFn: () => api<CashFlow>(`/v1/reports/cash-flow?from=${from}&to=${to}`),
  });
  const margins = useQuery({
    queryKey: ['item-margins', from, to],
    queryFn: () => api<{ rows: MarginRow[] }>(`/v1/reports/item-margins?from=${from}&to=${to}`),
  });
  const equity = useQuery({
    queryKey: ['equity', from, to],
    queryFn: () => api<Equity>(`/v1/reports/changes-in-equity?from=${from}&to=${to}`),
  });

  const classify = useMutation({
    mutationFn: (input: { accountId: string; classification: string }) =>
      api('/v1/reports/cash-flow/classifications', { method: 'POST', body: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['cash-flow'] }),
  });

  // Fetch with the session attached, then hand the bytes to the browser as a
  // download — a plain <a href> cannot carry the Authorization header.
  async function exportCsv(path: string, filename: string) {
    setExportError(null);
    try {
      const url = await apiBlobUrl(path);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Reports</h1>
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

      {/*
        Worst margin FIRST — the question this table answers is "what am I
        selling for nothing", and burying the giveaway under the good news
        would defeat it. Blank % means zero revenue, not 0%.
      */}
      <Card title="Margin by item — worst first">
        {margins.data && margins.data.rows.length > 0 ? (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2">Item</th>
                  <th className="pb-2 text-right">Qty sold</th>
                  <th className="pb-2 text-right">Revenue</th>
                  <th className="pb-2 text-right">Cost</th>
                  <th className="pb-2 text-right">Margin</th>
                  <th className="pb-2 text-right">%</th>
                </tr>
              </thead>
              <tbody>
                {margins.data.rows.map((row) => (
                  <tr key={row.itemId ?? 'free-text'} className="border-t border-slate-100">
                    <td className="py-2">
                      <span className="text-xs text-slate-500">{row.code}</span> {row.name}
                    </td>
                    <td className="py-2 text-right">{row.quantitySold}</td>
                    <td className="py-2 text-right">{rm(row.revenue)}</td>
                    <td className="py-2 text-right">{rm(row.cost)}</td>
                    <td
                      className={`py-2 text-right font-medium ${
                        row.margin.startsWith('-') ? 'text-red-600' : ''
                      }`}
                    >
                      {rm(row.margin)}
                    </td>
                    <td className="py-2 text-right">
                      {row.marginBp === null ? '—' : `${(row.marginBp / 100).toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {can(me.data, 'report.read') ? (
              <div className="mt-2">
                <Button
                  variant="ghost"
                  onClick={() =>
                    void exportCsv(
                      `/v1/reports/item-margins/csv?from=${from}&to=${to}`,
                      `item-margins-${from}-to-${to}.csv`,
                    )
                  }
                >
                  CSV
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-slate-500">No sales in this period.</p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Cash flow"
          action={
            <Button variant="ghost" onClick={() => void exportCsv(`/v1/reports/cash-flow/export?from=${from}&to=${to}`, `cash-flow-${from}-to-${to}.csv`)}>
              CSV
            </Button>
          }
        >
          {cashFlow.data ? (
            <div className="space-y-3 text-sm">
              {cashFlow.data.sections
                .filter((s) => !(s.activity === 'UNCLASSIFIED' && s.lines.length === 0))
                .map((section) => (
                  <div key={section.activity}>
                    <div className="pt-1 text-xs font-semibold uppercase text-slate-400">
                      {section.activity.charAt(0) + section.activity.slice(1).toLowerCase()}
                    </div>
                    {section.lines.map((line) => (
                      <div key={line.accountId} className="flex justify-between border-t border-slate-50 py-1">
                        <span>
                          <span className="font-mono text-xs text-slate-400">{line.code}</span> {line.name}
                        </span>
                        <span className={line.amount.startsWith('-') ? 'text-red-700' : ''}>{rm(line.amount)}</span>
                      </div>
                    ))}
                    <div className="flex justify-between border-t border-slate-100 py-1 font-semibold">
                      <span>Net</span>
                      <span className={section.subtotal.startsWith('-') ? 'text-red-700' : ''}>{rm(section.subtotal)}</span>
                    </div>
                  </div>
                ))}
              <div className="space-y-1 border-t-2 border-slate-300 pt-2">
                <div className="flex justify-between font-semibold">
                  <span>Net change in cash</span>
                  <span>{rm(cashFlow.data.netCashFlow)}</span>
                </div>
                <div className="flex justify-between text-slate-500">
                  <span>Cash at start</span>
                  <span>{rm(cashFlow.data.openingCash)}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>Cash at end</span>
                  <span>{rm(cashFlow.data.closingCash)}</span>
                </div>
              </div>
              {!cashFlow.data.reconciles ? (
                <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
                  Does NOT reconcile to the movement in cash (off by {rm(cashFlow.data.difference)}). Do not
                  rely on this statement.
                </p>
              ) : null}
              {cashFlow.data.unclassifiedAccounts.length > 0 ? (
                <div className="space-y-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <p>These accounts need a cash flow classification:</p>
                  {cashFlow.data.unclassifiedAccounts.map((account) => (
                    <div key={account.id} className="flex items-center justify-between gap-2">
                      <span>
                        {account.code} {account.name}
                      </span>
                      {can(me.data, 'org.manage') ? (
                        <select
                          className="rounded-md border-0 bg-white px-2 py-1 text-xs shadow-sm ring-1 ring-inset ring-amber-300"
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value)
                              classify.mutate({ accountId: account.id, classification: e.target.value });
                          }}
                        >
                          <option value="">Classify…</option>
                          <option value="OPERATING">Operating</option>
                          <option value="INVESTING">Investing</option>
                          <option value="FINANCING">Financing</option>
                        </select>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <Loading />
          )}
        </Card>

        <Card title="Changes in equity">
          {equity.data ? (
            <div className="overflow-x-auto text-sm">
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 pb-1 text-right text-xs text-slate-500">
                <span className="text-left">Component</span>
                <span>Opening</span>
                <span>Movement</span>
                <span>Closing</span>
              </div>
              {equity.data.components.map((component) => (
                <div
                  key={component.key}
                  className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 border-t border-slate-50 py-1 text-right"
                >
                  <span className="text-left">{component.label}</span>
                  <span className="whitespace-nowrap">{rm(component.opening)}</span>
                  <span className={`whitespace-nowrap ${component.movement.startsWith('-') ? 'text-red-700' : ''}`}>
                    {rm(component.movement)}
                  </span>
                  <span className="whitespace-nowrap">{rm(component.closing)}</span>
                </div>
              ))}
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 border-t-2 border-slate-300 py-1.5 text-right font-semibold">
                <span className="text-left">Total equity</span>
                <span className="whitespace-nowrap">{rm(equity.data.openingEquity)}</span>
                <span />
                <span className="whitespace-nowrap">{rm(equity.data.closingEquity)}</span>
              </div>
              {!equity.data.consistent ? (
                <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-800">
                  The components do not add up to the balance sheet&apos;s equity — tell your accountant.
                </p>
              ) : null}
            </div>
          ) : (
            <Loading />
          )}
        </Card>
      </div>

      <ErrorNote error={exportError} />

      <Card
        title="Trial balance"
        action={
          <Button variant="ghost" onClick={() => void exportCsv(`/v1/reports/trial-balance/export?from=${from}&to=${to}`, `trial-balance-${from}-to-${to}.csv`)}>
            CSV
          </Button>
        }
      >
        {tb.data ? (
          <div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-1">Code</th>
                  <th className="pb-1">Account</th>
                  <th className="pb-1 text-right">Debit</th>
                  <th className="pb-1 text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {tb.data.rows.map((r) => (
                  <tr key={r.code} className="border-t border-slate-100">
                    <td className="py-1 font-mono text-xs text-slate-500">{r.code}</td>
                    <td className="py-1">{r.name}</td>
                    <td className="py-1 text-right">{r.debit === '0.0000' ? '' : rm(r.debit)}</td>
                    <td className="py-1 text-right">{r.credit === '0.0000' ? '' : rm(r.credit)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-300 font-semibold">
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
          className={`flex justify-between border-t border-slate-50 py-1 ${
            line.lineType === 'TOTAL' || line.lineType === 'SUBTOTAL'
              ? 'font-semibold'
              : line.lineType === 'HEADER'
                ? 'pt-3 text-xs font-semibold uppercase text-slate-400'
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
  return <Skeleton />;
}
