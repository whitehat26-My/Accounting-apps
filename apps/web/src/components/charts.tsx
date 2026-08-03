'use client';

import { useEffect, useRef, useState } from 'react';
import { rm } from '@/lib/display';

/**
 * Hand-rolled SVG charts — no chart library.
 *
 * A dependency would do more, and rot faster; three small components cover
 * everything this app plots, render identically in the static demo, and add
 * zero kilobytes of vendor code.
 *
 * ---------------------------------------------------------------------------
 * NUMBERS HERE ARE PIXELS, NOT MONEY.
 *
 * The app-wide rule stands: amounts are strings end to end and no client
 * arithmetic produces a displayed figure. `scale()` below turns a server
 * decimal string into a bar height or a point position — presentation geometry
 * only, and it never travels back out as text.
 *
 * Which is why the y-axis labels ONLY the baseline and the peak, and the peak
 * is the real maximum data point's own string rather than a "nice" round
 * number this file invented. Intermediate gridlines are drawn but never
 * labelled: a tick reading "RM 4,000" would be a figure no server ever sent.
 * The cents are dropped from the axis label (`ringgit()` — a string slice, not
 * a rounding), which is conventional for an axis; the exact amount is in the
 * tooltip and in the table view under every chart.
 * ---------------------------------------------------------------------------
 *
 * The marks follow one spec everywhere: bars capped at 24px with a 4px
 * rounded cap and a square foot on the baseline, 2px lines with round joins,
 * 8px dots ringed in the surface colour, area fills as a 10% wash, and
 * hairline gridlines one step off white. Nothing is drawn with a border —
 * separation is done by gaps in the surface.
 */

const scale = (decimal: string) => Number(decimal);

/** Chart chrome, one step off the white card surface. */
const GRID = '#e2e8f0';
const BASELINE = '#cbd5e1';
const SURFACE = '#ffffff';
const SERIES = '#059669';
const NEGATIVE = '#dc2626';

/**
 * `rm()` with the cents dropped, for an axis label where "RM 12,076.80" will
 * not fit and does not need to. A string slice — never a rounding of money.
 */
function ringgit(decimal: string): string {
  const formatted = rm(decimal);
  const dot = formatted.lastIndexOf('.');
  return dot === -1 ? formatted : formatted.slice(0, dot);
}

/**
 * The container's real pixel width.
 *
 * Charts are drawn at true device pixels rather than in a stretched viewBox.
 * The old `preserveAspectRatio="none"` approach scaled x and y by different
 * factors, which turned every rounded corner into an ellipse and every stroke
 * into an inconsistent weight — the single biggest reason the charts read as
 * homemade. Measuring costs one ResizeObserver and makes every spec below
 * mean what it says.
 */
function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/** A bar with a rounded cap and a square foot planted on the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return '';
  return (
    `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} ` +
    `L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`
  );
}

/** The same, lying down: rounded at the tip, square at the baseline. */
function rowPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, h / 2, w);
  if (w <= 0) return '';
  return (
    `M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} ` +
    `L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`
  );
}

interface Hovered {
  x: number;
  y: number;
  label: string;
  value: string;
}

function Tooltip({ hovered }: { hovered: Hovered | null }) {
  if (!hovered) return null;
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg bg-slate-900 px-2.5 py-1.5 shadow-lg"
      style={{ left: hovered.x, top: hovered.y - 8 }}
    >
      {/* Value leads, label follows — the reader already knows which bar they
          are pointing at; what they came for is the number. */}
      <div className="text-xs font-semibold text-white">{rm(hovered.value)}</div>
      <div className="text-[10px] text-slate-300">{hovered.label}</div>
    </div>
  );
}

/**
 * Every chart ships its numbers as a table too.
 *
 * A tooltip enhances; it must never be the only way to reach a value. This is
 * also the answer for anyone reading with a screen reader, printing the page,
 * or looking at it in bright sun on the shop floor.
 */
function TableView({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <details className="mt-3 border-t border-slate-100 pt-2">
      <summary className="cursor-pointer select-none text-xs text-slate-400 hover:text-slate-600">
        Show the numbers
      </summary>
      <table className="mt-2 w-full text-xs">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-slate-50">
              <td className="py-1 text-slate-500">{row.label}</td>
              <td className="py-1 text-right font-medium text-slate-700">{rm(row.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** Baseline, peak and the hairlines between — the shared plot backdrop. */
function Gridlines({
  left,
  right,
  top,
  bottom,
}: {
  left: number;
  right: number;
  top: number;
  bottom: number;
}) {
  return (
    <g>
      {[0.25, 0.5, 0.75].map((t) => (
        <line
          key={t}
          x1={left}
          x2={right}
          y1={bottom - (bottom - top) * t}
          y2={bottom - (bottom - top) * t}
          stroke={GRID}
          strokeWidth={1}
        />
      ))}
      <line x1={left} x2={right} y1={top} y2={top} stroke={GRID} strokeWidth={1} />
      <line x1={left} x2={right} y1={bottom} y2={bottom} stroke={BASELINE} strokeWidth={1} />
    </g>
  );
}

const GUTTER = 62;
const PAD_TOP = 12;
const AXIS_BAND = 20;
/**
 * Room for the endpoint marker.
 *
 * The last point of a trend sits at the plot's right edge, and an 8px dot with
 * a 2px surface ring needs 6px beyond it or the SVG viewport cuts it in half.
 * Found by rendering the chart and looking at it, which is the only way this
 * class of defect ever gets found.
 */
const PAD_RIGHT = 8;

export function BarChart({
  points,
  height = 180,
}: {
  points: { label: string; value: string; secondary?: string }[];
  height?: number;
}) {
  const [ref, width] = useMeasuredWidth();
  const [hovered, setHovered] = useState<Hovered | null>(null);

  if (points.length === 0) return null;

  const values = points.map((p) => scale(p.value));
  const max = Math.max(...values, 1);
  const peak = points[values.indexOf(Math.max(...values))]!;

  const plotBottom = height - AXIS_BAND;
  const plotHeight = plotBottom - PAD_TOP;
  const plotRight = width - PAD_RIGHT;
  const plotWidth = Math.max(plotRight - GUTTER, 0);
  const band = points.length > 0 ? plotWidth / points.length : 0;
  // Capped, never "fill the slot" — the leftover band is deliberate air, and
  // it is also what keeps neighbouring bars separated by surface rather than
  // by a stroke drawn around them.
  const barW = Math.max(Math.min(24, band * 0.62), 2);

  // Thin the x labels until they stop colliding: one per ~64px of plot.
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotWidth / 64))));

  return (
    <div ref={ref} className="relative">
      <Tooltip hovered={hovered} />
      {width > 0 ? (
        <svg width={width} height={height} className="block" role="img"
             aria-label={`Bar chart, ${points.length} points, peak ${rm(peak.value)}`}>
          <Gridlines left={GUTTER} right={plotRight} top={PAD_TOP} bottom={plotBottom} />

          {/* Only two labels, and both are real: zero, and the tallest bar's
              own server string. Nothing between them is invented. */}
          <text x={GUTTER - 8} y={PAD_TOP + 4} textAnchor="end"
                className="fill-slate-400 text-[10px] tabular-nums">
            {ringgit(peak.value)}
          </text>
          <text x={GUTTER - 8} y={plotBottom + 3} textAnchor="end"
                className="fill-slate-400 text-[10px] tabular-nums">
            RM 0
          </text>

          {points.map((p, i) => {
            const h = (scale(p.value) / max) * plotHeight;
            const x = GUTTER + i * band + (band - barW) / 2;
            const y = plotBottom - h;
            return (
              <g key={p.label}>
                {/* The hit area is the whole band, not the painted bar — a
                    4px-wide column is a pinpoint nobody lands on. */}
                <rect
                  x={GUTTER + i * band}
                  y={PAD_TOP}
                  width={band}
                  height={plotHeight}
                  fill="transparent"
                  tabIndex={0}
                  className="cursor-pointer outline-none"
                  onPointerEnter={() =>
                    setHovered({ x: x + barW / 2, y, label: p.label, value: p.value })
                  }
                  onPointerLeave={() => setHovered(null)}
                  onFocus={() => setHovered({ x: x + barW / 2, y, label: p.label, value: p.value })}
                  onBlur={() => setHovered(null)}
                />
                <path
                  d={columnPath(x, y, barW, h)}
                  fill={SERIES}
                  className="emil-grow pointer-events-none"
                  style={{ animationDelay: `${Math.min(i * 22, 300)}ms` }}
                  opacity={hovered && hovered.label !== p.label ? 0.55 : 1}
                />
              </g>
            );
          })}

          {points.map((p, i) =>
            i % every === 0 || i === points.length - 1 ? (
              <text
                key={`label-${p.label}`}
                x={GUTTER + i * band + band / 2}
                y={height - 5}
                textAnchor="middle"
                className="fill-slate-400 text-[10px]"
              >
                {p.label.slice(0, 5)}
              </text>
            ) : null,
          )}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
      <TableView rows={points} />
    </div>
  );
}

export function TrendLine({
  points,
  height = 180,
}: {
  points: { label: string; value: string }[];
  height?: number;
}) {
  const [ref, width] = useMeasuredWidth();
  const [hovered, setHovered] = useState<number | null>(null);

  if (points.length < 2) {
    return <p className="text-sm text-slate-500">Not enough history to draw yet.</p>;
  }

  const values = points.map((p) => scale(p.value));
  const max = Math.max(...values, 1);
  const peak = points[values.indexOf(Math.max(...values))]!;

  const plotBottom = height - AXIS_BAND;
  const plotHeight = plotBottom - PAD_TOP;
  const plotRight = width - PAD_RIGHT;
  const plotWidth = Math.max(plotRight - GUTTER, 0);
  const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;
  const x = (i: number) => GUTTER + i * step;
  const y = (v: number) => plotBottom - (v / max) * plotHeight;

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
  const area = `${line} L${x(points.length - 1)},${plotBottom} L${x(0)},${plotBottom} Z`;
  const last = points.length - 1;

  return (
    <div ref={ref} className="relative">
      <Tooltip
        hovered={
          hovered === null
            ? null
            : {
                x: x(hovered),
                y: y(values[hovered]!),
                label: points[hovered]!.label,
                value: points[hovered]!.value,
              }
        }
      />
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          className="block"
          role="img"
          aria-label={`Trend line, ${points.length} points, peak ${rm(peak.value)}`}
          onPointerLeave={() => setHovered(null)}
          onPointerMove={(e) => {
            // The crosshair finds the X: the reader aims at a week, never at a
            // 2px line.
            const box = e.currentTarget.getBoundingClientRect();
            const local = e.clientX - box.left - GUTTER;
            const nearest = Math.round(local / (step || 1));
            setHovered(Math.max(0, Math.min(points.length - 1, nearest)));
          }}
        >
          <Gridlines left={GUTTER} right={plotRight} top={PAD_TOP} bottom={plotBottom} />

          <text x={GUTTER - 8} y={PAD_TOP + 4} textAnchor="end"
                className="fill-slate-400 text-[10px] tabular-nums">
            {ringgit(peak.value)}
          </text>
          <text x={GUTTER - 8} y={plotBottom + 3} textAnchor="end"
                className="fill-slate-400 text-[10px] tabular-nums">
            RM 0
          </text>

          {/* A wash, never a saturated block. */}
          <path d={area} fill={SERIES} opacity={0.1} className="pointer-events-none" />
          <path
            d={line}
            fill="none"
            stroke={SERIES}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none"
          />

          {hovered !== null ? (
            <line
              x1={x(hovered)}
              x2={x(hovered)}
              y1={PAD_TOP}
              y2={plotBottom}
              stroke={BASELINE}
              strokeWidth={1}
              className="pointer-events-none"
            />
          ) : null}

          {/* Only the endpoint and the hovered point carry a dot — a marker on
              every reading is the "number on every point" failure in dot form. */}
          {[last, ...(hovered !== null && hovered !== last ? [hovered] : [])].map((i) => (
            <circle
              key={i}
              cx={x(i)}
              cy={y(values[i]!)}
              r={4}
              fill={SERIES}
              stroke={SURFACE}
              strokeWidth={2}
              className="pointer-events-none"
            />
          ))}

          <text x={GUTTER} y={height - 5} textAnchor="start" className="fill-slate-400 text-[10px]">
            {points[0]!.label.slice(0, 5)}
          </text>
          <text x={plotRight} y={height - 5} textAnchor="end" className="fill-slate-400 text-[10px]">
            {points[last]!.label.slice(0, 5)}
          </text>
        </svg>
      ) : (
        <div style={{ height }} />
      )}
      <TableView rows={points} />
    </div>
  );
}

/**
 * Horizontal bars for a small fixed set — the forecast horizons.
 *
 * Value at the tip, per the bar convention, so no gutter and no tooltip are
 * needed: every figure is already on the face of the chart.
 */
export function HBarChart({ rows }: { rows: { label: string; value: string }[] }) {
  const [ref, width] = useMeasuredWidth();
  if (rows.length === 0) return null;

  const max = Math.max(...rows.map((r) => Math.abs(scale(r.value))), 1);
  const track = Math.max(width, 0);

  return (
    <div ref={ref} className="space-y-3">
      {rows.map((r, i) => {
        const negative = r.value.startsWith('-');
        const w = (Math.abs(scale(r.value)) / max) * track;
        return (
          <div key={r.label}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="text-slate-500">{r.label}</span>
              <span className={`font-semibold ${negative ? 'text-red-700' : 'text-slate-800'}`}>
                {rm(r.value)}
              </span>
            </div>
            {width > 0 ? (
              <svg width={width} height={8} className="block">
                <rect x={0} y={0} width={track} height={8} rx={4} fill={GRID} />
                <path
                  d={rowPath(0, 0, w, 8)}
                  fill={negative ? NEGATIVE : SERIES}
                  className="emil-widen"
                  style={{ animationDelay: `${i * 60}ms` }}
                />
              </svg>
            ) : (
              <div className="h-2" />
            )}
          </div>
        );
      })}
    </div>
  );
}
