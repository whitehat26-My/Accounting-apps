'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { displayDate } from '@/lib/display';
import { Button, Card, ErrorNote, Field, Input, Skeleton } from '@/components/ui';
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
      <TaxCard canAdd={writesTax} />
    </div>
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
