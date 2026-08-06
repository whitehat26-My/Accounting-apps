'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiBlobUrl } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Button, Card, ErrorNote, Field, Input, Skeleton } from '@/components/ui';

/**
 * Sales beyond the till: invoices on terms, and the payments that settle them.
 *
 * The POS rings walk-ins; THIS is for the customer who collects their machine
 * and pays at month-end. Issue → PDF → chase (Collections) → record payment.
 * Amounts are the server's strings end to end; the total is whatever the
 * server said it was, never re-added here.
 */

interface OpenInvoice {
  id: string;
  invoiceNo: string;
  contactId: string;
  contactName: string;
  issueDate: string;
  dueDate: string;
  total: string;
  amountDue: string;
  status: string;
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
  accountId: string;
  taxCodeId: string;
}

export default function SalesPage() {
  const queryClient = useQueryClient();

  const invoices = useQuery({
    queryKey: ['open-invoices'],
    queryFn: () => api<{ invoices: OpenInvoice[] }>('/v1/invoices'),
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

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['open-invoices'] });
  const open = invoices.data?.invoices ?? [];
  const today = todayIso();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Sales &amp; invoices</h1>

      <CreditNotesCard />

      <Card title="Unpaid invoices">
        {invoices.data ? (
          open.length > 0 ? (
            <div className="space-y-3">
              {open.map((inv) => (
                <InvoiceRow
                  key={inv.id}
                  invoice={inv}
                  overdue={inv.dueDate < today}
                  assetAccounts={(accounts.data?.accounts ?? []).filter((a) => a.type === 'ASSET')}
                  onChanged={refresh}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              Nothing unpaid. Every invoice issued has been settled.
            </p>
          )
        ) : (
          <Skeleton />
        )}
      </Card>

      <NewInvoiceCard
        customers={(contacts.data?.contacts ?? []).filter((c) => c.isCustomer)}
        incomeAccounts={(accounts.data?.accounts ?? []).filter((a) => a.type === 'INCOME')}
        taxCodes={taxCodes.data?.taxCodes ?? []}
        onIssued={() => {
          refresh();
          void queryClient.invalidateQueries({ queryKey: ['contacts'] });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function InvoiceRow({
  invoice,
  overdue,
  assetAccounts,
  onChanged,
}: {
  invoice: OpenInvoice;
  overdue: boolean;
  assetAccounts: GlAccount[];
  onChanged: () => void;
}) {
  const [paying, setPaying] = useState(false);
  const [method, setMethod] = useState('TRANSFER');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [amount, setAmount] = useState(invoice.amountDue);

  const credit = useMutation({
    mutationFn: (reason: string) =>
      api(`/v1/invoices/${invoice.id}/credit-note`, {
        method: 'POST',
        // No lines: credit everything not already credited. Price, account
        // and tax come from the original — a credit that differs from the
        // sale is not a reversal of it.
        body: { creditDate: todayIso(), reason },
      }),
    onSuccess: onChanged,
  });

  const receive = useMutation({
    mutationFn: () =>
      api('/v1/receipts', {
        method: 'POST',
        body: {
          contactId: invoice.contactId,
          paymentDate: todayIso(),
          amount,
          method,
          depositAccountId,
          allocations: [{ invoiceId: invoice.id, amount }],
        },
      }),
    onSuccess: () => {
      setPaying(false);
      onChanged();
    },
  });

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-medium">{invoice.invoiceNo}</span>
          <span className="ml-2 text-sm text-slate-500">{invoice.contactName}</span>
        </div>
        <div className="text-right">
          <div className="font-semibold">{rm(invoice.amountDue)} due</div>
          <div className={`text-xs ${overdue ? 'font-medium text-red-600' : 'text-slate-500'}`}>
            {overdue ? 'overdue since ' : 'due '}
            {displayDate(invoice.dueDate)}
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          onClick={() =>
            void apiBlobUrl(`/v1/invoices/${invoice.id}/pdf`)
              .then((url) => window.open(url, '_blank'))
              .catch((e) => alert(e instanceof Error ? e.message : String(e)))
          }
        >
          PDF
        </Button>
        <Button onClick={() => setPaying(!paying)}>
          {paying ? 'Cancel' : 'Record payment'}
        </Button>
        <Button
          onClick={() => {
            const reason = window.prompt(
              'Credit this invoice in full? Type a reason:\n' +
                'RETURN, OVERCHARGE, DISCOUNT, CANCELLATION, BAD_DEBT or OTHER',
              'CANCELLATION',
            );
            if (reason === null) return;
            const normalised = reason.trim().toUpperCase();
            if (!['RETURN', 'OVERCHARGE', 'DISCOUNT', 'CANCELLATION', 'BAD_DEBT', 'OTHER'].includes(normalised)) {
              alert('Not a recognised reason — nothing was credited.');
              return;
            }
            credit.mutate(normalised);
          }}
          disabled={credit.isPending}
        >
          Credit fully
        </Button>
      </div>
      {credit.isError ? <ErrorNote error={credit.error} /> : null}

      {paying ? (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md bg-slate-50 p-2">
          <Field label="Amount">
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-28" />
          </Field>
          <Field label="Method">
            <select
              className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-2 text-sm"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {['TRANSFER', 'DUITNOW', 'FPX', 'CASH', 'CARD', 'CHEQUE', 'OTHER'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Into">
            <select
              className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-2 text-sm"
              value={depositAccountId}
              onChange={(e) => setDepositAccountId(e.target.value)}
            >
              <option value="">Choose account…</option>
              {assetAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
              ))}
            </select>
          </Field>
          <Button
            onClick={() => receive.mutate()}
            disabled={!depositAccountId || receive.isPending}
          >
            {receive.isPending ? 'Recording…' : 'Record'}
          </Button>
          {receive.isError ? <ErrorNote error={receive.error} /> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

const EMPTY_LINE: DraftLine = {
  description: '',
  quantity: '1',
  unitPrice: '',
  accountId: '',
  taxCodeId: '',
};

function NewInvoiceCard({
  customers,
  incomeAccounts,
  taxCodes,
  onIssued,
}: {
  customers: Contact[];
  incomeAccounts: GlAccount[];
  taxCodes: TaxCode[];
  onIssued: () => void;
}) {
  const [contactId, setContactId] = useState('');
  const [newCustomer, setNewCustomer] = useState('');
  const [issueDate, setIssueDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }]);
  const [issued, setIssued] = useState<{ invoiceNo: string; total: string; id: string } | null>(null);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const issue = useMutation({
    mutationFn: async () => {
      let customer = contactId;
      if (customer === '') {
        const created = await api<{ id: string }>('/v1/contacts', {
          method: 'POST',
          body: { name: newCustomer, isCustomer: true },
        });
        customer = created.id;
      }
      return api<{ id: string; invoiceNo: string; total: string }>('/v1/invoices', {
        method: 'POST',
        body: {
          contactId: customer,
          issueDate,
          ...(dueDate !== '' ? { dueDate } : {}),
          lines: lines
            .filter((l) => l.description.trim() !== '')
            .map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              accountId: l.accountId,
              taxCodeId: l.taxCodeId,
            })),
        },
      });
    },
    onSuccess: (r) => {
      setIssued({ invoiceNo: r.invoiceNo, total: r.total, id: r.id });
      setLines([{ ...EMPTY_LINE }]);
      setNewCustomer('');
      onIssued();
    },
  });

  const complete =
    (contactId !== '' || newCustomer.trim() !== '') &&
    lines.some(
      (l) =>
        l.description.trim() !== '' && l.unitPrice !== '' && l.accountId !== '' && l.taxCodeId !== '',
    );

  return (
    <Card title="New invoice — payment on terms">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-3">
          <Field label="Customer">
            <select
              className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-2 text-sm"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
            >
              <option value="">— new customer —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
          {contactId === '' ? (
            <Field label="New customer name">
              <Input
                value={newCustomer}
                onChange={(e) => setNewCustomer(e.target.value)}
                placeholder="Nusantara Retail Sdn Bhd"
              />
            </Field>
          ) : null}
          <Field label="Issue date">
            <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </Field>
          <Field label="Due date (blank = customer's terms)">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>

        {lines.map((line, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-md bg-slate-50 p-2">
            <Field label="Description">
              <Input
                value={line.description}
                onChange={(e) => setLine(i, { description: e.target.value })}
                placeholder="Custom PC build — Ryzen 7"
              />
            </Field>
            <Field label="Qty">
              <Input
                value={line.quantity}
                onChange={(e) => setLine(i, { quantity: e.target.value })}
                className="w-16"
              />
            </Field>
            <Field label="Unit price (RM)">
              <Input
                value={line.unitPrice}
                onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                className="w-28"
                placeholder="1080.00"
              />
            </Field>
            <Field label="Revenue account">
              <select
                className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-2 text-sm"
                value={line.accountId}
                onChange={(e) => setLine(i, { accountId: e.target.value })}
              >
                <option value="">Choose…</option>
                {incomeAccounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Tax">
              <select
                className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-2 text-sm"
                value={line.taxCodeId}
                onChange={(e) => setLine(i, { taxCodeId: e.target.value })}
              >
                <option value="">Choose…</option>
                {taxCodes.map((t) => (
                  <option key={t.id} value={t.id}>{t.code}</option>
                ))}
              </select>
            </Field>
          </div>
        ))}

        <div className="flex gap-2">
          <Button onClick={() => setLines([...lines, { ...EMPTY_LINE }])}>Add line</Button>
          <Button onClick={() => issue.mutate()} disabled={!complete || issue.isPending}>
            {issue.isPending ? 'Issuing…' : 'Issue invoice'}
          </Button>
        </div>
        {issue.isError ? <ErrorNote error={issue.error} /> : null}
        {issued ? (
          <p className="text-sm text-emerald-700">
            {issued.invoiceNo} issued for {rm(issued.total)}.{' '}
            <button
              className="underline"
              onClick={() =>
                void apiBlobUrl(`/v1/invoices/${issued.id}/pdf`)
                  .then((url) => window.open(url, '_blank'))
                  .catch((e) => alert(e instanceof Error ? e.message : String(e)))
              }
            >
              Open the PDF
            </button>
          </p>
        ) : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

interface CreditNote {
  id: string;
  creditNoteNo: string;
  creditDate: string;
  customer: string;
  againstInvoiceNo: string | null;
  reason: string;
  status: string;
  total: string;
  unallocated: string;
}

const CREDIT_REASON: Record<string, string> = {
  RETURN: 'Goods returned',
  OVERCHARGE: 'Overcharged',
  DISCOUNT: 'Discount agreed',
  CANCELLATION: 'Order cancelled',
  BAD_DEBT: 'Bad debt relief',
  OTHER: 'Other',
};

/**
 * The credit notes, and the paper copy of each.
 *
 * Until now one could be issued from an invoice above and then never seen
 * again — the ledger held it, the customer's balance reflected it, and there
 * was nowhere to look at it or print the document explaining it.
 */
function CreditNotesCard() {
  const notes = useQuery({
    queryKey: ['credit-notes'],
    queryFn: () => api<{ creditNotes: CreditNote[] }>('/v1/credit-notes'),
  });

  const list = notes.data?.creditNotes ?? [];
  if (list.length === 0) return null;

  return (
    <Card title="Credit notes">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="pb-2">Note</th>
            <th className="pb-2">Customer</th>
            <th className="pb-2">Why</th>
            <th className="pb-2">Against</th>
            <th className="pb-2 text-right">Credited</th>
            <th className="pb-2 text-right">Unused</th>
            <th className="pb-2 text-right"></th>
          </tr>
        </thead>
        <tbody>
          {list.map((note) => (
            <tr key={note.id} className="border-t border-slate-100">
              <td className="py-2">
                <span className="font-mono text-xs">{note.creditNoteNo}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {displayDate(note.creditDate)}
                </span>
              </td>
              <td className="py-2">{note.customer}</td>
              <td className="py-2 text-slate-600">
                {CREDIT_REASON[note.reason] ?? note.reason}
              </td>
              <td className="py-2 text-xs text-slate-500">
                {note.againstInvoiceNo ?? <span className="text-slate-400">standalone</span>}
              </td>
              <td className="py-2 text-right font-medium">{rm(note.total)}</td>
              <td className="py-2 text-right">
                {/* A credit not yet spent is money the customer can still use,
                    and it is invisible unless it is on the screen. */}
                {note.unallocated === '0.0000' ? (
                  <span className="text-slate-300">—</span>
                ) : (
                  <span className="font-medium text-emerald-700">{rm(note.unallocated)}</span>
                )}
              </td>
              <td className="py-2 text-right">
                <Button variant="ghost" onClick={() => void openCreditNotePdf(note.id)}>
                  Print
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** The session lives in a header, so the bytes are fetched then handed over. */
async function openCreditNotePdf(id: string) {
  const url = await apiBlobUrl(`/v1/credit-notes/${id}/pdf`);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
