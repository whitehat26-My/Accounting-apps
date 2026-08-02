'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Card } from '@/components/ui';

/**
 * Today: the Z-report as a screen.
 *
 * The four numbers a shop owner checks at close: what came in by method (to
 * count the drawer against), what was invoiced, what the sold goods cost, and
 * what the day actually made.
 */

interface Takings {
  date: string;
  byMethod: { method: string; depositAccount: string; total: string; count: number }[];
  receiptsTotal: string;
  invoicedTotal: string;
  invoiceCount: number;
  costOfGoodsSold: string;
  grossProfit: string;
}

export default function TodayPage() {
  const date = todayIso();
  const takings = useQuery({
    queryKey: ['takings', date],
    queryFn: () => api<Takings>(`/v1/pos/takings?date=${date}`),
    refetchInterval: 60_000,
  });

  const t = takings.data;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Today — {displayDate(date)}</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Takings" value={t ? rm(t.receiptsTotal) : '—'} />
        <Stat label="Sales" value={t ? `${t.invoiceCount}` : '—'} />
        <Stat label="Cost of goods" value={t ? rm(t.costOfGoodsSold) : '—'} />
        <Stat label="Gross profit" value={t ? rm(t.grossProfit) : '—'} highlight />
      </div>

      <Card title="Drawer — by payment method">
        {t && t.byMethod.length > 0 ? (
          <table className="w-full text-sm">
            <tbody>
              {t.byMethod.map((m) => (
                <tr key={`${m.method}-${m.depositAccount}`} className="border-t border-neutral-100">
                  <td className="py-2 font-medium">{m.method}</td>
                  <td className="py-2 text-neutral-500">{m.depositAccount}</td>
                  <td className="py-2 text-right text-neutral-500">{m.count}×</td>
                  <td className="py-2 text-right font-medium">{rm(m.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-neutral-500">Nothing taken yet today.</p>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className={`mt-1 text-xl font-bold ${highlight ? 'text-emerald-700' : ''}`}>{value}</div>
    </div>
  );
}
