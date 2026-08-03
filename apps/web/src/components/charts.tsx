'use client';

import { rm } from '@/lib/display';

/**
 * Hand-rolled SVG charts — no chart library.
 *
 * A dependency would do more, and rot faster; three small components cover
 * everything this app plots, render identically in the static demo, and add
 * zero kilobytes of vendor code.
 *
 * NUMBERS HERE ARE PIXELS, NOT MONEY. The app-wide rule stands: amounts are
 * strings end to end and no client arithmetic produces a displayed figure.
 * `Number()` below converts a server decimal string into a bar height or a
 * point position — presentation geometry only. Every label a user reads is
 * formatted from the server's string, never from these scaled values.
 */

const scale = (decimal: string) => Number(decimal);

export function BarChart({
  points,
  height = 160,
}: {
  points: { label: string; value: string; secondary?: string }[];
  height?: number;
}) {
  if (points.length === 0) return null;
  const max = Math.max(...points.map((p) => scale(p.value)), 1);
  const barW = 100 / points.length;

  return (
    <div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none"
           className="w-full" style={{ height }}>
        {points.map((p, i) => {
          const h = (scale(p.value) / max) * (height - 8);
          return (
            <rect
              key={p.label}
              x={i * barW + barW * 0.15}
              y={height - h}
              width={barW * 0.7}
              height={h}
              rx={1}
              className="fill-emerald-600"
            >
              <title>{`${p.label}: ${rm(p.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-neutral-400">
        <span>{points[0]!.label}</span>
        <span>{points[points.length - 1]!.label}</span>
      </div>
    </div>
  );
}

export function TrendLine({
  points,
  height = 120,
}: {
  points: { label: string; value: string }[];
  height?: number;
}) {
  if (points.length < 2) {
    return <p className="text-sm text-neutral-500">Not enough history to draw yet.</p>;
  }
  const values = points.map((p) => scale(p.value));
  const max = Math.max(...values, 1);
  const step = 100 / (points.length - 1);
  const y = (v: number) => height - 6 - (v / max) * (height - 12);
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${i * step},${y(v)}`).join(' ');

  return (
    <div>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none"
           className="w-full" style={{ height }}>
        <path d={`${path} L100,${height} L0,${height} Z`} className="fill-emerald-100" />
        <path d={path} className="fill-none stroke-emerald-700" strokeWidth={1.5}
              vectorEffect="non-scaling-stroke" />
        {values.map((v, i) => (
          <circle key={points[i]!.label} cx={i * step} cy={y(v)} r={1.6}
                  className="fill-emerald-700">
            <title>{`${points[i]!.label}: ${rm(points[i]!.value)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-neutral-400">
        <span>{points[0]!.label}</span>
        <span>{points[points.length - 1]!.label}</span>
      </div>
    </div>
  );
}

/** Horizontal bars for a small fixed set — the forecast horizons. */
export function HBarChart({
  rows,
}: {
  rows: { label: string; value: string }[];
}) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => Math.abs(scale(r.value))), 1);

  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const negative = r.value.startsWith('-');
        const width = (Math.abs(scale(r.value)) / max) * 100;
        return (
          <div key={r.label}>
            <div className="mb-0.5 flex justify-between text-xs">
              <span className="text-neutral-500">{r.label}</span>
              <span className={`font-semibold ${negative ? 'text-red-700' : ''}`}>
                {rm(r.value)}
              </span>
            </div>
            <div className="h-2 rounded bg-neutral-100">
              <div
                className={`h-2 rounded ${negative ? 'bg-red-500' : 'bg-emerald-600'}`}
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
