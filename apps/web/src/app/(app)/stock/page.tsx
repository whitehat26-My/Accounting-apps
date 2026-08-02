'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { displayDate, qty, rm } from '@/lib/display';
import { Card } from '@/components/ui';

/**
 * The shelf: levels at weighted-average cost, with the movement trail one
 * click deep. Read-only by design — stock moves through documents (bills,
 * sales, counts), never by editing a number on this screen.
 */

interface Level {
  itemId: string;
  code: string;
  name: string;
  quantityOnHand: string;
  stockValue: string;
  weightedAverageCost: string;
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
      <h1 className="text-xl font-bold">Stock</h1>
      <div className="grid grid-cols-2 gap-4">
        <Card title="On hand">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-neutral-500">
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
                  className={`cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 ${
                    selected?.itemId === level.itemId ? 'bg-emerald-50' : ''
                  }`}
                >
                  <td className="py-2">
                    <span className="text-xs text-neutral-500">{level.code}</span>{' '}
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
            <p className="text-sm text-neutral-500">
              No tracked stock yet. Mark an item as tracked, then enter a purchase bill.
            </p>
          ) : null}
        </Card>

        <Card title={selected ? `Movements — ${selected.code}` : 'Movements'}>
          {selected ? (
            <table className="w-full text-sm">
              <tbody>
                {(movements.data?.movements ?? []).map((m) => (
                  <tr key={m.id} className="border-t border-neutral-100">
                    <td className="py-2 text-xs text-neutral-500">{displayDate(m.movedOn)}</td>
                    <td className="py-2">{m.movementType}</td>
                    <td className="py-2 text-xs text-neutral-500">
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
            <p className="text-sm text-neutral-500">Select an item to see its trail.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
