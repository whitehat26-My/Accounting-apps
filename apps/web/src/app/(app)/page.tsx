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

/** Matches the Insights screen's shape — the same endpoint, the same rows. */
interface DailySeries {
  points: { date: string; receipts: string; grossProfit: string }[];
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

  /*
   * The 14-day series behind the summary tiles.
   *
   * Same queryKey as the Insights screen, so TanStack serves both from ONE
   * cache entry and one request — this costs the dashboard nothing that
   * Insights was not already fetching.
   */
  const daily = useQuery({
    queryKey: ['daily-takings'],
    queryFn: () => api<DailySeries>('/v1/reports/daily-takings?days=14'),
    enabled: seesTakings,
    refetchInterval: 300_000,
  });

  const digests = useQuery({
    queryKey: ['weekly-digests'],
    queryFn: () => api<DigestList>('/v1/reports/weekly-digests?limit=1'),
    refetchInterval: 3_600_000,
    enabled: seesMoney,
  });

  const t = takings.data;
  /*
   * A decimal string per day, straight to a number for DRAWING ONLY.
   *
   * `Number()` on money is normally forbidden here and rightly so — but this
   * value never returns to the ledger, never reaches an input, and never gets
   * displayed. It picks a Y coordinate in a 28-unit viewBox, where float error
   * is many orders of magnitude below one screen pixel. Every figure a person
   * READS on this page is still the untouched string, formatted by `rm()`.
   */
  const series = (field: 'receipts' | 'grossProfit'): number[] =>
    (daily.data?.points ?? []).map((point) => Number(point[field]));

  const f = forecast.data;
  const fc = free.data;
  const d = digests.data?.digests[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Today — {displayDate(date)}</h1>
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
        /*
          ONE ACROSS ON A PHONE, NOT TWO.

          These were two-up at every width. On a 390px screen that leaves each
          tile 131px of interior, and the figure inside is `text-3xl
          font-extrabold` — "RM 12,345.00" wants about 190px. The number a shop
          owner opens this page to read was the one thing that did not fit.
          Full width to 640px, two across on a tablet, four on a desk.
        */
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Raw decimal strings, not rm() — Money formats the resting frame
              itself and counts through changes (a sale rings, Takings rolls). */}
          <Stat
            label="Takings"
            value={t ? t.receiptsTotal : '—'}
            delay={0}
            delta
            trend={series('receipts')}
          />
          <Stat label="Sales" value={t ? `${t.invoiceCount}` : '—'} plain delay={60} />
          <Stat label="Cost of goods" value={t ? t.costOfGoodsSold : '—'} delay={120} />
          <Stat
            label="Gross profit"
            value={t ? t.grossProfit : '—'}
            highlight
            delay={180}
            delta
            trend={series('grossProfit')}
          />
        </div>
      ) : null}

      {!seesTakings && !seesMoney && me.data ? (
        <Card>
          <p className="text-sm text-ink-muted">
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
              <span className="text-sm text-ink-muted">In the bank now</span>
              <span className="text-lg font-bold"><Money value={f.openingCash} /></span>
            </div>
            <table className="min-w-[24rem] w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-muted">
                  <th className="pb-1">Horizon</th>
                  <th className="pb-1 text-right">Coming in</th>
                  <th className="pb-1 text-right">Going out</th>
                  <th className="pb-1 text-right">Cash then</th>
                </tr>
              </thead>
              <tbody>
                {f.horizons.map((h) => (
                  <tr key={h.days} className="border-t border-line">
                    <td className="py-1.5">{h.days} days</td>
                    <td className="py-1.5 text-right text-positive">{rm(h.inflows)}</td>
                    <td className="py-1.5 text-right text-negative">{rm(h.outflows)}</td>
                    <td
                      className={`py-1.5 text-right font-semibold ${
                        h.closing.startsWith('-') ? 'text-negative' : ''
                      }`}
                    >
                      {rm(h.closing)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {f.overdueReceivables.count > 0 ? (
              <p className="rounded-md bg-caution-soft px-3 py-2 text-xs text-caution">
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
              <span className="text-sm text-ink-muted">
                {displayDate(d.weekStart)} – {displayDate(d.weekEnd)}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                  d.warnCount > 0 ? 'bg-caution-soft text-caution' : 'bg-positive-soft text-positive'
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
                        ? 'bg-caution-soft text-caution'
                        : 'bg-positive-soft text-positive'
                    }`}
                  >
                    {flag.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">
            The first digest appears after a full Monday-to-Sunday week of trading.
          </p>
        )}
      </Card>
      ) : null}

      {seesTakings ? (
      <Card title="Drawer — by payment method">
        {t && t.byMethod.length > 0 ? (
          <table className="min-w-[24rem] w-full text-sm">
            <tbody>
              {t.byMethod.map((m) => (
                <tr key={`${m.method}-${m.depositAccount}`} className="border-t border-line">
                  <td className="py-2 font-medium">{m.method}</td>
                  <td className="py-2 text-ink-muted">{m.depositAccount}</td>
                  <td className="py-2 text-right text-ink-muted">{m.count}×</td>
                  <td className="py-2 text-right font-medium">{rm(m.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-ink-muted">Nothing taken yet today.</p>
        )}
      </Card>
      ) : null}
    </div>
  );
}

function WeekStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-sunken px-3 py-2">
      <div className="text-xs text-ink-muted">{label}</div>
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
  delta = false,
  trend,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  /** A count rather than an amount — rendered as-is, no RM, no count-up. */
  plain?: boolean;
  /** Entrance stagger in ms — the charts.tsx idiom, capped by the caller. */
  delay?: number;
  /** Flash what the figure moved by when it changes. See the note below. */
  delta?: boolean;
  /**
   * The last 14 days of this figure, drawn faintly behind it.
   *
   * REAL NUMBERS OR NOTHING. A decorative squiggle on an accounting dashboard
   * is a lie sitting beside figures that are not, and the person reading it
   * cannot tell which is which — they will see a rising line next to their
   * takings and believe it. Fewer than two points draws nothing at all, which
   * is the honest thing for a shop that opened yesterday.
   */
  trend?: number[];
}) {
  return (
    <div
      className="emil-rise relative overflow-hidden rounded-2xl bg-surface-raised p-4 shadow-md ring-1 ring-line"
      style={{ animationDelay: `${delay}ms` }}
    >
      {trend && trend.length > 1 ? <Sparkline points={trend} /> : null}
      <div className="relative text-xs font-medium text-ink-muted">{label}</div>
      <div
        className={`relative mt-1.5 text-3xl font-extrabold tracking-tight ${
          highlight ? 'text-positive' : 'text-ink'
        }`}
      >
        {/*
          `delta` only on the tiles a sale actually moves.

          Takings and gross profit change the moment somebody rings something
          up, and the chip is what turns a dashboard that refreshes every 60s
          into a shop keeping score. Cost of goods moves too but nobody watches
          it land, and a count of invoices is not money at all.
        */}
        {plain ? value : <Money value={value} delta={delta} />}
      </div>
    </div>
  );
}

/**
 * Fourteen days of a figure, as a filled area behind the tile.
 *
 * `preserveAspectRatio="none"` so it stretches to whatever the tile is; the
 * viewBox is arbitrary units and the shape is what matters, not the scale.
 * `aria-hidden` because the accessible content is the FIGURE — a screen reader
 * announcing a polyline helps nobody, and the number is already there.
 *
 * Flat series (a shop with one trading day, or the same total every day) would
 * divide by zero on the range; they render as a flat line at the bottom, which
 * is true.
 */
function Sparkline({ points }: { points: number[] }) {
  const min = Math.min(...points);
  const max = Math.max(...points);

  /*
   * Nothing has happened yet, so draw nothing.
   *
   * All-zero days are a real answer and a flat line pinned to the floor is not
   * how to give it: it vanishes into the bottom edge, and the only thing left
   * on screen is whatever single day was not zero — which then reads as a
   * decorative arrow floating beside the figure rather than as a chart. Found
   * by looking at it, not by reading the code: the maths was right and the
   * result was misleading.
   */
  if (max <= 0) return null;

  /*
   * The baseline sits ABOVE the floor (26, not 28) so a quiet day is still a
   * visible line. A chart whose zero is invisible only ever shows its spikes.
   */
  const span = max - min || max;
  const step = 100 / (points.length - 1);
  const y = (v: number) => 26 - ((v - min) / span) * 20;

  const line = `M${points.map((v, i) => `${i * step},${y(v)}`).join(' L')}`;
  const area = `${line} L100,28 L0,28 Z`;

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-10 w-full"
    >
      <path d={area} className="fill-primary" opacity={0.08} />
      <path
        d={line}
        fill="none"
        strokeWidth={1.25}
        strokeLinejoin="round"
        className="stroke-primary"
        opacity={0.35}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------

const VERDICT: Record<
  FreeCash['verdict'],
  { tone: string; band: string; headline: string; advice: string }
> = {
  COMFORTABLE: {
    tone: 'text-positive',
    band: 'bg-positive-soft ring-positive/30',
    headline: 'yours to spend',
    advice: 'Everything you are holding for other people is covered, with room left over.',
  },
  TIGHT: {
    tone: 'text-caution',
    band: 'bg-caution-soft ring-caution/30',
    headline: 'yours to spend',
    advice:
      'Most of the money in the bank is not yours. It will cover what is owed — but a big purchase now would be spending other people’s money.',
  },
  SHORT: {
    tone: 'text-negative',
    band: 'bg-negative-soft ring-negative/40',
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
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Actually yours
            </p>
            <p className={`text-3xl font-bold ${style.tone}`}>
              {rm(position.freeCash)}
            </p>
            <p className="text-xs text-ink-muted">{style.headline}</p>
          </div>
          <div className="text-right text-sm">
            <p className="text-ink-muted">
              In the bank <span className="font-semibold">{rm(position.bankBalance)}</span>
            </p>
            <p className="text-ink-muted">
              Held for others{' '}
              <span className="font-semibold">{rm(position.totalHeld)}</span>
            </p>
          </div>
        </div>
        <p className={`mt-2 text-sm ${short ? 'font-medium text-negative' : 'text-ink-muted'}`}>
          {style.advice}
        </p>
      </div>

      {position.held.length > 0 ? (
        <table className="min-w-[19rem] mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-muted">
              <th className="pb-1">Not yours</th>
              <th className="pb-1 text-right">Amount</th>
              <th className="pb-1 text-right">Leaves by</th>
            </tr>
          </thead>
          <tbody>
            {position.held.map((line) => (
              <tr key={line.key} className="border-t border-line align-top">
                <td className="py-1.5">
                  <div className="font-medium text-ink">{line.label}</div>
                  <div className="text-xs text-ink-muted">{line.owedTo}</div>
                  {line.note ? (
                    <div className="text-xs text-caution">{line.note}</div>
                  ) : null}
                </td>
                <td className="py-1.5 text-right font-medium">{rm(line.amount)}</td>
                <td className="py-1.5 text-right text-xs text-ink-muted">
                  {line.dueDate === null ? 'no fixed date' : displayDate(line.dueDate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-3 text-sm text-ink-muted">
          You are not holding anything for anyone right now — the whole balance is yours.
        </p>
      )}
    </Card>
  );
}
