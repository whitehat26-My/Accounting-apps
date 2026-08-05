'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Badge, Button, Card, ErrorNote, Input, Skeleton } from '@/components/ui';

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

      <FraudWatchCard />

      <ProofPackCard />

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

// ---------------------------------------------------------------------------

interface Anchor {
  seq: number;
  entryCount: number;
  anchoredAt: string;
  reason: string;
  anchorHash: string;
}

/**
 * Proof packs — the half of tamper-evidence that has to leave the building.
 *
 * The hash chain alone cannot survive an attacker with database owner rights
 * who edits a row and recomputes every hash forward; `audit.ts` has said so
 * since the chain was built. What defeats that is a copy of the anchors in
 * somebody else's hands. So this card's real instruction is the one at the
 * bottom: DOWNLOAD IT AND SEND IT SOMEWHERE.
 */
function ProofPackCard() {
  const queryClient = useQueryClient();
  const [issued, setIssued] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ verdict: string; detail: string } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const anchors = useQuery({
    queryKey: ['audit-anchors'],
    queryFn: () => api<{ anchors: Anchor[] }>('/v1/audit-chain/anchors'),
  });

  const anchorNow = useMutation({
    mutationFn: () => api('/v1/audit-chain/anchors', { method: 'POST', body: {} }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['audit-anchors'] });
      void queryClient.invalidateQueries({ queryKey: ['audit-verify'] });
    },
  });

  const download = async () => {
    setError(null);
    try {
      const pack = await api<Record<string, unknown>>('/v1/audit-chain/proof');
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `proof-pack-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setIssued(String(pack['packHash']).slice(0, 16));
    } catch (e) {
      setError(e);
    }
  };

  const check = async (file: File) => {
    setError(null);
    setChecked(null);
    try {
      const pack = JSON.parse(await file.text()) as unknown;
      const result = await api<{ verdict: string; divergedAt: { reason: string } | null }>(
        '/v1/audit-chain/proof/verify',
        { method: 'POST', body: pack },
      );
      setChecked({
        verdict: result.verdict,
        detail:
          result.verdict === 'CONFIRMED'
            ? 'Every anchor in this pack still matches the books. Nothing was rewritten after it was issued.'
            : result.verdict === 'PACK_ALTERED'
              ? 'This FILE was edited after it was issued — its own hash no longer fits its contents.'
              : (result.divergedAt?.reason ??
                'The books no longer agree with this pack.'),
      });
    } catch (e) {
      setError(e);
    }
  };

  const list = anchors.data?.anchors ?? [];
  const latest = list[list.length - 1];

  return (
    <Card title="Proof pack — books somebody else can check">
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          A proof pack contains your trial balance and every anchor taken on the audit
          chain. Give one to your accountant, your bank or a grant assessor. Months later,
          feeding that same file back here proves nothing in between was rewritten — and
          they can check it themselves, without an account on this system.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void download()}>Download proof pack</Button>
          <label className="cursor-pointer rounded-lg px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
            Check a pack…
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void check(file);
              }}
            />
          </label>
          <Button
            variant="ghost"
            disabled={anchorNow.isPending}
            onClick={() => anchorNow.mutate()}
          >
            Pin the chain now
          </Button>
          <span className="text-xs text-slate-500">
            {latest
              ? `${list.length} anchor(s); last ${displayDate(latest.anchoredAt.slice(0, 10))} at ${latest.entryCount} records`
              : 'No anchors yet — the nightly job takes one, or press “Pin the chain now”.'}
          </span>
        </div>

        {issued ? (
          <p className="text-sm text-emerald-700">
            Pack issued, hash {issued}… — <strong>now send it somewhere</strong>. A pack
            that only ever lives on this machine proves nothing extra.
          </p>
        ) : null}

        {checked ? (
          <p
            className={`rounded-lg px-3 py-2 text-sm ring-1 ring-inset ${
              checked.verdict === 'CONFIRMED'
                ? 'bg-emerald-50 text-emerald-900 ring-emerald-200'
                : 'bg-red-50 text-red-800 ring-red-300'
            }`}
          >
            <strong>{checked.verdict}</strong> — {checked.detail}
          </p>
        ) : null}

        <p className="text-xs text-slate-500">
          Anyone can verify a pack with{' '}
          <code className="rounded bg-slate-100 px-1">
            node scripts/verify-proof-pack.mjs march.json september.json
          </code>{' '}
          — no dependencies, no access to this system, and the hashing algorithm is
          printed inside the pack itself.
        </p>
        <ErrorNote error={error} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface WatchFinding {
  code: string;
  severity: 'NOTE' | 'LOOK' | 'CHECK';
  headline: string;
  innocentExplanation: string;
}

interface Watch {
  window: { from: string; to: string };
  findings: WatchFinding[];
  checksRun: string[];
  duplicates: { party: string; amount: string; documents: string[]; daysApart: number }[];
}

const SEVERITY: Record<WatchFinding['severity'], { band: string; label: string }> = {
  NOTE: { band: 'bg-slate-50 ring-slate-200', label: 'Worth knowing' },
  LOOK: { band: 'bg-amber-50 ring-amber-200', label: 'Worth a look' },
  CHECK: { band: 'bg-red-50 ring-red-200', label: 'Worth checking' },
};

/**
 * The second pair of eyes.
 *
 * Two design rules, both about not being ignored. It never accuses — each
 * finding shows its innocent explanation with the same weight as the
 * suspicion, because a tool that cries fraud at ordinary bookkeeping is off
 * within a week and absent for the case that mattered. And it lists what it
 * CHECKED even when it found nothing, so a clean result reads as "we looked"
 * rather than "nothing ran".
 */
function FraudWatchCard() {
  const to = todayIso();
  const from = `${Number(to.slice(0, 4)) - 1}${to.slice(4)}`;

  const watch = useQuery({
    queryKey: ['fraud-watch', from, to],
    queryFn: () => api<Watch>(`/v1/reports/fraud-watch?from=${from}&to=${to}`),
  });

  const data = watch.data;
  if (!data) return null;

  return (
    <Card title="Second pair of eyes — the last 12 months">
      <div className="space-y-3">
        {data.findings.length === 0 ? (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
            Nothing stood out. These are the same tests an auditor samples for, run over
            everything rather than a sample.
          </p>
        ) : (
          data.findings.map((finding) => {
            const style = SEVERITY[finding.severity];
            return (
              <div
                key={finding.code}
                className={`rounded-lg px-3 py-2 ring-1 ring-inset ${style.band}`}
              >
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {style.label}
                </p>
                <p className="text-sm font-medium text-slate-900">{finding.headline}</p>
                {/* The innocent reading, never smaller than the suspicion. */}
                <p className="mt-1 text-sm text-slate-600">{finding.innocentExplanation}</p>
              </div>
            );
          })
        )}

        {data.duplicates.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-1">Supplier</th>
                <th className="pb-1">Documents</th>
                <th className="pb-1 text-right">Amount</th>
                <th className="pb-1 text-right">Days apart</th>
              </tr>
            </thead>
            <tbody>
              {data.duplicates.map((d) => (
                <tr key={`${d.party}-${d.documents.join()}`} className="border-t border-slate-100">
                  <td className="py-1.5">{d.party}</td>
                  <td className="py-1.5 text-xs text-slate-500">{d.documents.join(' and ')}</td>
                  <td className="py-1.5 text-right font-medium">{rm(d.amount)}</td>
                  <td className="py-1.5 text-right">{d.daysApart}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer">What was checked ({data.checksRun.length})</summary>
          <ul className="mt-1 list-disc pl-5">
            {data.checksRun.map((check) => (
              <li key={check}>{check}</li>
            ))}
          </ul>
        </details>
      </div>
    </Card>
  );
}
