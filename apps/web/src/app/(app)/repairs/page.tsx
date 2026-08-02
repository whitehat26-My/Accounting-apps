'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { displayDate, todayIso } from '@/lib/display';
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
        <h1 className="text-xl font-bold">Repairs</h1>
        <Card title="On the bench">
          {open.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing in the workshop.</p>
          ) : (
            <div className="space-y-2">
              {open.map((job) => (
                <Link
                  key={job.id}
                  href={`/repairs/job?id=${job.id}`}
                  className="block rounded-md border border-neutral-100 p-3 hover:border-emerald-500"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {job.jobNo} — {job.deviceDescription}
                    </span>
                    <Badge status={job.status} />
                  </div>
                  <div className="mt-1 text-xs text-neutral-500">
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
                  className="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-neutral-50"
                >
                  <span className="text-neutral-600">
                    {job.jobNo} — {job.deviceDescription}
                  </span>
                  <Badge status={job.status} />
                </Link>
              ))}
            </div>
          </Card>
        ) : null}
      </div>

      <div className="space-y-3">
        <h1 className="text-xl font-bold">&nbsp;</h1>
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
