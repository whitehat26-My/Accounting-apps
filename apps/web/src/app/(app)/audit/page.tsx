'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { displayDate } from '@/lib/display';
import { Badge, Card, Input, Skeleton } from '@/components/ui';

/**
 * The audit trail: who changed what, when, from where.
 *
 * Read-only by nature — the log is written by database triggers on every
 * mutation and chained with hashes, so this screen can only ever be a window.
 * The chain-verify banner is the point: "the log says X" is only worth
 * something if the log itself can prove nobody edited it.
 */

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorEmail: string | null;
  actorIp: string | null;
  occurredAt: string;
  changed: string[];
}

interface Verify {
  intact: boolean;
  entries: number;
}

const ACTIONS = ['ALL', 'CREATE', 'UPDATE', 'DELETE'] as const;

export default function AuditPage() {
  const [action, setAction] = useState<(typeof ACTIONS)[number]>('ALL');
  const [entityType, setEntityType] = useState('');

  const verify = useQuery({
    queryKey: ['audit-verify'],
    queryFn: () => api<Verify>('/v1/audit-chain/verify'),
    staleTime: 5 * 60_000,
  });

  const trail = useQuery({
    queryKey: ['audit', action, entityType],
    queryFn: () =>
      api<{ entries: AuditEntry[] }>(
        `/v1/audit?limit=100${action === 'ALL' ? '' : `&action=${action}`}${
          entityType ? `&entityType=${encodeURIComponent(entityType.trim())}` : ''
        }`,
      ),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Audit trail</h1>

      {verify.data ? (
        <p
          className={`rounded-xl px-4 py-2.5 text-sm ring-1 ring-inset ${
            verify.data.intact
              ? 'bg-emerald-50 text-emerald-900 ring-emerald-200'
              : 'bg-red-50 text-red-800 ring-red-200'
          }`}
        >
          {verify.data.intact
            ? `Hash chain verified — ${verify.data.entries} record(s), none altered since being written.`
            : 'THE HASH CHAIN IS BROKEN — the log has been tampered with. Preserve the database and involve your accountant immediately.'}
        </p>
      ) : null}

      <Card
        title="Every change, newest first"
        action={
          <div className="flex items-center gap-2">
            <Input
              className="!w-44"
              placeholder="Table, e.g. invoice"
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
            />
            <select
              className="rounded-lg border-0 bg-white px-2.5 py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-emerald-600"
              value={action}
              onChange={(e) => setAction(e.target.value as (typeof ACTIONS)[number])}
            >
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a === 'ALL' ? 'All actions' : a}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {trail.data ? (
          trail.data.entries.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-1">When</th>
                  <th className="pb-1">Who</th>
                  <th className="pb-1">Action</th>
                  <th className="pb-1">Record</th>
                  <th className="pb-1">Fields changed</th>
                </tr>
              </thead>
              <tbody>
                {trail.data.entries.map((entry) => (
                  <tr key={entry.id} className="border-t border-slate-100 align-top">
                    <td className="whitespace-nowrap py-2 text-slate-500">
                      {displayDate(entry.occurredAt.slice(0, 10))}{' '}
                      <span className="text-xs">{entry.occurredAt.slice(11, 16)}</span>
                    </td>
                    <td className="py-2">
                      {entry.actorEmail ?? <span className="text-slate-400">system</span>}
                      {entry.actorIp ? (
                        <div className="text-xs text-slate-400">{entry.actorIp}</div>
                      ) : null}
                    </td>
                    <td className="py-2">
                      <Badge status={entry.action} />
                    </td>
                    <td className="py-2 font-mono text-xs text-slate-600">{entry.entityType}</td>
                    <td className="py-2 text-xs text-slate-500">
                      {entry.changed.length > 0 ? entry.changed.join(', ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-slate-500">Nothing matches these filters.</p>
          )
        ) : (
          <Skeleton />
        )}
      </Card>
    </div>
  );
}
