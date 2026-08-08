'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, apiBlobUrl } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Button, Card, ErrorNote, Field, Input, Skeleton } from '@/components/ui';

/**
 * Customer statements: everything one customer did, and what they owe now.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE IS STORED, AND THAT IS THE FEATURE.
 *
 * A statement is reconstructed from the invoices, payments and credit notes
 * every time it is asked for, so re-running last March next year still shows
 * last March. Storing one would create a second copy of the truth — and the
 * copy is the one people would print.
 *
 * The screen leads with WHO OWES SOMETHING rather than with a customer picker,
 * because "run this month's statements" is the actual task and working out the
 * list by hand is most of the work.
 * ---------------------------------------------------------------------------
 */

interface Owing {
  id: string;
  name: string;
  balance: string;
}

interface StatementEntry {
  date: string;
  type: 'INVOICE' | 'PAYMENT' | 'CREDIT_NOTE';
  reference: string;
  detail: string | null;
  charge: string | null;
  credit: string | null;
  balance: string;
  dueDate: string | null;
}

interface Statement {
  contact: { id: string; name: string; email: string | null };
  from: string;
  to: string;
  currency: string;
  openingBalance: string;
  entries: StatementEntry[];
  closingBalance: string;
  overdue: string;
}

/** The first day of the month `to` falls in — the default a shop actually wants. */
function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export default function StatementsPage() {
  const [to, setTo] = useState(todayIso());
  const [from, setFrom] = useState(startOfMonth(todayIso()));
  const [selected, setSelected] = useState<string | null>(null);
  const [printError, setPrintError] = useState<unknown>(null);

  const owing = useQuery({
    queryKey: ['statement-customers', to],
    queryFn: () => api<{ customers: Owing[] }>(`/v1/statements?asOf=${to}`),
  });

  const statement = useQuery({
    queryKey: ['statement', selected, from, to],
    // Only asked for once a customer is chosen — the list above is the landing
    // view, and fetching a statement nobody selected is work for nothing.
    enabled: selected !== null,
    queryFn: () =>
      api<Statement>(`/v1/statements/${selected}?from=${from}&to=${to}`),
  });

  const print = async () => {
    setPrintError(null);
    try {
      const url = await apiBlobUrl(`/v1/statements/${selected}/pdf?from=${from}&to=${to}`);
      window.open(url, '_blank');
    } catch (error) {
      setPrintError(error);
    }
  };

  const customers = owing.data?.customers ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Statements</h1>

      <Card title="Period">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setFrom(startOfMonth(e.target.value));
              }}
            />
          </Field>
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          Both dates are included. Consecutive months join up exactly — one month&rsquo;s
          closing balance is the next one&rsquo;s opening balance, so nothing falls
          between two statements.
        </p>
      </Card>

      <Card title={`Who owes something as at ${displayDate(to)}`}>
        {owing.data ? (
          customers.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-muted">
                  <th className="pb-2">Customer</th>
                  <th className="pb-2 text-right">Balance</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <td className="py-2 font-medium">{c.name}</td>
                    <td className="py-2 text-right">{rm(c.balance)}</td>
                    <td className="py-2 text-right">
                      <Button variant="ghost" onClick={() => setSelected(c.id)}>
                        Statement
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-ink-muted">
              Nobody owes anything as at this date. Nothing to send.
            </p>
          )
        ) : (
          <Skeleton />
        )}
        <ErrorNote error={owing.error} />
      </Card>

      {selected !== null ? (
        statement.data ? (
          <Card title={statement.data.contact.name}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-ink-muted">
                {displayDate(statement.data.from)} — {displayDate(statement.data.to)}
                {statement.data.contact.email ? ` · ${statement.data.contact.email}` : ''}
              </p>
              <Button onClick={() => void print()}>Print / PDF</Button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-muted">
                    <th className="pb-2">Date</th>
                    <th className="pb-2">Document</th>
                    <th className="pb-2">Detail</th>
                    <th className="pb-2 text-right">Charge</th>
                    <th className="pb-2 text-right">Paid</th>
                    <th className="pb-2 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {/*
                    The carried-forward figure is a row, not a caption. A
                    statement that starts mid-story invites "what was this
                    opening number?", and the answer belongs on the page.
                  */}
                  <tr className="border-t border-line font-medium">
                    <td className="py-2" colSpan={5}>
                      Balance brought forward
                    </td>
                    <td className="py-2 text-right">{rm(statement.data.openingBalance)}</td>
                  </tr>
                  {statement.data.entries.map((entry, index) => (
                    <tr key={`${entry.reference}-${index}`} className="border-t border-line">
                      <td className="py-2 whitespace-nowrap text-ink-muted">
                        {displayDate(entry.date)}
                      </td>
                      <td className="py-2 whitespace-nowrap font-medium">{entry.reference}</td>
                      <td className="py-2 text-ink-muted">{entry.detail ?? ''}</td>
                      <td className="py-2 text-right">{entry.charge ? rm(entry.charge) : ''}</td>
                      <td className="py-2 text-right">{entry.credit ? rm(entry.credit) : ''}</td>
                      <td className="py-2 text-right">{rm(entry.balance)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-line font-semibold">
                    <td className="py-2" colSpan={5}>
                      Amount now due
                    </td>
                    <td className="py-2 text-right">{rm(statement.data.closingBalance)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {Number(statement.data.overdue) > 0 ? (
              /*
                Said separately rather than folded into the total: "you owe
                RM 4,000" and "RM 1,200 of it was due three weeks ago" start
                different conversations, and the second is the one that gets paid.
              */
              <p className="mt-3 text-sm font-medium text-caution">
                {rm(statement.data.overdue)} of this is already past its due date.
              </p>
            ) : null}

            {statement.data.entries.length === 0 ? (
              <p className="mt-3 text-xs text-ink-muted">
                Nothing happened on this account in this period. The balance carried
                forward is the whole story.
              </p>
            ) : null}

            <ErrorNote error={printError} />
          </Card>
        ) : (
          <Card title="Statement">
            <Skeleton />
            <ErrorNote error={statement.error} />
          </Card>
        )
      ) : null}
    </div>
  );
}
