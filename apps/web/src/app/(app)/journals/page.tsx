'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Badge, Button, Card, ErrorNote, Field, Input, Skeleton } from '@/components/ui';
import { can, useMe } from '@/lib/me';

/**
 * Manual journals: the accountant's screen.
 *
 * The form deliberately shows NO running total. Summing the lines is
 * arithmetic, arithmetic belongs to the server, and the server's validator
 * answers unbalanced entries with the exact violation — which this screen
 * relays verbatim. A client-side total that disagreed with the server's would
 * be worse than none.
 *
 * Two small assists on the default two-line entry, both explained on the
 * form itself:
 *
 *   - The AMOUNT mirrors between the two lines as you type. This is not a
 *     guess — a two-line entry has exactly one debit and one credit, so they
 *     must be equal, and the server would refuse anything else anyway.
 *   - The OTHER ACCOUNT is suggested from this tenant's own posting history
 *     (`GET /v1/journals/suggest-pair`) the moment the first account is
 *     picked, if the other side is still blank. It is a fact about how this
 *     shop has posted before, not a hardcoded "rent usually means cash" rule —
 *     a new tenant with no history simply gets no suggestion.
 *
 * Both stop applying the moment a third line is added — from there the split
 * is the user's judgement, not a pattern to auto-complete.
 *
 * The journal book below is `GET /v1/reports/journal` typeset: every posted
 * entry in the window, both sides shown, bounded by entry.
 */

interface GlAccount {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface JournalEntry {
  entryId: string;
  entryNo: string;
  entryDate: string;
  description: string | null;
  sourceModule: string;
  status: string;
  reversalOfId: string | null;
  lines: { accountCode: string; accountName: string; description: string | null; debit: string; credit: string }[];
  totalDebit: string;
  totalCredit: string;
}

interface FormLine {
  accountId: string;
  side: 'DEBIT' | 'CREDIT';
  amount: string;
}

const MODULES = ['ALL', 'MANUAL', 'SALES', 'PURCHASES', 'BANKING', 'SYSTEM'] as const;

function firstOfMonth(): string {
  return `${todayIso().slice(0, 8)}01`;
}

export default function JournalsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const posts = can(me.data, 'journal.post');

  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(todayIso());
  const [module, setModule] = useState<(typeof MODULES)[number]>('ALL');

  const [entryDate, setEntryDate] = useState(todayIso());
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<FormLine[]>([
    { accountId: '', side: 'DEBIT', amount: '' },
    { accountId: '', side: 'CREDIT', amount: '' },
  ]);
  const [posted, setPosted] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<{ accounts: GlAccount[] }>('/v1/accounts'),
  });

  const book = useQuery({
    queryKey: ['journal-book', from, to, module],
    queryFn: () =>
      api<{ entries: JournalEntry[]; truncated: boolean }>(
        `/v1/reports/journal?from=${from}&to=${to}${module === 'ALL' ? '' : `&sourceModule=${module}`}`,
      ),
  });

  const post = useMutation({
    mutationFn: () =>
      api<{ entryNo: string }>('/v1/journals', {
        method: 'POST',
        body: {
          entryDate,
          ...(description ? { description } : {}),
          lines: lines
            .filter((l) => l.accountId && l.amount)
            .map((l) => ({ accountId: l.accountId, side: l.side, amount: l.amount })),
        },
      }),
    onSuccess: (saved) => {
      setPosted(saved.entryNo);
      setDescription('');
      setLines([
        { accountId: '', side: 'DEBIT', amount: '' },
        { accountId: '', side: 'CREDIT', amount: '' },
      ]);
      void queryClient.invalidateQueries({ queryKey: ['journal-book'] });
    },
  });

  /**
   * A two-line entry has exactly one debit and one credit, which MUST be
   * equal — so mirroring the amount the user just typed onto the other line
   * is not a guess, it is the only value that entry can ever balance with.
   * The moment a third line exists, the split is a judgement call again and
   * this stops.
   */
  const setLine = (i: number, patch: Partial<FormLine>) =>
    setLines((all) => {
      const next = all.map((l, j) => (j === i ? { ...l, ...patch } : l));
      if (patch.amount !== undefined && next.length === 2) {
        const other = i === 0 ? 1 : 0;
        next[other] = { ...next[other]!, amount: patch.amount };
      }
      return next;
    });

  /**
   * The account was just picked on line `i`. If this is still the simple
   * two-line form and the OTHER line has no account yet, ask what has paired
   * with this one before and fill it in — the user can always change it.
   */
  async function chooseAccount(i: number, accountId: string) {
    setLine(i, { accountId });
    if (lines.length !== 2) return;
    const other = i === 0 ? 1 : 0;
    if (lines[other]!.accountId !== '') return;

    setSuggesting(true);
    try {
      const { suggestion } = await api<{
        suggestion: { accountId: string; code: string; name: string; occurrences: number } | null;
      }>(`/v1/journals/suggest-pair?accountId=${accountId}&side=${lines[i]!.side}`);
      if (suggestion) setLine(other, { accountId: suggestion.accountId });
    } catch {
      // No suggestion is a perfectly normal answer — a brand new tenant has no
      // history to mine, and the form works exactly as well without one.
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Journals</h1>

      {posts ? (
        <Card title="New manual journal — accruals, prepayments, corrections">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setPosted(null);
              post.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Entry date">
                <Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} required />
              </Field>
              <Field label="Description (why this entry exists)">
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. August rent accrual"
                />
              </Field>
            </div>

            <div className="space-y-2">
              {lines.map((line, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <select
                    className="min-w-0 flex-1 rounded-lg border-0 bg-surface-raised px-3 py-2 text-sm shadow-sm ring-1 ring-inset ring-line-strong focus:ring-2 focus:ring-positive"
                    value={line.accountId}
                    onChange={(e) => void chooseAccount(i, e.target.value)}
                    required
                  >
                    <option value="">Account…</option>
                    {(accounts.data?.accounts ?? []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="rounded-lg border-0 bg-surface-raised px-3 py-2 text-sm shadow-sm ring-1 ring-inset ring-line-strong focus:ring-2 focus:ring-positive"
                    value={line.side}
                    onChange={(e) => setLine(i, { side: e.target.value as FormLine['side'] })}
                  >
                    <option value="DEBIT">Debit</option>
                    <option value="CREDIT">Credit</option>
                  </select>
                  <Input
                    className="!w-32 text-right"
                    placeholder="0.00"
                    value={line.amount}
                    onChange={(e) => setLine(i, { amount: e.target.value })}
                    inputMode="decimal"
                    required
                  />
                  {lines.length > 2 ? (
                    <button
                      type="button"
                      aria-label="Remove line"
                      className="text-ink-faint hover:text-negative"
                      onClick={() => setLines((all) => all.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setLines((all) => [...all, { accountId: '', side: 'CREDIT', amount: '' }])}
              >
                + Line
              </Button>
              <Button type="submit" disabled={post.isPending}>
                {post.isPending ? 'Posting…' : 'Post journal'}
              </Button>
            </div>

            <p className="text-xs text-ink-faint">
              {suggesting
                ? 'Checking how you posted this before…'
                : 'Pick the first account and the amount fills both lines; the other account fills itself in from how you posted before, if it has seen the pair. Debits must equal credits — the server checks and will name the exact problem. Posted entries are permanent; a mistake is fixed by a reversing entry.'}
            </p>
            <ErrorNote error={post.error} />
            {posted ? (
              <p className="rounded-lg bg-positive-soft px-3 py-2 text-sm text-positive ring-1 ring-inset ring-positive/30">
                Posted as {posted}.
              </p>
            ) : null}
          </form>
        </Card>
      ) : null}

      <Card
        title="Journal book"
        action={
          <div className="flex items-center gap-2">
            <Input type="date" className="!w-36" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Input type="date" className="!w-36" value={to} onChange={(e) => setTo(e.target.value)} />
            <select
              className="rounded-lg border-0 bg-surface-raised px-2.5 py-2 text-sm shadow-sm ring-1 ring-inset ring-line-strong focus:ring-2 focus:ring-positive"
              value={module}
              onChange={(e) => setModule(e.target.value as (typeof MODULES)[number])}
            >
              {MODULES.map((m) => (
                <option key={m} value={m}>
                  {m === 'ALL' ? 'All sources' : m.charAt(0) + m.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {book.data ? (
          book.data.entries.length > 0 ? (
            <div className="space-y-2">
              {book.data.truncated ? (
                <p className="rounded-md bg-caution-soft px-3 py-2 text-xs text-caution">
                  More entries exist than are shown — narrow the dates.
                </p>
              ) : null}
              {book.data.entries.map((entry) => (
                <details key={entry.entryId} className="rounded-xl ring-1 ring-inset ring-line">
                  <summary className="flex cursor-pointer select-none flex-wrap items-center gap-3 px-3.5 py-2.5 text-sm">
                    <span className="font-mono text-xs text-ink-muted">{entry.entryNo}</span>
                    <span className="text-ink-muted">{displayDate(entry.entryDate)}</span>
                    <span className="min-w-0 flex-1 truncate">{entry.description ?? '—'}</span>
                    <Badge status={entry.sourceModule} />
                    {entry.reversalOfId ? <Badge status="REVERSAL" /> : null}
                    <span className="font-medium">{rm(entry.totalDebit)}</span>
                  </summary>
                  <table className="w-full border-t border-line text-sm">
                    <tbody>
                      {entry.lines.map((line, i) => (
                        <tr key={i} className="border-t border-line">
                          <td className="py-1.5 pl-3.5 font-mono text-xs text-ink-muted">{line.accountCode}</td>
                          <td className="py-1.5">{line.accountName}</td>
                          <td className="py-1.5 text-right">{line.debit === '0.0000' ? '' : rm(line.debit)}</td>
                          <td className="py-1.5 pr-3.5 text-right">
                            {line.credit === '0.0000' ? '' : rm(line.credit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">No entries in this window.</p>
          )
        ) : (
          <Skeleton />
        )}
      </Card>
    </div>
  );
}
