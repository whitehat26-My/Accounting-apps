'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { rm } from '@/lib/display';
import { Button, Card, ErrorNote, Field, Input } from '@/components/ui';

/**
 * The catalogue, kept to what a shop needs on day one: see what is sellable,
 * add a product with a price, choose whether the shelf counts it. Accounts
 * and tax codes come from sensible defaults — the revenue account and the
 * out-of-scope code onboarding created — and stay overridable via the API for
 * the accountant who needs more.
 */

interface Item {
  id: string;
  code: string;
  name: string;
  itemType: string;
  isTracked: boolean;
  isSerialised: boolean;
  sale: { unitPrice: string | null };
}

interface Account {
  id: string;
  code: string;
}

interface TaxCode {
  id: string;
  code: string;
}

export default function ItemsPage() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState('');
  const [price, setPrice] = useState('');
  const [kind, setKind] = useState<'GOODS' | 'SERVICE'>('GOODS');
  const [tracked, setTracked] = useState(true);
  const [serialised, setSerialised] = useState(false);
  const [warrantyMonths, setWarrantyMonths] = useState('');

  const items = useQuery({
    queryKey: ['items', ''],
    queryFn: () => api<Item[]>('/v1/items?direction=SALE'),
  });
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api<{ accounts: Account[] }>('/v1/accounts'),
  });
  const taxCodes = useQuery({
    queryKey: ['taxCodes'],
    queryFn: () => api<{ taxCodes: TaxCode[] }>('/v1/tax-codes'),
  });

  const create = useMutation({
    mutationFn: async () => {
      const revenue = accounts.data?.accounts.find((a) => a.code === '4000');
      const purchases = accounts.data?.accounts.find((a) => a.code === '5000');
      const none = taxCodes.data?.taxCodes.find((t) => t.code === 'NONE');
      if (!revenue || !none) throw new Error('Chart not loaded yet — try again');

      return api('/v1/items', {
        method: 'POST',
        body: {
          code,
          name,
          ...(barcode.trim() !== '' ? { barcode: barcode.trim() } : {}),
          itemType: kind,
          isSold: true,
          isPurchased: kind === 'GOODS',
          isTracked: kind === 'GOODS' && tracked,
          isSerialised: kind === 'GOODS' && tracked && serialised,
          // Only meaningful with serials: the promise is derived from the
          // sale of a NAMED unit, so an unserialised item has nothing to
          // hang it on. Sent as 0 rather than omitted so the intent is
          // explicit in the request.
          warrantyMonths:
            kind === 'GOODS' && tracked && serialised ? Number(warrantyMonths || 0) : 0,
          sale: { unitPrice: price, accountId: revenue.id, taxCodeId: none.id },
          ...(kind === 'GOODS' && purchases
            ? { purchase: { accountId: purchases.id, taxCodeId: none.id } }
            : {}),
        },
      });
    },
    onSuccess: () => {
      setCode('');
      setName('');
      setBarcode('');
      setPrice('');
      setWarrantyMonths('');
      void queryClient.invalidateQueries({ queryKey: ['items'] });
    },
  });

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Items</h1>
        <Card>
          <table className="w-full text-sm">
            <tbody>
              {(items.data ?? []).map((item) => (
                <tr key={item.id} className="border-t border-line">
                  <td className="py-2 text-xs text-ink-muted">{item.code}</td>
                  <td className="py-2">{item.name}</td>
                  <td className="py-2 text-xs text-ink-muted">
                    {item.itemType}
                    {item.isTracked ? ' · tracked' : ''}
                    {item.isSerialised ? ' · serials' : ''}
                  </td>
                  <td className="py-2 text-right font-medium">
                    {item.sale.unitPrice ? rm(item.sale.unitPrice) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">&nbsp;</h1>
        <Card title="New item">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Code">
              <Input value={code} onChange={(e) => setCode(e.target.value)} required placeholder="SSD-1TB" />
            </Field>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="1TB NVMe SSD" />
            </Field>
            <Field label="Barcode (optional)">
              {/* Click here, scan the product, done — the scanner types it. */}
              <Input
                value={barcode}
                onChange={(e) => setBarcode(e.target.value)}
                placeholder="Scan or type the EAN"
              />
            </Field>
            <Field label="Selling price (RM)">
              <Input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required
                inputMode="decimal"
                placeholder="400.00"
              />
            </Field>
            <div className="flex gap-2">
              {(['GOODS', 'SERVICE'] as const).map((k) => (
                <Button key={k} type="button" variant={kind === k ? 'primary' : 'ghost'} onClick={() => setKind(k)}>
                  {k === 'GOODS' ? 'Product' : 'Service'}
                </Button>
              ))}
            </div>
            {kind === 'GOODS' ? (
              <div className="space-y-1 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={tracked} onChange={(e) => setTracked(e.target.checked)} />
                  Track stock quantities and cost
                </label>
                {tracked ? (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={serialised}
                      onChange={(e) => setSerialised(e.target.checked)}
                    />
                    Every unit has a serial number
                  </label>
                ) : null}
                {tracked && serialised ? (
                  <Field label="Warranty (months) — 0 for none">
                    <Input
                      type="number"
                      min={0}
                      max={120}
                      inputMode="numeric"
                      value={warrantyMonths}
                      onChange={(e) => setWarrantyMonths(e.target.value)}
                      placeholder="12"
                    />
                  </Field>
                ) : null}
              </div>
            ) : null}
            <ErrorNote error={create.error} />
            {/*
              Disabled until the chart of accounts and the tax codes have
              arrived. The mutation refuses without them ("Chart not loaded yet
              — try again"), which is correct but is an error message where a
              disabled button belongs: the person did nothing wrong, the page
              was not ready, and telling them to retry is asking them to do the
              waiting the interface should have done.
            */}
            <Button
              type="submit"
              disabled={create.isPending || !accounts.data || !taxCodes.data}
              className="w-full"
            >
              {create.isPending
                ? 'Saving…'
                : !accounts.data || !taxCodes.data
                  ? 'Loading the chart…'
                  : 'Add item'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
