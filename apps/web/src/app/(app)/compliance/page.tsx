'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { displayDate } from '@/lib/display';
import { Button, Card, ErrorNote, Skeleton } from '@/components/ui';
import { can, useMe } from '@/lib/me';

/**
 * The compliance calendar: what the shop owes whom, by when, and whether the
 * thing it depends on exists yet.
 *
 * This screen is most of what a monthly retainer buys — remembering. Every
 * row is a real deadline with its legal basis one hover away; payroll rows
 * read the actual pay-run state, so "CP39 due the 15th" stands next to
 * "and your August run is confirmed, the file is ready" or "August was never
 * confirmed — nothing to file FROM". A ⚠ marks deadlines whose primary
 * source is not yet committed (see docs/research/sources) — the system says
 * so instead of looking equally sure about everything.
 */

interface Entry {
  ruleCode: string;
  periodKey: string;
  periodLabel: string;
  dueDate: string;
  label: string;
  description: string;
  legislationRef: string;
  verification: 'PRIMARY' | 'SECONDARY';
  status: 'DONE' | 'OVERDUE' | 'READY' | 'ATTENTION' | 'UPCOMING';
  ticked: { at: string; note: string | null } | null;
}

interface Calendar {
  year: number;
  today: string;
  applies: { payroll: boolean; sst: boolean };
  entries: Entry[];
}

const STATUS_STYLE: Record<Entry['status'], { badge: string; label: string }> = {
  DONE: { badge: 'bg-positive-soft text-positive', label: 'Done' },
  OVERDUE: { badge: 'bg-negative-soft text-negative', label: 'Overdue' },
  READY: { badge: 'bg-brand/10 text-brand', label: 'Ready to file' },
  ATTENTION: { badge: 'bg-caution-soft text-caution', label: 'Needs attention' },
  UPCOMING: { badge: 'bg-surface-sunken text-ink-muted', label: 'Upcoming' },
};

export default function CompliancePage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [year, setYear] = useState(new Date().getFullYear());

  const calendar = useQuery({
    queryKey: ['compliance', year],
    queryFn: () => api<Calendar>(`/v1/compliance/calendar?year=${year}`),
  });

  const tick = useMutation({
    mutationFn: (input: { ruleCode: string; periodKey: string; undo: boolean }) =>
      input.undo
        ? api('/v1/compliance/ticks', {
            method: 'DELETE',
            body: { ruleCode: input.ruleCode, periodKey: input.periodKey },
          })
        : api('/v1/compliance/ticks', {
            method: 'POST',
            body: { ruleCode: input.ruleCode, periodKey: input.periodKey },
          }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['compliance'] }),
  });

  const data = calendar.data;
  const canManage = can(me.data, 'compliance.manage');

  // Group by due month for scanning; the year is a list you walk down.
  const groups = new Map<string, Entry[]>();
  for (const entry of data?.entries ?? []) {
    const month = entry.dueDate.slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), entry]);
  }

  const next = data?.entries.find((e) => e.status !== 'DONE' && e.dueDate >= data.today);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Compliance</h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setYear((y) => y - 1)}>
            ← {year - 1}
          </Button>
          <span className="text-lg font-semibold">{year}</span>
          <Button variant="ghost" onClick={() => setYear((y) => y + 1)}>
            {year + 1} →
          </Button>
        </div>
      </div>

      {next ? (
        <Card>
          <p className="text-sm">
            <span className="font-semibold text-ink">Next: {next.label}</span>{' '}
            <span className="text-ink-muted">
              for {next.periodLabel} — due {displayDate(next.dueDate)}.
            </span>
          </p>
        </Card>
      ) : null}

      {data && !data.applies.payroll ? (
        <p className="text-sm text-ink-muted">
          Payroll deadlines (EPF, SOCSO/EIS, PCB, EA, Form E) will appear once staff are on
          the register under Payroll.
        </p>
      ) : null}
      {data && !data.applies.sst ? (
        <p className="text-sm text-ink-muted">
          SST deadlines are hidden because no SST number is set — add it under Settings if
          the shop is registered.
        </p>
      ) : null}

      {!data ? <Skeleton /> : null}

      {[...groups.entries()].map(([month, entries]) => (
        <Card key={month} title={monthTitle(month)}>
          <table className="w-full text-sm">
            <tbody>
              {entries.map((entry) => {
                const style = STATUS_STYLE[entry.status];
                return (
                  <tr
                    key={`${entry.ruleCode}-${entry.periodKey}`}
                    className="border-t border-line"
                  >
                    <td className="w-24 py-2 text-xs font-medium text-ink-muted">
                      {displayDate(entry.dueDate)}
                    </td>
                    <td className="py-2">
                      <div className="font-medium text-ink">
                        {entry.label}
                        {entry.verification === 'SECONDARY' ? (
                          <span
                            className="ml-1 cursor-help text-caution"
                            title="Deadline confirmed from the agency's own page, but the primary document is not yet on file — see docs/research/sources."
                          >
                            ⚠
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-ink-muted" title={entry.legislationRef}>
                        {entry.periodLabel} — {entry.description}
                      </div>
                      {entry.ticked ? (
                        <div className="text-xs text-positive">
                          Marked done {displayDate(entry.ticked.at.slice(0, 10))}
                          {entry.ticked.note ? ` — ${entry.ticked.note}` : ''}
                        </div>
                      ) : null}
                    </td>
                    <td className="w-32 py-2 text-right">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${style.badge}`}
                      >
                        {style.label}
                      </span>
                    </td>
                    {canManage ? (
                      <td className="w-24 py-2 text-right">
                        <Button
                          variant="ghost"
                          disabled={tick.isPending}
                          onClick={() =>
                            tick.mutate({
                              ruleCode: entry.ruleCode,
                              periodKey: entry.periodKey,
                              undo: entry.status === 'DONE',
                            })
                          }
                        >
                          {entry.status === 'DONE' ? 'Undo' : 'Mark done'}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ))}

      <ErrorNote error={tick.error} />
      <p className="text-xs text-ink-muted">
        Every mark here is recorded with who and when, in the audit trail. Hover a deadline
        for its legal basis.
      </p>
    </div>
  );
}

function monthTitle(isoMonth: string): string {
  const [year, month] = isoMonth.split('-');
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${names[Number(month) - 1]} ${year}`;
}
