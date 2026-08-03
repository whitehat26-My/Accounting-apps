'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Badge, Button, Card, ErrorNote, Field, Input, Skeleton } from '@/components/ui';
import { can, useMe } from '@/lib/me';

/**
 * Settings: the organisation, its chart of accounts, and its tax codes.
 *
 * Tax rates are effective-dated DATA with a citation, never constants: a new
 * rate here must name the legal instrument it came from, because a
 * plausible-looking wrong rate is worse than an explicit gap.
 */

interface Organisation {
  name: string;
  baseCurrency: string;
  reportingFramework: string;
}

interface GlAccount {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface TaxCode {
  id: string;
  code: string;
  name: string;
  regime: string;
  rates: { rateBasisPoints: number; validFrom: string; validTo: string | null; legislationRef: string | null }[];
}

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;

export default function SettingsPage() {
  const me = useMe();
  const manages = can(me.data, 'org.manage');
  const writesTax = can(me.data, 'tax.write');

  const org = useQuery({
    queryKey: ['organisation'],
    queryFn: () => api<Organisation>('/v1/organisation'),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Settings</h1>

      <Card title="Organisation">
        {org.data ? (
          <div className="grid grid-cols-2 gap-2 text-sm lg:grid-cols-3">
            <div>
              <div className="text-xs text-slate-500">Name</div>
              <div className="font-medium">{org.data.name}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Base currency</div>
              <div className="font-medium">{org.data.baseCurrency}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Reporting framework</div>
              <div className="font-medium">{org.data.reportingFramework}</div>
            </div>
          </div>
        ) : (
          <Skeleton />
        )}
      </Card>

      <ChartCard canAdd={manages} />
      {can(me.data, 'journal.post') ? <OpeningBalancesCard /> : null}
      <TaxCard canAdd={writesTax} />
      <PeriodsCard canLock={can(me.data, 'period.lock')} />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface StatableAccount {
  id: string;
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY';
}

interface ControlledAccount {
  code: string;
  name: string;
  role: string;
  guidance: string;
}

/**
 * Opening balances — where the shop stood the day it started using this.
 *
 * The refused accounts are shown, greyed, with the reason. A form that simply
 * omitted them would enforce the rule; showing them explains it, and the
 * explanation is the part that stops somebody trying to work around it later.
 */
function OpeningBalancesCard() {
  const queryClient = useQueryClient();
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [posted, setPosted] = useState<{ entryNo: string; figure: string; side: string } | null>(null);

  const accounts = useQuery({
    queryKey: ['opening-accounts'],
    queryFn: () =>
      api<{ statable: StatableAccount[]; controlled: ControlledAccount[] }>(
        '/v1/opening-balances/accounts',
      ),
  });

  const post = useMutation({
    mutationFn: () =>
      api<{ entryNo: string; balancingFigure: string; balancingSide: string }>(
        '/v1/opening-balances',
        {
          method: 'POST',
          body: {
            asOfDate,
            balances: Object.entries(amounts)
              .filter(([, amount]) => amount.trim() !== '')
              .map(([accountId, amount]) => ({ accountId, amount: amount.trim() })),
          },
        },
      ),
    onSuccess: (saved) => {
      setPosted({ entryNo: saved.entryNo, figure: saved.balancingFigure, side: saved.balancingSide });
      setAmounts({});
      void queryClient.invalidateQueries();
    },
  });

  const filled = Object.values(amounts).filter((a) => a.trim() !== '').length;

  return (
    <Card title="Opening balances — where the shop stood on day one">
      {accounts.data ? (
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            Nobody starts trading the day they start an accounting system. State what the
            shop already had and owed, and the difference is recorded as accumulated worth —
            you never type the balancing figure, it is worked out.
          </p>

          <Field label="As at (the day before you started using this)">
            <Input
              type="date"
              className="!w-44"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
            />
          </Field>

          <div className="space-y-1.5">
            {accounts.data.statable.map((account) => (
              <div key={account.id} className="flex items-center gap-3">
                <span className="w-14 shrink-0 font-mono text-xs text-slate-400">
                  {account.code}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{account.name}</span>
                <Input
                  className="!w-32 text-right"
                  placeholder="0.00"
                  inputMode="decimal"
                  value={amounts[account.id] ?? ''}
                  onChange={(e) =>
                    setAmounts((all) => ({ ...all, [account.id]: e.target.value }))
                  }
                />
              </div>
            ))}
          </div>

          {accounts.data.controlled.length > 0 ? (
            <div className="space-y-2 rounded-xl bg-slate-50 p-3">
              <p className="text-xs font-medium text-slate-600">
                These three are not entered here, on purpose:
              </p>
              {accounts.data.controlled.map((account) => (
                <div key={account.code} className="text-xs text-slate-500">
                  <span className="font-mono text-slate-400">{account.code}</span>{' '}
                  <span className="font-medium text-slate-600">{account.name}</span>
                  <span> — {account.guidance}</span>
                </div>
              ))}
            </div>
          ) : null}

          <ErrorNote error={post.error} />
          {posted ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
              Recorded as {posted.entryNo}. {rm(posted.figure)} was{' '}
              {posted.side === 'CREDIT' ? 'credited to' : 'debited from'} Opening Balances —
              that is what the shop was worth. If it is not roughly what you expected,
              something above was mistyped.
            </p>
          ) : null}

          <Button onClick={() => post.mutate()} disabled={filled === 0 || post.isPending}>
            {post.isPending ? 'Recording…' : `Record ${filled || ''} opening balance${filled === 1 ? '' : 's'}`}
          </Button>
        </div>
      ) : (
        <Skeleton />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface Period {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED' | 'LOCKED';
  entryCount: number;
}

interface FiscalYear {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  status: string;
  openPeriods: number;
}

/**
 * Periods and the year end.
 *
 * Closing a period stops routine posting into it; locking makes it final;
 * closing the YEAR posts the profit to retained earnings and locks
 * everything. Each is a judgement, so each asks before it acts — and
 * reopening a closed year demands a written reason, which the audit trail
 * keeps forever.
 */
function PeriodsCard({ canLock }: { canLock: boolean }) {
  const queryClient = useQueryClient();
  const [confirmYear, setConfirmYear] = useState<string | null>(null);

  const periods = useQuery({
    queryKey: ['periods'],
    queryFn: () => api<{ periods: Period[] }>('/v1/periods'),
  });
  const years = useQuery({
    queryKey: ['fiscal-years'],
    queryFn: () => api<{ fiscalYears: FiscalYear[] }>('/v1/fiscal-years'),
  });

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: string; reason?: string }) =>
      api(`/v1/periods/${input.id}/status`, {
        method: 'POST',
        body: { status: input.status, ...(input.reason ? { reason: input.reason } : {}) },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['periods'] }),
  });

  const closeYear = useMutation({
    mutationFn: (id: string) => api(`/v1/fiscal-years/${id}/close`, { method: 'POST', body: {} }),
    onSuccess: () => {
      setConfirmYear(null);
      void queryClient.invalidateQueries();
    },
  });

  const reopenYear = useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      api(`/v1/fiscal-years/${input.id}/reopen`, { method: 'POST', body: { reason: input.reason } }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  return (
    <Card title="Periods & year end">
      {periods.data && years.data ? (
        <div className="space-y-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-1">Period</th>
                <th className="pb-1 text-right">Entries</th>
                <th className="pb-1 pl-4">Status</th>
                {canLock ? <th className="pb-1 text-right">Change</th> : null}
              </tr>
            </thead>
            <tbody>
              {periods.data.periods.map((period) => (
                <tr key={period.id} className="border-t border-slate-100">
                  <td className="py-1.5">
                    {period.label}
                    <span className="ml-2 text-xs text-slate-400">
                      {displayDate(period.startDate)} – {displayDate(period.endDate)}
                    </span>
                  </td>
                  <td className="py-1.5 text-right text-slate-500">{period.entryCount}</td>
                  <td className="py-1.5 pl-4">
                    <Badge status={period.status} />
                  </td>
                  {canLock ? (
                    <td className="py-1.5 text-right">
                      {period.status === 'OPEN' ? (
                        <Button variant="ghost" onClick={() => setStatus.mutate({ id: period.id, status: 'CLOSED' })}>
                          Close
                        </Button>
                      ) : period.status === 'CLOSED' ? (
                        <span className="inline-flex gap-1.5">
                          <Button variant="ghost" onClick={() => setStatus.mutate({ id: period.id, status: 'LOCKED' })}>
                            Lock
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              const reason = window.prompt('Why reopen this period? (kept in the audit trail)');
                              if (reason) setStatus.mutate({ id: period.id, status: 'OPEN', reason });
                            }}
                          >
                            Reopen
                          </Button>
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">Final</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <ErrorNote error={setStatus.error} />

          <div className="space-y-2 border-t border-slate-100 pt-3">
            {years.data.fiscalYears.map((year) => (
              <div key={year.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-medium">{year.label}</span>
                  <span className="ml-2 text-xs text-slate-400">
                    {displayDate(year.startDate)} – {displayDate(year.endDate)} · {year.openPeriods} period(s) still open
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge status={year.status} />
                  {canLock && year.status !== 'CLOSED' ? (
                    confirmYear === year.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Button variant="danger" disabled={closeYear.isPending} onClick={() => closeYear.mutate(year.id)}>
                          {closeYear.isPending ? 'Closing…' : 'Yes, close the year'}
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirmYear(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button variant="ghost" onClick={() => setConfirmYear(year.id)}>
                        Close year
                      </Button>
                    )
                  ) : null}
                  {canLock && year.status === 'CLOSED' ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const reason = window.prompt('Why reopen this closed year? (kept in the audit trail)');
                        if (reason) reopenYear.mutate({ id: year.id, reason });
                      }}
                    >
                      Reopen
                    </Button>
                  ) : null}
                </span>
              </div>
            ))}
            {confirmYear ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Closing the year posts this year&apos;s profit to retained earnings and locks every
                period. It can be reopened later, with a reason.
              </p>
            ) : null}
            <ErrorNote error={closeYear.error} />
            <ErrorNote error={reopenYear.error} />
          </div>
        </div>
      ) : (
        <Skeleton />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ChartCard({ canAdd }: { canAdd: boolean }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('EXPENSE');

  const accounts = useQuery({
    queryKey: ['gl-accounts'],
    queryFn: () => api<{ accounts: GlAccount[] }>('/v1/accounts'),
  });

  const create = useMutation({
    mutationFn: () =>
      api('/v1/accounts', { method: 'POST', body: { code, name, type } }),
    onSuccess: () => {
      setCode('');
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['gl-accounts'] });
    },
  });

  const grouped = ACCOUNT_TYPES.map((t) => ({
    type: t,
    accounts: (accounts.data?.accounts ?? []).filter((a) => a.type === t),
  })).filter((g) => g.accounts.length > 0);

  return (
    <Card title="Chart of accounts">
      {accounts.data ? (
        <div className="space-y-3">
          {grouped.map((group) => (
            <div key={group.type}>
              <div className="mb-1 text-xs font-semibold uppercase text-slate-400">
                {group.type}
              </div>
              <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
                {group.accounts.map((a) => (
                  <div key={a.id} className="flex justify-between border-t border-slate-100 py-1 text-sm">
                    <span className="font-mono text-xs text-slate-500">{a.code}</span>
                    <span className="flex-1 px-3">{a.name}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {canAdd ? (
            <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
              <Field label="Code">
                <Input value={code} onChange={(e) => setCode(e.target.value)} className="w-24" placeholder="6300" />
              </Field>
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing" />
              </Field>
              <Field label="Type">
                <select
                  className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-2 text-sm"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                >
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </Field>
              <Button
                onClick={() => create.mutate()}
                disabled={!code.trim() || !name.trim() || create.isPending}
              >
                Add account
              </Button>
              {create.isError ? <ErrorNote error={create.error} /> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <Skeleton />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function TaxCard({ canAdd }: { canAdd: boolean }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [regime, setRegime] = useState('SST_SERVICE');
  const [ratePercent, setRatePercent] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [legislationRef, setLegislationRef] = useState('');

  const taxCodes = useQuery({
    queryKey: ['tax-codes'],
    queryFn: () => api<{ taxCodes: TaxCode[] }>('/v1/tax-codes'),
  });

  const create = useMutation({
    mutationFn: () =>
      api('/v1/tax-codes', {
        method: 'POST',
        body: {
          code,
          name,
          regime,
          inputTreatment: 'COST',
          rates: [{
            // Whole percent → basis points; a select of whole numbers, no float.
            rateBasisPoints: Number(ratePercent) * 100,
            validFrom,
            legislationRef,
          }],
        },
      }),
    onSuccess: () => {
      setCode('');
      setName('');
      setRatePercent('');
      setLegislationRef('');
      void queryClient.invalidateQueries({ queryKey: ['tax-codes'] });
    },
  });

  return (
    <Card title="Tax codes — every rate cites its law">
      {taxCodes.data ? (
        <div className="space-y-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-1">Code</th>
                <th className="pb-1">Name</th>
                <th className="pb-1 text-right">Rate</th>
                <th className="pb-1">From</th>
                <th className="pb-1">Citation</th>
              </tr>
            </thead>
            <tbody>
              {taxCodes.data.taxCodes.flatMap((t) =>
                t.rates.map((r, i) => (
                  <tr key={`${t.id}-${i}`} className="border-t border-slate-100">
                    <td className="py-1.5 font-mono text-xs">{t.code}</td>
                    <td className="py-1.5">{t.name}</td>
                    <td className="py-1.5 text-right">{r.rateBasisPoints / 100}%</td>
                    <td className="py-1.5 text-xs text-slate-500">{displayDate(r.validFrom)}</td>
                    <td className="py-1.5 text-xs text-slate-500">{r.legislationRef ?? '—'}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>

          {canAdd ? (
            <div className="space-y-2 border-t border-slate-100 pt-3">
              <p className="text-xs text-slate-500">
                A new rate must cite the legal instrument it came from (e.g. a gazette
                order). If you are unsure of a rate, ask your tax agent — do not guess.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Code">
                  <Input value={code} onChange={(e) => setCode(e.target.value)} className="w-24" placeholder="SVC8" />
                </Field>
                <Field label="Name">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Service tax 8%" />
                </Field>
                <Field label="Regime">
                  <select
                    className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-2 text-sm"
                    value={regime}
                    onChange={(e) => setRegime(e.target.value)}
                  >
                    <option value="SST_SERVICE">SST — service</option>
                    <option value="SST_SALES">SST — sales</option>
                  </select>
                </Field>
                <Field label="Rate %">
                  <select
                    className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-2 text-sm"
                    value={ratePercent}
                    onChange={(e) => setRatePercent(e.target.value)}
                  >
                    <option value="">—</option>
                    {['5', '6', '8', '10'].map((p) => (
                      <option key={p} value={p}>{p}%</option>
                    ))}
                  </select>
                </Field>
                <Field label="Valid from">
                  <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
                </Field>
                <Field label="Legal citation (min 8 chars)">
                  <Input
                    value={legislationRef}
                    onChange={(e) => setLegislationRef(e.target.value)}
                    placeholder="Service Tax (Rate of Tax) Order …"
                  />
                </Field>
                <Button
                  onClick={() => create.mutate()}
                  disabled={
                    !code.trim() || !name.trim() || ratePercent === '' || !validFrom ||
                    legislationRef.trim().length < 8 || create.isPending
                  }
                >
                  Add tax code
                </Button>
              </div>
              {create.isError ? <ErrorNote error={create.error} /> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <Skeleton />
      )}
    </Card>
  );
}
