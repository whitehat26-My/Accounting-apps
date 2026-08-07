'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiBlobUrl } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Badge, Button, Card, ErrorNote, Field, Input, Skeleton } from '@/components/ui';

/** The session lives in a header, so the bytes are fetched then handed over. */
async function openQuotePdf(id: string) {
  const url = await apiBlobUrl(`/v1/quotes/${id}/pdf`);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Quotes: what a job would cost, before anybody owes anything.
 *
 * ---------------------------------------------------------------------------
 * NOTHING ON THIS SCREEN TOUCHES THE BOOKS — EXCEPT ONE BUTTON.
 *
 * A quote is an offer. It has a number and a customer and a price, and none of
 * that is revenue: no journal entry exists until "Make it an invoice", which
 * goes through the same path a typed invoice takes and is the moment the offer
 * becomes money owed.
 *
 * That asymmetry is the whole point of the screen. Quoting is cheap and
 * reversible — write it, send it, revive it after a no — and invoicing is
 * neither, so the one irreversible action is a separate, deliberate press.
 * ---------------------------------------------------------------------------
 */

interface Quote {
  id: string;
  quoteNo: string;
  contactId: string;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'INVOICED';
  quoteDate: string;
  validUntil: string | null;
  lapsed: boolean;
  reference: string | null;
  notes: string | null;
  invoiceId: string | null;
  declineReason: string | null;
  subtotal: string;
}

interface Contact {
  id: string;
  name: string;
  isCustomer: boolean;
}

interface GlAccount {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface TaxCode {
  id: string;
  code: string;
  name: string;
}

interface DraftLine {
  description: string;
  quantity: string;
  unitPrice: string;
}

/** What each status means at the counter, in the words someone would use. */
const STATUS_MEANING: Record<Quote['status'], string> = {
  DRAFT: 'Not sent yet. Change it as much as you like.',
  SENT: 'With the customer. Waiting on their answer.',
  ACCEPTED: 'They said yes. Turn it into an invoice when the work is done.',
  DECLINED: 'They said no. The reason is kept.',
  EXPIRED: 'Nobody answered before it ran out.',
  INVOICED: 'Already became an invoice. This one is finished.',
};

export default function QuotesPage() {
  const queryClient = useQueryClient();

  const quotes = useQuery({
    queryKey: ['quotes'],
    queryFn: () => api<{ quotes: Quote[] }>('/v1/quotes'),
  });
  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: () => api<{ contacts: Contact[] }>('/v1/contacts'),
  });
  const accounts = useQuery({
    queryKey: ['gl-accounts'],
    queryFn: () => api<{ accounts: GlAccount[] }>('/v1/accounts'),
  });
  const taxCodes = useQuery({
    queryKey: ['tax-codes'],
    queryFn: () => api<{ taxCodes: TaxCode[] }>('/v1/tax-codes'),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['quotes'] });
    void queryClient.invalidateQueries({ queryKey: ['open-invoices'] });
  };

  const all = quotes.data?.quotes ?? [];
  // Finished quotes still matter — an invoiced one is the paper trail behind an
  // invoice — but they do not belong at the top of a working list.
  const live = all.filter((q) => q.status !== 'INVOICED' && q.status !== 'DECLINED');
  const closed = all.filter((q) => q.status === 'INVOICED' || q.status === 'DECLINED');

  const nameOf = (contactId: string) =>
    contacts.data?.contacts.find((c) => c.id === contactId)?.name ?? 'Customer';

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Quotes</h1>

      <Card title="Open quotes">
        {quotes.data ? (
          live.length > 0 ? (
            <div className="space-y-3">
              {live.map((quote) => (
                <QuoteRow
                  key={quote.id}
                  quote={quote}
                  customerName={nameOf(quote.contactId)}
                  onChanged={refresh}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">
              No open quotes. Write one below when a customer asks what a job will cost.
            </p>
          )
        ) : (
          <Skeleton />
        )}
      </Card>

      <NewQuoteCard
        customers={(contacts.data?.contacts ?? []).filter((c) => c.isCustomer)}
        incomeAccounts={(accounts.data?.accounts ?? []).filter((a) => a.type === 'INCOME')}
        taxCodes={taxCodes.data?.taxCodes ?? []}
        onCreated={refresh}
      />

      {closed.length > 0 ? (
        <Card title="Finished">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-muted">
                <th className="pb-2">Quote</th>
                <th className="pb-2">Customer</th>
                <th className="pb-2">Date</th>
                <th className="pb-2 text-right">Amount</th>
                <th className="pb-2">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((quote) => (
                <tr key={quote.id} className="border-t border-line">
                  <td className="py-2 font-medium">{quote.quoteNo}</td>
                  <td className="py-2 text-ink-muted">{nameOf(quote.contactId)}</td>
                  <td className="py-2 text-ink-muted">{displayDate(quote.quoteDate)}</td>
                  <td className="py-2 text-right">{rm(quote.subtotal)}</td>
                  <td className="py-2">
                    <Badge status={quote.status} />
                    {quote.declineReason ? (
                      <span className="ml-2 text-xs text-ink-muted">{quote.declineReason}</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function QuoteRow({
  quote,
  customerName,
  onChanged,
}: {
  quote: Quote;
  customerName: string;
  onChanged: () => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [converting, setConverting] = useState(false);
  const [issueDate, setIssueDate] = useState(todayIso());

  const transition = useMutation({
    mutationFn: (body: { to: string; reason?: string }) =>
      api(`/v1/quotes/${quote.id}/status`, { method: 'POST', body }),
    onSuccess: () => {
      setDeclining(false);
      setReason('');
      onChanged();
    },
  });

  const convert = useMutation({
    mutationFn: () =>
      api(`/v1/quotes/${quote.id}/convert`, { method: 'POST', body: { issueDate } }),
    onSuccess: () => {
      setConverting(false);
      onChanged();
    },
  });

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{quote.quoteNo}</span>
            <Badge status={quote.status} />
            {/*
              `lapsed` is computed by the server, not stored, and it is not the
              same as the EXPIRED status: a quote can be past its date while
              still sitting in SENT because nobody has run the sweep. Saying
              "ran out" beside the real status is more honest than either
              hiding it or pretending the status changed.
            */}
            {quote.lapsed ? (
              <span className="text-xs font-medium text-caution">ran out</span>
            ) : null}
          </div>
          <p className="mt-0.5 text-sm text-ink-muted">
            {customerName} · {displayDate(quote.quoteDate)}
            {quote.validUntil ? ` · good until ${displayDate(quote.validUntil)}` : ''}
            {quote.reference ? ` · ${quote.reference}` : ''}
          </p>
          <p className="mt-1 text-xs text-ink-muted">{STATUS_MEANING[quote.status]}</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold text-ink">{rm(quote.subtotal)}</p>
          <p className="text-xs text-ink-muted">before tax</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {/* Available at every status, including DRAFT: the point of printing a
            quote is to put it in front of somebody before it is sent. */}
        <Button variant="ghost" onClick={() => void openQuotePdf(quote.id)}>
          Print
        </Button>

        {quote.status === 'DRAFT' ? (
          <Button
            variant="ghost"
            disabled={transition.isPending}
            onClick={() => transition.mutate({ to: 'SENT' })}
          >
            Mark as sent
          </Button>
        ) : null}

        {quote.status === 'SENT' ? (
          <>
            <Button
              disabled={transition.isPending}
              onClick={() => transition.mutate({ to: 'ACCEPTED' })}
            >
              They said yes
            </Button>
            <Button variant="ghost" onClick={() => setDeclining((open) => !open)}>
              They said no
            </Button>
          </>
        ) : null}

        {quote.status === 'ACCEPTED' ? (
          <Button onClick={() => setConverting((open) => !open)}>Make it an invoice</Button>
        ) : null}

        {/*
          A declined or lapsed quote can go back to DRAFT and be re-priced,
          which is what actually happens when a customer comes back a month
          later. The alternative is retyping it, and retyping loses the history.
        */}
        {quote.status === 'DECLINED' || quote.status === 'EXPIRED' ? (
          <Button
            variant="ghost"
            disabled={transition.isPending}
            onClick={() => transition.mutate({ to: 'DRAFT' })}
          >
            Reopen as draft
          </Button>
        ) : null}
      </div>

      {declining ? (
        <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-surface-sunken p-3">
          <div className="min-w-[220px] flex-1">
            {/*
              Required by the server, and worth requiring: "too expensive" and
              "went with the shop next door" lead to different decisions, and
              six months later nobody remembers which it was.
            */}
            <Field label="Why not? (kept on the record)">
              <Input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Price too high"
              />
            </Field>
          </div>
          <Button
            disabled={transition.isPending || reason.trim() === ''}
            onClick={() => transition.mutate({ to: 'DECLINED', reason: reason.trim() })}
          >
            Record the no
          </Button>
        </div>
      ) : null}

      {converting ? (
        <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-positive-soft p-3">
          <div className="min-w-[180px]">
            <Field label="Invoice date">
              <Input
                type="date"
                value={issueDate}
                onChange={(event) => setIssueDate(event.target.value)}
              />
            </Field>
          </div>
          <Button disabled={convert.isPending} onClick={() => convert.mutate()}>
            {convert.isPending ? 'Issuing…' : 'Issue the invoice'}
          </Button>
          <p className="w-full text-xs text-ink-muted">
            This posts to the books: the customer will owe the money, and the invoice
            appears under Sales. It cannot be undone — a mistake is corrected with a
            credit note.
          </p>
        </div>
      ) : null}

      <ErrorNote error={transition.error} />
      <ErrorNote error={convert.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function NewQuoteCard({
  customers,
  incomeAccounts,
  taxCodes,
  onCreated,
}: {
  customers: Contact[];
  incomeAccounts: GlAccount[];
  taxCodes: TaxCode[];
  onCreated: () => void;
}) {
  const [contactId, setContactId] = useState('');
  const [quoteDate, setQuoteDate] = useState(todayIso());
  const [validUntil, setValidUntil] = useState('');
  const [reference, setReference] = useState('');
  const [accountId, setAccountId] = useState('');
  const [taxCodeId, setTaxCodeId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([
    { description: '', quantity: '1', unitPrice: '' },
  ]);

  const create = useMutation({
    mutationFn: () =>
      api('/v1/quotes', {
        method: 'POST',
        body: {
          contactId,
          quoteDate,
          ...(validUntil ? { validUntil } : {}),
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          lines: lines
            .filter((l) => l.description.trim() !== '' && l.unitPrice.trim() !== '')
            .map((l) => ({
              description: l.description.trim(),
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              accountId,
              taxCodeId,
            })),
        },
      }),
    onSuccess: () => {
      setLines([{ description: '', quantity: '1', unitPrice: '' }]);
      setReference('');
      onCreated();
    },
  });

  const usable = lines.filter(
    (l) => l.description.trim() !== '' && l.unitPrice.trim() !== '',
  );
  const ready =
    contactId !== '' && accountId !== '' && taxCodeId !== '' && usable.length > 0;

  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  return (
    <Card title="Write a quote">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Customer">
          <select
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
            value={contactId}
            onChange={(event) => setContactId(event.target.value)}
          >
            <option value="">Choose…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quote date">
          <Input
            type="date"
            value={quoteDate}
            onChange={(event) => setQuoteDate(event.target.value)}
          />
        </Field>
        <Field label="Good until (optional)">
          <Input
            type="date"
            value={validUntil}
            onChange={(event) => setValidUntil(event.target.value)}
          />
        </Field>
        <Field label="Their reference (optional)">
          <Input value={reference} onChange={(event) => setReference(event.target.value)} />
        </Field>

        <Field label="Post the income to">
          <select
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="">Choose…</option>
            {incomeAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tax code">
          <select
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
            value={taxCodeId}
            onChange={(event) => setTaxCodeId(event.target.value)}
          >
            <option value="">Choose…</option>
            {taxCodes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-4 space-y-2">
        {lines.map((line, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[1fr_100px_140px]">
            <Input
              value={line.description}
              onChange={(event) => setLine(index, { description: event.target.value })}
              placeholder="What the job includes"
            />
            <Input
              value={line.quantity}
              inputMode="decimal"
              onChange={(event) => setLine(index, { quantity: event.target.value })}
              placeholder="Qty"
            />
            <Input
              value={line.unitPrice}
              inputMode="decimal"
              onChange={(event) => setLine(index, { unitPrice: event.target.value })}
              placeholder="Unit price (RM)"
            />
          </div>
        ))}
        <Button
          variant="ghost"
          onClick={() =>
            setLines((current) => [...current, { description: '', quantity: '1', unitPrice: '' }])
          }
        >
          Add a line
        </Button>
      </div>

      {/*
        No running total here on purpose. This app does no arithmetic on money —
        adding the lines up in the browser would need parseFloat, and it is the
        server's subtotal that appears on the quote the moment it is saved.
      */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button disabled={!ready || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Saving…' : 'Save as draft'}
        </Button>
        {!ready ? (
          <span className="text-xs text-ink-muted">
            Pick a customer, an income account, a tax code, and at least one priced line.
          </span>
        ) : null}
      </div>

      <ErrorNote error={create.error} />
    </Card>
  );
}
