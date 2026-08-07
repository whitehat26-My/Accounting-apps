'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { displayDate, rm } from '@/lib/display';
import { Card, Skeleton } from '@/components/ui';
import { BarChart, HBarChart, TrendLine } from '@/components/charts';

/**
 * Insights: the shop's numbers as pictures.
 *
 * Three questions, one chart each: how were the last two weeks (daily bars),
 * where is the business heading (weekly trend from the stored digests), and
 * will there be money (forecast horizons). Every figure is a server string;
 * the SVGs only turn them into geometry.
 */

interface DailySeries {
  from: string;
  to: string;
  points: { date: string; receipts: string; invoiced: string; grossProfit: string }[];
}

interface DigestList {
  digests: {
    id: string;
    weekStart: string;
    warnCount: number;
    digest: { week: { salesNet: string; grossProfit: string } };
  }[];
}

interface Forecast {
  openingCash: string;
  horizons: { days: number; closing: string }[];
  overdueReceivables: { total: string; count: number };
}

export default function InsightsPage() {
  const daily = useQuery({
    queryKey: ['daily-takings'],
    queryFn: () => api<DailySeries>('/v1/reports/daily-takings?days=14'),
    refetchInterval: 300_000,
  });

  const weekly = useQuery({
    queryKey: ['weekly-digests', 'trend'],
    queryFn: () => api<DigestList>('/v1/reports/weekly-digests?limit=12'),
  });

  const forecast = useQuery({
    queryKey: ['cash-forecast'],
    queryFn: () => api<Forecast>('/v1/reports/cash-forecast'),
  });

  const trend = [...(weekly.data?.digests ?? [])].reverse();
  const f = forecast.data;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">Insights</h1>

      <Card title="Daily takings — last 14 days">
        {daily.data ? (
          <BarChart
            points={daily.data.points.map((p) => ({
              label: displayDate(p.date),
              value: p.receipts,
            }))}
          />
        ) : (
          <Skeleton />
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Weekly sales trend">
          {weekly.data ? (
            <TrendLine
              points={trend.map((d) => ({
                label: displayDate(d.weekStart),
                value: d.digest.week.salesNet,
              }))}
            />
          ) : (
            <Skeleton />
          )}
        </Card>

        <Card title="Cash ahead">
          {f ? (
            <div className="space-y-3">
              <HBarChart
                rows={[
                  { label: 'In the bank now', value: f.openingCash },
                  ...f.horizons.map((h) => ({
                    label: `In ${h.days} days`,
                    value: h.closing,
                  })),
                ]}
              />
              {f.overdueReceivables.count > 0 ? (
                <p className="text-xs text-caution">
                  Plus {rm(f.overdueReceivables.total)} overdue — timing unknown, chase it.
                </p>
              ) : null}
            </div>
          ) : (
            <Skeleton />
          )}
        </Card>
      </div>

      <Card title="Weekly gross profit">
        {weekly.data ? (
          trend.length > 0 ? (
            <BarChart
              height={120}
              points={trend.map((d) => ({
                label: displayDate(d.weekStart),
                value: d.digest.week.grossProfit,
              }))}
            />
          ) : (
            <p className="text-sm text-ink-muted">
              Appears once the first weekly digest is stored.
            </p>
          )
        ) : (
          <Skeleton />
        )}
      </Card>
    </div>
  );
}
