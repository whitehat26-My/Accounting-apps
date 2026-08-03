'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Button, Card, ErrorNote, Field, Input } from '@/components/ui';

/**
 * Bills: what the shop owes, entered when the paper arrives, paid when due.
 *
 * Recognition and payment are separate on purpose — entering the bill puts
 * the cost in the books on the bill's date; paying it later only moves cash.
 * An approval rule may gate payment; the server refuses and the refusal is
 * shown, not smoothed over.
 */

interface OpenBill {
  id: string;
  internalRef: string;
  billNo: string;
  supplierId: string;
  supplierName: string;
  billDate: string;
  dueDate: string;
  total: string;
  amountDue: string;
  status: string;
}

interface Contact {
  id: string;
  name: string;
  isSupplier: boolean;
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
}

interface DraftLine {
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  taxCodeId: string;
}

const EMPTY_LINE: DraftLine = {
  description: '',
  quantity: '1',
  unitPrice: '',
  accountId: '',
  taxCodeId: '',
};

export default function PurchasesPage() {
  const queryClient = useQueryClient();

  const bills = useQuery({
    queryKey: ['open-bills'],
    queryFn: () => api<{ bills: OpenBill[] }>('/v1/bills'),
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

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['open-bills'] });
  const open = bills.data?.bills ?? [];
  const today = todayIso();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Bills &amp; expenses</h1>

      <Card title="Unpaid bills">
        {bills.data ? (
          open.length > 0 ? (
            <div className="space-y-3">
              {open.map((bill) => (
                <BillRow
                  key={bill.id}
                  bill={bill}
                  overdue={bill.dueDate < today}
                  assetAccounts={(accounts.data?.accounts ?? []).filter((a) => a.type === 'ASSET')}
                  onChanged={refresh}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Nothing owed. Every bill entered is paid.</p>
          )
        ) : (
          <p className="text-sm text-slate-500">Loading…</p>
        )}
      </Card>

      <NewBillCard
        suppliers={(contacts.data?.contacts ?? []).filter((c) => c.isSupplier)}
        expenseAccounts={(accounts.data?.accounts ?? []).filter((a) => a.type === 'EXPENSE')}
        taxCodes={taxCodes.data?.taxCodes ?? []}
        onEntered={() => {
          refresh();
          void queryClient.invalidateQueries({ queryKey: ['contacts'] });
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function BillRow({
  bill,
  overdue,
  assetAccounts,
  onChanged,
}: {
  bill: OpenBill;
  overdue: boolean;
  assetAccounts: GlAccount[];
  onChanged: () => void;
}) {
  const [paying, setPaying] = useState(false);
  const [method, setMethod] = useState('TRANSFER');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [amount, setAmount] = useState(bill.amountDue);

  const pay = useMutation({
    mutationFn: () =>
      api('/v1/supplier-payments', {
        method: 'POST',
        body: {
          supplierId: bill.supplierId,
          paymentDate: todayIso(),
          amount,
          method,
          depositAccountId,
          allocations: [{ billId: bill.id, amount }],
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
          <span className="font-medium">{bill.supplierName}</span>
          <span className="ml-2 text-sm text-slate-500">
            {bill.billNo} · {bill.internalRef}
          </span>
        </div>
        <div className="text-right">
          <div className="font-semibold">{rm(bill.amountDue)} due</div>
          <div className={`text-xs ${overdue ? 'font-medium text-red-600' : 'text-slate-500'}`}>
            {overdue ? 'overdue since ' : 'due '}
            {displayDate(bill.dueDate)}
          </div>
        </div>
      </div>

      <div className="mt-2">
        <Button onClick={() => setPaying(!paying)}>{paying ? 'Cancel' : 'Pay'}</Button>
      </div>

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
              {['TRANSFER', 'DUITNOW', 'FPX', 'CASH', 'CHEQUE', 'OTHER'].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Paid from">
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
          <Button onClick={() => pay.mutate()} disabled={!depositAccountId || pay.isPending}>
            {pay.isPending ? 'Paying…' : 'Record payment'}
          </Button>
          {/* An approval rule may refuse this — the refusal is the feature. */}
          {pay.isError ? <ErrorNote error={pay.error} /> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function NewBillCard({
  suppliers,
  expenseAccounts,
  taxCodes,
  onEntered,
}: {
  suppliers: Contact[];
  expenseAccounts: GlAccount[];
  taxCodes: TaxCode[];
  onEntered: () => void;
}) {
  const [supplierId, setSupplierId] = useState('');
  const [newSupplier, setNewSupplier] = useState('');
  const [billNo, setBillNo] = useState('');
  const [billDate, setBillDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE }]);
  const [entered, setEntered] = useState<string | null>(null);

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const enter = useMutation({
    mutationFn: async () => {
      let supplier = supplierId;
      if (supplier === '') {
        const created = await api<{ id: string }>('/v1/contacts', {
          method: 'POST',
          body: { name: newSupplier, isSupplier: true },
        });
        supplier = created.id;
      }
      return api<{ internalRef: string }>('/v1/bills', {
        method: 'POST',
        body: {
          supplierId: supplier,
          billNo,
          billDate,
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
      setEntered(r.internalRef ?? 'Bill');
      setLines([{ ...EMPTY_LINE }]);
      setBillNo('');
      setNewSupplier('');
      onEntered();
    },
  });

  const complete =
    (supplierId !== '' || newSupplier.trim() !== '') &&
    billNo.trim() !== '' &&
    lines.some(
      (l) =>
        l.description.trim() !== '' && l.unitPrice !== '' && l.accountId !== '' && l.taxCodeId !== '',
    );

  return (
    <Card title="Enter a bill — the supplier's paper, into the books">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-3">
          <Field label="Supplier">
            <select
              className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-2 text-sm"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              <option value="">— new supplier —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          {supplierId === '' ? (
            <Field label="New supplier name">
              <Input
                value={newSupplier}
                onChange={(e) => setNewSupplier(e.target.value)}
                placeholder="Selangor Supplies Sdn Bhd"
              />
            </Field>
          ) : null}
          <Field label="Their bill number">
            <Input value={billNo} onChange={(e) => setBillNo(e.target.value)} placeholder="INV-8891" />
          </Field>
          <Field label="Bill date">
            <Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
          </Field>
          <Field label="Due date (blank = supplier's terms)">
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
        </div>

        {lines.map((line, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-md bg-slate-50 p-2">
            <Field label="Description">
              <Input
                value={line.description}
                onChange={(e) => setLine(i, { description: e.target.value })}
                placeholder="Shop rental — August"
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
                placeholder="1500.00"
              />
            </Field>
            <Field label="Expense account">
              <select
                className="rounded-lg border-0 bg-white shadow-sm ring-1 ring-inset ring-slate-300 px-2 py-2 text-sm"
                value={line.accountId}
                onChange={(e) => setLine(i, { accountId: e.target.value })}
              >
                <option value="">Choose…</option>
                {expenseAccounts.map((a) => (
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
          <Button onClick={() => enter.mutate()} disabled={!complete || enter.isPending}>
            {enter.isPending ? 'Entering…' : 'Enter bill'}
          </Button>
        </div>
        {enter.isError ? <ErrorNote error={enter.error} /> : null}
        {entered ? <p className="text-sm text-emerald-700">{entered} entered.</p> : null}
      </div>
    </Card>
  );
}
