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
  const [accessories, setAccessories] = useState<string[]>([]);
  const [otherAccessory, setOtherAccessory] = useState('');

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
          ...(accessories.length > 0 ? { accessories } : {}),
        },
      });
    },
    onSuccess: () => {
      setCustomer('');
      setPhone('');
      setDevice('');
      setSerial('');
      setFault('');
      setAccessories([]);
      setOtherAccessory('');
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
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Repairs</h1>
        <Card title="On the bench">
          {open.length === 0 ? (
            <p className="text-sm text-ink-muted">Nothing in the workshop.</p>
          ) : (
            <div className="space-y-2">
              {open.map((job) => (
                <Link
                  key={job.id}
                  href={`/repairs/job?id=${job.id}`}
                  className="block rounded-md border border-line p-3 hover:border-positive"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {job.jobNo} — {job.deviceDescription}
                    </span>
                    <Badge status={job.status} />
                  </div>
                  <div className="mt-1 text-xs text-ink-muted">
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
                  className="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-surface-sunken"
                >
                  <span className="text-ink-muted">
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
        <h1 className="text-2xl font-semibold tracking-tight text-ink">&nbsp;</h1>
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
            <AccessoryPicker
              chosen={accessories}
              onChange={setAccessories}
              other={otherAccessory}
              onOther={setOtherAccessory}
            />

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

/**
 * What came in with the device.
 *
 * ---------------------------------------------------------------------------
 * TICKED, NOT TYPED — AND THAT IS THE WHOLE DESIGN.
 *
 * "I gave you the charger" is the second most common repair dispute after
 * "that scratch was not there", and unlike the scratch a photograph of the
 * laptop does not answer it. It is only ever answered by a list agreed at the
 * counter while both people are standing there.
 *
 * A free-text box would not get filled in, because typing "Charger" while a
 * customer waits is friction and the counter will skip it. Six taps that cover
 * nine intakes out of ten will not be skipped. The tenth gets the box.
 * ---------------------------------------------------------------------------
 */
const COMMON_ACCESSORIES = [
  'Charger',
  'Battery',
  'Bag / sleeve',
  'SIM card',
  'Memory card',
  'Cable',
] as const;

function AccessoryPicker({
  chosen, onChange, other, onOther,
}: {
  chosen: string[];
  onChange: (next: string[]) => void;
  other: string;
  onOther: (value: string) => void;
}) {
  const toggle = (item: string) =>
    onChange(chosen.includes(item) ? chosen.filter((c) => c !== item) : [...chosen, item]);

  const addOther = () => {
    const trimmed = other.trim();
    // Twenty is the CHECK on the column; stopping here means the counter finds
    // out now rather than losing the whole intake form to a 422.
    if (!trimmed || chosen.includes(trimmed) || chosen.length >= 20) return;
    onChange([...chosen, trimmed]);
    onOther('');
  };

  const custom = chosen.filter((c) => !COMMON_ACCESSORIES.includes(c as never));

  return (
    <div>
      <div className="text-xs font-medium text-ink-muted">Came in with it</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {COMMON_ACCESSORIES.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => toggle(item)}
            aria-pressed={chosen.includes(item)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              chosen.includes(item)
                ? 'bg-ink text-surface'
                : 'bg-surface-sunken text-ink-muted hover:bg-line'
            }`}
          >
            {item}
          </button>
        ))}
        {custom.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => toggle(item)}
            aria-pressed
            className="rounded-full bg-ink px-3 py-1 text-xs font-medium text-surface"
          >
            {item} ✕
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Input
          value={other}
          onChange={(e) => onOther(e.target.value)}
          placeholder="Anything else"
          maxLength={60}
          // Enter would otherwise submit the intake form and take the device
          // in with the accessory still sitting unadded in this box.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addOther();
            }
          }}
        />
        <Button variant="ghost" onClick={addOther} disabled={!other.trim()}>
          Add
        </Button>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Printed on the receipt the customer takes away — it is what settles “I gave you the
        charger”.
      </p>
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
          <tr className="text-left text-xs text-ink-muted">
            <th className="pb-2">Job</th>
            <th className="pb-2 text-right">Billed</th>
            <th className="pb-2 text-right">Parts</th>
            <th className="pb-2 text-right">Left over</th>
          </tr>
        </thead>
        <tbody>
          {data.jobs.slice(0, 8).map((job) => (
            <tr key={job.jobNo} className="border-t border-line">
              <td className="py-2">
                <span className="text-xs text-ink-muted">{job.jobNo}</span> {job.device}
              </td>
              <td className="py-2 text-right">{rm(job.revenue)}</td>
              <td className="py-2 text-right">{rm(job.partsCost)}</td>
              <td
                className={`py-2 text-right font-medium ${
                  job.margin.startsWith('-') ? 'text-negative' : ''
                }`}
              >
                {rm(job.margin)}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-line font-medium">
            <td className="py-2">All collected jobs</td>
            <td className="py-2 text-right">{rm(data.totals.revenue)}</td>
            <td className="py-2 text-right">{rm(data.totals.partsCost)}</td>
            <td className="py-2 text-right">{rm(data.totals.margin)}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-muted">
        Ex-tax billing minus parts at their real weighted-average cost. What is left pays
        for the technician's time — the wage itself lives in Payroll.
      </p>
    </Card>
  );
}
