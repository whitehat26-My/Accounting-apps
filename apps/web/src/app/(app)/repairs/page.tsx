'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Badge, Button, Card, ErrorNote, Field, Input } from '@/components/ui';

/**
 * The workshop queue, plus intake.
 *
 * Intake needs a customer, and a walk-in repair customer usually gives a name
 * and a phone number — so the form creates the contact and the job in two
 * calls, which is what the counter actually does.
 */

interface Job {
  id: string;
  jobNo: string;
  deviceDescription: string;
  reportedFault: string;
  status: string;
  receivedOn: string;
}

export default function RepairsPage() {
  const queryClient = useQueryClient();
  const jobs = useQuery({
    queryKey: ['repairs'],
    queryFn: () => api<{ jobs: Job[] }>('/v1/repairs'),
  });

  const [customer, setCustomer] = useState('');
  const [phone, setPhone] = useState('');
  const [device, setDevice] = useState('');
  const [serial, setSerial] = useState('');
  const [fault, setFault] = useState('');

  const intake = useMutation({
    mutationFn: async () => {
      const contact = await api<{ id: string }>('/v1/contacts', {
        method: 'POST',
        body: { name: customer, isCustomer: true, ...(phone ? { phone } : {}) },
      });
      return api('/v1/repairs', {
        method: 'POST',
        body: {
          contactId: contact.id,
          deviceDescription: device,
          ...(serial ? { deviceSerial: serial } : {}),
          reportedFault: fault,
          receivedOn: todayIso(),
        },
      });
    },
    onSuccess: () => {
      setCustomer('');
      setPhone('');
      setDevice('');
      setSerial('');
      setFault('');
      void queryClient.invalidateQueries({ queryKey: ['repairs'] });
    },
  });

  const open = (jobs.data?.jobs ?? []).filter(
    (j) => !['COLLECTED', 'CANCELLED', 'DECLINED'].includes(j.status),
  );
  const closed = (jobs.data?.jobs ?? []).filter((j) =>
    ['COLLECTED', 'CANCELLED', 'DECLINED'].includes(j.status),
  );

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Repairs</h1>
        <Card title="On the bench">
          {open.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing in the workshop.</p>
          ) : (
            <div className="space-y-2">
              {open.map((job) => (
                <Link
                  key={job.id}
                  href={`/repairs/job?id=${job.id}`}
                  className="block rounded-md border border-slate-100 p-3 hover:border-emerald-500"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {job.jobNo} — {job.deviceDescription}
                    </span>
                    <Badge status={job.status} />
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {displayDate(job.receivedOn)} · {job.reportedFault}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>
        {closed.length > 0 ? (
          <Card title="Finished">
            <div className="space-y-1">
              {closed.slice(0, 10).map((job) => (
                <Link
                  key={job.id}
                  href={`/repairs/job?id=${job.id}`}
                  className="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-slate-50"
                >
                  <span className="text-slate-600">
                    {job.jobNo} — {job.deviceDescription}
                  </span>
                  <Badge status={job.status} />
                </Link>
              ))}
            </div>
          </Card>
        ) : null}
        <BenchProfitCard />
      </div>

      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">&nbsp;</h1>
        <Card title="Take a device in">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              intake.mutate();
            }}
          >
            <Field label="Customer name">
              <Input value={customer} onChange={(e) => setCustomer(e.target.value)} required />
            </Field>
            <Field label="Phone (optional)">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Device">
              <Input
                value={device}
                onChange={(e) => setDevice(e.target.value)}
                required
                placeholder="Acer Aspire 5, silver, with charger"
              />
            </Field>
            <Field label="Device serial (optional)">
              <Input value={serial} onChange={(e) => setSerial(e.target.value)} />
            </Field>
            <Field label="Reported fault">
              <Input
                value={fault}
                onChange={(e) => setFault(e.target.value)}
                required
                placeholder="Does not boot; clicking noise"
              />
            </Field>
            <ErrorNote error={intake.error} />
            <Button type="submit" disabled={intake.isPending} className="w-full">
              {intake.isPending ? 'Saving…' : 'Take in'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

interface RepairProfit {
  jobs: {
    jobNo: string;
    device: string;
    customerName: string;
    collectedOn: string;
    revenue: string;
    partsCost: string;
    margin: string;
    marginBp: number | null;
  }[];
  totals: { revenue: string; partsCost: string; margin: string };
}

/**
 * Is the bench earning its space? Collected jobs for the last 30 days: what
 * each billed ex-tax, what the parts cost off the shelf, and the
 * contribution left for labour. Labour itself is deliberately not costed —
 * the wage is payroll's fixed cost, and per-job spreading would manufacture
 * precision the data does not hold.
 */
function BenchProfitCard() {
  const to = todayIso();
  const from = (() => {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
  })();

  const profit = useQuery({
    queryKey: ['repair-profit', from, to],
    queryFn: () => api<RepairProfit>(`/v1/reports/repair-profit?from=${from}&to=${to}`),
  });
  const data = profit.data;
  if (!data || data.jobs.length === 0) return null;

  return (
    <Card title="The bench, last 30 days">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="pb-2">Job</th>
            <th className="pb-2 text-right">Billed</th>
            <th className="pb-2 text-right">Parts</th>
            <th className="pb-2 text-right">Left over</th>
          </tr>
        </thead>
        <tbody>
          {data.jobs.slice(0, 8).map((job) => (
            <tr key={job.jobNo} className="border-t border-slate-100">
              <td className="py-2">
                <span className="text-xs text-slate-500">{job.jobNo}</span> {job.device}
              </td>
              <td className="py-2 text-right">{rm(job.revenue)}</td>
              <td className="py-2 text-right">{rm(job.partsCost)}</td>
              <td
                className={`py-2 text-right font-medium ${
                  job.margin.startsWith('-') ? 'text-red-600' : ''
                }`}
              >
                {rm(job.margin)}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-200 font-medium">
            <td className="py-2">All collected jobs</td>
            <td className="py-2 text-right">{rm(data.totals.revenue)}</td>
            <td className="py-2 text-right">{rm(data.totals.partsCost)}</td>
            <td className="py-2 text-right">{rm(data.totals.margin)}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-500">
        Ex-tax billing minus parts at their real weighted-average cost. What is left pays
        for the technician's time — the wage itself lives in Payroll.
      </p>
    </Card>
  );
}
