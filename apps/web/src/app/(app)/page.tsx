'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Card } from '@/components/ui';
import { can, useMe } from '@/lib/me';

/**
 * Today: the Z-report as a screen.
 *
 * The four numbers a shop owner checks at close: what came in by method (to
 * count the drawer against), what was invoiced, what the sold goods cost, and
 * what the day actually made.
 */

interface Forecast {
  openingCash: string;
  horizons: { days: number; until: string; inflows: string; outflows: string; closing: string }[];
  overdueReceivables: { total: string; count: number };
}

interface DigestList {
  digests: {
    id: string;
    weekStart: string;
    weekEnd: string;
    warnCount: number;
    digest: {
      week: { salesNet: string; takings: string; grossProfit: string; expenses: string; daysWithSales: number };
      comparedAgainstWeeks: number;
      flags: { code: string; severity: 'INFO' | 'WARN'; message: string }[];
    };
  }[];
}

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
  const me = useMe();
  // Each block asks for exactly what its API call requires, so a cashier's
  // Today is the till and a technician's is a calm empty page — no 403 noise.
  const seesTakings = can(me.data, 'pos.sale');
  const seesMoney = can(me.data, 'report.read');

  const takings = useQuery({
    queryKey: ['takings', date],
    queryFn: () => api<Takings>(`/v1/pos/takings?date=${date}`),
    refetchInterval: 60_000,
    enabled: seesTakings,
  });

  const forecast = useQuery({
    queryKey: ['cash-forecast'],
    queryFn: () => api<Forecast>('/v1/reports/cash-forecast'),
    refetchInterval: 300_000,
    enabled: seesMoney,
  });

  const digests = useQuery({
    queryKey: ['weekly-digests'],
    queryFn: () => api<DigestList>('/v1/reports/weekly-digests?limit=1'),
    refetchInterval: 3_600_000,
    enabled: seesMoney,
  });

  const t = takings.data;
  const f = forecast.data;
  const d = digests.data?.digests[0];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Today — {displayDate(date)}</h1>

      {seesTakings ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Takings" value={t ? rm(t.receiptsTotal) : '—'} />
          <Stat label="Sales" value={t ? `${t.invoiceCount}` : '—'} />
          <Stat label="Cost of goods" value={t ? rm(t.costOfGoodsSold) : '—'} />
          <Stat label="Gross profit" value={t ? rm(t.grossProfit) : '—'} highlight />
        </div>
      ) : null}

      {!seesTakings && !seesMoney && me.data ? (
        <Card>
          <p className="text-sm text-neutral-500">
            Welcome. Your work lives in the sections on the left.
          </p>
        </Card>
      ) : null}

      {seesMoney ? (
      <Card title="Cash — today and ahead">
        {f ? (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-neutral-500">In the bank now</span>
              <span className="text-lg font-bold">{rm(f.openingCash)}</span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-neutral-500">
                  <th className="pb-1">Horizon</th>
                  <th className="pb-1 text-right">Coming in</th>
                  <th className="pb-1 text-right">Going out</th>
                  <th className="pb-1 text-right">Cash then</th>
                </tr>
              </thead>
              <tbody>
                {f.horizons.map((h) => (
                  <tr key={h.days} className="border-t border-neutral-100">
                    <td className="py-1.5">{h.days} days</td>
                    <td className="py-1.5 text-right text-emerald-700">{rm(h.inflows)}</td>
                    <td className="py-1.5 text-right text-red-600">{rm(h.outflows)}</td>
                    <td
                      className={`py-1.5 text-right font-semibold ${
                        h.closing.startsWith('-') ? 'text-red-700' : ''
                      }`}
                    >
                      {rm(h.closing)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {f.overdueReceivables.count > 0 ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {rm(f.overdueReceivables.total)} across {f.overdueReceivables.count} overdue
                invoice{f.overdueReceivables.count > 1 ? 's' : ''} is NOT counted above —
                late payers have unknown timing. Chase them in Collections.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">Loading…</p>
        )}
      </Card>
      ) : null}

      {seesMoney ? (
      <Card title="Last week — anything off?">
        {d ? (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-neutral-500">
                {displayDate(d.weekStart)} – {displayDate(d.weekEnd)}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                  d.warnCount > 0 ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-800'
                }`}
              >
                {d.warnCount > 0
                  ? `${d.warnCount} thing${d.warnCount > 1 ? 's' : ''} to look at`
                  : 'Normal week'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm lg:grid-cols-4">
              <WeekStat label="Sales" value={rm(d.digest.week.salesNet)} />
              <WeekStat label="Gross profit" value={rm(d.digest.week.grossProfit)} />
              <WeekStat label="Expenses" value={rm(d.digest.week.expenses)} />
              <WeekStat label="Collected" value={rm(d.digest.week.takings)} />
            </div>
            {d.digest.flags.length > 0 ? (
              <ul className="space-y-2">
                {d.digest.flags.map((flag) => (
                  <li
                    key={flag.code}
                    className={`rounded-md px-3 py-2 text-xs ${
                      flag.severity === 'WARN'
                        ? 'bg-amber-50 text-amber-900'
                        : 'bg-emerald-50 text-emerald-900'
                    }`}
                  >
                    {flag.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-neutral-500">
            The first digest appears after a full Monday-to-Sunday week of trading.
          </p>
        )}
      </Card>
      ) : null}

      {seesTakings ? (
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
      ) : null}
    </div>
  );
}

function WeekStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-neutral-50 px-3 py-2">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="font-semibold">{value}</div>
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
