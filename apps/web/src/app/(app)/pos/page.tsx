'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, apiBlobUrl } from '@/lib/api';
import { qty, rm, todayIso } from '@/lib/display';
import { Button, Card, ErrorNote, Field, Input } from '@/components/ui';

/**
 * The till.
 *
 * Search, tap to add, take the money. The screen holds NO arithmetic beyond
 * a display estimate — the authoritative total, tax and change come back from
 * the server, which is the only place Money lives. A serialised item's row
 * asks for exactly as many serials as its quantity, because the API will
 * refuse anything less and the counter should hear that from the input field,
 * not from a rejected sale.
 */

interface Item {
  id: string;
  code: string;
  name: string;
  isTracked: boolean;
  isSerialised: boolean;
  sale: { unitPrice: string | null };
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

interface CartLine {
  item: Item;
  quantity: number;
  serials: string[];
}

interface SaleResult {
  invoiceNo: string;
  receiptId: string;
  total: string;
  changeDue: string | null;
}

export default function PosPage() {
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [method, setMethod] = useState<'CASH' | 'CARD' | 'DUITNOW'>('CASH');
  const [tendered, setTendered] = useState('');
  const [result, setResult] = useState<SaleResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const items = useQuery({
    queryKey: ['items', search],
    queryFn: () => api<Item[]>(`/v1/items?direction=SALE&search=${encodeURIComponent(search)}`),
  });

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<{ accounts: Account[] }>('/v1/accounts'),
  });

  // Cash lands in the first cash-and-bank asset; card/QR in undeposited funds
  // if present. Overridable later; the default is what a till expects.
  const depositAccountId = (() => {
    const all = accounts.data?.accounts ?? [];
    if (method === 'CASH') return all.find((a) => a.code === '1000')?.id ?? all[0]?.id;
    return (all.find((a) => a.code === '1200') ?? all.find((a) => a.code === '1000'))?.id;
  })();

  function add(item: Item) {
    setResult(null);
    setCart((current) => {
      const existing = current.find((l) => l.item.id === item.id);
      if (existing && !item.isSerialised) {
        return current.map((l) =>
          l.item.id === item.id ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      if (existing && item.isSerialised) {
        return current.map((l) =>
          l.item.id === item.id ? { ...l, quantity: l.quantity + 1, serials: [...l.serials, ''] } : l,
        );
      }
      return [...current, { item, quantity: 1, serials: item.isSerialised ? [''] : [] }];
    });
  }

  // Display estimate only. The server computes the real total; this exists so
  // the tender field has something to stand next to before the sale is rung.
  const estimateCents = cart.reduce((sum, line) => {
    const price = line.item.sale.unitPrice ?? '0';
    const [whole = '0', fraction = ''] = price.split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
    return sum + cents * line.quantity;
  }, 0);
  const estimate = `${Math.floor(estimateCents / 100)}.${String(estimateCents % 100).padStart(2, '0')}`;

  async function ring() {
    if (!depositAccountId) return;
    setBusy(true);
    setError(null);
    try {
      const sale = await api<SaleResult>('/v1/pos/sales', {
        method: 'POST',
        body: {
          saleDate: todayIso(),
          lines: cart.map((line) => ({
            itemId: line.item.id,
            quantity: String(line.quantity),
            ...(line.item.isSerialised
              ? { serialNumbers: line.serials.map((s) => s.trim()).filter((s) => s.length > 0) }
              : {}),
          })),
          method,
          depositAccountId,
          ...(method === 'CASH' && tendered ? { tenderedAmount: tendered } : {}),
        },
      });
      setResult(sale);
      setCart([]);
      setTendered('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-3">
        <h1 className="text-xl font-bold">Point of sale</h1>
        <Input
          placeholder="Search items…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <div className="grid grid-cols-2 gap-2">
          {(items.data ?? []).map((item) => (
            <button
              key={item.id}
              onClick={() => add(item)}
              className="rounded-lg border border-neutral-200 bg-white p-3 text-left shadow-sm hover:border-emerald-500"
            >
              <div className="text-xs text-neutral-500">{item.code}</div>
              <div className="text-sm font-medium">{item.name}</div>
              <div className="mt-1 text-sm font-semibold text-emerald-700">
                {item.sale.unitPrice ? rm(item.sale.unitPrice) : 'price at till'}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <Card title="Sale">
          {cart.length === 0 && !result ? (
            <p className="text-sm text-neutral-500">Tap an item to start.</p>
          ) : null}

          <div className="space-y-2">
            {cart.map((line, index) => (
              <div key={line.item.id} className="rounded-md border border-neutral-100 p-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{line.item.name}</span>
                  <span>
                    {qty(String(line.quantity))} ×{' '}
                    {line.item.sale.unitPrice ? rm(line.item.sale.unitPrice) : '—'}
                  </span>
                  <button
                    className="text-xs text-red-600 hover:underline"
                    onClick={() => setCart(cart.filter((_, i) => i !== index))}
                  >
                    remove
                  </button>
                </div>
                {line.item.isSerialised
                  ? line.serials.map((serial, si) => (
                      <Input
                        key={si}
                        className="mt-1"
                        placeholder={`Serial number ${si + 1} — scan the unit`}
                        value={serial}
                        onChange={(e) =>
                          setCart(
                            cart.map((l, i) =>
                              i === index
                                ? {
                                    ...l,
                                    serials: l.serials.map((s, j) =>
                                      j === si ? e.target.value : s,
                                    ),
                                  }
                                : l,
                            ),
                          )
                        }
                      />
                    ))
                  : null}
              </div>
            ))}
          </div>

          {cart.length > 0 ? (
            <div className="mt-4 space-y-3 border-t border-neutral-200 pt-3">
              <div className="flex justify-between text-sm">
                <span className="text-neutral-500">Estimated total (before tax)</span>
                <span className="font-semibold">{rm(estimate)}</span>
              </div>

              <div className="flex gap-2">
                {(['CASH', 'CARD', 'DUITNOW'] as const).map((m) => (
                  <Button
                    key={m}
                    variant={method === m ? 'primary' : 'ghost'}
                    onClick={() => setMethod(m)}
                  >
                    {m}
                  </Button>
                ))}
              </div>

              {method === 'CASH' ? (
                <Field label="Cash tendered (for change)">
                  <Input
                    inputMode="decimal"
                    placeholder="100.00"
                    value={tendered}
                    onChange={(e) => setTendered(e.target.value)}
                  />
                </Field>
              ) : null}

              <ErrorNote error={error} />
              <Button className="w-full" disabled={busy || !depositAccountId} onClick={() => void ring()}>
                {busy ? 'Ringing…' : 'Ring sale'}
              </Button>
            </div>
          ) : null}
        </Card>

        {result ? (
          <Card title={`Done — ${result.invoiceNo}`}>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Total</span>
                <span className="font-bold">{rm(result.total)}</span>
              </div>
              {result.changeDue ? (
                <div className="flex justify-between text-lg font-bold text-emerald-700">
                  <span>Change due</span>
                  <span data-testid="change-due">{rm(result.changeDue)}</span>
                </div>
              ) : null}
              <Button
                variant="ghost"
                className="w-full"
                onClick={() =>
                  void apiBlobUrl(`/v1/receipts/${result.receiptId}/pdf`).then((url) =>
                    window.open(url, '_blank'),
                  )
                }
              >
                Print receipt
              </Button>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
