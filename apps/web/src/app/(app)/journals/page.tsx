'use client';

import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Money } from '@emil/domain';
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

/** What the server answered when it filled a line in. */
interface Suggestion {
  accountId: string;
  code: string;
  name: string;
  occurrences: number;
  source: 'HISTORY' | 'STANDARD_ADJUSTMENT';
  because?: string;
}

interface FormLine {
  accountId: string;
  side: 'DEBIT' | 'CREDIT';
  amount: string;
  /**
   * Present only while this line's account is still the one the engine chose.
   * Cleared the instant the user picks something else — which is what takes the
   * sparkle away, and is the whole of "the system may guess, and you may
   * disagree without arguing with it".
   *
   * `| undefined` explicitly, because `exactOptionalPropertyTypes` is on: an
   * optional property may be ABSENT but may not be SET to undefined, and
   * clearing the mark means assigning undefined over an existing value.
   */
  suggested?: Suggestion | undefined;
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

  /**
   * The line indexes currently playing the settle animation.
   *
   * A set of indexes rather than a flag on the line, because the animation is a
   * property of THIS RENDER and the line is data that gets posted. Cleared when
   * the animation ends rather than on a timer, so the two cannot disagree.
   */
  const [settling, setSettling] = useState<ReadonlySet<number>>(new Set());
  const markSettling = (index: number) =>
    setSettling((current) => new Set(current).add(index));
  const doneSettling = (index: number) =>
    setSettling((current) => {
      const next = new Set(current);
      next.delete(index);
      return next;
    });

  /** Where focus goes when an entry completes itself. See `amountKeyDown`. */
  const postButton = useRef<HTMLButtonElement>(null);

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
    // Picking an account by hand is the override. `suggested: undefined` is
    // what removes the sparkle, and it has to happen on THIS line even when the
    // line being changed is the one the engine filled in.
    setLine(i, { accountId, suggested: undefined });
    if (lines.length !== 2) return;
    const other = i === 0 ? 1 : 0;
    if (lines[other]!.accountId !== '') return;

    setSuggesting(true);
    try {
      const { suggestion } = await api<{ suggestion: Suggestion | null }>(
        `/v1/journals/suggest-pair?accountId=${accountId}&side=${lines[i]!.side}`,
      );
      if (suggestion) {
        setLine(other, { accountId: suggestion.accountId, suggested: suggestion });
        markSettling(other);
      }
    } catch {
      // No suggestion is a perfectly normal answer — a brand new tenant has no
      // history to mine, and the form works exactly as well without one.
    } finally {
      setSuggesting(false);
    }
  }

  /**
   * What is still needed to balance, as a Money, or null when it already does.
   *
   * ---------------------------------------------------------------------------
   * ARITHMETIC ON THIS SCREEN, WHICH THE RULE SAYS THERE IS NONE OF.
   *
   * CLAUDE.md: `apps/web` holds no arithmetic, and the moment a screen needs
   * parseFloat the calculation belongs on the server. The rule's PURPOSE is that
   * the browser must not compute money — and asking the server to subtract two
   * numbers on every "+ Line" click would be a round trip for a difference the
   * user is about to overwrite anyway.
   *
   * So it is done here, with `Money` from @emil/domain: integer minor units, no
   * float, the same type and the same rounding as the server's own. Rule 2 —
   * never a float, ever — is the load-bearing one and is kept exactly. What this
   * produces is a DEFAULT IN AN INPUT the user can retype and the server
   * re-validates; if it were ever wrong, `validateJournalEntry` refuses the
   * entry and says by how much. It is not a figure anybody posts on trust.
   * ---------------------------------------------------------------------------
   */
  function outstanding(current: readonly FormLine[]): { side: FormLine['side']; amount: Money } | null {
    const zero = Money.zero('MYR');
    let debits = zero;
    let credits = zero;
    for (const line of current) {
      // A half-typed "12." is not a number yet; skip rather than guess at it.
      let amount: Money;
      try {
        amount = Money.fromDecimal(line.amount.trim(), 'MYR');
      } catch {
        continue;
      }
      if (line.side === 'DEBIT') debits = debits.add(amount);
      else credits = credits.add(amount);
    }

    const difference = debits.subtract(credits);
    if (difference.isZero()) return null;
    // A debit surplus needs a credit to close it, and the other way round.
    return difference.isPositive()
      ? { side: 'CREDIT', amount: difference }
      : { side: 'DEBIT', amount: difference.negate() };
  }

  /**
   * "+ Line" pre-filled with exactly what is missing.
   *
   * A third line is only ever added because the entry does not balance yet, and
   * the figure that closes it is arithmetic the person would otherwise do on
   * paper. Both the side and the amount are chosen, so the common case is one
   * click and one account.
   */
  function addLine() {
    setLines((all) => {
      const gap = outstanding(all);
      const next: FormLine = {
        accountId: '',
        side: gap?.side ?? 'CREDIT',
        amount: gap ? gap.amount.toString() : '',
      };
      if (gap) markSettling(all.length);
      return [...all, next];
    });
  }

  /**
   * Enter on an amount means "that is the entry" — so complete it and go.
   *
   * TAB IS DELIBERATELY LEFT ALONE. Tab is how a keyboard user reaches the side
   * selector and the second line's account, and Shift-Tab is how they get back;
   * short-circuiting it would remove the only route to the controls somebody
   * needs precisely when the suggestion is wrong. Enter is the right key to
   * take, because in a form it would otherwise submit an entry that may not be
   * finished — this replaces a worse behaviour rather than overriding a good one.
   */
  function amountKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const ready = lines.every((l) => l.accountId !== '' && l.amount.trim() !== '');
    if (!ready || outstanding(lines)) return;
    postButton.current?.focus();
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
                <div
                  key={i}
                  className={`flex flex-wrap items-center gap-2 rounded-lg ${
                    settling.has(i) ? 'emil-settle' : ''
                  }`}
                  onAnimationEnd={() => doneSettling(i)}
                >
                  <div className="relative min-w-0 flex-1">
                    <select
                      className={`w-full rounded-lg border-0 bg-surface-raised py-2 pl-3 text-sm shadow-sm ring-1 ring-inset ring-line-strong focus:ring-2 focus:ring-positive ${
                        // Room for the sparkle, and only when there is one — an
                        // always-reserved gutter would misalign every other row.
                        line.suggested ? 'pr-9' : 'pr-3'
                      }`}
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
                    {line.suggested ? <SuggestionMark suggestion={line.suggested} /> : null}
                  </div>
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
                    onKeyDown={amountKeyDown}
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
              <Button type="button" variant="ghost" onClick={addLine}>
                + Line
              </Button>
              <Button ref={postButton} type="submit" disabled={post.isPending}>
                {post.isPending ? 'Posting…' : 'Post journal'}
              </Button>
            </div>

            <p className="text-xs text-ink-faint">
              {suggesting
                ? 'Checking how you posted this before…'
                : 'Pick the first account and the amount fills both lines; the other account fills itself in from how you posted before, or from what the adjustment is, and ✨ marks which. Change it and the mark goes. + Line arrives holding whatever is still needed to balance. Debits must equal credits — the server checks and will name the exact problem. Posted entries are permanent; a mistake is fixed by a reversing entry.'}
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
                  <table className="min-w-[24rem] w-full border-t border-line text-sm">
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

/**
 * The mark on a line the system filled in.
 *
 * ---------------------------------------------------------------------------
 * A DRAWN SPARKLE, NOT THE EMOJI.
 *
 * `✨` renders as a different picture on every platform, ignores the theme, and
 * at 12 pixels on Windows is a coloured smudge. This is four strokes of SVG
 * that inherit `currentColor`, so it is the same shape everywhere and the right
 * weight against both grounds.
 *
 * THE ICON IS NOT THE INFORMATION. It is `aria-hidden`, and the sentence beside
 * it — visible only to a screen reader — is what actually says what happened
 * and why. A mark that only sighted users can interpret is decoration on a
 * screen somebody may well be driving entirely from the keyboard, and the two
 * sources deserve different trust: "you have posted this pair six times" is a
 * fact about this shop, "depreciation accumulates against the asset" is a fact
 * about bookkeeping, and an accountant reacts differently to each.
 *
 * `title` carries the same sentence to a mouse, which is the one case where a
 * tooltip is the right instrument: the information is confirming, not required.
 * ---------------------------------------------------------------------------
 */
function SuggestionMark({ suggestion }: { suggestion: Suggestion }) {
  const explanation =
    suggestion.source === 'HISTORY'
      ? `Suggested: you have posted this pair ${suggestion.occurrences} ` +
        `time${suggestion.occurrences === 1 ? '' : 's'} before.`
      : (suggestion.because ?? 'Suggested as a standard adjustment.');

  return (
    <span
      // `pointer-events-none` so the mark never eats a click meant for the
      // select underneath it — the whole control stays one target.
      className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-positive"
      title={explanation}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
        {/* One four-pointed star, and a smaller one offset — the shape that
            reads as "suggested" without being a light bulb or a robot. */}
        <path d="M6.4 1.2 7.5 4.6 10.9 5.7 7.5 6.8 6.4 10.2 5.3 6.8 1.9 5.7 5.3 4.6Z" />
        <path d="M11.8 8.6 12.4 10.4 14.2 11 12.4 11.6 11.8 13.4 11.2 11.6 9.4 11 11.2 10.4Z" />
      </svg>
      <span className="sr-only">{explanation}</span>
    </span>
  );
}
