'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, apiBlobUrl } from '@/lib/api';
import { qty, rm, todayIso } from '@/lib/display';
import { Badge, Button, Card, ErrorNote, Field, Input } from '@/components/ui';

/**
 * One job, driven through its life: quote it, record the approval, mark it
 * ready, collect the money. The buttons only offer what the state machine
 * will accept — but the SERVER decides, and a refusal surfaces verbatim.
 */

interface JobLine {
  lineNo: number;
  description: string;
  quantity: string;
  unitPrice: string;
}

interface Job {
  id: string;
  jobNo: string;
  deviceDescription: string;
  deviceSerial: string | null;
  reportedFault: string;
  diagnosis: string | null;
  status: string;
  approvalNote: string | null;
  invoiceId: string | null;
  lines: JobLine[];
}

interface QuoteDraft {
  description: string;
  quantity: string;
  unitPrice: string;
}

/**
 * Query-param route rather than /repairs/[id]: a dynamic segment cannot be
 * statically exported, and the GitHub Pages demo is a static export. The
 * real deployment renders it identically.
 */
export default function RepairDetailPage() {
  return (
    <Suspense>
      <RepairDetail />
    </Suspense>
  );
}

function RepairDetail() {
  const id = useSearchParams().get('id') ?? '';
  const queryClient = useQueryClient();

  const job = useQuery({
    queryKey: ['repair', id],
    queryFn: () => api<Job>(`/v1/repairs/${id}`),
  });

  const [diagnosis, setDiagnosis] = useState('');
  const [draftLines, setDraftLines] = useState<QuoteDraft[]>([
    { description: '', quantity: '1', unitPrice: '' },
  ]);
  const [approvalNote, setApprovalNote] = useState('');
  const [tendered, setTendered] = useState('');
  const [error, setError] = useState<unknown>(null);

  const refresh = () => {
    setError(null);
    void queryClient.invalidateQueries({ queryKey: ['repair', id] });
    void queryClient.invalidateQueries({ queryKey: ['repairs'] });
  };

  const quote = useMutation({
    mutationFn: () =>
      api(`/v1/repairs/${id}/quote`, {
        method: 'POST',
        body: {
          diagnosis,
          lines: draftLines
            .filter((l) => l.description && l.unitPrice)
            .map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })),
        },
      }),
    onSuccess: refresh,
    onError: setError,
  });

  const transition = useMutation({
    mutationFn: (body: { to: string; reason?: string; approvalNote?: string }) =>
      api(`/v1/repairs/${id}/status`, { method: 'POST', body }),
    onSuccess: refresh,
    onError: setError,
  });

  const collect = useMutation({
    mutationFn: async () => {
      const accounts = await api<{ accounts: { id: string; code: string }[] }>('/v1/accounts');
      const cash = accounts.accounts.find((a) => a.code === '1000');
      if (!cash) throw new Error('No cash account found');
      return api<{ invoiceId: string }>(`/v1/repairs/${id}/collect`, {
        method: 'POST',
        body: {
          collectDate: todayIso(),
          payment: {
            method: 'CASH',
            depositAccountId: cash.id,
            ...(tendered ? { tenderedAmount: tendered } : {}),
          },
        },
      });
    },
    onSuccess: refresh,
    onError: setError,
  });

  const j = job.data;
  if (!j) return null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">
          {j.jobNo} — {j.deviceDescription}
        </h1>
        <Badge status={j.status} />
      </div>

      <Card title="Device">
        <dl className="space-y-1 text-sm">
          {j.deviceSerial ? <Row label="Serial" value={j.deviceSerial} /> : null}
          <Row label="Reported fault" value={j.reportedFault} />
          {j.diagnosis ? <Row label="Diagnosis" value={j.diagnosis} /> : null}
          {j.approvalNote ? <Row label="Approval" value={j.approvalNote} /> : null}
        </dl>
      </Card>

      {j.lines.length > 0 ? (
        <Card title="Quote — agreed prices">
          <table className="w-full text-sm">
            <tbody>
              {j.lines.map((line) => (
                <tr key={line.lineNo} className="border-t border-neutral-100">
                  <td className="py-2">{line.description}</td>
                  <td className="py-2 text-right">{qty(line.quantity)}</td>
                  <td className="py-2 text-right font-medium">{rm(line.unitPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <ErrorNote error={error} />

      {['RECEIVED', 'QUOTED', 'DECLINED'].includes(j.status) ? (
        <Card title={j.status === 'RECEIVED' ? 'Quote this job' : 'Revise the quote'}>
          <div className="space-y-3">
            <Field label="Diagnosis">
              <Input
                value={diagnosis}
                onChange={(e) => setDiagnosis(e.target.value)}
                placeholder="Failed HDD; replace and clone"
              />
            </Field>
            {draftLines.map((line, index) => (
              <div key={index} className="flex gap-2">
                <Input
                  placeholder="Work or part"
                  value={line.description}
                  onChange={(e) =>
                    setDraftLines(draftLines.map((l, i) => (i === index ? { ...l, description: e.target.value } : l)))
                  }
                />
                <Input
                  className="w-16"
                  value={line.quantity}
                  onChange={(e) =>
                    setDraftLines(draftLines.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)))
                  }
                />
                <Input
                  className="w-28"
                  placeholder="Price"
                  value={line.unitPrice}
                  onChange={(e) =>
                    setDraftLines(draftLines.map((l, i) => (i === index ? { ...l, unitPrice: e.target.value } : l)))
                  }
                />
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => setDraftLines([...draftLines, { description: '', quantity: '1', unitPrice: '' }])}
              >
                + line
              </Button>
              <Button disabled={quote.isPending} onClick={() => quote.mutate()}>
                Save quote
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {j.status === 'QUOTED' ? (
        <Card title="Customer decision">
          <div className="space-y-3">
            <Field label="How was the yes given?">
              <Input
                value={approvalNote}
                onChange={(e) => setApprovalNote(e.target.value)}
                placeholder="Approved by WhatsApp, 14:32"
              />
            </Field>
            <div className="flex gap-2">
              <Button onClick={() => transition.mutate({ to: 'APPROVED', approvalNote })}>
                Approved
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const reason = window.prompt('Why was it declined?');
                  if (reason) transition.mutate({ to: 'DECLINED', reason });
                }}
              >
                Declined
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {['APPROVED', 'IN_PROGRESS'].includes(j.status) ? (
        <Button onClick={() => transition.mutate({ to: 'READY' })}>Mark ready for collection</Button>
      ) : null}

      {j.status === 'READY' ? (
        <Card title="Collect — cash">
          <div className="space-y-3">
            <Field label="Cash tendered (optional, for change)">
              <Input value={tendered} onChange={(e) => setTendered(e.target.value)} inputMode="decimal" />
            </Field>
            <Button disabled={collect.isPending} onClick={() => collect.mutate()} className="w-full">
              {collect.isPending ? 'Collecting…' : 'Invoice and take payment'}
            </Button>
          </div>
        </Card>
      ) : null}

      {j.status === 'COLLECTED' && j.invoiceId ? (
        <Button
          variant="ghost"
          onClick={() =>
            void apiBlobUrl(`/v1/invoices/${j.invoiceId}/pdf`)
              .then((url) => window.open(url, '_blank'))
              .catch((e: Error) => window.alert(e.message))
          }
        >
          Print invoice
        </Button>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-neutral-500">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
