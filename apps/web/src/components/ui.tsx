/**
 * The handful of primitives every screen shares.
 *
 * Hand-rolled rather than a component library: a few components cover this
 * app, and a registry of fifty would be dependency surface with no second
 * user. If the design system grows past what a file can hold, that is the
 * moment to adopt one — with this file as the shopping list.
 */

import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode } from 'react';

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    primary:
      'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-slate-300 disabled:shadow-none',
    ghost:
      'bg-white text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700 disabled:bg-slate-300',
  }[variant];
  /*
   * `active:scale` gives a press somewhere to land — 0.98 is felt in the
   * finger without being seen from across the room. Guarded by
   * `motion-safe:` so a press stays perfectly still for people who asked
   * everything to. The focus ring is not optional the same way: it is how a
   * keyboard user knows where they are, and it was missing entirely.
   */
  return (
    <button
      className={`min-h-10 rounded-lg px-3.5 py-2 text-sm font-medium transition-[background-color,transform,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 motion-safe:active:scale-[0.98] disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  );
}

/** Loading placeholder: bars with a light sweep where the content will land. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="emil-shimmer h-4 rounded bg-slate-200/80"
          style={{ width: `${[85, 60, 72, 48, 66][i % 5]}%` }}
        />
      ))}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600 ${props.className ?? ''}`}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
  style,
}: {
  title?: string;
  /** Optional right-aligned header content — a button, a badge, a date. */
  action?: ReactNode;
  children: ReactNode;
  /** Pages opt into entrance motion here — `emil-rise` plus a staggered
      `animationDelay` in `style`, the idiom charts.tsx established. */
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`rounded-2xl bg-white shadow-sm ring-1 ring-slate-900/5 ${className}`} style={style}>
      {/*
        `flex-wrap` on the header for the phone: several cards put date pickers
        or a filter in `action`, and on a 390px screen a title plus two date
        inputs cannot sit on one line — unwrapped they were clipped at the card
        edge and forced the whole page to render zoomed out. Wrapping drops the
        action onto its own line instead. `min-w-0` lets the title shrink rather
        than pushing the action out of the card.
      */}
      {title ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <h2 className="min-w-0 text-sm font-semibold text-slate-900">{title}</h2>
          {action ?? null}
        </div>
      ) : null}
      {/*
        `overflow-x-auto` is what makes this usable on a phone. Every data table
        in the app lives in a Card and is `w-full` with five to eight columns of
        figures — on a 390px screen that is wider than the viewport, and without
        a scroll container here the whole PAGE scrolls sideways instead of the
        table. Contained, the table scrolls within its own card and the page
        never moves. Safe to put on the body rather than around each table: no
        card contains an absolutely-positioned popover that would be clipped.
      */}
      <div className="overflow-x-auto p-5">{children}</div>
    </div>
  );
}

export function Badge({ status }: { status: string }) {
  const tone =
    {
      RECEIVED: 'bg-slate-100 text-slate-700 ring-slate-200',
      QUOTED: 'bg-amber-50 text-amber-800 ring-amber-200',
      APPROVED: 'bg-sky-50 text-sky-800 ring-sky-200',
      IN_PROGRESS: 'bg-sky-50 text-sky-800 ring-sky-200',
      READY: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
      COLLECTED: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
      DECLINED: 'bg-red-50 text-red-700 ring-red-200',
      CANCELLED: 'bg-red-50 text-red-700 ring-red-200',
      PAID: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
      ISSUED: 'bg-amber-50 text-amber-800 ring-amber-200',
      PART_PAID: 'bg-amber-50 text-amber-800 ring-amber-200',
      ACTIVE: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
      OPEN: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
      CLOSED: 'bg-amber-50 text-amber-800 ring-amber-200',
      LOCKED: 'bg-slate-800 text-white ring-slate-800',
      MANUAL: 'bg-sky-50 text-sky-800 ring-sky-200',
      // Quote statuses. DRAFT is grey because a draft is not yet a commitment
      // to anybody; SENT is amber because it is waiting on someone else.
      DRAFT: 'bg-slate-100 text-slate-700 ring-slate-200',
      SENT: 'bg-amber-50 text-amber-800 ring-amber-200',
      ACCEPTED: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
      EXPIRED: 'bg-slate-200 text-slate-600 ring-slate-300',
      INVOICED: 'bg-sky-50 text-sky-800 ring-sky-200',
      REVERSAL: 'bg-red-50 text-red-700 ring-red-200',
      CREATE: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
      UPDATE: 'bg-sky-50 text-sky-800 ring-sky-200',
      DELETE: 'bg-red-50 text-red-700 ring-red-200',
    }[status] ?? 'bg-slate-100 text-slate-700 ring-slate-200';
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-inset ring-red-200">
      {message}
    </p>
  );
}
