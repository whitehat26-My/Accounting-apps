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
      'bg-positive text-surface-raised shadow-sm hover:brightness-110 active:brightness-95 disabled:bg-line disabled:text-ink-faint disabled:shadow-none',
    ghost:
      'bg-surface-raised text-ink shadow-sm ring-1 ring-inset ring-line-strong hover:bg-surface-sunken disabled:text-ink-faint',
    danger: 'bg-negative text-surface-raised shadow-sm hover:brightness-110 disabled:bg-line disabled:text-ink-faint',
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
      className={`min-h-10 rounded-lg px-3.5 py-2 text-sm font-medium transition-[background-color,filter,transform,box-shadow] duration-150 motion-safe:active:scale-[0.98] disabled:cursor-not-allowed ${styles} ${className}`}
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
          className="emil-shimmer h-4 rounded"
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
      className={`w-full rounded-lg border-0 bg-surface-raised px-3 py-2 text-sm text-ink shadow-sm ring-1 ring-inset ring-line-strong placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-brand ${props.className ?? ''}`}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
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
    <div className={`rounded-2xl bg-surface-raised shadow-sm ring-1 ring-line ${className}`} style={style}>
      {/*
        `flex-wrap` on the header for the phone: several cards put date pickers
        or a filter in `action`, and on a 390px screen a title plus two date
        inputs cannot sit on one line — unwrapped they were clipped at the card
        edge and forced the whole page to render zoomed out. Wrapping drops the
        action onto its own line instead. `min-w-0` lets the title shrink rather
        than pushing the action out of the card.
      */}
      {title ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="min-w-0 text-sm font-semibold text-ink">{title}</h2>
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

/**
 * A status chip.
 *
 * ---------------------------------------------------------------------------
 * FIVE TONES, NOT TWENTY-FIVE COLOURS.
 *
 * This mapped each of ~25 statuses to its own literal palette
 * (`bg-caution-soft text-caution ring-caution/30` …), which meant twenty-five
 * places to get night mode wrong and no way to see that DECLINED and CANCELLED
 * were meant to read the same. Statuses do not have twenty-five meanings; they
 * have five:
 *
 *   neutral   nothing is being asked of anybody yet
 *   waiting   the ball is in someone else's court
 *   working   in hand, in this shop, right now
 *   done      finished well
 *   stopped   finished badly, or refused
 *
 * The tone carries the meaning and the token carries the theme, so a status
 * added later picks a tone rather than inventing a colour.
 * ---------------------------------------------------------------------------
 */
type Tone = 'neutral' | 'waiting' | 'working' | 'done' | 'stopped';

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-sunken text-ink-muted ring-line',
  waiting: 'bg-caution-soft text-caution ring-caution/30',
  working: 'bg-brand/10 text-brand ring-brand/30',
  done: 'bg-positive-soft text-positive ring-positive/30',
  stopped: 'bg-negative-soft text-negative ring-negative/30',
};

const STATUS_TONE: Record<string, Tone> = {
  // Repairs
  RECEIVED: 'neutral', QUOTED: 'waiting', APPROVED: 'working',
  IN_PROGRESS: 'working', READY: 'done', COLLECTED: 'done',
  DECLINED: 'stopped', CANCELLED: 'stopped',
  // Invoices
  ISSUED: 'waiting', PART_PAID: 'waiting', PAID: 'done',
  // Periods and books
  ACTIVE: 'done', OPEN: 'done', CLOSED: 'waiting', LOCKED: 'neutral',
  // Quotes. DRAFT is neutral because a draft commits nobody; SENT waits on
  // someone else; EXPIRED stopped without anybody deciding.
  DRAFT: 'neutral', SENT: 'waiting', ACCEPTED: 'done',
  EXPIRED: 'neutral', INVOICED: 'working',
  // Audit
  MANUAL: 'working', REVERSAL: 'stopped',
  CREATE: 'done', UPDATE: 'working', DELETE: 'stopped',
};

export function Badge({ status }: { status: string }) {
  return (
    <span
      // `whitespace-nowrap`: a status is one word to the reader even when it is
      // two on the page. Without it "IN PROGRESS" breaks across two lines and
      // spills out of its own pill the moment the column is narrow.
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        TONE[STATUS_TONE[status] ?? 'neutral']
      }`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p className="rounded-lg bg-negative-soft px-3 py-2 text-sm text-negative ring-1 ring-inset ring-negative/30">
      {message}
    </p>
  );
}
