'use client';

import { useQuery } from '@tanstack/react-query';
import { api, apiBlobUrl } from '@/lib/api';
import { displayDate, rm, todayIso } from '@/lib/display';
import { Button, Card, Skeleton } from '@/components/ui';
import { Money } from '@/components/money';
import { can, useMe } from '@/lib/me';

/**
 * Today: the Z-report as a screen.
 *
 * The four numbers a shop owner checks at close: what came in by method (to
 * count the drawer against), what was invoiced, what the sold goods cost, and
 * what the day actually made.
 */

interface FreeCash {
  bankBalance: string;
  totalHeld: string;
  freeCash: string;
  verdict: 'COMFORTABLE' | 'TIGHT' | 'SHORT';
  held: { key: string; label: string; owedTo: string; amount: string; dueDate: string | null; note?: string }[];
  soonest: { label: string; amount: string; dueDate: string | null } | null;
}

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

/** Fetch with the session attached, then hand the bytes to the browser —
    a plain window.open cannot carry the Authorization header. */
async function openPdf(path: string) {
  const url = await apiBlobUrl(path);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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

  const free = useQuery({
    queryKey: ['free-cash'],
    queryFn: () => api<FreeCash>('/v1/reports/free-cash'),
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
  const fc = free.data;
  const d = digests.data?.digests[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Today — {displayDate(date)}</h1>
        {/* Closing up is the counter's job, so this rides pos.sale — the same
            permission that rang the sales it totals. */}
        {seesTakings ? (
          <Button
            variant="ghost"
            onClick={() => void openPdf(`/v1/pos/takings/pdf?date=${date}`)}
          >
            Print the day sheet
          </Button>
        ) : null}
      </div>

      {seesTakings ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {/* Raw decimal strings, not rm() — Money formats the resting frame
              itself and counts through changes (a sale rings, Takings rolls). */}
          <Stat label="Takings" value={t ? t.receiptsTotal : '—'} delay={0} />
          <Stat label="Sales" value={t ? `${t.invoiceCount}` : '—'} plain delay={60} />
          <Stat label="Cost of goods" value={t ? t.costOfGoodsSold : '—'} delay={120} />
          <Stat label="Gross profit" value={t ? t.grossProfit : '—'} highlight delay={180} />
        </div>
      ) : null}

      {!seesTakings && !seesMoney && me.data ? (
        <Card>
          <p className="text-sm text-slate-500">
            Welcome. Your work lives in the sections on the left.
          </p>
        </Card>
      ) : null}

      {seesMoney && fc ? <FreeCashCard position={fc} /> : null}

      {seesMoney ? (
      <Card title="Cash — today and ahead">
        {f ? (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-slate-500">In the bank now</span>
              <span className="text-lg font-bold"><Money value={f.openingCash} /></span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-1">Horizon</th>
                  <th className="pb-1 text-right">Coming in</th>
                  <th className="pb-1 text-right">Going out</th>
                  <th className="pb-1 text-right">Cash then</th>
                </tr>
              </thead>
              <tbody>
                {f.horizons.map((h) => (
                  <tr key={h.days} className="border-t border-slate-100">
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
          <Skeleton />
        )}
      </Card>
      ) : null}

      {seesMoney ? (
      <Card title="Last week — anything off?">
        {d ? (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-slate-500">
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
          <p className="text-sm text-slate-500">
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
                <tr key={`${m.method}-${m.depositAccount}`} className="border-t border-slate-100">
                  <td className="py-2 font-medium">{m.method}</td>
                  <td className="py-2 text-slate-500">{m.depositAccount}</td>
                  <td className="py-2 text-right text-slate-500">{m.count}×</td>
                  <td className="py-2 text-right font-medium">{rm(m.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-slate-500">Nothing taken yet today.</p>
        )}
      </Card>
      ) : null}
    </div>
  );
}

function WeekStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
  plain,
  delay = 0,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  /** A count rather than an amount — rendered as-is, no RM, no count-up. */
  plain?: boolean;
  /** Entrance stagger in ms — the charts.tsx idiom, capped by the caller. */
  delay?: number;
}) {
  return (
    <div
      className="emil-rise rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div
        className={`mt-1.5 text-2xl font-semibold tracking-tight ${
          highlight ? 'text-emerald-600' : 'text-slate-900'
        }`}
      >
        {plain ? value : <Money value={value} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const VERDICT: Record<
  FreeCash['verdict'],
  { tone: string; band: string; headline: string; advice: string }
> = {
  COMFORTABLE: {
    tone: 'text-emerald-700',
    band: 'bg-emerald-50 ring-emerald-200',
    headline: 'yours to spend',
    advice: 'Everything you are holding for other people is covered, with room left over.',
  },
  TIGHT: {
    tone: 'text-amber-700',
    band: 'bg-amber-50 ring-amber-200',
    headline: 'yours to spend',
    advice:
      'Most of the money in the bank is not yours. It will cover what is owed — but a big purchase now would be spending other people’s money.',
  },
  SHORT: {
    tone: 'text-red-700',
    band: 'bg-red-50 ring-red-300',
    headline: 'short of what you are holding',
    advice:
      'The money you are holding for staff and the government is MORE than what is in the bank. Some of it has already been spent. The next deadline will overdraw you unless money comes in first.',
  },
};

/**
 * The bank balance, minus what isn't yours.
 *
 * Placed above the forecast deliberately: the forecast answers "will money
 * arrive", and this answers "is the money already here even mine". A shop
 * that reads the second number wrongly buys stock with the staff's EPF and
 * finds out on the 15th.
 *
 * Every figure is a real ledger balance — EPF_PAYABLE, PCB_PAYABLE and the
 * rest — so this cannot drift from the balance sheet.
 */
function FreeCashCard({ position }: { position: FreeCash }) {
  const style = VERDICT[position.verdict];
  const short = position.verdict === 'SHORT';

  return (
    <Card>
      <div className={`rounded-lg p-4 ring-1 ring-inset ${style.band}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Actually yours
            </p>
            <p className={`text-3xl font-bold ${style.tone}`}>
              {rm(position.freeCash)}
            </p>
            <p className="text-xs text-slate-600">{style.headline}</p>
          </div>
          <div className="text-right text-sm">
            <p className="text-slate-600">
              In the bank <span className="font-semibold">{rm(position.bankBalance)}</span>
            </p>
            <p className="text-slate-600">
              Held for others{' '}
              <span className="font-semibold">{rm(position.totalHeld)}</span>
            </p>
          </div>
        </div>
        <p className={`mt-2 text-sm ${short ? 'font-medium text-red-700' : 'text-slate-600'}`}>
          {style.advice}
        </p>
      </div>

      {position.held.length > 0 ? (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="pb-1">Not yours</th>
              <th className="pb-1 text-right">Amount</th>
              <th className="pb-1 text-right">Leaves by</th>
            </tr>
          </thead>
          <tbody>
            {position.held.map((line) => (
              <tr key={line.key} className="border-t border-slate-100 align-top">
                <td className="py-1.5">
                  <div className="font-medium text-slate-900">{line.label}</div>
                  <div className="text-xs text-slate-500">{line.owedTo}</div>
                  {line.note ? (
                    <div className="text-xs text-amber-700">{line.note}</div>
                  ) : null}
                </td>
                <td className="py-1.5 text-right font-medium">{rm(line.amount)}</td>
                <td className="py-1.5 text-right text-xs text-slate-500">
                  {line.dueDate === null ? 'no fixed date' : displayDate(line.dueDate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-3 text-sm text-slate-500">
          You are not holding anything for anyone right now — the whole balance is yours.
        </p>
      )}
    </Card>
  );
}
