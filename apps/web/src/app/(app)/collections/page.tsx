'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { rm } from '@/lib/display';
import { Button, Card, ErrorNote } from '@/components/ui';
import { can, useMe } from '@/lib/me';

/**
 * Collections: chasing money on a schedule, not a mood.
 *
 * The system composes each reminder with the figures as they were; a human
 * sends it — WhatsApp today — and marks it sent. The escalation ladder
 * (friendly → firm → owner alert) is worked by the daily job or the button
 * here, and the one rule that matters is enforced server-side: a customer is
 * never chased for money they already paid.
 */

interface OverdueRow {
  invoiceId: string;
  invoiceNo: string;
  contactName: string;
  dueDate: string;
  amountDue: string;
  daysOverdue: number;
  highestTierRaised: number;
  queuedReminders: number;
}

interface Reminder {
  id: string;
  invoiceNo: string;
  contactName: string;
  tier: number;
  tone: string;
  message: string;
  amountDue: string;
  daysOverdue: number;
}

const TIER_LABELS = ['—', 'Friendly sent', 'Firm sent', 'Owner alerted'];

export default function CollectionsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const chases = can(me.data, 'collections.chase');

  const overdue = useQuery({
    queryKey: ['collections-overdue'],
    queryFn: () => api<{ overdue: OverdueRow[] }>('/v1/collections/overdue'),
  });

  const reminders = useQuery({
    queryKey: ['collections-reminders'],
    queryFn: () => api<{ reminders: Reminder[] }>('/v1/collections/reminders?status=QUEUED'),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['collections-overdue'] });
    void queryClient.invalidateQueries({ queryKey: ['collections-reminders'] });
  };

  const run = useMutation({
    mutationFn: () => api('/v1/collections/run', { method: 'POST', body: {} }),
    onSuccess: refresh,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Collections</h1>
        {chases ? (
          <Button onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? 'Running…' : 'Run follow-up now'}
          </Button>
        ) : null}
      </div>
      {run.isError ? <ErrorNote error={run.error} /> : null}

      <Card title="Ready to send — copy, WhatsApp, mark sent">
        {reminders.data ? (
          reminders.data.reminders.length > 0 ? (
            <div className="space-y-3">
              {reminders.data.reminders.map((r) => (
                <ReminderRow key={r.id} reminder={r} canSend={chases} onChanged={refresh} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              Queue is empty. Reminders appear here when an invoice crosses day 3, 7 or 14
              overdue — or press “Run follow-up now”.
            </p>
          )
        ) : (
          <p className="text-sm text-slate-500">Loading…</p>
        )}
      </Card>

      <Card title="Everything overdue">
        {overdue.data ? (
          overdue.data.overdue.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2">Invoice</th>
                  <th className="pb-2">Customer</th>
                  <th className="pb-2 text-right">Days late</th>
                  <th className="pb-2 text-right">Amount</th>
                  <th className="pb-2 text-right">Chased</th>
                </tr>
              </thead>
              <tbody>
                {overdue.data.overdue.map((row) => (
                  <tr key={row.invoiceId} className="border-t border-slate-100">
                    <td className="py-2 font-medium">{row.invoiceNo}</td>
                    <td className="py-2 text-slate-600">{row.contactName}</td>
                    <td className="py-2 text-right text-red-600">{row.daysOverdue}</td>
                    <td className="py-2 text-right font-medium">{rm(row.amountDue)}</td>
                    <td className="py-2 text-right text-xs text-slate-500">
                      {TIER_LABELS[row.highestTierRaised] ?? '—'}
                      {row.queuedReminders > 0 ? ' · 1 queued' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-slate-500">
              Nobody is overdue. This page being boring is the goal.
            </p>
          )
        ) : (
          <p className="text-sm text-slate-500">Loading…</p>
        )}
      </Card>
    </div>
  );
}

function ReminderRow({
  reminder,
  canSend,
  onChanged,
}: {
  reminder: Reminder;
  canSend: boolean;
  onChanged: () => void;
}) {
  const markSent = useMutation({
    mutationFn: () =>
      api(`/v1/collections/reminders/${reminder.id}/sent`, {
        method: 'POST',
        body: { channel: 'WHATSAPP' },
      }),
    onSuccess: onChanged,
  });

  const cancel = useMutation({
    mutationFn: () =>
      api(`/v1/collections/reminders/${reminder.id}/cancel`, {
        method: 'POST',
        body: { reason: 'Cancelled from the Collections screen' },
      }),
    onSuccess: onChanged,
  });

  const tone =
    reminder.tone === 'OWNER_ALERT' ? 'bg-red-50' : reminder.tone === 'FIRM' ? 'bg-amber-50' : 'bg-slate-50';

  return (
    <div className={`rounded-md p-3 ${tone}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">
          {reminder.contactName} · {reminder.invoiceNo}
        </span>
        <span className="text-sm font-semibold">{rm(reminder.amountDue)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{reminder.message}</p>
      {canSend ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            onClick={() => {
              void navigator.clipboard?.writeText(reminder.message);
              window.open(`https://wa.me/?text=${encodeURIComponent(reminder.message)}`, '_blank');
            }}
          >
            Copy &amp; open WhatsApp
          </Button>
          <Button onClick={() => markSent.mutate()} disabled={markSent.isPending}>
            Mark sent
          </Button>
          <Button onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            Cancel
          </Button>
        </div>
      ) : null}
      {markSent.isError ? <ErrorNote error={markSent.error} /> : null}
      {cancel.isError ? <ErrorNote error={cancel.error} /> : null}
    </div>
  );
}
