'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { rm } from '@/lib/display';
import { Button } from '@/components/ui';

/**
 * The assistant: one floating button on every signed-in screen.
 *
 * Three jobs, in order of trust required:
 *
 *   1. TEACH — the "how to use this screen" content below is STATIC. It works
 *      in the demo, offline, and with no API key, because knowing how your
 *      own software works should not require a model.
 *   2. EVALUATE — chat calls the server, which builds a snapshot from ONLY
 *      what this user's role may see, so the answer cannot leak past the nav.
 *   3. RECORD — catalogue entries happen directly; anything that is money
 *      comes back as a DRAFT CARD, and only the Confirm button on that card —
 *      calling the normal endpoint with this user's own token — posts it.
 *      The assistant cannot spend money; it can only fill in the form.
 */

interface Draft {
  kind: 'INVOICE' | 'CASH_SALE';
  title: string;
  lines: { label: string; amount: string }[];
  endpoint: string;
  payload: Record<string, unknown>;
}

interface Action {
  type: string;
  id: string;
  label: string;
}

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  drafts?: Draft[];
  actions?: Action[];
}

interface ChatResponse {
  configured: boolean;
  message: string;
  actions: Action[];
  drafts: Draft[];
}

/** Per-screen "how to use", keyed by the first path segment. */
const HELP: Record<string, { title: string; steps: string[] }> = {
  '': {
    title: 'Today',
    steps: [
      'The four numbers at the top are the day so far: takings, sales count, cost of goods, gross profit.',
      '"Cash — today and ahead" shows the bank now and 30/60/90 days out, from real due dates only.',
      'Overdue invoices are listed separately — chase them in Collections, they are not counted as arrived.',
      '"Last week" is the weekly digest: green means a normal week, amber lists what to look at.',
    ],
  },
  pos: {
    title: 'Point of sale',
    steps: [
      'Tap items to add them to the sale; tap a line to change quantity.',
      'Pick how the customer pays — cash shows change from the tendered amount.',
      'Ring sale posts everything at once: invoice, stock, cost and the money in.',
      'A serialised item asks for its serial numbers before it can be rung.',
    ],
  },
  repairs: {
    title: 'Repairs',
    steps: [
      'New job: customer, device and the fault as they described it.',
      'Move the job along its statuses — quote it, get approval, start work, mark READY.',
      'COLLECTED asks how they paid and posts the sale, same as the till.',
      'The board shows every open job oldest first, so nothing gets forgotten.',
    ],
  },
  stock: {
    title: 'Stock',
    steps: [
      'Each tracked item shows quantity on hand and its weighted-average cost.',
      'Adjust writes the difference off (or on) with a reason — the reason is kept forever.',
      'Value here should always equal the inventory account; the system checks this.',
    ],
  },
  items: {
    title: 'Items',
    steps: [
      'Everything you sell needs an item: a short code, a name, a price.',
      'GOODS with tracking on means stock is counted; SERVICE (labour) is not.',
      'You can also just tell the assistant: "add Acer laptop A315, sell at 1899, cost 1550".',
    ],
  },
  quotes: {
    title: 'Quotes',
    steps: [
      'Write what a job would cost, before anybody owes anything — a quote posts nothing to the books.',
      'Mark it sent when the customer has it, then record their yes or no. A no needs a reason, and the reason is kept.',
      '"Make it an invoice" is the one button here that touches the books: the customer then owes the money and it appears under Sales.',
      'A no or a lapsed quote can be reopened as a draft and re-priced when they come back.',
    ],
  },
  sales: {
    title: 'Sales',
    steps: [
      'Invoices the shop has issued, newest first — open ones show what is still owed.',
      'Record payment when money arrives; the invoice closes itself when fully paid.',
      'PDF gives the customer copy. Credit fully reverses a wrong invoice with a paper trail.',
    ],
  },
  collections: {
    title: 'Collections',
    steps: [
      'Who owes what, grouped by how late they are.',
      'Run follow-ups queues polite reminders by lateness tier.',
      'Copy & open WhatsApp puts the reminder in the chat, ready to send.',
    ],
  },
  statements: {
    title: 'Statements',
    steps: [
      'The list shows who owes something as at the date you pick — that IS the month\u2019s send list.',
      'Open one to see everything that customer did in the period, with the balance after each line.',
      'Print / PDF gives the copy you post or attach to an email.',
      'Consecutive months join up exactly: one month\u2019s closing balance is the next one\u2019s opening balance.',
    ],
  },
  purchases: {
    title: 'Purchases',
    steps: [
      'Enter supplier bills as they arrive; due dates drive the cash forecast.',
      'A bill above the approval limit waits in Approvals before it can be paid.',
      'Record payment when you actually pay — part payments are fine.',
    ],
  },
  approvals: {
    title: 'Approvals',
    steps: [
      'Bills waiting for an approver, with who entered them and why they are big enough to wait.',
      'Approve or reject with a note; the note is kept in the audit trail.',
    ],
  },
  banking: {
    title: 'Banking',
    steps: [
      'Import the bank statement — CSV, or a Maybank payment advice as-is.',
      'Match each line to the invoice or bill it settles; rules learn repeat lines.',
      'One transfer covering several invoices shows a breakdown — confirm the split in one tap.',
      'When the difference reads RM 0.00, sign off the month.',
    ],
  },
  insights: {
    title: 'Insights',
    steps: [
      'Daily takings for the last two weeks — gaps are days with no sales, which is information too.',
      'Cash runway shows the forecast as a picture.',
    ],
  },
  reports: {
    title: 'Reports',
    steps: [
      'P&L, balance sheet, trial balance and cash flow for any period.',
      'Every report exports to CSV for your accountant.',
      'A report that does not reconcile SAYS SO on its face — never ignore that line.',
    ],
  },
  journals: {
    title: 'Journals',
    steps: [
      'The journal book shows every posted entry — from sales, purchases, banking, or by hand.',
      'A manual journal is for accruals, prepayments and corrections; debits must equal credits.',
      'Posted entries are permanent. A mistake is fixed by a reversing entry, never by editing.',
    ],
  },
  audit: {
    title: 'Audit trail',
    steps: [
      'Every change in the system, with who made it, when, and from where.',
      'The green banner means the log proves itself — a hash chain shows nothing was altered.',
      'Filter by table name or action to answer "who touched this?"',
    ],
  },
  team: {
    title: 'Team',
    steps: [
      'Add a teammate by the email they registered with, and pick their role.',
      'Roles decide what each person sees — the cashier sees the till, not the books.',
    ],
  },
  payroll: {
    title: 'Payroll',
    steps: [
      'Type a monthly wage and it tells you three things: what the staff member takes home, what the shop pays on top, and the true total cost.',
      'The figures are looked up in the EPF, SOCSO and EIS tables — not worked out from a percentage. The employer EPF rate is 13% up to RM 5,000 and 12% above, so the "12%" everyone quotes is wrong for most shop wages.',
      'Set the contribution month if you are working out an earlier one. SKBBK changed the SOCSO deductions from 1 June 2026.',
      'Tick "include income tax" for a real take-home figure. It needs the tax category and what has been paid this year — tax is worked out on the whole year, not the month, so someone who joined in August pays less than a colleague on the same wage since January.',
    ],
  },
  settings: {
    title: 'Settings',
    steps: [
      'The chart of accounts — where each kind of money is filed.',
      'Opening balances: what the shop already had and owed on day one. Do this once, early — without it every report describes only the weeks since you started.',
      'Tax codes with dated rates; changing a rate needs the legal reference.',
      'Periods: close a month so nothing new lands in it; close the year to move profit to retained earnings.',
    ],
  },
};

const QUICK_PROMPTS = [
  'How is my shop doing?',
  'Anything to worry about?',
  'How do I use this screen?',
];

export function Assistant() {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const screen = pathname.split('/')[1] ?? '';
  const help = HELP[screen] ?? HELP['']!;

  const status = useQuery({
    queryKey: ['assistant-status'],
    queryFn: () => api<{ configured: boolean; provider: string }>('/v1/assistant/status'),
    staleTime: 5 * 60_000,
    enabled: open,
  });

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [thread, busy]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    setError(null);
    setInput('');
    const next: ChatEntry[] = [...thread, { role: 'user', content }];
    setThread(next);
    setBusy(true);
    try {
      const reply = await api<ChatResponse>('/v1/assistant/chat', {
        method: 'POST',
        body: {
          // The last few turns are enough context; the server caps at 24.
          messages: next.slice(-12).map((m) => ({ role: m.role, content: m.content })),
          screen: screen || 'today',
        },
      });
      setThread((t) => [
        ...t,
        { role: 'assistant', content: reply.message, drafts: reply.drafts, actions: reply.actions },
      ]);
      if (reply.actions.length > 0) void queryClient.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        aria-label="Open assistant"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 p-3 text-slate-950 shadow-lg shadow-emerald-500/30 transition-transform hover:scale-105"
      >
        <SparkleIcon />
      </button>
    );
  }

  // The drawer floats over the page, which is exactly the case glass is for —
  // the content it covers shows through as a blur, so it reads as sitting on
  // top rather than replacing what is underneath. Solid white stays the
  // fallback where backdrop-filter is unavailable.
  return (
    <div
      className="fixed bottom-5 right-5 z-40 flex max-h-[78vh] w-[min(26rem,calc(100vw-2.5rem))] flex-col
                 overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/10
                 supports-[backdrop-filter]:bg-white/80 supports-[backdrop-filter]:backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-3 bg-slate-950 px-4 py-3 text-white">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 p-1.5 text-slate-950">
            <SparkleIcon />
          </span>
          <div>
            <div className="text-sm font-semibold leading-tight">Assistant</div>
            <div className="text-[11px] text-slate-400">
              {status.data && !status.data.configured
                ? 'Guides only — model not connected'
                : help.title}
            </div>
          </div>
        </div>
        <button
          aria-label="Close assistant"
          onClick={() => setOpen(false)}
          className="rounded-md p-1 text-slate-400 transition-colors hover:text-white"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
            <path d="M4 4l8 8m0-8-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div ref={scroller} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <details className="rounded-xl bg-slate-50 px-3.5 py-2.5 ring-1 ring-inset ring-slate-200" open={thread.length === 0}>
          <summary className="cursor-pointer select-none text-xs font-semibold text-slate-700">
            How to use {help.title}
          </summary>
          <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-slate-600">
            {help.steps.map((step) => (
              <li key={step} className="flex gap-2">
                <span className="mt-0.5 text-emerald-600">•</span>
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </details>

        {status.data && !status.data.configured ? (
          <p className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs leading-relaxed text-amber-900 ring-1 ring-inset ring-amber-200">
            The chat needs the server connected to the model — set ANTHROPIC_API_KEY there and
            restart. The guides above work regardless.
          </p>
        ) : null}

        {thread.length === 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                onClick={() => void send(prompt)}
                className="rounded-full bg-white px-3 py-1.5 text-xs text-slate-600 ring-1 ring-inset ring-slate-300 transition-colors hover:bg-emerald-50 hover:text-emerald-800 hover:ring-emerald-300"
              >
                {prompt}
              </button>
            ))}
          </div>
        ) : null}

        {thread.map((entry, i) => (
          <div key={i} className="space-y-2">
            <div
              className={
                entry.role === 'user'
                  ? 'ml-8 rounded-2xl rounded-br-md bg-emerald-600 px-3.5 py-2 text-sm text-white'
                  : 'mr-4 whitespace-pre-wrap rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-2 text-sm text-slate-800'
              }
            >
              {entry.content}
            </div>
            {entry.actions?.map((action) => (
              <div
                key={action.id}
                className="mr-4 rounded-xl bg-emerald-50 px-3.5 py-2 text-xs text-emerald-900 ring-1 ring-inset ring-emerald-200"
              >
                ✓ {action.label}
              </div>
            ))}
            {entry.drafts?.map((draft, j) => <DraftCard key={j} draft={draft} />)}
          </div>
        ))}

        {busy ? (
          <div className="mr-4 w-fit rounded-2xl rounded-bl-md bg-slate-100 px-3.5 py-2.5">
            <span className="inline-flex gap-1">
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
                  style={{ animationDelay: `${d * 150}ms` }}
                />
              ))}
            </span>
          </div>
        ) : null}

        {error ? (
          <p className="rounded-xl bg-red-50 px-3.5 py-2 text-xs text-red-800 ring-1 ring-inset ring-red-200">
            {error}
          </p>
        ) : null}
      </div>

      <form
        className="flex items-center gap-2 border-t border-slate-100 px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Ask, or say "add item…", "invoice…"'
          className="min-w-0 flex-1 rounded-full bg-slate-100 px-4 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600"
        />
        <button
          type="submit"
          disabled={busy || input.trim().length === 0}
          aria-label="Send"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white transition-colors hover:bg-emerald-700 disabled:bg-slate-300"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
            <path d="M2.5 8h10M9 4.5 13 8l-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
    </div>
  );
}

/**
 * A money draft, waiting for its human. Confirm POSTs the payload the SERVER
 * assembled to the normal endpoint — same permissions, same idempotency, same
 * audit trail as filling the form in by hand.
 */
function DraftCard({ draft }: { draft: Draft }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<'idle' | 'saving' | 'done'>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setState('saving');
    setError(null);
    try {
      let payload = draft.payload;
      if (draft.kind === 'CASH_SALE') {
        // Same deposit-account default the POS screen uses: cash to the cash
        // account, everything else to undeposited funds.
        const { accounts } = await api<{ accounts: { id: string; code: string }[] }>('/v1/accounts');
        const method = draft.payload['method'];
        const target =
          method === 'CASH'
            ? accounts.find((a) => a.code === '1000') ?? accounts[0]
            : accounts.find((a) => a.code === '1200') ?? accounts.find((a) => a.code === '1000');
        if (!target) throw new Error('No deposit account found — check Settings.');
        payload = { ...payload, depositAccountId: target.id };
      }
      const saved = await api<Record<string, unknown>>(draft.endpoint, {
        method: 'POST',
        body: payload,
      });
      const docNo = saved['invoiceNo'] ?? saved['receiptNo'] ?? null;
      setNote(typeof docNo === 'string' ? `Recorded — ${docNo}` : 'Recorded');
      setState('done');
      void queryClient.invalidateQueries();
    } catch (e) {
      setState('idle');
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="mr-4 overflow-hidden rounded-xl ring-1 ring-inset ring-slate-200">
      <div className="flex items-center justify-between bg-slate-50 px-3.5 py-2">
        <span className="text-xs font-semibold text-slate-700">{draft.title}</span>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900">
          {state === 'done' ? 'DONE' : 'DRAFT'}
        </span>
      </div>
      <div className="space-y-1 px-3.5 py-2 text-xs text-slate-600">
        {draft.lines.map((line, i) => (
          <div key={i} className="flex justify-between gap-3">
            <span>{line.label}</span>
            <span className="font-medium text-slate-800">{rm(line.amount)}</span>
          </div>
        ))}
      </div>
      <div className="px-3.5 pb-3">
        {state === 'done' ? (
          <p className="text-xs font-medium text-emerald-700">✓ {note}</p>
        ) : (
          <>
            <Button className="w-full" disabled={state === 'saving'} onClick={() => void confirm()}>
              {state === 'saving' ? 'Saving…' : 'Confirm & save'}
            </Button>
            <p className="mt-1.5 text-[10px] text-slate-400">
              Nothing is recorded until you confirm. Review the lines first.
            </p>
          </>
        )}
        {error ? <p className="mt-1.5 text-xs text-red-700">{error}</p> : null}
      </div>
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-full w-full" aria-hidden="true">
      <path
        d="M8 1.5 9.6 6 14 7.5 9.6 9 8 13.5 6.4 9 2 7.5 6.4 6 8 1.5ZM13 2l.6 1.6L15 4l-1.4.5L13 6l-.5-1.5L11 4l1.5-.4L13 2Z"
        fill="currentColor"
      />
    </svg>
  );
}
