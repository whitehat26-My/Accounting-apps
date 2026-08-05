'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { displayDate, qty, rm, todayIso } from '@/lib/display';
import { Button, Card, ErrorNote, Field, Input } from '@/components/ui';

/**
 * The shelf: levels at weighted-average cost, with the movement trail one
 * click deep. Stock still moves only through DOCUMENTS — and the count form
 * below files exactly such a document: what the shelf actually says, with a
 * reason, posted as an adjustment. Never by editing a number.
 */

interface Level {
  itemId: string;
  code: string;
  name: string;
  quantityOnHand: string;
  stockValue: string;
  weightedAverageCost: string;
}

interface AgeingRow {
  itemId: string;
  code: string;
  name: string;
  quantityOnHand: string;
  stockValue: string;
  lastSoldOn: string | null;
  lastReceivedOn: string | null;
  daysIdle: number;
  bucket: 'FRESH' | 'SLOWING' | 'STALE' | 'DEAD';
}

interface Movement {
  id: string;
  movementType: string;
  quantity: string;
  valueDelta: string;
  sourceDocumentType: string;
  movedOn: string;
  reason: string | null;
}

export default function StockPage() {
  const [selected, setSelected] = useState<Level | null>(null);

  const levels = useQuery({
    queryKey: ['stock'],
    queryFn: () => api<{ stock: Level[] }>('/v1/stock'),
  });

  const movements = useQuery({
    queryKey: ['movements', selected?.itemId],
    enabled: selected !== null,
    queryFn: () =>
      api<{ movements: Movement[] }>(`/v1/stock/items/${selected!.itemId}/movements`),
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Stock</h1>
      <div className="grid grid-cols-2 gap-4">
        <Card title="On hand">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-2">Item</th>
                <th className="pb-2 text-right">Qty</th>
                <th className="pb-2 text-right">Avg cost</th>
                <th className="pb-2 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {(levels.data?.stock ?? []).map((level) => (
                <tr
                  key={level.itemId}
                  onClick={() => setSelected(level)}
                  className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 ${
                    selected?.itemId === level.itemId ? 'bg-emerald-50' : ''
                  }`}
                >
                  <td className="py-2">
                    <span className="text-xs text-slate-500">{level.code}</span>{' '}
                    {level.name}
                  </td>
                  <td className="py-2 text-right font-medium">{qty(level.quantityOnHand)}</td>
                  <td className="py-2 text-right">{rm(level.weightedAverageCost)}</td>
                  <td className="py-2 text-right">{rm(level.stockValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {levels.data && levels.data.stock.length === 0 ? (
            <p className="text-sm text-slate-500">
              No tracked stock yet. Mark an item as tracked, then enter a purchase bill.
            </p>
          ) : null}
        </Card>

        <Card title={selected ? `Movements — ${selected.code}` : 'Movements'}>
          {selected ? (
            <table className="w-full text-sm">
              <tbody>
                {(movements.data?.movements ?? []).map((m) => (
                  <tr key={m.id} className="border-t border-slate-100">
                    <td className="py-2 text-xs text-slate-500">{displayDate(m.movedOn)}</td>
                    <td className="py-2">{m.movementType}</td>
                    <td className="py-2 text-xs text-slate-500">
                      {m.sourceDocumentType}
                      {m.reason ? ` — ${m.reason}` : ''}
                    </td>
                    <td className="py-2 text-right font-medium">{qty(m.quantity)}</td>
                    <td className="py-2 text-right">{rm(m.valueDelta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-slate-500">Select an item to see its trail.</p>
          )}
          {selected ? <CountForm level={selected} /> : null}
        </Card>
      </div>
      <AgeingCard />
    </div>
  );
}

/**
 * The physical count, filed properly: an absolute quantity off the shelf and
 * a reason, posted through the same adjustment path everything else uses.
 * The variance is shown BEFORE submitting — "you are about to write off 3"
 * is a sentence someone should read while still holding the clipboard.
 */
function CountForm({ level }: { level: Level }) {
  const queryClient = useQueryClient();
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const variance = (() => {
    if (counted.trim() === '' || !/^\d+(\.\d{1,4})?$/.test(counted.trim())) return null;
    // Display only — the server does the real arithmetic on the posted count.
    const diff = Number(counted) - Number(level.quantityOnHand);
    return diff === 0 ? 'matches the book' : diff > 0 ? `+${diff} found` : `${diff} missing`;
  })();

  const count = useMutation({
    mutationFn: () =>
      api<{ movementId: string | null }>('/v1/stock/counts', {
        method: 'POST',
        body: {
          itemId: level.itemId,
          countedQuantity: counted.trim(),
          countDate: todayIso(),
          reason: reason.trim(),
        },
      }),
    onSuccess: () => {
      setDone(`Counted ${level.code} at ${counted.trim()}.`);
      setCounted('');
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['stock'] });
      void queryClient.invalidateQueries({ queryKey: ['movements'] });
      void queryClient.invalidateQueries({ queryKey: ['stock-ageing'] });
    },
  });

  return (
    <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Count this item
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Shelf says">
          <Input
            inputMode="decimal"
            value={counted}
            onChange={(e) => {
              setCounted(e.target.value);
              setDone(null);
            }}
            placeholder={qty(level.quantityOnHand)}
          />
        </Field>
        <Field label="Reason (kept forever)">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Monthly stock take"
          />
        </Field>
        <Button
          disabled={count.isPending || counted.trim() === '' || reason.trim() === ''}
          onClick={() => count.mutate()}
        >
          Post count
        </Button>
      </div>
      {variance !== null ? (
        <p className="text-sm text-slate-600">
          Book says {qty(level.quantityOnHand)} — this count {variance}.
        </p>
      ) : null}
      {done !== null ? <p className="text-sm text-emerald-700">{done}</p> : null}
      <ErrorNote error={count.error} />
    </div>
  );
}

const BUCKET_STYLE: Record<AgeingRow['bucket'], string> = {
  FRESH: 'bg-emerald-100 text-emerald-900',
  SLOWING: 'bg-amber-100 text-amber-900',
  STALE: 'bg-orange-100 text-orange-900',
  DEAD: 'bg-red-100 text-red-900',
};

/**
 * What is sitting. Sorted by silence, because the shelf's most expensive
 * occupants are the ones nobody has asked about since March.
 */
function AgeingCard() {
  const ageing = useQuery({
    queryKey: ['stock-ageing'],
    queryFn: () => api<{ rows: AgeingRow[] }>('/v1/reports/stock-ageing'),
  });
  const rows = ageing.data?.rows ?? [];
  if (rows.length === 0) return null;

  return (
    <Card title="What is sitting — oldest silence first">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="pb-2">Item</th>
            <th className="pb-2 text-right">Qty</th>
            <th className="pb-2 text-right">Value</th>
            <th className="pb-2 text-right">Last sold</th>
            <th className="pb-2 text-right">Days idle</th>
            <th className="pb-2 text-right"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.itemId} className="border-t border-slate-100">
              <td className="py-2">
                <span className="text-xs text-slate-500">{row.code}</span> {row.name}
              </td>
              <td className="py-2 text-right">{qty(row.quantityOnHand)}</td>
              <td className="py-2 text-right">{rm(row.stockValue)}</td>
              <td className="py-2 text-right text-xs text-slate-500">
                {row.lastSoldOn === null ? 'never' : displayDate(row.lastSoldOn)}
              </td>
              <td className="py-2 text-right font-medium">{row.daysIdle}</td>
              <td className="py-2 text-right">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${BUCKET_STYLE[row.bucket]}`}
                >
                  {row.bucket}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-500">
        DEAD is six months without a sale — usually a part that outlived the machines it
        fits. Count it down or discount it out; the shelf space is worth more.
      </p>
    </Card>
  );
}
