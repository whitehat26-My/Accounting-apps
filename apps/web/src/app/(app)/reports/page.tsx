'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiBlobUrl, apiDownload } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Badge, Button, Card, ErrorNote, Field, Input, Skeleton } from '@/components/ui';
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

/** The session lives in a header, so the bytes are fetched then handed over. */
async function openReportPdf(path: string) {
  const url = await apiBlobUrl(path);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
      {/* The month-end pack, as paper. The CSVs beside it serve a
          spreadsheet; these serve the folder an accountant is handed. */}
      <Card title="Print for the folder">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 first:border-0 first:pt-0">
            <p className="text-sm text-slate-600">
              <span className="font-medium">Sales day book</span> — every invoice issued
              between {displayDate(from)} and {displayDate(to)}, one line each, with what is
              still owed on it.
            </p>
            <Button
              variant="ghost"
              onClick={() =>
                void openReportPdf(`/v1/reports/sales-day-book/pdf?from=${from}&to=${to}`)
              }
            >
              Print
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
            <p className="text-sm text-slate-600">
              <span className="font-medium">Financial statements</span> — profit or loss for
              the period and the balance sheet at its end, on their own pages. What a bank or
              a grant assessor asks for.
            </p>
            <Button
              variant="ghost"
              onClick={() =>
                void openReportPdf(`/v1/reports/financial-statements/pdf?from=${from}&to=${to}`)
              }
            >
              Print
            </Button>
          </div>
        </div>
      </Card>

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

      <TimeMachineCard from={from} to={to} onExport={exportCsv} />
      <ArchiveCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The hundred-year archive
// ---------------------------------------------------------------------------

interface FiscalYear {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  status: string;
}

/**
 * One file per financial year, meant to outlive this software.
 *
 * The copy that matters is the one somewhere else — a hard disk in a drawer,
 * an email to the accountant — so the card says so rather than implying that
 * pressing the button has finished the job.
 */
function ArchiveCard() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  const years = useQuery({
    queryKey: ['fiscal-years'],
    queryFn: () => api<{ fiscalYears: FiscalYear[] }>('/v1/fiscal-years'),
  });

  const download = async (year: FiscalYear) => {
    setError(null);
    setDone(null);
    setBusy(year.id);
    try {
      await apiDownload(`/v1/reports/archive/${year.id}`, `books-${year.label}.zip`);
      setDone(year.label);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const list = years.data?.fiscalYears ?? [];
  if (list.length === 0) return null;

  return (
    <Card title="Keep a copy that outlives this software">
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          One file per financial year, holding every journal entry, the general ledger, the
          trial balance and the statements — as plain CSV and a PDF, readable without this
          app or any other. The tool that checks the books were not altered travels inside
          the file.
        </p>
        <div className="space-y-1">
          {list.map((year) => (
            <div
              key={year.id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 py-2 text-sm"
            >
              <span>
                <span className="font-medium">{year.label}</span>{' '}
                <span className="text-xs text-slate-500">
                  {displayDate(year.startDate)} – {displayDate(year.endDate)}
                </span>
              </span>
              <div className="flex items-center gap-2">
                <Badge status={year.status} />
                <Button
                  variant="ghost"
                  disabled={busy === year.id}
                  onClick={() => void download(year)}
                >
                  {busy === year.id ? 'Building…' : 'Download'}
                </Button>
              </div>
            </div>
          ))}
        </div>
        {done ? (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
            {done} downloaded. <strong>Now put it somewhere else</strong> — a copy that only
            ever lives on this machine is lost with this machine.
          </p>
        ) : null}
        <ErrorNote error={error} />
        <p className="text-xs text-slate-500">
          Holds the general ledger and the statements built from it. Invoice PDFs, repair
          photographs and customer records are not included and must be exported separately.
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The time machine
// ---------------------------------------------------------------------------

interface LockMoment {
  eventType: string;
  occurredAt: string;
  periodLabel: string | null;
  actorName: string | null;
}

interface Changed {
  since: string;
  until: string;
  unchanged: boolean;
  changes: { accountId: string; code: string; name: string; before: string; after: string; delta: string }[];
  entries: {
    entryNo: string;
    entryDate: string;
    postedAt: string;
    description: string | null;
    sourceModule: string;
    postedByName: string | null;
    kind: 'REVERSAL' | 'BACKDATED' | 'LATER';
  }[];
}

const KIND: Record<Changed['entries'][number]['kind'], { band: string; label: string }> = {
  BACKDATED: {
    band: 'bg-amber-100 text-amber-900',
    // The one worth a person's attention, so it is the one that gets a colour.
    label: 'Backdated into this period',
  },
  REVERSAL: { band: 'bg-slate-100 text-slate-700', label: 'Reversal' },
  LATER: { band: 'bg-slate-100 text-slate-600', label: 'Later trading' },
};

/**
 * "I closed March on 5 April. It is September and the figure is different.
 * What changed, and who changed it?"
 *
 * The ledger here is append-only, so the answer is exact rather than
 * reconstructed — nothing was ever edited, so the books at any past instant
 * are still sitting there. The screen's only real job is to stop asking for a
 * timestamp: nobody knows theirs, so the moments a period was locked or closed
 * are offered by name.
 */
function TimeMachineCard({
  from,
  to,
  onExport,
}: {
  from: string;
  to: string;
  onExport: (path: string, filename: string) => Promise<void>;
}) {
  const [since, setSince] = useState<string>('');

  const moments = useQuery({
    queryKey: ['lock-moments'],
    queryFn: () => api<{ moments: LockMoment[] }>('/v1/reports/lock-moments'),
  });

  const diff = useQuery({
    queryKey: ['what-changed', since, from, to],
    enabled: since !== '',
    queryFn: () =>
      api<Changed>(
        `/v1/reports/what-changed?since=${encodeURIComponent(since)}&from=${from}&to=${to}`,
      ),
  });

  const presets = moments.data?.moments ?? [];

  return (
    <Card title="What changed since you closed the books">
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Pick the moment you last read these figures. Anything posted since then is listed
          below with the person who posted it — including entries <em>dated</em> inside this
          period but keyed afterwards, which is how a month you already reported quietly
          changes.
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Since">
            <select
              className="rounded-lg border-0 bg-white px-3 py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            >
              <option value="">Choose a moment…</option>
              {presets.map((m) => (
                <option key={m.occurredAt} value={m.occurredAt}>
                  {m.eventType === 'PERIOD_LOCKED'
                    ? 'Since you locked'
                    : m.eventType === 'PERIOD_UNLOCKED'
                      ? 'Since you unlocked'
                      : 'Since year-end close'}
                  {m.periodLabel ? ` ${m.periodLabel}` : ''} —{' '}
                  {displayDate(m.occurredAt.slice(0, 10))}
                  {m.actorName ? ` (${m.actorName})` : ''}
                </option>
              ))}
              {/* Always available, so the card is useful before the first lock. */}
              <option value={`${from}T00:00:00+08:00`}>
                Since the start of this period — {displayDate(from)}
              </option>
            </select>
          </Field>
          {since !== '' && diff.data && !diff.data.unchanged ? (
            <Button
              variant="ghost"
              onClick={() =>
                void onExport(
                  `/v1/reports/what-changed/csv?since=${encodeURIComponent(since)}&from=${from}&to=${to}`,
                  `what-changed-${from}-to-${to}.csv`,
                )
              }
            >
              CSV
            </Button>
          ) : null}
        </div>

        {since === '' ? null : diff.isPending ? (
          <Loading />
        ) : diff.data?.unchanged ? (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
            Nothing has changed since then. The figures you reported are still the figures in
            the books.
          </p>
        ) : diff.data ? (
          <div className="space-y-4">
            <div className="overflow-x-auto text-sm">
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 pb-1 text-right text-xs text-slate-500">
                <span className="text-left">Account</span>
                <span>As you read it</span>
                <span>Now</span>
                <span>Change</span>
              </div>
              {diff.data.changes.map((c) => (
                <div
                  key={c.accountId}
                  className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 border-t border-slate-50 py-1 text-right"
                >
                  <span className="text-left">
                    <span className="font-mono text-xs text-slate-400">{c.code}</span> {c.name}
                  </span>
                  <span className="whitespace-nowrap text-slate-500">{rm(c.before)}</span>
                  <span className="whitespace-nowrap">{rm(c.after)}</span>
                  <span
                    className={`whitespace-nowrap font-medium ${
                      c.delta.startsWith('-') ? 'text-red-700' : 'text-emerald-700'
                    }`}
                  >
                    {rm(c.delta)}
                  </span>
                </div>
              ))}
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase text-slate-400">
                The entries responsible
              </p>
              {diff.data.entries.map((e) => (
                <div
                  key={e.entryNo}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-50 py-1.5 text-sm"
                >
                  <span className="font-mono text-xs text-slate-500">{e.entryNo}</span>
                  <span className="flex-1">{e.description ?? '—'}</span>
                  <span className="text-xs text-slate-500">
                    dated {displayDate(e.entryDate)} · posted{' '}
                    {displayDate(e.postedAt.slice(0, 10))} by {e.postedByName ?? 'unknown'}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${KIND[e.kind].band}`}
                  >
                    {KIND[e.kind].label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <ErrorNote error={diff.error} />

        <p className="text-xs text-slate-500">
          This reconstructs the <strong>general ledger</strong>. Invoice statuses, stock
          levels and contact details change in place and are not travelled back — the audit
          trail answers those one record at a time.
        </p>
      </div>
    </Card>
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
